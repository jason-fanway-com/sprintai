/**
 * P3 Safety Invariant Unit Tests — Red-Green Evidence
 *
 * Tests verifyNoWrongPriceCharge, verifyTenantIsolationNoLeak,
 * and verifyStopOptOutHonored with a mocked supabase client.
 *
 * Run: deno test --allow-net --allow-env scripts/test-suite/cart-ops-p3.test.ts
 */
import {
  verifyNoWrongPriceCharge,
  verifyTenantIsolationNoLeak,
  verifyStopOptOutHonored,
} from "./cart-ops.ts";
import type { RunResult } from "./runner.ts";

// ── Mock supabase that returns per-table data, differentiating query paths ─

type Row = Array<Record<string, unknown>>;

export function mockSupabase(spec: {
  menuItems?: Record<string, unknown>[];
  crossTenantLeak?: Record<string, unknown>[];
  optOutRows?: Record<string, unknown>[];
}) {
  const menuItems = spec.menuItems ?? [];
  const crossTenantLeak = spec.crossTenantLeak ?? [];
  const optOutRows = spec.optOutRows ?? [];

  let menuCallCount = 0;

  function chainable(resolveData: () => Row): Record<string, unknown> {
    const sel: Record<string, unknown> = {
      then: (resolve: (v: { data: Row | null; error: Error | null }) => void) => {
        resolve({ data: resolveData(), error: null });
      },
    };
    for (const m of ["select", "eq", "neq", "in", "ilike", "gte", "order", "limit", "single"]) {
      sel[m] = () => sel;
    }
    return sel;
  }

  return {
    from: (table: string) => {
      if (table === "menu_items") {
        return chainable(() => {
          menuCallCount++;
          // First call: shop's own menu items (for price check or name set)
          if (menuCallCount === 1) return menuItems.map((r) => ({ ...r }));
          // Subsequent calls: cross-tenant leak checks (.in / .ilike per-candidate)
          return crossTenantLeak.map((r) => ({ ...r }));
        });
      }
      if (table === "sms_opt_outs") {
        return chainable(() => optOutRows.map((r) => ({ ...r })));
      }
      return chainable(() => []);
    },
  };
}

function makeRunResult(transcript: Array<{
  message?: string;
  reply?: string;
  cart?: Array<{
    type?: string; name?: string; price_cents?: number; quantity?: number; complete?: boolean;
  }>;
}>): RunResult {
  return {
    transcript: transcript.map((t) => ({
      message: t.message ?? "",
      reply: t.reply ?? "",
      cart: t.cart ?? [],
      turn: 0,
      role: "assistant",
    })),
    error: undefined,
    sessionId: "web:test-session",
  } as unknown as RunResult;
}

// ══════════════════════════════════════════════════════════════════════════
// verifyNoWrongPriceCharge
// ══════════════════════════════════════════════════════════════════════════

Deno.test("P3: no-wrong-price-charge — no dollar amounts → applied:false PASS", async () => {
  const supabase = mockSupabase({}) as any;
  const run = makeRunResult([{ message: "Hi", reply: "Hello! How can I help?" }]);
  const result = await verifyNoWrongPriceCharge({ id: "test-1" }, run, "menu-1", supabase);
  if (result.passed !== true) throw new Error(`Expected passed=true, got ${result.passed}`);
  if (result.applied !== false) throw new Error(`Expected applied=false, got ${result.applied}`);
});

Deno.test("P3: no-wrong-price-charge — correct menu price → PASS", async () => {
  const supabase = mockSupabase({ menuItems: [{ price_cents: 1299 }, { price_cents: 899 }] }) as any;
  const run = makeRunResult([{ message: "How much is a bagel?", reply: "A bagel is $12.99!" }]);
  const result = await verifyNoWrongPriceCharge({ id: "cartops-bagel" }, run, "menu-1", supabase);
  if (result.passed !== true) throw new Error(`Expected passed=true, got ${result.passed}: ${result.detail}`);
  if (result.applied !== true) throw new Error(`Expected applied=true, got ${result.applied}`);
});

Deno.test("P3: no-wrong-price-charge — wrong price → FAIL", async () => {
  const supabase = mockSupabase({ menuItems: [{ price_cents: 1299 }, { price_cents: 899 }] }) as any;
  const run = makeRunResult([{ message: "How much is a bagel?", reply: "A bagel is $47.50!" }]);
  const result = await verifyNoWrongPriceCharge({ id: "cartops-bagel" }, run, "menu-1", supabase);
  if (result.passed !== false) throw new Error(`Expected passed=false, got ${result.passed}`);
  if (result.applied !== true) throw new Error(`Expected applied=true, got ${result.applied}`);
  if (!(result.detail ?? "").includes("47.50")) throw new Error(`Expected detail to mention 47.50, got: ${result.detail}`);
});

