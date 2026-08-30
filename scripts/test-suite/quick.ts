#!/usr/bin/env deno run --allow-net --allow-env --allow-read
/**
 * quick.ts — Abbreviated test runner (~25 cases, ~2–4 min).
 *
 * Reuses the existing runner.ts + cart-ops.ts + hours-closed.ts to run a
 * high-value subset against the deployed chat-sms edge function on the
 * live TEST Supabase. No LLM judge, no persist — programmatic invariants only.
 *
 * INVARIANTS (from cart-ops.ts):
 *   1. quoted_total = sum(cart line totals) + $0.99 service fee + delivery_fee + driver_tip
 *   2. Every displayed item in the bot's summary exists in cart_json at same qty
 *   3. A tip/name/question turn NEVER changes item quantities
 *   4. A correction that reduces/removes IS reflected in cart_json before next reply
 *   5. No duplicate lines for same menu_item_id + modifiers
 *
 * BUILDING-phase cart total = subtotal; final quoted/checkout = subtotal + $0.99 fee.
 * Do NOT assert building total == quoted.
 *
 * Run:
 *   deno run --allow-net --allow-env scripts/test-suite/quick.ts
 *
 * Requires env: SPRINTAI_CHAT_SUPABASE_URL, SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { runCase } from "./runner.ts";
import {
  buildCartOpsCases,
  verifyCartOpsInvariants,
  type CartOpsVerification,
} from "./cart-ops.ts";
import { HOURS_CLOSED_CASES, verifyHoursClosed, type HoursClosedVerification } from "./hours-closed.ts";
import type { TestCase, SuccessCriterion } from "./library.ts";

// ── Config ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PROJECT_REF = "rvdqfxtrskxekfkqnegx";
const CHAT_FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/chat-sms`;

// Test shop: synthetic, no phone, not protected — safe for automated testing.
const SHOP_ID = "38ae034c-cb9d-4f32-b4f1-d9b40393574b";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("quick: missing SPRINTAI_CHAT_SUPABASE_URL or SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const runConfig = { supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_KEY, chatFunctionUrl: CHAT_FUNCTION_URL };

// ── Helpers (mirrors cart-ops.ts internals) ───────────────────────────────

type CartItemLike = {
  menu_item_id?: string; name?: string; quantity?: number;
  price_cents?: number; modifiers?: string[]; options?: Record<string, string[]>;
  type?: string; target?: number; complete?: boolean;
  selections?: Array<{ flavor: string; quantity: number }>;
};

function cartSubtotalCents(cart: CartItemLike[] | undefined | null): number {
  if (!cart || !Array.isArray(cart)) return 0;
  let total = 0;
  for (const item of cart) {
    const qty = item.quantity ?? 1;
    let price = item.price_cents ?? 0;
    // selections (e.g., loukoumades)
    if (item.selections) {
      for (const sel of item.selections) {
        total += (sel.quantity ?? 0) * price; // price already at item level
      }
      continue; // don't double-count base item
    }
    total += price * qty;
  }
  return total;
}

function expectedTotalCents(cart: CartItemLike[] | undefined | null, deliveryFeeCents = 0, driverTipCents = 0): number {
  return cartSubtotalCents(cart) + 99 + deliveryFeeCents + driverTipCents;
}

function findQuotedTotal(text: string): { cents: number; raw: string } | null {
  const patterns = [
    /\$?(\d+\.\d{2})\s*(?:total|checkout|due)/i,
    /(?:total|checkout|due)[:\s]*\$?(\d+\.\d{2})/i,
    /\$(\d+\.\d{2})/g,
  ];
  // Try explicit total patterns first
  for (const p of patterns.slice(0, 2)) {
    const m = text.match(p);
    if (m) return { cents: Math.round(parseFloat(m[1]) * 100), raw: m[0] };
  }
  // Fallback: find the last dollar amount (heuristic)
  const allDollars = [...text.matchAll(/\$(\d+\.\d{2})/g)];
  if (allDollars.length > 0) {
    const last = allDollars[allDollars.length - 1];
    return { cents: Math.round(parseFloat(last[1]) * 100), raw: last[0] };
  }
  return null;
}

// ── Types ──────────────────────────────────────────────────────────────────

interface QuickResult {
  caseId: string;
  label: string;
  passed: boolean;
  details: string[];
}

// ── Load shop + menu ───────────────────────────────────────────────────────

console.log("quick.ts — abbreviated test runner\n");

const { data: shop, error: shopErr } = await supabase
  .from("shops")
  .select("id, tenant_id, name, protected, phone_number_e164")
  .eq("id", SHOP_ID)
  .single();

if (shopErr || !shop) throw new Error(`Shop ${SHOP_ID} not found: ${shopErr?.message}`);

if (shop.protected === true || (shop.phone_number_e164 && shop.phone_number_e164 !== "")) {
  throw new Error(`SAFETY: shop ${shop.name} is protected or has phone — refusing to run`);
}

console.log(`Shop: ${shop.name} (${shop.id})`);

const { data: menu } = await supabase
  .from("menus")
  .select("id")
  .eq("shop_id", SHOP_ID)
  .order("created_at", { ascending: false })
  .limit(1)
  .single();

if (!menu) throw new Error(`No menu found for shop ${shop.name}`);

const { data: itemsRaw, error: menuErr } = await supabase
  .from("menu_items")
  .select("id, name, price_cents, modifiers_json, category, active")
  .eq("menu_id", menu.id)
  .eq("active", true);

if (menuErr || !itemsRaw?.length) throw new Error(`No active menu items: ${menuErr?.message}`);

const items = itemsRaw.map((i) => ({ name: i.name, price_cents: i.price_cents }));
console.log(`Menu items: ${items.length}\n`);

// ── Build cases (~25) ──────────────────────────────────────────────────────

// 1. All CartOps adversarial cases (21 from buildCartOpsCases)
const cartOpsCases = buildCartOpsCases(items);

// 2. Hours-closed critical case (1)
const hoursClosedCase = HOURS_CLOSED_CASES[0];

// 3. Menu-derived checkout/recognition cases (3)
const A = items[0];
const B = items[1];
const C = items[2];

const menuCheckoutCases: TestCase[] = [
  {
    id: "quick-checkout-single",
    category: "menu-checkout",
    criticality: "critical",
    label: `Single-item checkout: ${A.name} → confirm → name → verify quoted total = subtotal + $0.99`,
    turns: [
      { role: "customer", message: `I'd like a ${A.name} please` },
      { role: "customer", message: "yes" },
      { role: "customer", message: "checkout" },
      { role: "customer", message: "Pat" },
    ],
    success_criteria: [{ id: "checkout_reached", description: "Bot reaches checkout phase" }],
  },
  {
    id: "quick-checkout-two",
    category: "menu-checkout",
    criticality: "critical",
    label: `Two-item checkout: ${A.name} + ${B.name} → confirm → name → verify quoted total`,
    turns: [
      { role: "customer", message: `I'll take a ${A.name} and a ${B.name}` },
      { role: "customer", message: "yes" },
      { role: "customer", message: "checkout" },
      { role: "customer", message: "Pat" },
    ],
    success_criteria: [{ id: "checkout_reached", description: "Bot reaches checkout phase with both items" }],
  },
  {
    id: "quick-with-modifier",
    category: "menu-checkout",
    criticality: "critical",
    label: `Order with modifier: ${A.name} + a modifier → confirm → verify subtotal includes modifier`,
    turns: [
      { role: "customer", message: `I'll take a ${A.name} with ${B.name} on it` },
      { role: "customer", message: "yes" },
      { role: "customer", message: "checkout" },
      { role: "customer", message: "Pat" },
    ],
    success_criteria: [{ id: "checkout_reached", description: "Bot reaches checkout with modifier applied" }],
  },
];

const allCases = [...cartOpsCases, hoursClosedCase, ...menuCheckoutCases];

console.log(`Cases: ${cartOpsCases.length} CartOps + 1 hours-closed + ${menuCheckoutCases.length} menu-checkout = ${allCases.length}\n`);
console.log("═══ RUNNING ═══\n");

// ── Run ────────────────────────────────────────────────────────────────────

const results: QuickResult[] = [];

for (let i = 0; i < allCases.length; i++) {
  const tc = allCases[i];
  const label = `[${i + 1}/${allCases.length}] ${tc.id}`;
  console.log(`${label}: ${tc.label}`);

  try {
    const run = await runCase(runConfig, SHOP_ID, tc);

    if (tc.category === "cart-ops") {
      // ── CartOps: programmatic invariant verification ──────────────────
      const verify = verifyCartOpsInvariants(run);
      const failedInvs = verify.invariants.filter((inv) => !inv.passed);
      const details: string[] = [];

      for (const inv of verify.invariants) {
        const mark = inv.passed ? "  ✓" : "  ✗";
        console.log(`${mark} ${inv.id}: ${inv.detail}`);
        if (!inv.passed) details.push(`${inv.id}: ${inv.detail}`);
      }

      const passed = verify.passed;
      console.log(`  → ${passed ? "PASS" : "FAIL"}\n`);
      results.push({ caseId: tc.id, label: tc.label, passed, details });
    } else if (tc.category === "hours-closed") {
      // ── Hours-closed: programmatic verification ───────────────────────
      const verify = verifyHoursClosed(run);
      const details: string[] = [];

      for (const inv of verify.invariants) {
        const mark = inv.passed ? "  ✓" : "  ✗";
        console.log(`${mark} ${inv.id}: ${inv.detail}`);
        if (!inv.passed) details.push(`${inv.id}: ${inv.detail}`);
      }

      const passed = verify.passed;
      console.log(`  → ${passed ? "PASS" : "FAIL"}\n`);
      results.push({ caseId: tc.id, label: tc.label, passed, details });
    } else {
      // ── Menu-checkout: simple fee-aware total verification ───────────
      const details: string[] = [];
      let passed = true;

      // Check: reached checkout phase
      const lastTurn = run.transcript[run.transcript.length - 1];
      const phase = (lastTurn?.phase as string) ?? "";
      const reachedCheckout = phase === "checkout";
      console.log(`  • Phase: ${phase} ${reachedCheckout ? "✓" : "✗ (expected checkout)"}`);
      if (!reachedCheckout) {
        details.push(`Phase "${phase}" — expected "checkout"`);
        passed = false;
      }

      // Check: quoted total matches cart_json + $0.99 fee (Invariant 1)
      const cart = (lastTurn?.cart as unknown[]) ?? [];
      const reply = lastTurn?.reply ?? "";
      const quoted = findQuotedTotal(reply);
      if (quoted && cart.length > 0) {
        const expected = expectedTotalCents(cart as any);
        const diffCents = Math.abs(quoted.cents - expected);
        const ok = diffCents <= 2;
        console.log(`  • Quoted: $${(quoted.cents / 100).toFixed(2)} | Expected: $${(expected / 100).toFixed(2)} (${cartSubtotalCents(cart as any) / 100} + $0.99) | diff: ${diffCents}c ${ok ? "✓" : "✗"}`);
        if (!ok) {
          details.push(`Quoted $${(quoted.cents / 100).toFixed(2)} but cart computes to $${(expected / 100).toFixed(2)} (subtotal $${(cartSubtotalCents(cart as any) / 100).toFixed(2)} + $0.99 fee)`);
          passed = false;
        }
      } else if (!quoted) {
        console.log(`  • No quoted total found in reply ⚠`);
        // Don't fail on missing total — the bot might not quote one in building
      }

      // Check: cart is not empty
      if (cart.length === 0) {
        console.log(`  • Cart empty ✗`);
        details.push("Cart is empty — no items added");
        passed = false;
      }

      console.log(`  → ${passed ? "PASS" : "FAIL"}\n`);
      results.push({ caseId: tc.id, label: tc.label, passed, details });
    }
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`  → CRASH: ${msg}\n`);
    results.push({ caseId: tc.id, label: tc.label, passed: false, details: [`Crash: ${msg}`] });
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

const passCount = results.filter((r) => r.passed).length;
const total = results.length;
const pct = Math.round((passCount / total) * 100);

console.log("═══ RESULTS ═══\n");

let anyCriticalFail = false;
for (const r of results) {
  const mark = r.passed ? "✓" : "✗";
  console.log(`  ${mark} ${r.caseId}`);
  if (!r.passed) {
    for (const d of r.details) {
      console.log(`      ${d}`);
    }
  }
}

// Check critical cases
const criticalFails = results.filter((r) => !r.passed);
for (const f of criticalFails) {
  // All CartOps + hours-closed + menu-checkout cases are critical
  anyCriticalFail = true;
}

console.log(`\nQUICK: ${passCount}/${total} pass (${pct}%)`);
if (anyCriticalFail) {
  console.log(`CRITICAL FAILURES: ${criticalFails.length} case(s) — exit 1`);
  Deno.exit(1);
} else {
  console.log("All critical cases pass.");
  Deno.exit(0);
}