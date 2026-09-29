// _shared/doordash-fake.ts — an in-memory DoorDash Drive for tests. It answers the
// same HTTP calls the real adapter makes, so tests drive makeDoorDashProvider
// end to end with no network: quote → accept (or create) → Dasher lifecycle via
// advance() → webhooks via webhook() → cancel.

import { type DoorDashConfig, makeDoorDashProvider } from "./doordash.ts";
import type { DeliveryProvider } from "./delivery.ts";

export interface FakeDoorDashOptions {
  /** fee every quote returns (DoorDash's tipped base is $7.00) */
  feeCents?: number;
  /** quotes to these dropoff addresses fail as too far */
  outOfRange?: string[];
  now?: () => number;
}

interface FakeDelivery {
  external_delivery_id: string;
  delivery_status: string;
  fee: number;
  tip: number;
  body: Record<string, unknown>;
  dasher_name?: string;
  dasher_dropoff_phone_number?: string;
  tracking_url: string;
}

export const FAKE_WEBHOOK_SECRET = "Basic ZmFrZTpmYWtl";
const FAKE_SECRET = "c2VjcmV0LXNpZ25pbmcta2V5LWZvci10ZXN0cy1vbmx5"; // base64url, not a real key

/** the lifecycle advance() walks, paired with the webhook DoorDash sends at each step */
const LIFECYCLE: Array<[string, string]> = [
  ["confirmed", "DASHER_CONFIRMED"],
  ["arrived_at_pickup", "DASHER_CONFIRMED_PICKUP_ARRIVAL"],
  ["picked_up", "DASHER_PICKED_UP"],
  ["arrived_at_dropoff", "DASHER_CONFIRMED_DROPOFF_ARRIVAL"],
  ["delivered", "DASHER_DROPPED_OFF"],
];

export function makeFakeDoorDash(opts: FakeDoorDashOptions = {}) {
  const now = opts.now ?? Date.now;
  const fee = opts.feeCents ?? 700;
  const quotes = new Map<string, { at: number; body: Record<string, unknown> }>();
  const deliveries = new Map<string, FakeDelivery>();
  const calls: Array<{ method: string; path: string; body: any; auth: string }> = [];

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  function book(id: string, body: Record<string, unknown>, tip: number): FakeDelivery {
    const d: FakeDelivery = {
      external_delivery_id: id,
      delivery_status: "created",
      fee,
      tip,
      body,
      tracking_url: `https://doordash.com/drive/portal/track/fake-${id}`,
    };
    deliveries.set(id, d);
    return d;
  }

  async function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const auth = new Headers(init.headers).get("authorization") ?? "";
    calls.push({ method, path: url.pathname, body, auth });
    if (!auth.startsWith("Bearer ")) return json(401, { code: "authentication_error", message: "missing JWT" });

    let m: RegExpMatchArray | null;
    if (method === "POST" && url.pathname === "/drive/v2/quotes") {
      if (quotes.has(body.external_delivery_id) || deliveries.has(body.external_delivery_id)) {
        return json(409, { code: "duplicate_delivery_id", message: "Delivery with this id already exists" });
      }
      if ((opts.outOfRange ?? []).includes(body.dropoff_address)) {
        return json(400, {
          code: "validation_error",
          message: "Validation Failed",
          field_errors: [{ field: "dropoff_address", error: "Allowed distance between addresses exceeded" }],
        });
      }
      quotes.set(body.external_delivery_id, { at: now(), body });
      return json(200, {
        external_delivery_id: body.external_delivery_id,
        currency: "USD",
        delivery_status: "quote",
        fee,
        dropoff_time_estimated: new Date(now() + 30 * 60000).toISOString(),
      });
    }
    if (method === "POST" && (m = url.pathname.match(/^\/drive\/v2\/quotes\/([^/]+)\/accept$/))) {
      const id = decodeURIComponent(m[1]);
      const q = quotes.get(id);
      if (!q) return json(404, { code: "not_found", message: "Quote not found" });
      if (now() - q.at > 5 * 60000) return json(400, { code: "quote_expired", message: "Quote has expired" });
      quotes.delete(id);
      const d = book(id, q.body, Number(body?.tip ?? 0));
      return json(200, { ...d, body: undefined });
    }
    if (method === "POST" && url.pathname === "/drive/v2/deliveries") {
      if (deliveries.has(body.external_delivery_id)) {
        return json(409, { code: "duplicate_delivery_id", message: "Delivery with this id already exists" });
      }
      const d = book(body.external_delivery_id, body, Number(body.tip ?? 0));
      return json(200, { ...d, body: undefined });
    }
    if ((m = url.pathname.match(/^\/drive\/v2\/deliveries\/([^/]+)(\/cancel)?$/))) {
      const d = deliveries.get(decodeURIComponent(m[1]));
      if (!d) return json(404, { code: "not_found", message: "Delivery not found" });
      if (m[2] && method === "PUT") {
        if (!["created", "confirmed", "arrived_at_pickup"].includes(d.delivery_status)) {
          return json(422, { code: "unprocessable_entity", message: "Delivery cannot be cancelled" });
        }
        d.delivery_status = "cancelled";
      }
      return json(200, { ...d, body: undefined });
    }
    return json(404, { code: "not_found", message: `no route ${method} ${url.pathname}` });
  }

  const cfg: DoorDashConfig = {
    developerId: "fake-developer",
    keyId: "fake-key",
    signingSecret: FAKE_SECRET,
    webhookSecret: FAKE_WEBHOOK_SECRET,
    baseUrl: "https://fake.doordash.test",
    now,
  };

  return {
    cfg,
    fetch: fakeFetch,
    provider: makeDoorDashProvider(cfg, fakeFetch) as DeliveryProvider,
    deliveries,
    calls,
    /** move a delivery one step along; returns the webhook DoorDash would send */
    advance(id: string): Request {
      const d = deliveries.get(id);
      if (!d) throw new Error(`fake doordash: no delivery ${id}`);
      const i = LIFECYCLE.findIndex(([s]) => s === d.delivery_status);
      const [status, event] = LIFECYCLE[Math.min(i + 1, LIFECYCLE.length - 1)];
      d.delivery_status = status;
      if (status === "confirmed") {
        d.dasher_name = "Sam";
        d.dasher_dropoff_phone_number = "+16505555555";
      }
      return this.webhook(id, event);
    },
    /** the webhook request DoorDash sends for an event, with our configured Authorization value */
    webhook(id: string, eventName: string, auth = FAKE_WEBHOOK_SECRET): Request {
      const d = deliveries.get(id);
      return new Request("https://example.test/functions/v1/delivery-webhook/doordash", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({
          event_name: eventName,
          created_at: new Date(now()).toISOString(),
          external_delivery_id: id,
          delivery_status: d?.delivery_status,
          dasher_name: d?.dasher_name,
          dasher_dropoff_phone_number: d?.dasher_dropoff_phone_number,
          tracking_url: d?.tracking_url,
        }),
      });
    },
  };
}
