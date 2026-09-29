// Tests for _shared/delivery-store.ts and the delivery-webhook handler, against an in-memory table store
// and the fake provider. No network, no database.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { applyDeliveryEvent, bookDelivery, cancelDeliveryForCart, type BookInput } from "./delivery-store.ts";
import { makeFakeProvider } from "./delivery-fake.ts";
import type { Place, WebhookEvent } from "./delivery.ts";
import { handle } from "../delivery-webhook/index.ts";

// ─── a tiny in-memory stand-in for the supabase-js query builder ───────────
type Row = Record<string, unknown>;
export function memDb(unique: Record<string, string[]> = { deliveries: ["cart_id"] }) {
  const tables: Record<string, Row[]> = {};
  let seq = 0, clock = 0;
  const t = (name: string) => (tables[name] ??= []);
  function builder(table: string) {
    let op: "select" | "insert" | "update" = "select", payload: Row | null = null, single = false;
    const filters: Array<[string, unknown]> = [];
    const q = {
      select(_c?: string) { return q; },
      insert(r: Row) { op = "insert"; payload = r; return q; },
      update(p: Row) { op = "update"; payload = p; return q; },
      eq(k: string, v: unknown) { filters.push([k, v]); return q; },
      maybeSingle() { single = true; return q; },
      then(res: (v: { data: unknown; error: { message: string; code?: string } | null }) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(res, rej);
      },
    };
    const match = (r: Row) => filters.every(([k, v]) => r[k] === v);
    function run() {
      if (op === "insert") {
        for (const col of unique[table] ?? []) if (t(table).some((r) => r[col] === payload![col])) return { data: null, error: { message: "duplicate key", code: "23505" } };
        const row: Row = { id: `row_${++seq}`, events: [], updated_at: `t${++clock}`, ...payload };
        t(table).push(row);
        return { data: single ? { ...row } : [{ ...row }], error: null };
      }
      const hits = t(table).filter(match);
      if (op === "update") { for (const r of hits) Object.assign(r, payload, table === "deliveries" && !("updated_at" in payload!) ? {} : { updated_at: `t${++clock}` }); }
      const out = hits.map((r) => ({ ...r }));
      return { data: single ? (out[0] ?? null) : out, error: null };
    }
    return q;
  }
  return { client: { from: builder } as unknown as SupabaseClient, tables: t };
}

const SHOP: Place = { name: "Vito's", address: "5620 Cetronia Rd, Allentown, PA 18106, USA", lat: null, lng: null, phone: "+14845550100", notes: null };
const CUST: Place = { name: "Pat", address: "1200 Hamilton St, Allentown, PA 18102, USA", lat: null, lng: null, phone: "+14845550199", notes: null };
const input = (over: Partial<BookInput> = {}): BookInput => ({
  cart_id: "cart_1", shop_id: "shop_1", test_mode: true, pickup: SHOP, dropoff: CUST, items: [{ name: "Cheese Pizza", qty: 1 }],
  order_value_cents: 2400, tip_cents: 300, dropoff_notes: "side door", prep_minutes: 20, now: new Date("2026-09-29T16:00:00Z"), ...over,
});

Deno.test("book: quotes, creates, stores the delivery and mirrors status on the cart", async () => {
  const { client, tables } = memDb();
  tables("order_carts").push({ id: "cart_1" });
  const p = makeFakeProvider({ fee_cents: 725 });
  const r = await bookDelivery(client, p, input());
  assert(r.ok);
  assertEquals([r.row.delivery_id, r.row.fee_cents, r.row.status, r.row.tracking_url, r.row.tip_cents], ["fd_2", 725, "created", "https://track.example/fd_2", 300]);
  assertEquals(r.row.pickup_ready_at, "2026-09-29T16:20:00.000Z");
  assertEquals(tables("order_carts")[0].delivery_status, "created");
  const create = p.calls.find((c) => c.op === "create")!.req as { tip_cents: number; dropoff_notes: string; external_id: string };
  assertEquals([create.tip_cents, create.dropoff_notes, create.external_id], [300, "side door", "cart_1"]);
});

Deno.test("book: a replayed payment webhook does not book a second courier", async () => {
  const { client, tables } = memDb();
  const p = makeFakeProvider();
  await bookDelivery(client, p, input());
  const again = await bookDelivery(client, p, input());
  assert(again.ok && again.already);
  assertEquals(p.calls.filter((c) => c.op === "create").length, 1);
  assertEquals(tables("deliveries").length, 1);
});

Deno.test("book: out of range at booking time is recorded; a later retry may book", async () => {
  const { client, tables } = memDb();
  const r = await bookDelivery(client, makeFakeProvider({ quoteError: { error: "too far", code: "out_of_range" } }), input());
  assert(!r.ok); assertEquals(r.stage, "quote");
  assert(String(tables("deliveries")[0].error).startsWith("quote out_of_range"));
  const retry = await bookDelivery(client, makeFakeProvider(), input());
  assert(retry.ok && !retry.already);
  assertEquals(tables("deliveries")[0].error, null);
});

