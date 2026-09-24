// runner.test.ts — the I/O shell against an in-memory Supabase fake. Proves the
// loads, the writes, the checkout create on handoff and the expire on reopen.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runEngineTurn, type RunnerDeps, type RunnerInput } from "../runner.ts";
import { IDS, RAW_ITEMS, RAW_LEXICON } from "./fixture-menu.ts";
import type { Move } from "../form.ts";
import { JUDGE } from "../turn.ts";

type Row = Record<string, unknown>;
class FakeDb {
  writes: Array<{ table: string; op: string; payload: unknown }> = [];
  reads: Array<{ table: string; paged: boolean }> = [];
  tables: Record<string, Row[]> = {
    menus: [{ id: "m1" }],
    menu_items: RAW_ITEMS.map((r) => ({ ...r })),
    option_groups: [
      { id: IDS.tempGroup, menu_item_id: IDS.cheeseburger, name: "Temperature", max_select: 1 },
      { id: IDS.tempGroup, menu_item_id: IDS.baconCheeseburger, name: "Temperature", max_select: 1 },
      { id: IDS.dressingGroup, menu_item_id: IDS.houseSalad, name: "Dressing", max_select: 1 },
      { id: IDS.saladAddons, menu_item_id: IDS.houseSalad, name: "Add-ons", max_select: 5 },
      { id: IDS.sizeFriesGroup, menu_item_id: IDS.fries, name: "Size", max_select: 1 },
    ],
    lexicon: RAW_LEXICON.map((l) => ({ ...l, menu_id: "m1" })),
  };
  from(table: string) {
    const db = this;
    const state = { op: "select", payload: null as unknown, single: false };
    const q: Record<string, unknown> = {};
    const chain = () => q;
    Object.assign(q, {
      select: () => { if (state.op === "select") state.op = "select"; return q; },
      eq: chain, or: chain, order: chain, limit: chain, in: chain, not: chain,
      range: (a: number, b: number) => { state.payload = { a, b }; return q; },
      maybeSingle: () => { state.single = true; return q; },
      single: () => { state.single = true; return q; },
      update: (p: unknown) => { state.op = "update"; state.payload = p; return q; },
      insert: (p: unknown) => { state.op = "insert"; state.payload = p; return q; },
      then: (res: (v: { data: unknown; error: null }) => unknown, _rej?: unknown) => {
        if (state.op === "select") {
          let rows = db.tables[table] ?? [];
          const r = state.payload as { a: number; b: number } | null;
          db.reads.push({ table, paged: !!r });
          if (r) rows = rows.slice(r.a, r.b + 1);
          return Promise.resolve(res({ data: state.single ? (rows[0] ?? null) : rows, error: null }));
        }
        db.writes.push({ table, op: state.op, payload: state.payload });
        if (state.op === "insert" && table === "messages") return Promise.resolve(res({ data: { id: "msg-1" }, error: null }));
        return Promise.resolve(res({ data: null, error: null }));
      },
    });
    return q;
  }
}

const shop = { id: "vitos", tenant_id: "t1", name: "Vito's Pizza", delivery_enabled: true, delivery_fee_cents: 0, tax_rate_bps: 600, phone_number_e164: "+16105550100", latitude: 40.57, longitude: -75.57, delivery_radius_mi: 5 };

function deps(db: FakeDb, fakeInterpret: (msg: string) => Move[], fakeJudge?: (asks: Array<{ span: string }>) => Record<string, number> | null): RunnerDeps & { created: unknown[]; expired: string[] } {
  const created: unknown[] = []; const expired: string[] = [];
  return {
    // deno-lint-ignore no-explicit-any
    supabase: db as any,
    model: { provider: fakeJudge ? "openrouter" : "anthropic", model: "fake", apiKey: "x" },
    ...(fakeJudge ? { judgeImpl: ((ctx: { asks: Array<{ span: string }> }) => { const p = fakeJudge(ctx.asks); return Promise.resolve(p ? { ok: true as const, p, ms: 1, cost: 0 } : { ok: false as const, reason: "timeout" as const, detail: "fake", ms: 1500 }); }) as any } : {}),
    geocoder: (text: string) => Promise.resolve({ text, formatted: text + ", Allentown, PA", validated: true, zone_ok: true }),
    createCheckout: (req) => { created.push(req); return Promise.resolve({ ok: true as const, sessionId: "cs_test_1", url: "https://pay.example/o/abc" }); },
    expireCheckout: (id) => { expired.push(id); return Promise.resolve(); },
    serviceFeeCents: 99,
    // deno-lint-ignore no-explicit-any
    interpretImpl: ((ctx: { message: string }) => Promise.resolve({ ok: true as const, moves: fakeInterpret(ctx.message), raw: null, ms: 1 })) as any,
    created, expired,
  };
}

