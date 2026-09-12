// Customer CRM (docs/specs/2026-09-03-customer-crm.md) — the "remembered
// diner" profile shared between stripe-webhook (writes, on paid order) and
// chat-sms (reads, at conversation start).
//
// Pure decision functions are kept separate from the two I/O functions
// (lookupCustomerContext / upsertCustomerProfile) so the ranking/merge/
// eligibility logic is unit-testable without a live database, matching this
// repo's pending-disambiguation.ts / guard9-unconsented-affirmation.ts
// precedent.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

export interface FavoriteItem {
  name:  string;
  count: number; // number of distinct PAID ORDERS containing this item name — never a unit/quantity sum.
}

export interface CustomerRow {
  tenant_id:         string;
  customer_phone:    string;
  name:              string | null;
  order_count:       number;
  total_spent_cents: number;
  favorite_items:    FavoriteItem[];
  last_order_id:     string | null;
  last_order_at:     string | null;
  last_order_type:      "pickup" | "delivery" | null;
  last_delivery_address: Record<string, unknown> | null;
}

const MAX_FAVORITE_ITEMS = 5;

/**
 * Canonicalize whatever raw string is currently used as `customer_phone` to
 * an E.164 phone (+1XXXXXXXXXX) when one can be confidently recovered, or
 * `null` when it can't (caller falls back to the raw value unchanged —
 * canonicalization must never invent an identity, only recover one that's
 * already embedded).
 *
 * Handles:
 *   - Already E.164 (`+16102565023`) → unchanged.
 *   - `web:imsg-p{digits}-{unix-timestamp}` — the iMessage-bridge's web
 *     session id, which embeds the real phone right after the `p` (confirmed
 *     against live rows, e.g. `web:imsg-p16102565023-1781561505`; the same
 *     `p(\d+)-` extraction already used at chat-sms/index.ts's outbound-
 *     delivery branch, reused here for identity instead of routing).
 *   - Anything else (bare `web:<uuid>` sessions, `web:imsg-{email-local}-*`
 *     email-derived ids, malformed digit runs) → null. These carry no
 *     recoverable phone; merging them would be a guess, not a canonicalization.
 */
export function canonicalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^\+[1-9]\d{9,14}$/.test(raw)) return raw;

  const bridgeMatch = raw.match(/^web:imsg-p(\d+)-\d+$/);
  if (bridgeMatch) {
    const digits = bridgeMatch[1];
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
  }

  return null;
}

/**
 * Merge one paid order's distinct item names into the existing favorite-item
 * ranking. `orderItemNames` is deduped by the caller's caller conceptually,
 * but deduped again here defensively — two of the same item in one order is
 * still ONE order containing it, not two, per AC6's "count" definition
 * (paid orders, not units).
 *
 * Returned array is sorted desc by count, ties broken by first-seen order
 * (stable sort), truncated to MAX_FAVORITE_ITEMS so the column never grows
 * unbounded across a long customer relationship.
 */
export function computeFavoriteItemsUpdate(
  existing:       FavoriteItem[],
  orderItemNames: string[],
): FavoriteItem[] {
  const counts = new Map<string, number>();
  for (const f of existing) counts.set(f.name, f.count);

  const distinctThisOrder = new Set(orderItemNames.map(n => n.trim()).filter(Boolean));
  for (const name of distinctThisOrder) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_FAVORITE_ITEMS);
}

/**
 * Q3 (spec open question, resolved by Jason): when pickup_name and
 * conversations.metadata.customer_name disagree, the LATEST PAID
 * pickup_name wins — money-attached names are more reliable than passing
 * mentions. This function only ever runs at paid-order time, so "latest
 * paid" is simply "this call" — a blank/whitespace-only pickup_name never
 * overwrites a previously known name (a paid order should never regress the
 * profile to anonymous).
 */
export function resolveCustomerName(
  existingName: string | null,
  pickupName:   string | null | undefined,
): string | null {
  const trimmed = pickupName?.trim();
  return trimmed ? trimmed : existingName;
}

export interface RegularItem {
  name:  string;
  count: number;
}

/**
 * AC6: "the regular" is only ever asserted when the top favorite item has
 * >= 3 paid orders. Below that threshold, chat-sms must ask instead of
 * guessing (spec pre-mortem #4 — a stale "regular" from a single fluke
 * order). Returns null when there is no eligible regular, including an
 * empty favorites list.
 */
