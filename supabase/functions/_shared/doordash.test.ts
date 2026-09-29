import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  doordashJwt,
  makeDoorDashProvider,
  mapDeliveryStatus,
  mapEventName,
  mapQuoteError,
} from "./doordash.ts";
import { FAKE_WEBHOOK_SECRET, makeFakeDoorDash } from "./doordash-fake.ts";
import { type DeliveryQuote, isForward, isQuoteError, type Place } from "./delivery.ts";

const FIX = new URL("./fixtures/doordash/", import.meta.url);
const fixture = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(name, FIX)));

const T0 = Date.parse("2026-09-29T19:00:00Z");
const VITOS: Place = {
  name: "Vito's Pizza",
  address: "1 Main St, Allentown, PA 18104",
  lat: null,
  lng: null,
  phone: "+16105550100",
  notes: "Pickup at the front counter",
};
const CUSTOMER: Place = {
  name: "Pat",
  address: "5620 Cetronia Rd, Allentown, PA 18106",
  lat: 40.6,
  lng: -75.55,
  phone: "+16105550199",
  notes: null,
};

/** a stub DoorDash that answers each call from a queue of [status, fixture] */
function stub(replies: Array<[number, unknown]>, now = () => T0) {
  const calls: Array<{ method: string; path: string; body: any; auth: string }> = [];
  const fetchImpl = (input: string, init: RequestInit = {}) => {
    const u = new URL(input);
    calls.push({
      method: init.method ?? "GET",
      path: u.pathname,
      body: init.body ? JSON.parse(String(init.body)) : null,
      auth: new Headers(init.headers).get("authorization") ?? "",
    });
    const [status, body] = replies.shift() ?? [500, { message: "no stub reply" }];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  const fake = makeFakeDoorDash({ now });
  return { calls, provider: makeDoorDashProvider({ ...fake.cfg, now }, fetchImpl) };
}

function quoteFor(id: string, expiresAt: number): DeliveryQuote {
  return { provider: "doordash", quote_id: id, fee_cents: 700, expires_at: new Date(expiresAt).toISOString(), eta_min: 38, raw: null };
}

const createReq = (quote: DeliveryQuote) => ({
  quote,
  pickup: VITOS,
  dropoff: CUSTOMER,
  items: [{ name: "Large Cheese Pizza", qty: 1 }, { name: "Garlic Knots", qty: 2 }],
  tip_cents: 300,
  dropoff_notes: "Side door",
  pickup_ready_at: "2026-09-29T19:20:00Z",
  external_id: "cart-123",
  order_value_cents: 3250,
});

// --- JWT -------------------------------------------------------------------

Deno.test("jwt: HS256 with dd-ver header, DoorDash claims, verifies with the decoded secret", async () => {
  const { cfg } = makeFakeDoorDash();
  const jwt = await doordashJwt(cfg, T0);
  const [h, c, s] = jwt.split(".");
  const dec = (x: string) => JSON.parse(atob(x.replace(/-/g, "+").replace(/_/g, "/")));
  assertEquals(dec(h), { alg: "HS256", typ: "JWT", "dd-ver": "DD-JWT-V1" });
  assertEquals(dec(c), { aud: "doordash", iss: "fake-developer", kid: "fake-key", iat: T0 / 1000, exp: T0 / 1000 + 300 });
  const b64 = cfg.signingSecret.replace(/-/g, "+").replace(/_/g, "/");
  const keyBytes = Uint8Array.from(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)), (x) => x.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), (x) => x.charCodeAt(0));
  assert(await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(`${h}.${c}`)));
});

// --- quote -----------------------------------------------------------------