Deno.test("runner: canary through the shell, tax and fee in the checkout request, expire on reopen", async () => {
  const db = new FakeDb();
  const d = deps(db, (msg) => msg.includes("cheesesteak")
    ? [{ kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] }]
    : [{ kind: "add_line", item_span: "cheeseburger", qty: 1, option_spans: [] }]);
  let cart: RunnerInput["cart"] = { id: "cart-1", engine_form: null, test_mode: true, stripe_checkout_session_id: null, notes: null };
  const base = { shop, conversationId: "conv-1", lastBotMessage: null as string | null, isFirstContact: true };

  let out = await runEngineTurn({ ...base, cart, message: "pickup" }, d);
  assertStringIncludes(out.reply, "Hi, this is Vito's Pizza.");
  cart = { ...cart, engine_form: out.form };

  out = await runEngineTurn({ ...base, cart, message: "cheeseburger", isFirstContact: false }, d);
  assertStringIncludes(out.reply, "cooked");
  const upd1 = db.writes.filter((w) => w.table === "order_carts" && w.op === "update").pop()!.payload as Record<string, unknown>;
  assertEquals(upd1.cart_json, []);            // not priced until the slot is answered
  assertEquals(upd1.subtotal_cents, 0);
  cart = { ...cart, engine_form: out.form };

  out = await runEngineTurn({ ...base, cart, message: "medium", isFirstContact: false }, d);
  const upd2 = db.writes.filter((w) => w.table === "order_carts" && w.op === "update").pop()!.payload as Record<string, unknown>;
  assertEquals((upd2.cart_json as Array<{ price_cents: number; quantity: number; options?: Record<string, string[]> }>)[0].price_cents, 849);
  assertEquals((upd2.cart_json as Array<{ options?: Record<string, string[]> }>)[0].options, { Temperature: ["Medium"] });
  assertEquals(upd2.tax_cents, 51);
  assertEquals(upd2.total_cents, 849 + 99 + 51);
  cart = { ...cart, engine_form: out.form };

  out = await runEngineTurn({ ...base, cart, message: "thats it", isFirstContact: false }, d);
  assertStringIncludes(out.reply, "Reply YES");
  assertStringIncludes(out.reply, "Tax $0.51");
  cart = { ...cart, engine_form: out.form };

  out = await runEngineTurn({ ...base, cart, message: "yes", isFirstContact: false }, d);
  assertEquals(d.created.length, 1);
  const req = d.created[0] as { taxCents: number; tipCents: number; deliveryFeeCents: number; orderType: string; cartLines: unknown[] };
  assertEquals([req.taxCents, req.tipCents, req.deliveryFeeCents, req.orderType, req.cartLines.length], [51, 0, 0, "pickup", 1]);
  assertStringIncludes(out.reply, "https://pay.example/o/abc");
  assertEquals(out.form.checkout_session_id, "cs_test_1");
  assert(db.writes.some((w) => w.table === "messages" && w.op === "insert"));
  cart = { ...cart, engine_form: out.form, stripe_checkout_session_id: "cs_test_1" };

  out = await runEngineTurn({ ...base, cart, message: "add a cheesesteak", isFirstContact: false }, d);
  assertEquals(d.expired, ["cs_test_1"]);
  assertEquals(out.form.checkout_session_id, null);
  assertStringIncludes(out.reply, "Cheesesteak");
  assertStringIncludes(out.reply, "Reply YES");
});