export function regularEligibility(favoriteItems: FavoriteItem[]): RegularItem | null {
  const top = favoriteItems[0];
  if (!top || top.count < 3) return null;
  return { name: top.name, count: top.count };
}

/**
 * AC7: conversation-start personalization must be exactly ONE indexed query
 * on (tenant_id, customer_phone) against `customers` — no join-scan of
 * order_carts per message. This is that query. Returns null on any miss or
 * error (cold start — the caller's job, not this function's, to decide
 * whether that's "first-ever contact" or "opted out" etc).
 */
export async function lookupCustomerContext(
  supabase:      SupabaseClient,
  tenantId:      string,
  customerPhone: string,
): Promise<CustomerRow | null> {
  if (!tenantId || !customerPhone) return null;
  const key = canonicalizePhone(customerPhone) ?? customerPhone;
  const { data, error } = await supabase
    .from("customers")
    .select("tenant_id, customer_phone, name, order_count, total_spent_cents, favorite_items, last_order_id, last_order_at, last_order_type, last_delivery_address")
    .eq("tenant_id", tenantId)
    .eq("customer_phone", key)
    .maybeSingle();
  if (error) {
    console.error(`[customer-profile] lookupCustomerContext error for ${customerPhone}:`, error.message);
    return null;
  }
  return (data as CustomerRow | null) ?? null;
}

/**
 * Whether a write carrying `candidateOrderAt` is allowed to overwrite the
 * `last_order_*` denormalized fields, given whatever order timestamp is
 * already stored. There are now two writers of these fields — chat-sms at
 * submission time and stripe-webhook at payment time — and they can race:
 * a payment webhook can land (and run) after a customer has already placed
 * a NEWER order whose submission-time write already updated the row. Both
 * writers pass the ORDER'S OWN timestamp (order_carts.created_at), not
 * wall-clock "now" at write time, so this comparison is stable regardless
 * of processing delay: an older order can never clobber a newer order's
 * already-recorded state, whichever writer runs second.
 */
export function shouldUpdateLastOrder(
  existingLastOrderAt: string | null | undefined,
  candidateOrderAt:    string,
): boolean {
  if (!existingLastOrderAt) return true;
  return new Date(candidateOrderAt).getTime() >= new Date(existingLastOrderAt).getTime();
}

export interface OrderFulfillmentMemory {
  tenantId:        string;
  customerPhone:   string;
  orderId:         string;
  orderAt:         string; // ISO — the order's own created_at, not wall-clock write time (see shouldUpdateLastOrder).
  orderType:       "pickup" | "delivery";
  deliveryAddress: Record<string, unknown> | null;
}

/**
 * Write ONLY the last_order_type/last_delivery_address denormalized fields,
 * at ORDER SUBMISSION time — deliberately separate from upsertCustomerProfile,
 * which runs at PAID-order time and also increments order_count/
 * total_spent_cents/favorite_items. Those counters must only ever reflect
 * paid orders (see their column comments in migration 121), so this function
 * must never touch them — it exists because upsertCustomerProfile's only
 * call site (a completed Stripe checkout) fires so rarely in practice that
 * the delivery-memory columns it was meant to populate stayed permanently
 * NULL (docs/specs/2026-09-12-returning-customer-delivery-memory.md).
 *
 * Idempotent/upsert, and safe to call whether or not the order is ever paid:
 * whichever of this or upsertCustomerProfile last passes the
 * shouldUpdateLastOrder check simply reflects the latest known fulfillment
 * state.
 */
export async function upsertOrderFulfillmentMemory(
  supabase: SupabaseClient,
  memory:   OrderFulfillmentMemory,
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  if (!memory.tenantId || !memory.customerPhone) {
    return { ok: false, error: "missing tenantId/customerPhone" };
  }
  const customerPhone = canonicalizePhone(memory.customerPhone) ?? memory.customerPhone;

  const { data: existing, error: fetchErr } = await supabase
    .from("customers")
    .select("last_order_at")
    .eq("tenant_id", memory.tenantId)
    .eq("customer_phone", customerPhone)
    .maybeSingle();
  if (fetchErr) {
    console.error(`[customer-profile] upsertOrderFulfillmentMemory fetch error for ${customerPhone}:`, fetchErr.message);
    return { ok: false, error: fetchErr.message };
  }

  if (!shouldUpdateLastOrder(existing?.last_order_at as string | null, memory.orderAt)) {
    return { ok: true, skipped: true };
  }

  const { error: upsertErr } = await supabase
    .from("customers")
    .upsert({
      tenant_id:             memory.tenantId,
      customer_phone:        customerPhone,
      last_order_id:         memory.orderId,
      last_order_at:         memory.orderAt,
      last_order_type:       memory.orderType,
      last_delivery_address: memory.deliveryAddress,
      last_seen_at:          memory.orderAt,
      updated_at:            memory.orderAt,
    }, { onConflict: "tenant_id, customer_phone" });
  if (upsertErr) {
    console.error(`[customer-profile] upsertOrderFulfillmentMemory upsert error for ${customerPhone}:`, upsertErr.message);
    return { ok: false, error: upsertErr.message };
  }
  return { ok: true };
}

