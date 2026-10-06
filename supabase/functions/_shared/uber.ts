// _shared/uber.ts — Uber Direct adapter behind the DeliveryProvider contract (delivery.ts).
//
// Auth: OAuth2 client_credentials (scope eats.deliveries); the token lives ~30 days and is
// cached per client id in memory. API: https://developer.uber.com/docs/deliveries
//   POST /v1/customers/{customer_id}/delivery_quotes
//   POST /v1/customers/{customer_id}/deliveries
//   GET  /v1/customers/{customer_id}/deliveries/{id}
//   POST /v1/customers/{customer_id}/deliveries/{id}/cancel
// Webhooks (event.delivery_status, event.courier_update) carry an HMAC-SHA256 hex signature
// of the raw body in x-uber-signature (older: x-postmates-signature).
//
// Test credentials dispatch simulated deliveries; with `robo: true` the create call asks
// Uber's robo courier to walk the delivery through its lifecycle on its own.
import type {
  CancelResult, Courier, CreateRequest, CreateResult, DeliveryProvider, DeliveryQuote, DeliveryStatus,
  GetResult, Place, QuoteError, QuoteErrorCode, QuoteRequest, WebhookEvent,
} from "./delivery.ts";

export interface UberConfig {
  customer_id: string;
  client_id: string;
  client_secret: string;
  /** Developer → Webhooks signing key; without it every webhook is rejected */
  webhook_secret: string | null;
  /** test credentials: ask the robo courier to drive the lifecycle */
  robo: boolean;
  auth_url?: string;
  api_base?: string;
}

const AUTH_URL = "https://auth.uber.com/oauth/v2/token";
const API_BASE = "https://api.uber.com";

/**
 * Reads config from env. Test and production are separate credential sets:
 *   test: UBER_DIRECT_CUSTOMER_ID / UBER_DIRECT_CLIENT_ID / UBER_DIRECT_CLIENT_SECRET
 *   live: UBER_DIRECT_LIVE_CUSTOMER_ID / UBER_DIRECT_LIVE_CLIENT_ID / UBER_DIRECT_LIVE_CLIENT_SECRET
 * Webhook signing keys differ per environment: UBER_DIRECT_WEBHOOK_SECRET (test), UBER_DIRECT_WEBHOOK_SECRET_LIVE.
 * null when any client credential is missing.
 */
export function uberConfigFromEnv(test: boolean): UberConfig | null {
  const p = test ? "UBER_DIRECT_" : "UBER_DIRECT_LIVE_";
  const get = (k: string) => (Deno.env.get(k) ?? "").trim();
  const customer_id = get(`${p}CUSTOMER_ID`), client_id = get(`${p}CLIENT_ID`), client_secret = get(`${p}CLIENT_SECRET`);
  if (!customer_id || !client_id || !client_secret) return null;
  return { customer_id, client_id, client_secret, webhook_secret: get(test ? "UBER_DIRECT_WEBHOOK_SECRET" : "UBER_DIRECT_WEBHOOK_SECRET_LIVE") || null, robo: test };
}

/**
 * Signature checkers for the webhook, one per configured signing key (live first). They need only the key,
 * not client credentials: a live webhook must verify even before live client credentials are set.
 */
export function uberWebhookVerifiers(): DeliveryProvider[] {
  return ["UBER_DIRECT_WEBHOOK_SECRET_LIVE", "UBER_DIRECT_WEBHOOK_SECRET"]
    .map((k) => (Deno.env.get(k) ?? "").trim())
    .filter(Boolean)
    .map((webhook_secret) => makeUberProvider({ customer_id: "", client_id: "", client_secret: "", webhook_secret, robo: false }));
}

// ─── status mapping ────────────────────────────────────────────────────────
const STATUS: Record<string, DeliveryStatus> = {
  pending: "created",
  pickup: "courier_assigned", // courier on the way to the shop
  pickup_complete: "picked_up",
  dropoff: "picked_up", // courier on the way to the customer
  delivered: "dropped_off",
  canceled: "canceled",
  returned: "returned",
};
export function uberStatus(s: string | null | undefined): DeliveryStatus {
  return (s && STATUS[s]) || "unknown";
}

// ─── address shaping ───────────────────────────────────────────────────────
/**
 * Uber wants a structured address as a JSON string. Our addresses are Google's formatted
 * line ("5620 Cetronia Rd, Allentown, PA 18106, USA"); split it, or pass the line through
 * when it does not have that shape (Uber also geocodes a free-text line).
 */
