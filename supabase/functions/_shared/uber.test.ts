// Tests for _shared/uber.ts against a stubbed fetch (response shapes from developer.uber.com/docs/deliveries).
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _clearUberTokens, _hmacHex, makeUberProvider, uberAddress, uberStatus, type UberConfig } from "./uber.ts";
import { isQuoteError, type Place } from "./delivery.ts";
import { makeFakeProvider } from "./delivery-fake.ts";

const CFG: UberConfig = { customer_id: "cust_1", client_id: "cid", client_secret: "csec", webhook_secret: "whsec", robo: true };
const SHOP: Place = { name: "Vito's", address: "5620 Cetronia Rd, Allentown, PA 18106, USA", lat: 40.58, lng: -75.56, phone: "+14845550100", notes: "Counter by the door" };
const CUST: Place = { name: "Pat", address: "1200 Hamilton St, Allentown, PA 18102, USA", lat: 40.6, lng: -75.48, phone: "+14845550199", notes: null };

type Seen = { url: string; method: string; headers: Headers; body: string };
function stub(routes: Array<(s: Seen) => Response | null>) {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body ? String(init.body) : "" };
    seen.push(s);
    for (const r of routes) { const res = r(s); if (res) return res; }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, seen };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const auth = (s: Seen) => s.url.includes("auth.uber.com") ? json({ access_token: "tok", expires_in: 2592000 }) : null;

Deno.test("uberAddress splits a Google formatted line into Uber's structured address", () => {
  assertEquals(JSON.parse(uberAddress(SHOP.address)), { street_address: ["5620 Cetronia Rd"], city: "Allentown", state: "PA", zip_code: "18106", country: "US" });
  assertEquals(JSON.parse(uberAddress("12 Main St, Apt 4, Emmaus, PA 18049")).street_address, ["12 Main St", "Apt 4"]);
  assertEquals(uberAddress("somewhere odd"), "somewhere odd");
});

Deno.test("uberStatus normalizes the lifecycle", () => {
  assertEquals(["pending", "pickup", "pickup_complete", "dropoff", "delivered", "canceled", "returned", "weird"].map(uberStatus),
    ["created", "courier_assigned", "picked_up", "picked_up", "dropped_off", "canceled", "returned", "unknown"]);
});

Deno.test("quote: token once, structured addresses, fee and eta back", async () => {
  _clearUberTokens();
  const { f, seen } = stub([auth, (s) => s.url.endsWith("/v1/customers/cust_1/delivery_quotes") ? json({ kind: "delivery_quote", id: "dqt_1", fee: 725, currency: "usd", expires: "2026-09-29T16:00:00Z", duration: 28 }) : null]);
  const p = makeUberProvider(CFG, f);
  const q1 = await p.quote({ pickup: SHOP, dropoff: CUST, order_value_cents: 2400, external_id: "cart_1" });
  const q2 = await p.quote({ pickup: SHOP, dropoff: CUST, order_value_cents: 2400, external_id: "cart_1" });
  assert(!isQuoteError(q1) && !isQuoteError(q2));
  assertEquals([q1.quote_id, q1.fee_cents, q1.eta_min, q1.provider], ["dqt_1", 725, 28, "uber"]);
  assertEquals(seen.filter((s) => s.url.includes("auth.uber.com")).length, 1, "token cached");
  const tokBody = new URLSearchParams(seen[0].body);
  assertEquals([tokBody.get("grant_type"), tokBody.get("scope")], ["client_credentials", "eats.deliveries"]);
  const body = JSON.parse(seen[1].body);
  assertEquals(JSON.parse(body.pickup_address).city, "Allentown");
  assertEquals([body.pickup_phone_number, body.dropoff_latitude, body.manifest_total_value], ["+14845550100", 40.6, 2400]);
  assertEquals(seen[1].headers.get("authorization"), "Bearer tok");
});

Deno.test("quote: Uber's undeliverable/unknown/busy codes map to our codes", async () => {
  for (const [code, status, want] of [["address_undeliverable", 400, "out_of_range"], ["unknown_location", 400, "bad_address"], ["couriers_busy", 400, "unavailable"], ["whatever", 503, "unavailable"], ["invalid_params", 400, "provider"]] as const) {
    _clearUberTokens();
    const { f } = stub([auth, (s) => s.url.includes("delivery_quotes") ? json({ kind: "error", code, message: "x" }, status) : null]);
    const q = await makeUberProvider(CFG, f).quote({ pickup: SHOP, dropoff: CUST, order_value_cents: 100, external_id: "c" });
    assert(isQuoteError(q)); assertEquals(q.code, want, code);
  }
});