Deno.test("runner: a failed model call becomes an honest re-ask, never a crash", async () => {
  const db = new FakeDb();
  const d = deps(db, () => []);
  // deno-lint-ignore no-explicit-any
  d.interpretImpl = (() => Promise.resolve({ ok: false as const, reason: "timeout" as const, detail: "slow", raw: null, ms: 15000 })) as any;
  const out = await runEngineTurn({ shop, conversationId: "c", cart: { id: "k", engine_form: null, test_mode: true, stripe_checkout_session_id: null }, message: "blah blah", lastBotMessage: null, isFirstContact: false }, d);
  assert(db.writes.some((w) => w.table === "error_log"));
  assertStringIncludes(out.reply, "Pickup or delivery?");
});

Deno.test("runner: a model answer with no items on a message naming items gets one retry", async () => {
  const db = new FakeDb();
  let calls = 0;
  const d = deps(db, () => []);
  // deno-lint-ignore no-explicit-any
  d.interpretImpl = ((_ctx: unknown) => { calls++; return Promise.resolve({ ok: true as const, raw: null, ms: 1, moves: calls === 1 ? [{ kind: "answer", field: "fulfillment", value: "delivery" } as Move] : [{ kind: "answer", field: "fulfillment", value: "delivery" } as Move, { kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] } as Move] }); }) as any;
  const out = await runEngineTurn({ shop, conversationId: "c", cart: { id: "k", engine_form: null, test_mode: true, stripe_checkout_session_id: null }, message: "delivery and garlic knots", lastBotMessage: null, isFirstContact: false }, d);
  assertEquals(calls, 2);
  assertEquals(out.form.lines.length, 1);
  assertStringIncludes(out.reply, "Garlic Knots");
});

