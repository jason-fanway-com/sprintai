// _shared/doordash.ts — DoorDash Drive (v2) behind the DeliveryProvider contract.
//
// Auth: a short-lived JWT per call, HS256, with the extra header `dd-ver: DD-JWT-V1`;
// claims aud=doordash, iss=developer_id, kid=key_id. The signing secret from the
// Developer Portal is base64url; its decoded bytes are the HMAC key.
//
// Flow: quote (POST /drive/v2/quotes, good for 5 minutes) → accept
// (POST /drive/v2/quotes/{id}/accept, tip added here) after payment. If the quote
// has expired by then we create the delivery directly (POST /drive/v2/deliveries).
// DoorDash keys everything by our external_delivery_id, so that id is our
// delivery_id too.
//
// Webhooks are NOT signed: the portal sends a fixed Authorization header value we
// choose (DOORDASH_WEBHOOK_SECRET); verifyWebhook compares it in constant time.
//
// Shapes follow developer.doordash.com (checked 2026-09-29). Fields marked
// UNVERIFIED have not yet been seen in a recorded sandbox response.

import type {
  CancelResult,
  Courier,
  CreateRequest,
  CreateResult,
  DeliveryProvider,
  DeliveryQuote,
  DeliveryStatus,
  GetResult,
  Place,
  QuoteError,
  QuoteErrorCode,
  QuoteRequest,
  WebhookEvent,
} from "./delivery.ts";

export const DOORDASH_BASE_URL = "https://openapi.doordash.com";

export interface DoorDashConfig {
  developerId: string;
  keyId: string;
  signingSecret: string;
  /** the Authorization header value configured on the portal's webhook; null = reject all webhooks */
  webhookSecret: string | null;
  baseUrl?: string;
  /** clock for JWT iat/exp and quote expiry; tests pin it */
  now?: () => number;
}

/**
 * Sandbox keys: DOORDASH_DEVELOPER_ID / DOORDASH_KEY_ID / DOORDASH_SIGNING_SECRET.
 * Production keys (after DoorDash's review): the same names with DOORDASH_PROD_.
 * Returns null when any key is missing, so callers fall back to the shop's own delivery.
 */
export function doordashConfigFromEnv(testMode: boolean): DoorDashConfig | null {
  const p = testMode ? "DOORDASH_" : "DOORDASH_PROD_";
  const developerId = (Deno.env.get(`${p}DEVELOPER_ID`) ?? "").trim();
  const keyId = (Deno.env.get(`${p}KEY_ID`) ?? "").trim();
  const signingSecret = (Deno.env.get(`${p}SIGNING_SECRET`) ?? "").trim();
  if (!developerId || !keyId || !signingSecret) return null;
  const webhookSecret = (Deno.env.get(`${p}WEBHOOK_SECRET`) ?? "").trim() || null;
  return { developerId, keyId, signingSecret, webhookSecret };
}

// ---------------------------------------------------------------------------
// JWT

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const enc = new TextEncoder();

