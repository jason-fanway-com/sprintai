// runner.test.ts — the I/O shell against an in-memory Supabase fake. Proves the
// loads, the writes, the checkout create on handoff and the expire on reopen.
import { faithfulRewrite } from "../normalize.ts";
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

function deps(db: FakeDb, fakeInterpret: (msg: string) => Move[], fakeJudge?: (asks: Array<{ span: string }>) => Record<string, number> | null, fakeVoice?: (draft: string) => string): RunnerDeps & { created: unknown[]; expired: string[] } {
  const created: unknown[] = []; const expired: string[] = [];
  return {
    // deno-lint-ignore no-explicit-any
    supabase: db as any,
    model: { provider: fakeJudge || fakeVoice ? "openrouter" : "anthropic", model: "fake", apiKey: "x" },
    // deno-lint-ignore no-explicit-any
    ...(fakeVoice ? { voiceImpl: ((inp: { draft: string }) => { const text = fakeVoice(inp.draft), why = faithfulRewrite(inp.draft, text); return Promise.resolve(why ? { ok: false as const, reason: "unfaithful" as const, detail: why, ms: 1 } : { ok: true as const, text, ms: 1 }); }) as any } : {}),
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
  assertEquals(out.form.checkout_session_id, "cs_test_1"); // a change after the link: the old session expired and a fresh one created in the same turn (2026-09-26)
  assertStringIncludes(out.reply, "Cheesesteak");
  assertStringIncludes(out.reply, "earlier link won't work anymore. Pay here: https://pay.example/o/abc");
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

Deno.test("runner: after the pay link a remark gets the remark and asking for the link re-sends the same link, never 'couldn't create your payment link'", async () => {
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
  assertEquals(out.reply, "Thanks, see you soon."); // pass 11: 38 of 40 conversations re-sent the pay sentence after a thank-you, a wasted segment each
  out = await runEngineTurn({ ...base, cart: { ...cart, engine_form: out.form }, message: "send the link again", isFirstContact: false }, d);
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

Deno.test("runner: the voice rewrites a short reply when it keeps every fact, and the draft goes out when it does not", async () => {
  const say = async (rewrite: (d: string) => string) => {
    const db = new FakeDb(); const d = deps(db, (m) => m === "garlic knots" ? [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }] : [], undefined, rewrite);
    const base = { shop, conversationId: "c1", lastBotMessage: null, cart: { id: "cart1", engine_form: null, stripe_checkout_session_id: null, test_mode: true, notes: null } } as Parameters<typeof runEngineTurn>[0];
    let out = await runEngineTurn({ ...base, message: "pickup" }, d);
    out = await runEngineTurn({ ...base, message: "garlic knots", cart: { ...base.cart, engine_form: out.form } }, d);
    return out.reply;
  };
  assertEquals(await say((d) => d.replace("Added 1 x Garlic Knots (6). Anything else?", "One order of Garlic Knots (6), got it. Anything else?")), "One order of Garlic Knots (6), got it. Anything else?");
  const draft = await say((d) => d); // an identical rewrite passes too
  assertStringIncludes(draft, "Garlic Knots (6)");
  assertEquals(await say((d) => d.replace("Anything else?", "Anything else? Your total is $6.34.")), draft); // an invented number: the draft
  assertEquals(await say((d) => "Sure thing! Anything else?"), draft); // the item name dropped: the draft
  assertEquals(await say((d) => d.replace("Anything else?", "Want fries with that?")), draft); // a menu item the draft never named, lowercase: the draft
});

Deno.test("runner: a change after the pay link expires the old session, creates a new one, and the reply carries the new link with the updated order", async () => {
  const db = new FakeDb(); const d = deps(db, (m) => m === "garlic knots" ? [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }] : m.includes("cheesesteak") ? [{ kind: "add_line", item_span: "cheesesteak", qty: 1, option_spans: [] }] : []);
  const base = { shop, conversationId: "c1", lastBotMessage: null, cart: { id: "cart1", engine_form: null, stripe_checkout_session_id: null, test_mode: true, notes: null } } as Parameters<typeof runEngineTurn>[0];
  let out = await runEngineTurn({ ...base, message: "pickup" }, d);
  for (const m of ["garlic knots", "thats it", "yes"]) out = await runEngineTurn({ ...base, message: m, cart: { ...base.cart, engine_form: out.form, stripe_checkout_session_id: out.form.checkout_session_id } }, d);
  assertStringIncludes(out.reply, "https://pay.example/o/abc");
  out = await runEngineTurn({ ...base, message: "wait add a cheesesteak too", cart: { ...base.cart, engine_form: out.form, stripe_checkout_session_id: out.form.checkout_session_id } }, d);
  assertEquals(d.expired, ["cs_test_1"]);
  assertEquals(d.created.length, 2);
  assertStringIncludes(out.reply, "Total is now");
  assertStringIncludes(out.reply, "earlier link won't work anymore. Pay here: https://pay.example/o/abc");
  assertEquals(out.form.status, "awaiting_payment");
});


// ─── courier delivery (Uber Direct / DoorDash Drive): the quote is the delivery fee ───────────────
const courierShop = { ...shop, id: "vitos-courier", delivery_fee_cents: 300, delivery_provider: "uber" }; // own ids: the menu cache is per shop and holds the flat fee
const courierMoves = (m: string): Move[] =>
  m === "delivery" ? [{ kind: "answer", field: "fulfillment", value: "delivery" }]
  : /main st/.test(m) ? [{ kind: "answer", field: "address", value: { text: m, formatted: null, validated: false, zone_ok: false } }]
  : m === "garlic knots" ? [{ kind: "add_line", item_span: "garlic knots", qty: 1, option_spans: [] }] : [];
async function courierOrder(fees: Array<number | "refuse">, script = ["delivery", "12 main st", "garlic knots", "thats it", "no tip", "yes"]) {
  const db = new FakeDb(); const d = deps(db, courierMoves);
  const quotes: Array<{ formatted: string; test: boolean }> = [];
  d.quoteDelivery = (req) => {
    quotes.push({ formatted: req.formatted, test: req.test });
    const f = fees[Math.min(quotes.length - 1, fees.length - 1)];
    return Promise.resolve(f === "refuse" ? { ok: false as const, code: "out_of_range" as const, error: "too far" } : { ok: true as const, fee_cents: f, quote_id: `q${quotes.length}` });
  };
  const base = { shop: courierShop, conversationId: "c1", lastBotMessage: null, isFirstContact: false, cart: { id: "cart1", engine_form: null, stripe_checkout_session_id: null, test_mode: true, notes: null } } as Parameters<typeof runEngineTurn>[0];
  const replies: string[] = [];
  let out = await runEngineTurn({ ...base, message: script[0] }, d); replies.push(out.reply);
  for (const m of script.slice(1)) { out = await runEngineTurn({ ...base, message: m, cart: { ...base.cart, engine_form: out.form, stripe_checkout_session_id: out.form.checkout_session_id } }, d); replies.push(out.reply); }
  return { out, replies, quotes, created: d.created as Array<{ deliveryFeeCents: number; orderType: string }> };
}

Deno.test("runner: a courier shop prices the address with a quote, reads it back, and re-quotes before the link", async () => {
  const r = await courierOrder([725, 725]);
  assertEquals(r.quotes.length, 2, "once at the address, once before the link");
  assertEquals(r.quotes[0], { formatted: "12 main st, Allentown, PA", test: true });
  assert(r.replies.some((x) => x.includes("Delivery $7.25")), r.replies.join("\n---\n"));
  assertEquals(r.created.map((c) => [c.orderType, c.deliveryFeeCents]), [["delivery", 725]]);
  assertEquals(r.out.form.address?.delivery_quote_id, "q2");
  assertStringIncludes(r.replies.at(-1)!, "https://pay.example/o/abc");
  assertStringIncludes(r.replies.at(-1)!, "I'll Uber it to you"); // an Uber shop says so with the link
});

Deno.test("runner: a courier fee that moved before the link goes out with the new total", async () => {
  const r = await courierOrder([725, 890]);
  assertEquals(r.created.map((c) => c.deliveryFeeCents), [890]);
  assertStringIncludes(r.replies.at(-1)!, "Total is now");
  assertStringIncludes(r.replies.at(-1)!, "https://pay.example/o/abc");
});

Deno.test("runner: a courier that will not go to the address is the outside-the-area decline", async () => {
  const r = await courierOrder(["refuse"], ["delivery", "12 main st"]);
  assertEquals(r.out.form.address?.zone_ok, false);
  assertEquals(r.out.form.address?.delivery_quote_cents, undefined);
  assertStringIncludes(r.replies.at(-1)!, "outside");
});

Deno.test("runner: a courier that refuses at the link step does not send a link", async () => {
  const r = await courierOrder([725, "refuse"]);
  assertEquals(r.created.length, 0);
  assertEquals(r.out.form.checkout_session_id, null);
  assertEquals(r.out.form.confirmed, false);
});

Deno.test("runner: an own-driver shop never asks for a quote and keeps its flat fee", async () => {
  const db = new FakeDb(); const d = deps(db, courierMoves);
  let asked = 0; d.quoteDelivery = () => { asked++; return Promise.resolve({ ok: true as const, fee_cents: 1, quote_id: "x" }); };
  const base = { shop: { ...courierShop, id: "vitos-own", delivery_provider: "own" }, conversationId: "c1", lastBotMessage: null, isFirstContact: false, cart: { id: "cart1", engine_form: null, stripe_checkout_session_id: null, test_mode: true, notes: null } } as Parameters<typeof runEngineTurn>[0];
  let out = await runEngineTurn({ ...base, message: "delivery" }, d);
  for (const m of ["12 main st", "garlic knots", "thats it", "no tip", "yes"]) out = await runEngineTurn({ ...base, message: m, cart: { ...base.cart, engine_form: out.form, stripe_checkout_session_id: out.form.checkout_session_id } }, d);
  assertEquals(asked, 0);
  assertEquals((d.created as Array<{ deliveryFeeCents: number }>).map((c) => c.deliveryFeeCents), [300]);
  assertStringIncludes(out.reply, "On its way about 30-45 min");
  assert(!out.reply.includes("Uber"), out.reply);
});