Deno.test("runner: a failed checkout reopens the confirm step instead of pretending a link is coming", async () => {
  const db = new FakeDb();
  const d = deps(db, () => [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  d.createCheckout = () => Promise.resolve({ ok: false as const, error: "boom" });
  let cart: RunnerInput["cart"] = { id: "c1", engine_form: null, test_mode: true, stripe_checkout_session_id: null };
  const base = { shop, conversationId: "conv", lastBotMessage: null as string | null, isFirstContact: false };
  let out = await runEngineTurn({ ...base, cart, message: "pickup" }, d); cart = { ...cart, engine_form: out.form };
  out = await runEngineTurn({ ...base, cart, message: "garlic knots" }, d); cart = { ...cart, engine_form: out.form };
  out = await runEngineTurn({ ...base, cart, message: "thats it" }, d); cart = { ...cart, engine_form: out.form };
  out = await runEngineTurn({ ...base, cart, message: "yes" }, d);
  assertStringIncludes(out.reply, "Reply YES to try again");
  assertEquals(out.form.status, "confirming");
  assertEquals(out.form.confirmed, false);
});

Deno.test("runner: the judge drops a pointless omission question; a failed judge leaves today's question", async () => {
  const was = JUDGE.enabled; JUDGE.enabled = true; // the switch is off in production; the seam still has to work
  try {
  const onlyPizzas = (msg: string): Move[] => msg.includes("pepperoni") ? [{ kind: "add_line", item_span: "pepperoni pizza", qty: 2, option_spans: ["large"] }] : msg === "pickup" ? [] : [];
  const msg = "2 large pepperoni pizzas and an order of garlic knots";
  const run = async (judge: ((asks: Array<{ span: string }>) => Record<string, number> | null) | undefined) => {
    const db = new FakeDb(); const d = deps(db, onlyPizzas, judge);
    const base = { shop, conversationId: "conv-j", lastBotMessage: null as string | null, isFirstContact: true };
    const cart: RunnerInput["cart"] = { id: "cart-j", engine_form: null, test_mode: true, stripe_checkout_session_id: null, notes: null };
    let out = await runEngineTurn({ ...base, cart, message: "pickup" }, d);
    out = await runEngineTurn({ ...base, cart: { ...cart, engine_form: out.form }, message: msg, isFirstContact: false }, d);
    return out;
  };
  const dropped = await run((asks) => Object.fromEntries(asks.map((a) => [a.span, 0.05])));
  assert(!dropped.reply.includes("Did you also want"), dropped.reply);
  assertEquals(dropped.form.omissions, []);
  const kept = await run((asks) => Object.fromEntries(asks.map((a) => [a.span, 0.95])));
  assertStringIncludes(kept.reply, "Did you also want garlic knots");
  const failed = await run(() => null);
  assertStringIncludes(failed.reply, "Did you also want garlic knots");
  const none = await run(undefined);
  assertStringIncludes(none.reply, "Did you also want garlic knots");
  JUDGE.enabled = false;
  const off = await run((asks) => Object.fromEntries(asks.map((a) => [a.span, 0.05])));
  assertStringIncludes(off.reply, "Did you also want garlic knots"); // switched off: no call, today's question
  } finally { JUDGE.enabled = was; }
});

Deno.test("runner: a message after the pay link re-sends the same link, never 'couldn't create your payment link'", async () => {
  const db = new FakeDb(); const d = deps(db, () => [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  const base = { shop, conversationId: "conv-l", lastBotMessage: null as string | null, isFirstContact: true };
  let cart: RunnerInput["cart"] = { id: "cart-l", engine_form: null, test_mode: true, stripe_checkout_session_id: null, notes: null };
  let out = await runEngineTurn({ ...base, cart, message: "pickup" }, d);
  out = await runEngineTurn({ ...base, cart: { ...cart, engine_form: out.form }, message: "garlic knots", isFirstContact: false }, d);
  out = await runEngineTurn({ ...base, cart: { ...cart, engine_form: out.form }, message: "thats it", isFirstContact: false }, d);
  out = await runEngineTurn({ ...base, cart: { ...cart, engine_form: out.form }, message: "yes", isFirstContact: false }, d);
  assertStringIncludes(out.reply, "Pay here: https://pay.example/o/abc");
  assertEquals(out.form.checkout_url, "https://pay.example/o/abc");
  cart = { ...cart, engine_form: out.form, stripe_checkout_session_id: "cs_test_1" };
  d.interpretImpl = (() => Promise.resolve({ ok: true as const, moves: [{ kind: "talk", text: "Thanks, see you soon." }], raw: null, ms: 1 })) as any;
  out = await runEngineTurn({ ...base, cart, message: "thanks, coming now", isFirstContact: false }, d);
  assert(!out.reply.includes("couldn't create"), out.reply);
  assertStringIncludes(out.reply, "Pay here: https://pay.example/o/abc");
});

Deno.test("runner: the menu is downloaded once per version, not once per message", async () => {
  const db = new FakeDb(); const d = deps(db, () => [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }]);
  const base = { shop: { ...shop, id: "vitos-egress" }, conversationId: "conv-e", lastBotMessage: null as string | null, isFirstContact: true };
  const cart: RunnerInput["cart"] = { id: "cart-e", engine_form: null, test_mode: true, stripe_checkout_session_id: null, notes: null };
  let out = await runEngineTurn({ ...base, cart, message: "pickup" }, d);
  out = await runEngineTurn({ ...base, cart: { ...cart, engine_form: out.form }, message: "garlic knots", isFirstContact: false }, d);
  out = await runEngineTurn({ ...base, cart: { ...cart, engine_form: out.form }, message: "thats it", isFirstContact: false }, d);
  const full = db.reads.filter((r) => r.paged);
  assertEquals(full.filter((r) => r.table === "menu_items").length, 1, "menu items downloaded once");
  assertEquals(full.filter((r) => r.table === "lexicon").length, 1, "lexicon downloaded once");
  assertEquals(db.reads.filter((r) => r.table === "lexicon" && !r.paged).length, 3, "one tiny version probe per message");
  // a menu change (newer lexicon row) triggers exactly one more download
  db.tables.lexicon.unshift({ term: "zzz", target_type: "item", target_id: IDS.knots, menu_id: "m1", created_at: "2099-01-01T00:00:00Z" });
  await runEngineTurn({ ...base, cart: { ...cart, engine_form: out.form }, message: "yes", isFirstContact: false }, d);
  assertEquals(db.reads.filter((r) => r.paged && r.table === "lexicon").length, 2, "reloaded once after the change");
});
