// Confidence + selection-order + no-suppression proof for the eval-sweep worker.
//
// Drives the REAL worker functions (loadGroundTruth / selectCandidates /
// runSweep, exported from ../index.ts) against an in-memory fake Supabase
// client + a stubbed Anthropic endpoint. NO remote DB, NO real LLM, NO network.
//
// Proves:
//   (A) CONFIDENCE LOGIC: a cart-bearing conv with a real menu  → eval confidence='high'.
//                         a cart-less conv (no shop/menu)        → eval confidence='low'.
//   (B) SELECTION ORDER:  a mixed batch over the cap judges cart-bearing convs
//                         BEFORE cart-less ones (cap unchanged).
//   (C) NO SUPPRESSION:   a real invented_item on a real menu still yields a
//                         CRITICAL flag at HIGH confidence — not hidden, not
//                         downgraded.
//
// Run: ANTHROPIC_API_KEY=x deno run --allow-env --allow-net run-confidence-proof.ts
//   (the key value is irrelevant — fetch is stubbed; it just satisfies the
//    presence check in callJudge.)

import { loadGroundTruth, selectCandidates, runSweep } from "../index.ts";

let pass = true;
function assert(name: string, cond: boolean, extra = "") {
  if (!cond) pass = false;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${extra ? " :: " + extra : ""}`);
}

// ─── Stub Anthropic: deterministic judge output keyed off transcript content ──
// If the transcript mentions "buffalo wings" (NOT on the NJB menu) → emit an
// invented_item flag (CRITICAL via the rubric severity map). Otherwise clean.
const realFetch = globalThis.fetch;
// deno-lint-ignore no-explicit-any
(globalThis as any).fetch = async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("api.anthropic.com")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const userText: string = body?.messages?.[0]?.content ?? "";
    const lc = userText.toLowerCase();
    const flags = lc.includes("buffalo wings")
      ? [{
          check: "invented_item",
          severity: "critical",
          evidence_message_ids: ["a1"],
          explanation: "Buffalo Wings are not on the menu.",
        }]
      : [];
    const out = JSON.stringify({ verdict: flags.length ? "flagged" : "clean", flags });
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: out }],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return realFetch(url as never, init);
};
Deno.env.set("ANTHROPIC_API_KEY", "stub-key-for-proof");

// ─── In-memory fake Supabase client ───────────────────────────────────────────
// Minimal subset of the query builder the worker uses: from().select().eq()
// .in().lt().gte().order().limit().maybeSingle()/insert()/update(). Returns
// { data } / { data, error }. Tenant isolation is enforced by the worker code,
// not the fake (the fake just stores rows).
type Row = Record<string, unknown>;
interface Tables {
  conversations: Row[];
  order_carts: Row[];
  shops: Row[];
  menus: Row[];
  menu_items: Row[];
  messages: Row[];
  conversation_evals: Row[];
  tenants: Row[];
}

function makeClient(tables: Tables) {
  function query(table: keyof Tables) {
    let rows = [...(tables[table] as Row[])];
    const api = {
      select(_cols?: string) { return api; },
      eq(col: string, val: unknown) { rows = rows.filter((r) => r[col] === val); return api; },
      in(col: string, vals: unknown[]) { rows = rows.filter((r) => vals.includes(r[col])); return api; },
      lt(col: string, val: unknown) { rows = rows.filter((r) => (r[col] as string) < (val as string)); return api; },
      gte(col: string, val: unknown) { rows = rows.filter((r) => (r[col] as string) >= (val as string)); return api; },
      order(col: string, opts?: { ascending?: boolean }) {
        const asc = opts?.ascending !== false;
        rows.sort((a, b) => {
          const av = a[col] as never, bv = b[col] as never;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        });
        return api;
      },
      limit(n: number) { rows = rows.slice(0, n); return api; },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
      insert(payload: Row) {
        const rowsToInsert = Array.isArray(payload) ? payload : [payload];
        const inserted: Row[] = [];
        for (const p of rowsToInsert) {
          // enforce the unique (conversation_id, transcript_hash) index
          const dup = (tables[table] as Row[]).some(
            (r) => r.conversation_id === p.conversation_id && r.transcript_hash === p.transcript_hash,
          );
          if (table === "conversation_evals" && dup) {
            return {
              select() { return { maybeSingle() { return Promise.resolve({ data: null, error: { message: "duplicate key" } }); } }; },
            };
          }
          const withId = { id: p.id ?? crypto.randomUUID(), ...p };
          (tables[table] as Row[]).push(withId);
          inserted.push(withId);
        }
        return {
          select() {
            return { maybeSingle() { return Promise.resolve({ data: inserted[0], error: null }); } };
          },
        };
      },
      update(patch: Row) {
        return {
          in(col: string, vals: unknown[]) {
            for (const r of tables[table] as Row[]) {
              if (vals.includes(r[col])) Object.assign(r, patch);
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };
    return api;
  }
  return { from: (t: keyof Tables) => query(t) } as unknown as Parameters<typeof runSweep>[0];
}

// ─── Seed data ────────────────────────────────────────────────────────────────
const TENANT = "11111111-1111-1111-1111-111111111111";
const SHOP = "22222222-2222-2222-2222-222222222222";
const MENU = "33333333-3333-3333-3333-333333333333";
const old = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago → idle

function baseTables(): Tables {
  return {
    tenants: [{ id: TENANT, name: "NJB" }],
    shops: [{ id: SHOP, tenant_id: TENANT, name: "Nonna's Brick", timezone: "America/New_York", open_hours: {}, created_at: old }],
    menus: [{ id: MENU, shop_id: SHOP, created_at: old }],
    menu_items: [
      { menu_id: MENU, name: "Margherita Pizza", price_cents: 1400, category: "Pizza", active: true, display_order: 1 },
      { menu_id: MENU, name: "Pepperoni Pizza", price_cents: 1600, category: "Pizza", active: true, display_order: 2 },
    ],
    conversations: [],
    order_carts: [],
    messages: [],
    conversation_evals: [],
  };
}

console.log("=== eval-sweep CONFIDENCE / SELECTION / NO-SUPPRESSION proof ===\n");

// ── (A) Confidence logic via loadGroundTruth ─────────────────────────────────
console.log("--- (A) CONFIDENCE LOGIC (loadGroundTruth) ---");
{
  const tables = baseTables();
  // cart-bearing conv → resolves SHOP → real menu
  const convHigh = "aaaaaaaa-0000-0000-0000-000000000001";
  tables.conversations.push({ id: convHigh, tenant_id: TENANT, last_message_at: old });
  tables.order_carts.push({ conversation_id: convHigh, shop_id: SHOP, phase: "confirmed", payment_status: "paid", stripe_checkout_session_id: "cs_1", created_at: old });

  // cart-less conv → no cart; ALSO no tenant shop fallback would resolve a menu
  // here because we want a true "no menu" case. Use a SEPARATE tenant with no shop.
  const TENANT2 = "99999999-9999-9999-9999-999999999999";
  tables.tenants.push({ id: TENANT2, name: "Ghost tenant (no shop)" });
  const convLow = "bbbbbbbb-0000-0000-0000-000000000001";
  tables.conversations.push({ id: convLow, tenant_id: TENANT2, last_message_at: old });

  const client = makeClient(tables);
  const gHigh = await loadGroundTruth(client, { id: convHigh, tenant_id: TENANT });
  const gLow = await loadGroundTruth(client, { id: convLow, tenant_id: TENANT2 });

  assert("cart-bearing conv with real menu → confidence='high'", gHigh.confidence === "high", `shopId=${gHigh.shopId} menuLoaded=${gHigh.menuLoaded}`);
  assert("high case actually loaded menu items", gHigh.menuLoaded && gHigh.ground.menu.length === 2);
  assert("cart-less conv (no shop/menu) → confidence='low'", gLow.confidence === "low", `shopId=${gLow.shopId} menuLoaded=${gLow.menuLoaded}`);
  assert("low case has no menu ground truth", gLow.ground.menu.length === 0);
}

// ── (B) Selection order: cart-bearing before cart-less, within cap ────────────
// NOTE: MAX_CONVERSATIONS_PER_SWEEP is read once at module load (a const), so we
// cannot shrink it at runtime here. We instead prove the two guarantees that
// matter and are cap-independent:
//   (1) PARTITION: every cart-bearing conv sorts strictly before every cart-less
//       conv in the selection — even though cart-less convs are OLDER (and would
//       lead under the old oldest-first-only ordering).
//   (2) CAP TRUNCATION: with a batch LARGER than the cap, the cap still bounds
//       the result, and the truncation falls on the cart-less tail (cart-bearing
//       are never dropped in favor of cart-less).
console.log("\n--- (B) SELECTION ORDER (cart-bearing first; cap unchanged) ---");
{
  const CAP = 50; // module default MAX_CONVERSATIONS_PER_SWEEP
  const tables = baseTables();
  // 40 cart-less convs (OLDER) + 20 cart-bearing convs (NEWER) = 60 > CAP.
  // Old oldest-first ordering would put cart-less first and fill the cap with
  // them, starving cart-bearing. New ordering must lead with all 20 cart-bearing.
  const cartless: string[] = [];
  for (let i = 0; i < 40; i++) {
    const id = `cccccccc-0000-0000-0000-${String(i).padStart(12, "0")}`;
    cartless.push(id);
    tables.conversations.push({ id, tenant_id: TENANT, last_message_at: new Date(Date.now() - (300 - i) * 60_000).toISOString() });
  }
  const cartbearing: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = `dddddddd-0000-0000-0000-${String(i).padStart(12, "0")}`;
    cartbearing.push(id);
    tables.conversations.push({ id, tenant_id: TENANT, last_message_at: new Date(Date.now() - (60 - i) * 60_000).toISOString() });
    tables.order_carts.push({ conversation_id: id, shop_id: SHOP, phase: "open", payment_status: null, stripe_checkout_session_id: null, created_at: old });
  }

  const client = makeClient(tables);
  const selected = await selectCandidates(client);
  const selectedIds = selected.map((c) => c.id);

  assert("cap respected (<= 50)", selected.length <= CAP, `got ${selected.length}`);
  assert("selected exactly the cap (60 candidates > cap)", selected.length === CAP, `got ${selected.length}`);

  const cbSet = new Set(cartbearing);
  const clSet = new Set(cartless);
  // partition: index of last cart-bearing < index of first cart-less
  const lastCb = Math.max(...selectedIds.map((id, i) => (cbSet.has(id) ? i : -1)));
  const firstCl = Math.min(...selectedIds.map((id, i) => (clSet.has(id) ? i : Number.MAX_SAFE_INTEGER)));
  assert("PARTITION: every cart-bearing precedes every cart-less", lastCb < firstCl, `lastCb=${lastCb} firstCl=${firstCl}`);

  const cbSelected = selectedIds.filter((id) => cbSet.has(id)).length;
  const clSelected = selectedIds.filter((id) => clSet.has(id)).length;
  assert("all 20 cart-bearing selected (none dropped by cap)", cbSelected === 20, `cb=${cbSelected}`);
  assert("cart-less NOT skipped entirely (fills remaining cap)", clSelected === CAP - 20, `cl=${clSelected}`);
  assert("cap truncation falls on cart-less tail only", cbSelected + clSelected === CAP);

  // determinism: run again, identical order
  const again = (await selectCandidates(makeClient(tables))).map((c) => c.id);
  assert("selection is deterministic (stable across runs)", JSON.stringify(again) === JSON.stringify(selectedIds));
}

// ── (C) No suppression: real invented_item on real menu → CRITICAL + high ─────
console.log("\n--- (C) NO SUPPRESSION (real invented_item stays CRITICAL/high) ---");
{
  const tables = baseTables();
  const conv = "eeeeeeee-0000-0000-0000-000000000001";
  tables.conversations.push({ id: conv, tenant_id: TENANT, last_message_at: old });
  tables.order_carts.push({ conversation_id: conv, shop_id: SHOP, phase: "open", payment_status: null, stripe_checkout_session_id: null, created_at: old });
  tables.messages.push(
    { id: "c1", conversation_id: conv, role: "customer", content: "do you have buffalo wings?", created_at: old },
    { id: "a1", conversation_id: conv, role: "assistant", content: "Yes! Buffalo Wings are $11.00. Added 10.", created_at: old },
  );

  const client = makeClient(tables);
  const report = await runSweep(client);
  const stored = tables.conversation_evals.find((r) => r.conversation_id === conv);

  assert("eval was stored", !!stored);
  if (stored) {
    assert("verdict flagged (not hidden)", stored.verdict === "flagged", String(stored.verdict));
    assert("max_severity CRITICAL (not downgraded)", stored.max_severity === "critical", String(stored.max_severity));
    const flags = stored.flags as Array<{ check: string; severity: string }>;
    assert("invented_item flag present", flags.some((f) => f.check === "invented_item" && f.severity === "critical"));
    assert("confidence='high' (real menu ground truth)", stored.confidence === "high", String(stored.confidence));
    assert("shop_id persisted on eval", stored.shop_id === SHOP, String(stored.shop_id));
  }
  console.log(`  sweep report: judged=${report.judged} flagged=${report.flagged} clean=${report.clean} errored=${report.errored}`);
}

// ── (A2) Also prove a low-confidence eval is STORED with confidence='low' via runSweep ──
console.log("\n--- (A2) STORED confidence='low' for cart-less conv via runSweep ---");
{
  const tables = baseTables();
  const TENANT2 = "99999999-9999-9999-9999-999999999999";
  tables.tenants.push({ id: TENANT2, name: "Ghost tenant (no shop)" });
  const conv = "ffffffff-0000-0000-0000-000000000001";
  tables.conversations.push({ id: conv, tenant_id: TENANT2, last_message_at: old });
  tables.messages.push(
    { id: "c1", conversation_id: conv, role: "customer", content: "hi", created_at: old },
    { id: "a1", conversation_id: conv, role: "assistant", content: "Hello!", created_at: old },
  );
  const client = makeClient(tables);
  await runSweep(client);
  const stored = tables.conversation_evals.find((r) => r.conversation_id === conv);
  assert("cart-less eval stored with confidence='low'", !!stored && stored.confidence === "low", String(stored?.confidence));
  assert("cart-less eval shop_id null", !!stored && stored.shop_id === null, String(stored?.shop_id));
}

console.log(`\n=== OVERALL: ${pass ? "ALL PASS" : "SOME FAIL"} ===`);
// index.ts runs Deno.serve() at import (it is an edge-function entrypoint),
// which keeps the event loop alive. Exit explicitly so the proof terminates.
Deno.exit(pass ? 0 : 1);