export async function doordashJwt(cfg: DoorDashConfig, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: "HS256", typ: "JWT", "dd-ver": "DD-JWT-V1" };
  const claims = { aud: "doordash", iss: cfg.developerId, kid: cfg.keyId, iat, exp: iat + 300 };
  const signingInput = `${b64urlEncode(enc.encode(JSON.stringify(header)))}.${
    b64urlEncode(enc.encode(JSON.stringify(claims)))
  }`;
  const key = await crypto.subtle.importKey(
    "raw",
    b64urlDecode(cfg.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

// ---------------------------------------------------------------------------
// status mapping

/** DoorDash delivery_status → our normalized status */
export function mapDeliveryStatus(s: string | null | undefined): DeliveryStatus {
  switch (s) {
    case "quote":
      return "quoted";
    case "created":
      return "created";
    case "confirmed":
    case "enroute_to_pickup":
    case "arrived_at_pickup":
      return "courier_assigned";
    case "picked_up":
    case "enroute_to_dropoff":
    case "arrived_at_dropoff":
      return "picked_up";
    case "delivered":
      return "dropped_off";
    case "cancelled":
      return "canceled";
    // a return is under way: the food left with the Dasher and is coming back
    case "enroute_to_return":
    case "arrived_at_return":
      return "picked_up";
    case "returned":
      return "returned";
    default:
      return "unknown";
  }
}

/** DoorDash webhook event_name → our normalized status */
export function mapEventName(e: string | null | undefined): DeliveryStatus {
  switch (e) {
    case "DELIVERY_CREATED":
      return "created";
    case "DASHER_CONFIRMED":
    case "DASHER_ENROUTE_TO_PICKUP":
    case "DASHER_CONFIRMED_PICKUP_ARRIVAL":
      return "courier_assigned";
    case "DASHER_PICKED_UP":
    case "DASHER_ENROUTE_TO_DROPOFF":
    case "DASHER_CONFIRMED_DROPOFF_ARRIVAL":
    case "DELIVERY_RETURN_INITIALIZED":
    case "DASHER_ENROUTE_TO_RETURN":
    case "DASHER_CONFIRMED_RETURN_ARRIVAL":
      return "picked_up";
    case "DASHER_DROPPED_OFF":
      return "dropped_off";
    case "DELIVERY_CANCELLED":
      return "canceled";
    case "DELIVERY_RETURNED":
      return "returned";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// error mapping

interface DDError {
  code?: string;
  message?: string;
  field_errors?: Array<{ field?: string; error?: string }>;
}

export function mapQuoteError(status: number, body: DDError | null): QuoteError {
  const code = (body?.code ?? "").toLowerCase();
  const fields = body?.field_errors ?? [];
  const text = [code, body?.message ?? "", ...fields.map((f) => `${f.field ?? ""} ${f.error ?? ""}`)]
    .join(" ")
    .toLowerCase();
  const message = body?.message || code || `doordash http ${status}`;
  let kind: QuoteErrorCode = "provider";
  if (status === 429 || status >= 500) kind = "unavailable";
  else if (/distance|too_long|too far|outside|not_serviceable|unserviceable|no_coverage|coverage/.test(text)) {
    kind = "out_of_range";
  } else if (/no dasher|dasher_unavailable|unavailable|capacity|closed/.test(text)) kind = "unavailable";
  else if (/address|phone_number|dropoff_location/.test(text)) kind = "bad_address";
  return { error: message, code: kind };
}

// ---------------------------------------------------------------------------
// provider

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class DoorDashError extends Error {
  constructor(public status: number, public body: unknown, msg: string) {
    super(msg);
  }
}

function placeFields(role: "pickup" | "dropoff", p: Place): Record<string, unknown> {
  const out: Record<string, unknown> = {
    [`${role}_address`]: p.address,
    [`${role}_phone_number`]: p.phone,
  };
  if (role === "pickup") out.pickup_business_name = p.name;
  else out.dropoff_contact_given_name = p.name;
  if (p.notes) out[`${role}_instructions`] = p.notes;
  // UNVERIFIED for pickup; dropoff_location is documented
  if (role === "dropoff" && p.lat != null && p.lng != null) out.dropoff_location = { lat: p.lat, lng: p.lng };
  return out;
}

function courierOf(d: Record<string, unknown>): Courier | undefined {
  const name = typeof d.dasher_name === "string" ? d.dasher_name : null;
  if (!name) return undefined;
  const phone = typeof d.dasher_dropoff_phone_number === "string" ? d.dasher_dropoff_phone_number : null;
  return { name, phone };
}

function minutesBetween(fromMs: number, iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - fromMs) / 60000)) : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const QUOTE_TTL_MS = 5 * 60 * 1000;

export function makeDoorDashProvider(cfg: DoorDashConfig, fetchImpl: FetchLike = fetch): DeliveryProvider {
  const base = cfg.baseUrl ?? DOORDASH_BASE_URL;
  const now = cfg.now ?? Date.now;

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await doordashJwt(cfg, now())}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: text.slice(0, 200) };
    }
    return { status: res.status, json };
  }

  function fail(op: string, r: { status: number; json: any }): never {
    const msg = r.json?.message || r.json?.code || `http ${r.status}`;
    throw new DoorDashError(r.status, r.json, `doordash ${op} failed: ${msg}`);
  }

  function deliveryBody(req: CreateRequest, externalId: string): Record<string, unknown> {
    return {
      external_delivery_id: externalId,
      ...placeFields("pickup", req.pickup),
      ...placeFields("dropoff", {
        ...req.dropoff,
        notes: req.dropoff_notes ?? req.dropoff.notes,
      }),
      order_value: req.order_value_cents ?? 0,
      tip: req.tip_cents,
      pickup_time: req.pickup_ready_at,
      items: req.items.map((i) => ({ name: i.name, quantity: i.qty })),
      // decision 4 default: the customer gets the tracking link in our receipt, not texts from DoorDash
      dropoff_contact_send_notifications: false,
    };
  }

  function toCreateResult(json: any, deliveryId: string): CreateResult {
    return {
      delivery_id: deliveryId,
      tracking_url: typeof json?.tracking_url === "string" ? json.tracking_url : null,
      status: mapDeliveryStatus(json?.delivery_status) === "quoted"
        ? "created"
        : mapDeliveryStatus(json?.delivery_status),
      fee_cents: Number(json?.fee ?? 0),
      raw: json,
    };
  }

  return {
    name: "doordash",

    async quote(req: QuoteRequest): Promise<DeliveryQuote | QuoteError> {
      // a fresh DoorDash id per quote: re-quoting before the pay link must not collide,
      // even twice in the same millisecond
      const salt = crypto.getRandomValues(new Uint8Array(2)).reduce((s, b) => s + b.toString(36).padStart(2, "0"), "");
      const quoteId = `${req.external_id}-${now().toString(36)}${salt}`;
      const t0 = now();
      let r;
      try {
        r = await call("POST", "/drive/v2/quotes", {
          external_delivery_id: quoteId,
          ...placeFields("pickup", req.pickup),
          ...placeFields("dropoff", req.dropoff),
          order_value: req.order_value_cents,
        });
      } catch (e) {
        return { error: `doordash quote network error: ${(e as Error).message}`, code: "unavailable" };
      }
      if (r.status < 200 || r.status >= 300) return mapQuoteError(r.status, r.json);
      const fee = Number(r.json?.fee);
      if (!Number.isInteger(fee) || fee < 0) return { error: "doordash quote had no fee", code: "provider" };
      return {
        provider: "doordash",
        quote_id: quoteId,
        fee_cents: fee,
        expires_at: new Date(t0 + QUOTE_TTL_MS).toISOString(),
        eta_min: minutesBetween(t0, r.json?.dropoff_time_estimated),
        raw: r.json,
      };
    },

    async create(req: CreateRequest): Promise<CreateResult> {
      const q = req.quote;
      if (q.provider === "doordash" && Date.parse(q.expires_at) > now()) {
        const r = await call("POST", `/drive/v2/quotes/${encodeURIComponent(q.quote_id)}/accept`, {
          tip: req.tip_cents,
        });
        if (r.status >= 200 && r.status < 300) return toCreateResult(r.json, q.quote_id);
        // expired or otherwise not acceptable: fall through to a direct create
        if (r.status >= 500 || r.status === 401 || r.status === 403) fail("accept", r);
      }
      // the quote's id is spent on DoorDash's side; book under a new one
      const deliveryId = `${q.quote_id}-d`;
      const r = await call("POST", "/drive/v2/deliveries", deliveryBody(req, deliveryId));
      if (r.status < 200 || r.status >= 300) fail("create", r);
      return toCreateResult(r.json, deliveryId);
    },

    async cancel(deliveryId: string): Promise<CancelResult> {
      const r = await call("PUT", `/drive/v2/deliveries/${encodeURIComponent(deliveryId)}/cancel`);
      if (r.status >= 200 && r.status < 300) {
        // UNVERIFIED: DoorDash does not document a cancellation-fee field on this response;
        // a cancel it accepts is treated as free, and a late one is refused (below)
        return { ok: true, fee_cents: 0 };
      }
      // refused (Dasher already has the food): the order becomes a return, billed at DoorDash's return rate
      if (r.status === 400 || r.status === 409 || r.status === 422) return { ok: false, fee_cents: 0 };
      fail("cancel", r);
    },

    async get(deliveryId: string): Promise<GetResult> {
      const r = await call("GET", `/drive/v2/deliveries/${encodeURIComponent(deliveryId)}`);
      if (r.status < 200 || r.status >= 300) fail("get", r);
      return {
        status: mapDeliveryStatus(r.json?.delivery_status),
        courier: courierOf(r.json ?? {}),
        tracking_url: typeof r.json?.tracking_url === "string" ? r.json.tracking_url : null,
        raw: r.json,
      };
    },

    async verifyWebhook(req: Request): Promise<{ ok: boolean; event: WebhookEvent | null }> {
      if (!cfg.webhookSecret) return { ok: false, event: null };
      const auth = req.headers.get("authorization") ?? "";
      if (!timingSafeEqual(auth, cfg.webhookSecret)) return { ok: false, event: null };
      let body: any;
      try {
        body = await req.json();
      } catch {
        return { ok: false, event: null };
      }
      const deliveryId = typeof body?.external_delivery_id === "string" ? body.external_delivery_id : "";
      const eventName = typeof body?.event_name === "string" ? body.event_name : "";
      const status = mapEventName(eventName);
      // authentic but nothing we track (e.g. DASHER_LOCATION updates, batching notices)
      if (!deliveryId || status === "unknown") return { ok: true, event: null };
      return {
        ok: true,
        event: {
          delivery_id: deliveryId,
          status,
          provider_status: eventName,
          at: typeof body.created_at === "string" ? body.created_at : new Date(now()).toISOString(),
          courier: courierOf(body),
          tracking_url: typeof body.tracking_url === "string" ? body.tracking_url : null,
          // our cart id is the prefix of every DoorDash id we mint (see quote())
          external_id: deliveryId.replace(/-[0-9a-z]+(-d)?$/, ""),
        },
      };
    },
  };
}
