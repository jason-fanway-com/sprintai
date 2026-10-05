// Tests for _shared/delivery-paid.ts: which paid carts book a courier, and what the courier is told.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { bookCourierForPaidCart } from "./delivery-paid.ts";
import { makeFakeProvider } from "./delivery-fake.ts";
import { memDb } from "./delivery-testdb.ts";
import type { CreateRequest } from "./delivery.ts";

function seed(over: { cart?: Record<string, unknown>; shop?: Record<string, unknown> } = {}) {
  const db = memDb();
  db.tables("shops").push({ id: "shop_1", tenant_id: "ten_1", name: "Vito's", formatted_address: "5620 Cetronia Rd, Allentown, PA 18106, USA", latitude: 40.58, longitude: -75.56, phone_number_e164: "+14845550100", courier_pickup_phone: null, courier_pickup_notes: "counter", delivery_provider: "uber", prep_minutes: 25, ...over.shop });
  db.tables("conversations").push({ id: "conv_1", customer_phone: "+14845550199" });
  db.tables("order_carts").push({ id: "cart_1", shop_id: "shop_1", conversation_id: "conv_1", order_type: "delivery", test_mode: true, delivery_address: { formatted: "1200 Hamilton St, Allentown, PA 18102, USA" }, cart_json: [{ name: "Large Cheese Pizza", quantity: 2, price_cents: 1500 }, { type: "bundle", name: "Wing Party" }], subtotal_cents: 4200, driver_tip_cents: 400, pickup_name: "Pat", order_number: 17, ...over.cart });
  return db;
}
const NOW = new Date("2026-09-29T16:00:00Z");

Deno.test("paid delivery cart at an Uber shop: books a courier with the shop, the customer, the items and the full tip", async () => {
  const db = seed();
  const p = makeFakeProvider({ fee_cents: 725 });
  const seen: Array<[string, boolean]> = [];
  const r = await bookCourierForPaidCart(db.client, "cart_1", (n, t) => { seen.push([n, t]); return p; }, NOW);
  assertEquals(r, { booked: true, delivery_id: "fd_2", tracking_url: "https://track.example/fd_2", fee_cents: 725, already: false });
  assertEquals(seen, [["uber", true]], "test-mode cart uses sandbox credentials");
  const req = p.calls.find((c) => c.op === "create")!.req as CreateRequest;
  assertEquals([req.pickup.phone, req.pickup.notes, req.dropoff.name, req.dropoff.phone, req.tip_cents, req.order_value_cents, req.pickup_ready_at],
    ["+14845550100", "counter", "Pat", "+14845550199", 400, 4200, "2026-09-29T16:25:00.000Z"]);
  assertEquals(req.items, [{ name: "Large Cheese Pizza", qty: 2 }, { name: "Wing Party", qty: 1 }]);
  assertEquals(db.tables("order_carts")[0].delivery_status, "created");
});

Deno.test("pickup orders and own-driver shops never book", async () => {
  const none = () => { throw new Error("must not be asked for a provider"); };
  assertEquals(await bookCourierForPaidCart(seed({ cart: { order_type: "pickup" } }).client, "cart_1", none, NOW), { booked: false, reason: "not_delivery" });
  assertEquals(await bookCourierForPaidCart(seed({ shop: { delivery_provider: "own" } }).client, "cart_1", none, NOW), { booked: false, reason: "own_driver" });
});

Deno.test("missing credentials or a failed booking raise a sev_1 issue instead of throwing", async () => {
  const a = seed();
  const r1 = await bookCourierForPaidCart(a.client, "cart_1", () => null, NOW);
  assert(!r1.booked && r1.reason === "no_credentials");
  assertEquals(a.tables("issues").map((i) => [i.detection_rule, i.severity]), [["courier_not_booked", "sev_1"]]);
  const b = seed();
  const r2 = await bookCourierForPaidCart(b.client, "cart_1", () => makeFakeProvider({ quoteError: { error: "too far", code: "out_of_range" } }), NOW);
  assert(!r2.booked && r2.reason === "failed");
  assert(String(b.tables("issues")[0].description).includes("out_of_range"));
});

Deno.test("courier_pickup_phone wins over the shop's number; a replayed payment is not booked twice", async () => {
  const db = seed({ shop: { courier_pickup_phone: "+14845550111" } });
  const p = makeFakeProvider();
  await bookCourierForPaidCart(db.client, "cart_1", () => p, NOW);
  const again = await bookCourierForPaidCart(db.client, "cart_1", () => p, NOW);
  assert(again.booked && again.already);
  assertEquals(p.calls.filter((c) => c.op === "create").length, 1);
  assertEquals((p.calls.find((c) => c.op === "create")!.req as CreateRequest).pickup.phone, "+14845550111");
});

Deno.test("a web test conversation (no phone) books with the shop's number as the drop-off phone; a live one without a phone raises an issue", async () => {
  const db = seed(); db.tables("conversations")[0].customer_phone = "web:6f1c";
  const p = makeFakeProvider();
  const r = await bookCourierForPaidCart(db.client, "cart_1", () => p, NOW);
  assert(r.booked);
  assertEquals((p.calls.find((c) => c.op === "create")!.req as CreateRequest).dropoff.phone, "+14845550100");
  const live = seed({ cart: { test_mode: false } }); live.tables("conversations")[0].customer_phone = "web:6f1c";
  const r2 = await bookCourierForPaidCart(live.client, "cart_1", () => makeFakeProvider(), NOW);
  assert(!r2.booked);
  assertEquals(live.tables("issues").length, 1);
});

Deno.test("a test shop books with sandbox credentials even when the cart is not marked test", async () => {
  const live = seed({ cart: { test_mode: false } });
  const seenLive: boolean[] = [];
  await bookCourierForPaidCart(live.client, "cart_1", (_n, t) => { seenLive.push(t); return makeFakeProvider({ fee_cents: 725 }); }, NOW);
  assertEquals(seenLive, [false], "a real shop's live cart uses live credentials");
  const vitos = seed({ cart: { test_mode: false }, shop: { is_test: true } });
  const seen: boolean[] = [];
  await bookCourierForPaidCart(vitos.client, "cart_1", (_n, t) => { seen.push(t); return makeFakeProvider({ fee_cents: 725 }); }, NOW);
  assertEquals(seen, [true], "is_test forces the sandbox: a test shop can never send a real driver");
});

Deno.test("an order books the courier it was quoted with, not the shop's setting at payment time", async () => {
  const quotedOwn = seed({ cart: { delivery_address: { formatted: "1200 Hamilton St, Allentown, PA 18102, USA", courier: "own" } } }); // shop is uber now
  const r1 = await bookCourierForPaidCart(quotedOwn.client, "cart_1", () => makeFakeProvider({ fee_cents: 725 }), NOW);
  assertEquals(r1, { booked: false, reason: "own_driver" });
  const quotedUber = seed({ cart: { delivery_address: { formatted: "1200 Hamilton St, Allentown, PA 18102, USA", courier: "uber" } }, shop: { delivery_provider: "own" } });
  const seen: string[] = [];
  const r2 = await bookCourierForPaidCart(quotedUber.client, "cart_1", (n) => { seen.push(n); return makeFakeProvider({ fee_cents: 725 }); }, NOW);
  assert(r2.booked, JSON.stringify(r2)); assertEquals(seen, ["uber"]);
});