Deno.test("a 401 drops the cached token and retries once", async () => {
  _clearUberTokens();
  let n = 0;
  const { f, seen } = stub([auth, (s) => s.url.includes("delivery_quotes") ? (++n === 1 ? json({ code: "unauthorized" }, 401) : json({ id: "dqt_2", fee: 500, expires: "x" })) : null]);
  const q = await makeUberProvider(CFG, f).quote({ pickup: SHOP, dropoff: CUST, order_value_cents: 100, external_id: "c" });
  assert(!isQuoteError(q)); assertEquals(q.quote_id, "dqt_2");
  assertEquals(seen.filter((s) => s.url.includes("auth.uber.com")).length, 2);
});

Deno.test("create: quote id, manifest, tip, ready time, robo courier in test mode", async () => {
  _clearUberTokens();
  const { f, seen } = stub([auth, (s) => s.url.endsWith("/deliveries") ? json({ id: "del_1", status: "pending", fee: 725, tracking_url: "https://track.uber/del_1" }) : null]);
  const r = await makeUberProvider(CFG, f).create({
    quote: { provider: "uber", quote_id: "dqt_1", fee_cents: 725, expires_at: "x", eta_min: 28, raw: null },
    pickup: SHOP, dropoff: CUST, items: [{ name: "Large Cheese Pizza", qty: 2 }], tip_cents: 300, dropoff_notes: "ring twice",
    pickup_ready_at: "2026-09-29T16:20:00Z", external_id: "cart_1", order_value_cents: 2400,
  });
  assertEquals(r, { delivery_id: "del_1", tracking_url: "https://track.uber/del_1", status: "created", fee_cents: 725, raw: { id: "del_1", status: "pending", fee: 725, tracking_url: "https://track.uber/del_1" } });
  const b = JSON.parse(seen[1].body);
  assertEquals([b.quote_id, b.tip, b.pickup_ready_dt, b.external_id, b.dropoff_notes, b.pickup_notes, b.pickup_name], ["dqt_1", 300, "2026-09-29T16:20:00Z", "cart_1", "ring twice", "Counter by the door", "Vito's"]);
  assertEquals(b.manifest_items, [{ name: "Large Cheese Pizza", quantity: 2, size: "small" }]);
  assertEquals(b.test_specifications, { robo_courier_specification: { mode: "auto" } });
});

Deno.test("create: production config never asks for the robo courier; errors throw", async () => {
  _clearUberTokens();
  const { f, seen } = stub([auth, (s) => s.url.endsWith("/deliveries") ? json({ code: "expired_quote", message: "gone" }, 400) : null]);
  await assertRejects(() => makeUberProvider({ ...CFG, robo: false }, f).create({
    quote: { provider: "uber", quote_id: "dqt_1", fee_cents: 725, expires_at: "x", eta_min: null, raw: null },
    pickup: SHOP, dropoff: CUST, items: [], tip_cents: 0, dropoff_notes: null, pickup_ready_at: "x", external_id: "c",
  }), Error, "expired_quote");
  assertEquals(JSON.parse(seen[1].body).test_specifications, undefined);
});

Deno.test("cancel and get", async () => {
  _clearUberTokens();
  const { f } = stub([auth,
    (s) => s.url.endsWith("/deliveries/del_1/cancel") ? json({ id: "del_1", status: "canceled", fee: 725 }) : null,
    (s) => s.url.endsWith("/deliveries/del_1") ? json({ id: "del_1", status: "pickup_complete", tracking_url: "t", courier: { name: "Sam", phone_number: "+1555" } }) : null]);
  const p = makeUberProvider(CFG, f);
  assertEquals(await p.cancel("del_1"), { ok: true, fee_cents: 0 });
  const g = await p.get("del_1");
  assertEquals([g.status, g.courier, g.tracking_url], ["picked_up", { name: "Sam", phone: "+1555" }, "t"]);
});

Deno.test("verifyWebhook: good signature parses, bad or missing signature rejects, no secret rejects", async () => {
  const body = JSON.stringify({ kind: "event.delivery_status", delivery_id: "del_1", status: "pickup_complete", created: "2026-09-29T16:30:00Z", data: { id: "del_1", status: "pickup_complete", external_id: "cart_1", courier: { name: "Sam", phone_number: null }, tracking_url: "t" } });
  const sig = await _hmacHex("whsec", body);
  const p = makeUberProvider(CFG);
  const ok = await p.verifyWebhook(new Request("https://x", { method: "POST", body, headers: { "x-uber-signature": sig } }));
  assertEquals(ok, { ok: true, event: { delivery_id: "del_1", status: "picked_up", provider_status: "pickup_complete", at: "2026-09-29T16:30:00Z", courier: { name: "Sam", phone: null }, tracking_url: "t", external_id: "cart_1" } });
  const legacy = await p.verifyWebhook(new Request("https://x", { method: "POST", body, headers: { "x-postmates-signature": sig } }));
  assert(legacy.ok);
  assertEquals((await p.verifyWebhook(new Request("https://x", { method: "POST", body, headers: { "x-uber-signature": sig.replace(/.$/, "0") === sig ? sig.replace(/.$/, "1") : sig.replace(/.$/, "0") } }))).ok, false);
  assertEquals((await p.verifyWebhook(new Request("https://x", { method: "POST", body }))).ok, false);
  assertEquals((await makeUberProvider({ ...CFG, webhook_secret: null }).verifyWebhook(new Request("https://x", { method: "POST", body, headers: { "x-uber-signature": sig } }))).ok, false);
});