Deno.test("quote: request carries both places and order value; fee and eta come back", async () => {
  const { calls, provider } = stub([[200, fixture("quote.json")]]);
  const q = await provider.quote({ pickup: VITOS, dropoff: CUSTOMER, order_value_cents: 3250, external_id: "cart-123" });
  assert(!isQuoteError(q));
  assertEquals(q.fee_cents, 700);
  assertEquals(q.eta_min, 38);
  assertEquals(q.expires_at, new Date(T0 + 5 * 60000).toISOString());
  assert(q.quote_id.startsWith("cart-123-"));
  const c = calls[0];
  assertEquals([c.method, c.path], ["POST", "/drive/v2/quotes"]);
  assert(c.auth.startsWith("Bearer ey"));
  assertEquals(c.body.external_delivery_id, q.quote_id);
  assertEquals(c.body.pickup_address, VITOS.address);
  assertEquals(c.body.pickup_business_name, "Vito's Pizza");
  assertEquals(c.body.pickup_phone_number, VITOS.phone);
  assertEquals(c.body.pickup_instructions, "Pickup at the front counter");
  assertEquals(c.body.dropoff_address, CUSTOMER.address);
  assertEquals(c.body.dropoff_contact_given_name, "Pat");
  assertEquals(c.body.dropoff_location, { lat: 40.6, lng: -75.55 });
  assertEquals(c.body.order_value, 3250);
});

Deno.test("quote: errors map to the contract's codes", async () => {
  const cases: Array<[number, unknown, string]> = [
    [400, fixture("error-distance.json"), "out_of_range"],
    [400, fixture("error-address.json"), "bad_address"],
    [429, { code: "rate_limited", message: "Too many requests" }, "unavailable"],
    [503, { message: "Service Unavailable" }, "unavailable"],
    [401, { code: "authentication_error", message: "invalid token" }, "provider"],
  ];
  for (const [status, body, want] of cases) {
    const { provider } = stub([[status, body]]);
    const q = await provider.quote({ pickup: VITOS, dropoff: CUSTOMER, order_value_cents: 100, external_id: "c" });
    assert(isQuoteError(q), `${status} should be an error`);
    assertEquals(q.code, want, JSON.stringify(body));
  }
});

Deno.test("quote: a network failure is 'unavailable', not a crash", async () => {
  const fake = makeFakeDoorDash();
  const provider = makeDoorDashProvider(fake.cfg, () => Promise.reject(new Error("dns")));
  const q = await provider.quote({ pickup: VITOS, dropoff: CUSTOMER, order_value_cents: 100, external_id: "c" });
  assert(isQuoteError(q));
  assertEquals(q.code, "unavailable");
});

Deno.test("mapQuoteError: unrecognised 4xx is a provider error", () => {
  assertEquals(mapQuoteError(400, { code: "something_new" }).code, "provider");
});

// --- create ----------------------------------------------------------------

Deno.test("create: a live quote is accepted with the full tip", async () => {
  const { calls, provider } = stub([[200, fixture("accept.json")]]);
  const r = await provider.create(createReq(quoteFor("cart-123-mg4k2p1a", T0 + 60000)));
  assertEquals(calls.length, 1);
  assertEquals([calls[0].method, calls[0].path], ["POST", "/drive/v2/quotes/cart-123-mg4k2p1a/accept"]);
  assertEquals(calls[0].body, { tip: 300 });
  assertEquals(r.delivery_id, "cart-123-mg4k2p1a");
  assertEquals(r.status, "created");
  assertEquals(r.fee_cents, 700);
  assert(r.tracking_url?.startsWith("https://doordash.com/drive/portal/track/"));
});

Deno.test("create: an expired quote books directly with items, tip, notes, pickup time", async () => {
  const { calls, provider } = stub([[200, { ...fixture("accept.json"), fee: 775 }]]);
  const r = await provider.create(createReq(quoteFor("cart-123-mg4k2p1a", T0 - 1)));
  assertEquals(calls.length, 1);
  assertEquals(calls[0].path, "/drive/v2/deliveries");
  const b = calls[0].body;
  assertEquals(b.external_delivery_id, "cart-123-mg4k2p1a-d");
  assertEquals(b.tip, 300);
  assertEquals(b.order_value, 3250);
  assertEquals(b.pickup_time, "2026-09-29T19:20:00Z");
  assertEquals(b.dropoff_instructions, "Side door");
  assertEquals(b.items, [{ name: "Large Cheese Pizza", quantity: 1 }, { name: "Garlic Knots", quantity: 2 }]);
  assertEquals(b.dropoff_contact_send_notifications, false);
  // the caller sees the fee actually charged, which may differ from the quote
  assertEquals(r.fee_cents, 775);
  assertEquals(r.delivery_id, "cart-123-mg4k2p1a-d");
});

