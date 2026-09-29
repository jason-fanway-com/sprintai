// _shared/delivery-store.ts — the deliveries table: book after payment, apply status webhooks,
// cancel on refund. Provider-agnostic; every call takes a DeliveryProvider (delivery.ts).
//
// Invariants:
//  - one deliveries row per cart (unique index): a replayed payment webhook cannot book twice;
//  - status only moves forward (isForward): out-of-order webhooks are logged, not applied;
//  - every webhook is appended to events once (same provider_status + at is a replay).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  isForward, isQuoteError, isTerminal,
  type DeliveryProvider, type DeliveryStatus, type Place, type WebhookEvent,
} from "./delivery.ts";

export interface DeliveryRow {
  id: string;
  cart_id: string;
  shop_id: string;
  provider: string;
  test_mode: boolean;
  quote_id: string | null;
  delivery_id: string | null;
  fee_cents: number | null;
  tip_cents: number;
  status: DeliveryStatus;
  tracking_url: string | null;
  courier_name: string | null;
  courier_phone: string | null;
  pickup_ready_at: string | null;
  error: string | null;
  events: Array<Record<string, unknown>>;
  updated_at: string;
}

const MAX_EVENTS = 100;

// ─── book ──────────────────────────────────────────────────────────────────
export interface BookInput {
  cart_id: string;
  shop_id: string;
  test_mode: boolean;
  pickup: Place;
  dropoff: Place;
  items: Array<{ name: string; qty: number }>;
  order_value_cents: number;
  tip_cents: number;
  dropoff_notes: string | null;
  prep_minutes: number;
  now?: Date;
}
export type BookResult =
  | { ok: true; row: DeliveryRow; already: boolean }
  | { ok: false; error: string; stage: "claim" | "quote" | "create" | "busy" };

/**
 * Quote fresh and book a courier for a paid cart. The quote the customer saw at checkout may be
 * minutes old (Uber quotes live 15 minutes); a fresh one right before create avoids an expired-quote
 * failure on a paid order. The fee we are billed is stored; what the customer paid stays on the cart.
 */