export function uberAddress(formatted: string): string {
  const parts = formatted.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const hasCountry = /^(usa|us|united states)$/i.test(parts[parts.length - 1]);
    const body = hasCountry ? parts.slice(0, -1) : parts;
    const stateZip = body[body.length - 1].split(/\s+/);
    if (body.length >= 3 && stateZip.length >= 1 && /^[A-Za-z]{2}$/.test(stateZip[0])) {
      return JSON.stringify({
        street_address: body.slice(0, body.length - 2),
        city: body[body.length - 2],
        state: stateZip[0].toUpperCase(),
        zip_code: stateZip[1] ?? "",
        country: "US",
      });
    }
  }
  return formatted;
}

// ─── errors ────────────────────────────────────────────────────────────────
interface UberError { code?: string; message?: string; kind?: string; metadata?: unknown }
function quoteErrorCode(status: number, code: string | undefined): QuoteErrorCode {
  const c = code ?? "";
  if (c.startsWith("address_undeliverable") || c === "outside_delivery_area" || c === "delivery_distance_too_long") return "out_of_range";
  if (c === "unknown_location" || c === "invalid_address" || c === "address_invalid") return "bad_address";
  if (c === "couriers_busy" || c === "no_couriers_available" || c === "customer_limited" || c === "store_closed") return "unavailable";
  if (status === 429 || status >= 500) return "unavailable";
  return "provider";
}

export class UberApiError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) { super(message); }
}

// ─── token cache ───────────────────────────────────────────────────────────
const tokens = new Map<string, { token: string; until: number }>();
/** test seam */
export function _clearUberTokens(): void { tokens.clear(); }

// ─── hex HMAC ──────────────────────────────────────────────────────────────
async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export { hmacHex as _hmacHex };

// ─── delivery object → our shapes ──────────────────────────────────────────
interface UberCourier { name?: string; phone_number?: string | null }
interface UberDelivery {
  id: string; status: string; fee?: number; tracking_url?: string | null; courier?: UberCourier | null;
  external_id?: string | null; updated?: string; created?: string;
}
function courierOf(c: UberCourier | null | undefined): Courier | undefined {
  return c && c.name ? { name: c.name, phone: c.phone_number ?? null } : undefined;
}