Deno.test("fake provider: quote, create, cancel before pickup is free, after pickup is a return", async () => {
  const p = makeFakeProvider({ fee_cents: 800 });
  const q = await p.quote({ pickup: SHOP, dropoff: CUST, order_value_cents: 1, external_id: "c" });
  assert(!isQuoteError(q));
  const a = await p.create({ quote: q, pickup: SHOP, dropoff: CUST, items: [], tip_cents: 0, dropoff_notes: null, pickup_ready_at: "x", external_id: "c" });
  assertEquals(await p.cancel(a.delivery_id), { ok: true, fee_cents: 0 });
  const b = await p.create({ quote: q, pickup: SHOP, dropoff: CUST, items: [], tip_cents: 0, dropoff_notes: null, pickup_ready_at: "x", external_id: "c" });
  p.advance(b.delivery_id, "picked_up");
  assertEquals(await p.cancel(b.delivery_id), { ok: true, fee_cents: 800 });
});

Deno.test("webhook verifiers: test and live signing keys each verify their own events, live first", async () => {
  const keep = { t: Deno.env.get("UBER_DIRECT_WEBHOOK_SECRET"), l: Deno.env.get("UBER_DIRECT_WEBHOOK_SECRET_LIVE") };
  Deno.env.set("UBER_DIRECT_WEBHOOK_SECRET", "test-key"); Deno.env.set("UBER_DIRECT_WEBHOOK_SECRET_LIVE", "live-key");
  try {
    const { uberWebhookVerifiers } = await import("./uber.ts");
    const vs = uberWebhookVerifiers();
    assertEquals(vs.length, 2);
    const body = JSON.stringify({ kind: "event.delivery_status", delivery_id: "del_9", status: "delivered", created: "t" });
    for (const [key, okIdx] of [["test-key", 1], ["live-key", 0]] as const) {
      const sig = await _hmacHex(key, body);
      const res = await Promise.all(vs.map((v) => v.verifyWebhook(new Request("https://x", { method: "POST", body, headers: { "x-uber-signature": sig } }))));
      assertEquals(res.map((r) => r.ok), [okIdx === 0, okIdx === 1], key);
    }
  } finally {
    if (keep.t === undefined) Deno.env.delete("UBER_DIRECT_WEBHOOK_SECRET"); else Deno.env.set("UBER_DIRECT_WEBHOOK_SECRET", keep.t);
    if (keep.l === undefined) Deno.env.delete("UBER_DIRECT_WEBHOOK_SECRET_LIVE"); else Deno.env.set("UBER_DIRECT_WEBHOOK_SECRET_LIVE", keep.l);
  }
});

Deno.test("an auth failure names Uber's OAuth error code and nothing else from the body", async () => {
  _clearUberTokens();
  const { f } = stub([(s) => s.url.includes("auth.uber.com") ? json({ error: "invalid_scope", error_description: "echo csec" }, 400) : null]);
  const q = await makeUberProvider(CFG, f).quote({ pickup: SHOP, dropoff: CUST, order_value_cents: 1, external_id: "c" });
  assert(isQuoteError(q));
  assertEquals(q.error, "uber auth failed: HTTP 400 invalid_scope (without a scope)");
});

Deno.test("keys that refuse the eats.deliveries scope by name get a token without a scope", async () => {
  _clearUberTokens();
  const { f, seen } = stub([
    (s) => s.url.includes("auth.uber.com") ? (new URLSearchParams(s.body).get("scope") ? json({ error: "invalid_scope" }, 400) : json({ access_token: "tok2", expires_in: 100 })) : null,
    (s) => s.url.includes("delivery_quotes") ? json({ id: "dqt_9", fee: 650, expires: "x" }) : null]);
  const q = await makeUberProvider(CFG, f).quote({ pickup: SHOP, dropoff: CUST, order_value_cents: 1, external_id: "c" });
  assert(!isQuoteError(q)); assertEquals(q.fee_cents, 650);
  assertEquals(seen.filter((s) => s.url.includes("auth.uber.com")).length, 2);
  assertEquals(seen.at(-1)!.headers.get("authorization"), "Bearer tok2");
});