export interface PaidOrderForProfile {
  tenantId:      string;
  customerPhone: string;
  pickupName:    string | null;
  totalCents:    number;
  itemNames:     string[]; // cart_json item names for this one paid order (may contain dupes — deduped internally)
  orderId:       string;
  orderAt:       string;   // ISO timestamp
  orderType:      "pickup" | "delivery";
  deliveryAddress: Record<string, unknown> | null;
}

/**
 * Upsert the customer profile after ONE order reaches paid. Called from
 * stripe-webhook's handleOrderPaymentComplete — the single authoritative
 * "this order is now paid" event, so there is exactly one writer and no
 * double-count race between chat-sms and stripe-webhook both reacting to
 * the same payment.
 *
 * Fetch-then-write (not a single upsert SQL statement) because
 * favorite_items requires reading the existing ranked array to merge into —
 * Postgres jsonb has no built-in "increment this key in this array" op that
 * wouldn't be far less readable than doing the merge in application code
 * via the pure computeFavoriteItemsUpdate above.
 */
export async function upsertCustomerProfile(
  supabase: SupabaseClient,
  order:    PaidOrderForProfile,
): Promise<{ ok: boolean; error?: string }> {
  if (!order.tenantId || !order.customerPhone) {
    return { ok: false, error: "missing tenantId/customerPhone" };
  }
  const customerPhone = canonicalizePhone(order.customerPhone) ?? order.customerPhone;

  const { data: existing, error: fetchErr } = await supabase
    .from("customers")
    .select("name, order_count, total_spent_cents, favorite_items, last_order_at")
    .eq("tenant_id", order.tenantId)
    .eq("customer_phone", customerPhone)
    .maybeSingle();
  if (fetchErr) {
    console.error(`[customer-profile] upsertCustomerProfile fetch error for ${customerPhone}:`, fetchErr.message);
    return { ok: false, error: fetchErr.message };
  }

  const existingFavorites = (existing?.favorite_items as FavoriteItem[] | null) ?? [];
  const favoriteItems = computeFavoriteItemsUpdate(existingFavorites, order.itemNames);
  const name = resolveCustomerName(existing?.name ?? null, order.pickupName);
  // order_count/total_spent_cents/favorite_items always accumulate — this is
  // the one authoritative "a paid order just happened" event regardless of
  // arrival order. Only the "most recent order" denormalized fields need the
  // recency guard, since chat-sms's submission-time write (see
  // upsertOrderFulfillmentMemory above) may have already recorded a NEWER
  // order by the time this payment webhook for an OLDER order is processed.
  const updateLastOrder = shouldUpdateLastOrder(existing?.last_order_at as string | null, order.orderAt);

  const { error: upsertErr } = await supabase
    .from("customers")
    .upsert({
      tenant_id:         order.tenantId,
      customer_phone:    customerPhone,
      name,
      last_seen_at:      order.orderAt,
      order_count:       (existing?.order_count ?? 0) + 1,
      total_spent_cents: (existing?.total_spent_cents ?? 0) + order.totalCents,
      favorite_items:    favoriteItems,
      ...(updateLastOrder ? {
        last_order_id:         order.orderId,
        last_order_at:         order.orderAt,
        last_order_type:       order.orderType,
        last_delivery_address: order.deliveryAddress,
      } : {}),
      updated_at:        order.orderAt,
      ...(existing ? {} : { first_seen_at: order.orderAt }),
    }, { onConflict: "tenant_id, customer_phone" });
  if (upsertErr) {
    console.error(`[customer-profile] upsertCustomerProfile upsert error for ${order.customerPhone}:`, upsertErr.message);
    return { ok: false, error: upsertErr.message };
  }
  return { ok: true };
}