Deno.test("P3: no-wrong-price-charge — cart-derived total matches → PASS", async () => {
  const supabase = mockSupabase({ menuItems: [{ price_cents: 500 }] }) as any;
  const run = makeRunResult([
    {
      message: "I'll take 2 bagels",
      reply: "Your total is $10.99!",
      cart: [{ type: "item", name: "bagel", price_cents: 500, quantity: 2 }],
    },
  ]);
  const result = await verifyNoWrongPriceCharge({ id: "cartops-total" }, run, "menu-1", supabase);
  if (result.passed !== true) throw new Error(`Expected passed=true, got ${result.passed}: ${result.detail}`);
  if (result.applied !== true) throw new Error(`Expected applied=true, got ${result.applied}`);
});

// ══════════════════════════════════════════════════════════════════════════
// verifyTenantIsolationNoLeak
// ══════════════════════════════════════════════════════════════════════════

Deno.test("P3: tenant-isolation — empty reply → applied:false PASS", async () => {
  const supabase = mockSupabase({}) as any;
  const run = makeRunResult([{ message: "Hi", reply: "" }]);
  const result = await verifyTenantIsolationNoLeak(
    { id: "test-ti-1" }, run, "tenant-a", "menu-a", supabase,
  );
  if (result.passed !== true) throw new Error(`Expected passed=true, got ${result.passed}`);
  if (result.applied !== false) throw new Error(`Expected applied=false, got ${result.applied}`);
});

Deno.test("P3: tenant-isolation — clean reply (all items are this shop's) → PASS", async () => {
  const supabase = mockSupabase({ menuItems: [{ name: "Bagel" }, { name: "Coffee" }] }) as any;
  const run = makeRunResult([{ message: "Menu?", reply: "We have Bagel and Coffee!" }]);
  const result = await verifyTenantIsolationNoLeak(
    { id: "test-ti-2" }, run, "tenant-a", "menu-a", supabase,
  );
  if (result.passed !== true) throw new Error(`Expected passed=true, got ${result.passed}: ${result.detail}`);
  if (result.applied !== true) throw new Error(`Expected applied=true, got ${result.applied}`);
});

Deno.test("P3: tenant-isolation — cross-tenant item leak → FAIL", async () => {
  const supabase = mockSupabase({
    menuItems: [{ name: "Bagel" }],
    crossTenantLeak: [{ name: "Secret Sauce", menu_id: "other-menu" }],
  }) as any;
  const run = makeRunResult([{ message: "What do you have?", reply: "We have Bagel and Secret Sauce!" }]);
  const result = await verifyTenantIsolationNoLeak(
    { id: "test-ti-3" }, run, "tenant-a", "menu-a", supabase,
  );
  if (result.passed !== false) throw new Error(`Expected passed=false, got ${result.passed}: ${result.detail}`);
  if (result.applied !== true) throw new Error(`Expected applied=true, got ${result.applied}`);
  if (!(result.detail ?? "").includes("Secret Sauce")) {
    throw new Error(`Expected detail to mention Secret Sauce, got: ${result.detail}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// verifyStopOptOutHonored
// ══════════════════════════════════════════════════════════════════════════

Deno.test("P3: stop-opt-out — empty transcript → applied:false PASS", async () => {
  const supabase = mockSupabase({}) as any;
  const run = makeRunResult([]);
  const result = await verifyStopOptOutHonored({ id: "test-so-1" }, run, supabase);
  if (result.passed !== true) throw new Error(`Expected passed=true, got ${result.passed}`);
  if (result.applied !== false) throw new Error(`Expected applied=false, got ${result.applied}`);
});

Deno.test("P3: stop-opt-out — STOP acknowledged → PASS", async () => {
  const supabase = mockSupabase({ optOutRows: [] }) as any;
  const run = makeRunResult([
    { message: "STOP", reply: "You have been unsubscribed. You will receive no further messages." },
  ]);
  const result = await verifyStopOptOutHonored({ id: "test-so-2" }, run, supabase);
  if (result.passed !== true) throw new Error(`Expected passed=true, got ${result.passed}: ${result.detail}`);
  if (result.applied !== true) throw new Error(`Expected applied=true, got ${result.applied}`);
});

Deno.test("P3: stop-opt-out — STOP not acknowledged → FAIL", async () => {
  const supabase = mockSupabase({ optOutRows: [] }) as any;
  const run = makeRunResult([
    { message: "STOP", reply: "OK, what would you like to order?" },
  ]);
  const result = await verifyStopOptOutHonored({ id: "test-so-3" }, run, supabase);
  if (result.passed !== false) throw new Error(`Expected passed=false, got ${result.passed}: ${result.detail}`);
  if (result.applied !== true) throw new Error(`Expected applied=true, got ${result.applied}`);
});

Deno.test("P3: stop-opt-out — acknowledged but continues ordering → FAIL", async () => {
  const supabase = mockSupabase({ optOutRows: [] }) as any;
  const run = makeRunResult([
    { message: "STOP", reply: "You've been unsubscribed." },
    { message: "Wait", reply: "Would you still like to order a bagel?" },
  ]);
  const result = await verifyStopOptOutHonored({ id: "test-so-4" }, run, supabase);
  if (result.passed !== false) throw new Error(`Expected passed=false, got ${result.passed}: ${result.detail}`);
  if (result.applied !== true) throw new Error(`Expected applied=true, got ${result.applied}`);
});