Deno.test("create: a refused accept falls back to a direct create", async () => {
  const { calls, provider } = stub([[400, { code: "quote_expired", message: "Quote has expired" }], [200, fixture("accept.json")]]);
  const r = await provider.create(createReq(quoteFor("q1", T0 + 60000)));
  assertEquals(calls.map((c) => c.path), ["/drive/v2/quotes/q1/accept", "/drive/v2/deliveries"]);
  assertEquals(r.delivery_id, "q1-d");
});

Deno.test("create: DoorDash down throws (the paid order must not silently lose its driver)", async () => {
  const { provider } = stub([[503, { message: "down" }]]);
  await assertRejects(() => provider.create(createReq(quoteFor("q1", T0 + 60000))), Error, "doordash accept failed");
});

// --- get / cancel ----------------------------------------------------------

Deno.test("get: status, Dasher, tracking link", async () => {
  const { calls, provider } = stub([[200, fixture("get-picked-up.json")]]);
  const g = await provider.get("cart-123-mg4k2p1a");
  assertEquals(calls[0].path, "/drive/v2/deliveries/cart-123-mg4k2p1a");
  assertEquals(g.status, "picked_up");
  assertEquals(g.courier, { name: "Sam", phone: "+16505555555" });
  assert(g.tracking_url);
});

Deno.test("cancel: accepted is ok; too late is not ok; outage throws", async () => {
  let s = stub([[200, { ...fixture("accept.json"), delivery_status: "cancelled" }]]);
  assertEquals(await s.provider.cancel("x"), { ok: true, fee_cents: 0 });
  assertEquals([s.calls[0].method, s.calls[0].path], ["PUT", "/drive/v2/deliveries/x/cancel"]);
  s = stub([[422, fixture("error-cancel-too-late.json")]]);
  assertEquals(await s.provider.cancel("x"), { ok: false, fee_cents: 0 });
  s = stub([[500, { message: "boom" }]]);
  await assertRejects(() => s.provider.cancel("x"));
});

// --- webhooks --------------------------------------------------------------

