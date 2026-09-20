// runner.test.ts — the I/O shell against an in-memory Supabase fake. Proves the
// loads, the writes, the checkout create on handoff and the expire on reopen.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runEngineTurn, type RunnerDeps, type RunnerInput } from "../runner.ts";
import { IDS, RAW_ITEMS, RAW_LEXICON } from "./fixture-menu.ts";
import type { Move } from "../form.ts";

type Row = Record<string, unknown>;
class FakeDb {
  writes: Array<{ table: string; op: string; payload: unknown }> = [];
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

function deps(db: FakeDb, fakeInterpret: (msg: string) => Move[]): RunnerDeps & { created: unknown[]; expired: string[] } {
  const created: unknown[] = []; const expired: string[] = [];
  return {
    // deno-lint-ignore no-explicit-any
    supabase: db as any,
    model: { provider: "anthropic", model: "fake", apiKey: "x" },
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