export async function bookDelivery(db: SupabaseClient, provider: DeliveryProvider, input: BookInput): Promise<BookResult> {
  const now = input.now ?? new Date();
  const pickup_ready_at = new Date(now.getTime() + input.prep_minutes * 60_000).toISOString();

  // claim the cart: the unique index on cart_id makes this the lock
  const claim = await db.from("deliveries").insert({
    cart_id: input.cart_id, shop_id: input.shop_id, provider: provider.name, test_mode: input.test_mode,
    tip_cents: input.tip_cents, status: "quoted", pickup_ready_at,
  }).select("*").maybeSingle();
  let row = claim.data as DeliveryRow | null;
  if (claim.error || !row) {
    const { data: existing } = await db.from("deliveries").select("*").eq("cart_id", input.cart_id).maybeSingle();
    const ex = existing as DeliveryRow | null;
    if (!ex) return { ok: false, error: `claim failed: ${claim.error?.message ?? "no row"}`, stage: "claim" };
    if (ex.delivery_id) return { ok: true, row: ex, already: true };
    if (!ex.error) return { ok: false, error: "booking already in progress", stage: "busy" };
    row = ex; // an earlier attempt failed: this retry may book
  }

  const q = await provider.quote({ pickup: input.pickup, dropoff: input.dropoff, order_value_cents: input.order_value_cents, external_id: input.cart_id });
  if (isQuoteError(q)) {
    const error = `quote ${q.code}: ${q.error}`.slice(0, 500);
    await db.from("deliveries").update({ error, updated_at: new Date().toISOString() }).eq("id", row.id);
    return { ok: false, error, stage: "quote" };
  }
  try {
    const c = await provider.create({
      quote: q, pickup: input.pickup, dropoff: input.dropoff, items: input.items, tip_cents: input.tip_cents,
      dropoff_notes: input.dropoff_notes, pickup_ready_at, external_id: input.cart_id, order_value_cents: input.order_value_cents,
    });
    const patch = {
      quote_id: q.quote_id, delivery_id: c.delivery_id, fee_cents: c.fee_cents, status: c.status, tracking_url: c.tracking_url,
      error: null, updated_at: new Date().toISOString(),
      events: [...(row.events ?? []), { at: now.toISOString(), status: c.status, provider_status: "created", source: "create" }],
    };
    const { data: upd } = await db.from("deliveries").update(patch).eq("id", row.id).select("*").maybeSingle();
    await db.from("order_carts").update({ delivery_status: c.status }).eq("id", input.cart_id);
    return { ok: true, row: (upd as DeliveryRow | null) ?? { ...row, ...patch } as DeliveryRow, already: false };
  } catch (e) {
    const error = `create: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    await db.from("deliveries").update({ quote_id: q.quote_id, error, updated_at: new Date().toISOString() }).eq("id", row.id);
    return { ok: false, error, stage: "create" };
  }
}

// ─── status webhooks ───────────────────────────────────────────────────────
export type ApplyResult =
  | { applied: true; status: DeliveryStatus; changed: boolean }
  | { applied: false; reason: "unknown_delivery" | "replay" | "conflict" };

export async function applyDeliveryEvent(db: SupabaseClient, providerName: string, ev: WebhookEvent): Promise<ApplyResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data } = await db.from("deliveries").select("*").eq("provider", providerName).eq("delivery_id", ev.delivery_id).maybeSingle();
    const row = data as DeliveryRow | null;
    if (!row) return { applied: false, reason: "unknown_delivery" };
    const events = row.events ?? [];
    if (events.some((e) => e.provider_status === ev.provider_status && e.at === ev.at)) return { applied: false, reason: "replay" };
    const forward = ev.status !== "unknown" && ev.status !== row.status && isForward(row.status, ev.status);
    const status = forward ? ev.status : row.status;
    const stamp = new Date().toISOString();
    const patch: Record<string, unknown> = {
      status,
      events: [...events, { at: ev.at, status: ev.status, provider_status: ev.provider_status, applied: forward, source: "webhook" }].slice(-MAX_EVENTS),
      updated_at: stamp,
      ...(ev.courier ? { courier_name: ev.courier.name, courier_phone: ev.courier.phone } : {}),
      ...(ev.tracking_url ? { tracking_url: ev.tracking_url } : {}),
      ...(forward && status === "picked_up" ? { picked_up_at: ev.at } : {}),
      ...(forward && status === "dropped_off" ? { dropped_off_at: ev.at } : {}),
      ...(forward && (status === "canceled" || status === "returned") ? { canceled_at: ev.at } : {}),
    };
    // optimistic: only if nobody else wrote since we read (two webhooks at once must not drop an event)
    const { data: upd } = await db.from("deliveries").update(patch).eq("id", row.id).eq("updated_at", row.updated_at).select("id");
    if (!upd || (upd as unknown[]).length === 0) continue;
    if (forward) await db.from("order_carts").update({ delivery_status: status }).eq("id", row.cart_id);
    return { applied: true, status, changed: forward };
  }
  return { applied: false, reason: "conflict" };
}

// ─── cancel ────────────────────────────────────────────────────────────────
export type CancelOutcome =
  | { cancelled: true; status: DeliveryStatus; fee_cents: number }
  | { cancelled: false; reason: "no_delivery" | "already_final" | "provider_refused" | "no_provider"; status?: DeliveryStatus };

export async function cancelDeliveryForCart(
  db: SupabaseClient, cart_id: string, providerFor: (name: string, test: boolean) => DeliveryProvider | null,
): Promise<CancelOutcome> {
  const { data } = await db.from("deliveries").select("*").eq("cart_id", cart_id).maybeSingle();
  const row = data as DeliveryRow | null;
  if (!row || !row.delivery_id) return { cancelled: false, reason: "no_delivery" };
  if (isTerminal(row.status)) return { cancelled: false, reason: "already_final", status: row.status };
  const provider = providerFor(row.provider, row.test_mode);
  if (!provider) return { cancelled: false, reason: "no_provider" };
  const r = await provider.cancel(row.delivery_id);
  if (!r.ok) return { cancelled: false, reason: "provider_refused", status: row.status };
  const status: DeliveryStatus = r.fee_cents > 0 ? "returned" : "canceled";
  const at = new Date().toISOString();
  await db.from("deliveries").update({
    status, cancel_fee_cents: r.fee_cents, canceled_at: at, updated_at: at,
    events: [...(row.events ?? []), { at, status, provider_status: "cancel", source: "refund" }].slice(-MAX_EVENTS),
  }).eq("id", row.id);
  await db.from("order_carts").update({ delivery_status: status }).eq("id", cart_id);
  return { cancelled: true, status, fee_cents: r.fee_cents };
}

/** the row the receipt and the ticket read; null when the cart has no courier delivery */
export async function deliveryForCart(db: SupabaseClient, cart_id: string): Promise<DeliveryRow | null> {
  const { data } = await db.from("deliveries").select("*").eq("cart_id", cart_id).maybeSingle();
  return (data as DeliveryRow | null) ?? null;
}