Deno.test("book: a create failure is recorded, not thrown", async () => {
  const { client, tables } = memDb();
  const r = await bookDelivery(client, makeFakeProvider({ createFails: true }), input());
  assert(!r.ok); assertEquals(r.stage, "create");
  assert(String(tables("deliveries")[0].error).includes("fake create failed"));
});

const ev = (status: WebhookEvent["status"], at: string, extra: Partial<WebhookEvent> = {}): WebhookEvent => ({ delivery_id: "fd_2", status, provider_status: status, at, ...extra });

Deno.test("webhook events: forward moves apply, backward and unknown are logged only, replays are ignored", async () => {
  const { client, tables } = memDb();
  tables("order_carts").push({ id: "cart_1" });
  await bookDelivery(client, makeFakeProvider(), input());
  assertEquals(await applyDeliveryEvent(client, "uber", ev("courier_assigned", "a1", { courier: { name: "Sam", phone: "+1555" } })), { applied: true, status: "courier_assigned", changed: true });
  assertEquals(await applyDeliveryEvent(client, "uber", ev("picked_up", "a2")), { applied: true, status: "picked_up", changed: true });
  assertEquals(await applyDeliveryEvent(client, "uber", ev("courier_assigned", "a0")), { applied: true, status: "picked_up", changed: false });
  assertEquals(await applyDeliveryEvent(client, "uber", ev("picked_up", "a2")), { applied: false, reason: "replay" });
  assertEquals(await applyDeliveryEvent(client, "uber", ev("unknown", "a3")), { applied: true, status: "picked_up", changed: false });
  assertEquals(await applyDeliveryEvent(client, "uber", ev("dropped_off", "a4")), { applied: true, status: "dropped_off", changed: true });
  assertEquals(await applyDeliveryEvent(client, "uber", ev("canceled", "a5")), { applied: true, status: "dropped_off", changed: false });
  const d = tables("deliveries")[0];
  assertEquals([d.status, d.courier_name, d.picked_up_at, d.dropped_off_at], ["dropped_off", "Sam", "a2", "a4"]);
  assertEquals((d.events as unknown[]).length, 7); // create + 6 distinct webhooks
  assertEquals(tables("order_carts")[0].delivery_status, "dropped_off");
  assertEquals(await applyDeliveryEvent(client, "uber", { ...ev("picked_up", "z"), delivery_id: "nope" }), { applied: false, reason: "unknown_delivery" });
  assertEquals(await applyDeliveryEvent(client, "doordash", ev("picked_up", "z")), { applied: false, reason: "unknown_delivery" }, "provider scoped");
});

Deno.test("cancel: before pickup is free; after pickup is a return; after drop-off nothing happens", async () => {
  for (const [advance, want] of [[null, { cancelled: true, status: "canceled", fee_cents: 0 }], ["picked_up", { cancelled: true, status: "returned", fee_cents: 699 }], ["dropped_off", { cancelled: false, reason: "already_final", status: "dropped_off" }]] as const) {
    const { client, tables } = memDb();
    tables("order_carts").push({ id: "cart_1" });
    const p = makeFakeProvider();
    await bookDelivery(client, p, input());
    if (advance) { p.advance("fd_2", advance); await applyDeliveryEvent(client, "uber", ev(advance, "x")); }
    assertEquals(await cancelDeliveryForCart(client, "cart_1", () => p), want);
  }
  const { client } = memDb();
  assertEquals(await cancelDeliveryForCart(client, "cart_x", () => null), { cancelled: false, reason: "no_delivery" });
});

Deno.test("delivery-webhook: routes by path, 401 on a bad signature, 404 on an unknown provider, 200 on unknown delivery", async () => {
  const { client, tables } = memDb();
  const p = makeFakeProvider({ webhookSecret: "s3cret" });
  await bookDelivery(client, p, input());
  const live = makeFakeProvider({ webhookSecret: "live-secret" });
  const resolve = (n: string) => (n === "uber" ? [live, p] : []); // live first, sandbox second: the sandbox signature still verifies
  const post = (path: string, body: unknown, sig?: string) =>
    handle(new Request(`https://x.supabase.co/functions/v1/delivery-webhook/${path}`, { method: "POST", body: JSON.stringify(body), headers: sig ? { "x-fake-signature": sig } : {} }), client, resolve);
  assertEquals((await post("uber", ev("picked_up", "w1"), "wrong")).status, 401);
  assertEquals((await post("lyft", ev("picked_up", "w1"), "s3cret")).status, 404);
  const ok = await post("uber", ev("picked_up", "w1"), "s3cret");
  assertEquals([ok.status, (await ok.json()).status], [200, "picked_up"]);
  assertEquals(tables("deliveries")[0].status, "picked_up");
  const unknown = await post("uber", { ...ev("picked_up", "w2"), delivery_id: "other" }, "s3cret");
  assertEquals([unknown.status, (await unknown.json()).reason], [200, "unknown_delivery"]);
});