const hook = (body: unknown, auth = FAKE_WEBHOOK_SECRET) =>
  new Request("https://x.test/delivery-webhook/doordash", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test("webhook: right Authorization value gives a normalized event", async () => {
  const { provider } = makeFakeDoorDash();
  const r = await provider.verifyWebhook(hook(fixture("webhook-dasher-confirmed.json")));
  assertEquals(r.ok, true);
  assertEquals(r.event, {
    delivery_id: "cart-123-mg4k2p1a",
    status: "courier_assigned",
    provider_status: "DASHER_CONFIRMED",
    at: "2026-09-29T19:12:03.000000Z",
    courier: { name: "Sam", phone: "+16505555555" },
    tracking_url: "https://doordash.com/drive/portal/track/71c7a4b9-7ab9-4d3e-8b3c-000000000001",
    external_id: "cart-123",
  });
});

Deno.test("webhook: wrong or missing Authorization is rejected; no secret configured rejects all", async () => {
  const { provider, cfg } = makeFakeDoorDash();
  assertEquals((await provider.verifyWebhook(hook(fixture("webhook-dasher-confirmed.json"), "Basic nope"))).ok, false);
  assertEquals((await provider.verifyWebhook(hook(fixture("webhook-dasher-confirmed.json"), ""))).ok, false);
  const closed = makeDoorDashProvider({ ...cfg, webhookSecret: null });
  assertEquals((await closed.verifyWebhook(hook(fixture("webhook-dasher-confirmed.json")))).ok, false);
});

Deno.test("webhook: authentic events we don't track are ok with no event", async () => {
  const { provider } = makeFakeDoorDash();
  const r = await provider.verifyWebhook(hook({ event_name: "DASHER_LOCATION_UPDATE", external_delivery_id: "x" }));
  assertEquals(r, { ok: true, event: null });
});

Deno.test("status maps cover every documented DoorDash status and event", () => {
  for (const s of ["created", "confirmed", "enroute_to_pickup", "arrived_at_pickup", "picked_up", "enroute_to_dropoff", "arrived_at_dropoff", "delivered", "cancelled", "enroute_to_return", "arrived_at_return", "returned"]) {
    assert(mapDeliveryStatus(s) !== "unknown", s);
  }
  for (const e of ["DELIVERY_CREATED", "DASHER_CONFIRMED", "DASHER_ENROUTE_TO_PICKUP", "DASHER_CONFIRMED_PICKUP_ARRIVAL", "DASHER_PICKED_UP", "DASHER_ENROUTE_TO_DROPOFF", "DASHER_CONFIRMED_DROPOFF_ARRIVAL", "DASHER_DROPPED_OFF", "DELIVERY_CANCELLED", "DELIVERY_RETURN_INITIALIZED", "DASHER_ENROUTE_TO_RETURN", "DASHER_CONFIRMED_RETURN_ARRIVAL", "DELIVERY_RETURNED"]) {
    assert(mapEventName(e) !== "unknown", e);
  }
});

// --- fake, end to end ------------------------------------------------------

Deno.test("fake: quote → pay → accept → Dasher lifecycle → delivered, statuses only move forward", async () => {
  let t = T0;
  const fake = makeFakeDoorDash({ now: () => t });
  const q = await fake.provider.quote({ pickup: VITOS, dropoff: CUSTOMER, order_value_cents: 3250, external_id: "cart-9" });
  assert(!isQuoteError(q));
  t += 2 * 60000; // customer pays within the 5 minutes
  const booked = await fake.provider.create(createReq(q));
  assertEquals(booked.status, "created");
  assertEquals(fake.deliveries.get(booked.delivery_id)?.tip, 300);
  let status = booked.status;
  const seen: string[] = [];
  for (let i = 0; i < 5; i++) {
    const { ok, event } = await fake.provider.verifyWebhook(fake.advance(booked.delivery_id));
    assert(ok && event);
    assertEquals(event.external_id, "cart-9");
    assert(isForward(status, event.status), `${status} → ${event.status}`);
    status = event.status;
    seen.push(event.status);
  }
  assertEquals(seen, ["courier_assigned", "courier_assigned", "picked_up", "picked_up", "dropped_off"]);
  assertEquals((await fake.provider.get(booked.delivery_id)).status, "dropped_off");
});

Deno.test("fake: slow payer's quote expires, booking still goes through under a new id", async () => {
  let t = T0;
  const fake = makeFakeDoorDash({ now: () => t });
  const q = await fake.provider.quote({ pickup: VITOS, dropoff: CUSTOMER, order_value_cents: 3250, external_id: "cart-9" });
  assert(!isQuoteError(q));
  t += 6 * 60000;
  const booked = await fake.provider.create(createReq(q));
  assertEquals(booked.delivery_id, `${q.quote_id}-d`);
  assertEquals(fake.calls.at(-1)?.path, "/drive/v2/deliveries");
});

Deno.test("fake: re-quoting the same cart doesn't collide; out-of-range address declines", async () => {
  let t = T0;
  const fake = makeFakeDoorDash({ now: () => t, outOfRange: ["99 Far Away Rd"] });
  const a = await fake.provider.quote({ pickup: VITOS, dropoff: CUSTOMER, order_value_cents: 1, external_id: "cart-9" });
  t += 1000;
  const b = await fake.provider.quote({ pickup: VITOS, dropoff: CUSTOMER, order_value_cents: 1, external_id: "cart-9" });
  assert(!isQuoteError(a) && !isQuoteError(b) && a.quote_id !== b.quote_id);
  const far = await fake.provider.quote({ pickup: VITOS, dropoff: { ...CUSTOMER, address: "99 Far Away Rd" }, order_value_cents: 1, external_id: "cart-9" });
  assert(isQuoteError(far));
  assertEquals(far.code, "out_of_range");
});

Deno.test("fake: cancel before pickup works, after pickup is refused", async () => {
  const fake = makeFakeDoorDash({ now: () => T0 });
  const q = await fake.provider.quote({ pickup: VITOS, dropoff: CUSTOMER, order_value_cents: 1, external_id: "a" });
  assert(!isQuoteError(q));
  const d1 = await fake.provider.create(createReq(q));
  assertEquals((await fake.provider.cancel(d1.delivery_id)).ok, true);
  const q2 = await fake.provider.quote({ pickup: VITOS, dropoff: CUSTOMER, order_value_cents: 1, external_id: "b" });
  assert(!isQuoteError(q2));
  const d2 = await fake.provider.create(createReq(q2));
  fake.advance(d2.delivery_id);
  fake.advance(d2.delivery_id);
  fake.advance(d2.delivery_id); // picked up
  assertEquals((await fake.provider.cancel(d2.delivery_id)).ok, false);
});