export function makeUberProvider(cfg: UberConfig, fetchImpl: typeof fetch = fetch): DeliveryProvider {
  const authUrl = cfg.auth_url ?? AUTH_URL, base = `${cfg.api_base ?? API_BASE}/v1/customers/${encodeURIComponent(cfg.customer_id)}`;

  async function token(): Promise<string> {
    const hit = tokens.get(cfg.client_id);
    if (hit && hit.until > Date.now()) return hit.token;
    // eats.deliveries is the documented scope; some Direct organizations' keys refuse it by name (invalid_scope)
    // yet carry delivery access by default, so ask once more without naming a scope before giving up
    for (const scope of ["eats.deliveries", null]) {
      const res = await fetchImpl(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: cfg.client_id, client_secret: cfg.client_secret, grant_type: "client_credentials", ...(scope ? { scope } : {}) }),
      });
      if (res.ok) {
        const j = await res.json() as { access_token: string; expires_in?: number };
        const ttl = Math.max(60, (j.expires_in ?? 3600) - 300) * 1000; // refresh five minutes early
        tokens.set(cfg.client_id, { token: j.access_token, until: Date.now() + ttl });
        return j.access_token;
      }
      // OAuth errors are a short code ("invalid_client", "invalid_scope"); keep only that, never the rest of the body
      let code = ""; try { const e = await res.json() as { error?: unknown }; if (typeof e.error === "string" && /^[a-z_]{1,40}$/.test(e.error)) code = e.error; } catch { /* not JSON */ }
      if (code === "invalid_scope" && scope) continue;
      throw new UberApiError(res.status, "auth", `uber auth failed: HTTP ${res.status}${code ? ` ${code}` : ""}${scope ? "" : " (without a scope)"}`);
    }
    throw new UberApiError(400, "auth", "uber auth failed");
  }


  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; err: UberError }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401 && attempt === 0) { tokens.delete(cfg.client_id); continue; } // token revoked or rotated: fetch once more
      if (res.ok) return { ok: true, data: await res.json() as T };
      let err: UberError = {};
      try { err = await res.json() as UberError; } catch { /* non-JSON error body */ }
      return { ok: false, status: res.status, err };
    }
    return { ok: false, status: 401, err: { code: "unauthorized" } };
  }

  const placeFields = (prefix: "pickup" | "dropoff", p: Place) => ({
    [`${prefix}_address`]: uberAddress(p.address),
    ...(p.phone ? { [`${prefix}_phone_number`]: p.phone } : {}),
    ...(p.lat != null && p.lng != null ? { [`${prefix}_latitude`]: p.lat, [`${prefix}_longitude`]: p.lng } : {}),
  });

  return {
    name: "uber",

    async quote(req: QuoteRequest): Promise<DeliveryQuote | QuoteError> {
      let r;
      try {
        r = await call<{ id: string; fee: number; expires: string; duration?: number; dropoff_eta?: string }>("POST", "/delivery_quotes", {
          ...placeFields("pickup", req.pickup),
          ...placeFields("dropoff", req.dropoff),
          manifest_total_value: req.order_value_cents,
          external_store_id: req.external_id,
        });
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e), code: "unavailable" };
      }
      if (!r.ok) return { error: `${r.status} ${r.err.code ?? ""} ${r.err.message ?? ""}`.trim(), code: quoteErrorCode(r.status, r.err.code) };
      const q = r.data;
      return { provider: "uber", quote_id: q.id, fee_cents: q.fee, expires_at: q.expires, eta_min: typeof q.duration === "number" ? q.duration : null, raw: q };
    },

    async create(req: CreateRequest): Promise<CreateResult> {
      const r = await call<UberDelivery>("POST", "/deliveries", {
        quote_id: req.quote.quote_id,
        pickup_name: req.pickup.name,
        ...placeFields("pickup", req.pickup),
        ...(req.pickup.notes ? { pickup_notes: req.pickup.notes } : {}),
        dropoff_name: req.dropoff.name,
        ...placeFields("dropoff", req.dropoff),
        ...((req.dropoff_notes ?? req.dropoff.notes) ? { dropoff_notes: req.dropoff_notes ?? req.dropoff.notes } : {}),
        manifest_items: req.items.map((i) => ({ name: i.name, quantity: i.qty, size: "small" })),
        manifest_total_value: req.order_value_cents ?? 0,
        tip: req.tip_cents,
        // leave at the door by default, and if nobody answers too: a returned order costs a second delivery fee (Jason 2026-10-06)
        deliverable_action: "deliverable_action_leave_at_door",
        undeliverable_action: "leave_at_door",
        pickup_ready_dt: req.pickup_ready_at,
        external_id: req.external_id,
        ...(cfg.robo ? { test_specifications: { robo_courier_specification: { mode: "auto" } } } : {}),
      });
      if (!r.ok) throw new UberApiError(r.status, r.err.code, `uber create failed: ${r.status} ${r.err.code ?? ""} ${r.err.message ?? ""}`.trim());
      const d = r.data;
      return { delivery_id: d.id, tracking_url: d.tracking_url ?? null, status: uberStatus(d.status), fee_cents: d.fee ?? req.quote.fee_cents, raw: d };
    },

    async cancel(delivery_id: string): Promise<CancelResult> {
      const r = await call<UberDelivery>("POST", `/deliveries/${encodeURIComponent(delivery_id)}/cancel`, {});
      if (!r.ok) return { ok: false, fee_cents: 0 };
      // Uber does not return a separate cancellation charge; a cancel after pickup becomes a return, billed per their terms
      const st = uberStatus(r.data.status);
      return { ok: st === "canceled" || st === "returned", fee_cents: st === "returned" ? (r.data.fee ?? 0) : 0 };
    },

    async get(delivery_id: string): Promise<GetResult> {
      const r = await call<UberDelivery>("GET", `/deliveries/${encodeURIComponent(delivery_id)}`);
      if (!r.ok) throw new UberApiError(r.status, r.err.code, `uber get failed: ${r.status} ${r.err.code ?? ""}`.trim());
      return { status: uberStatus(r.data.status), courier: courierOf(r.data.courier), tracking_url: r.data.tracking_url ?? null, raw: r.data };
    },

    async verifyWebhook(req: Request): Promise<{ ok: boolean; event: WebhookEvent | null }> {
      if (!cfg.webhook_secret) return { ok: false, event: null };
      const body = await req.text();
      const sig = (req.headers.get("x-uber-signature") ?? req.headers.get("x-postmates-signature") ?? "").trim().toLowerCase();
      if (!sig || !safeEqual(sig, await hmacHex(cfg.webhook_secret, body))) return { ok: false, event: null };
      let p: { kind?: string; delivery_id?: string; status?: string; created?: string; data?: UberDelivery & { courier?: UberCourier | null } };
      try { p = JSON.parse(body); } catch { return { ok: false, event: null }; }
      const id = p.delivery_id ?? p.data?.id;
      if (!id) return { ok: true, event: null };
      if (p.kind === "event.delivery_status" || p.kind === "event.courier_update") {
        const provider_status = p.status ?? p.data?.status ?? "";
        return {
          ok: true,
          event: {
            delivery_id: id,
            status: uberStatus(provider_status),
            provider_status: p.kind === "event.courier_update" ? `courier_update:${provider_status}` : provider_status,
            at: p.created ?? p.data?.updated ?? new Date().toISOString(),
            courier: courierOf(p.data?.courier),
            tracking_url: p.data?.tracking_url ?? null,
            external_id: p.data?.external_id ?? null,
          },
        };
      }
      return { ok: true, event: null };
    },
  };
}
