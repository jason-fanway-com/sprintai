// _shared/delivery-paid.ts — what stripe-webhook calls when a delivery cart is paid: load the cart,
// shop and customer, and book a courier when the shop uses one. Never throws: the payment has already
// succeeded, so a booking failure is recorded (deliveries.error + a sev_1 issue) for a human to act on,
// and the kitchen ticket says the courier is not booked.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { e164OrNull, type DeliveryProvider, type Place } from "./delivery.ts";
import { isCourierProvider } from "./delivery-providers.ts";
import { bookDelivery, type BookResult } from "./delivery-store.ts";

export type PaidBookOutcome =
  | { booked: false; reason: "not_delivery" | "own_driver" | "no_cart" | "no_shop" }
  | { booked: false; reason: "no_credentials" | "no_address" | "failed"; error: string }
  | { booked: true; delivery_id: string; tracking_url: string | null; fee_cents: number | null; already: boolean };

interface CartRow {
  id: string; shop_id: string; conversation_id: string; order_type: string | null; test_mode: boolean | null;
  delivery_address: { formatted?: string; lat?: number; lng?: number; notes?: string } | null;
  cart_json: Array<{ name?: string; quantity?: number; type?: string }> | null;
  subtotal_cents: number | null; driver_tip_cents: number | null; pickup_name: string | null; order_number: number | null;
}
interface ShopRow {
  id: string; tenant_id: string; name: string; formatted_address: string | null; latitude: number | null; longitude: number | null;
  phone_number_e164: string | null; courier_pickup_phone: string | null; courier_pickup_notes: string | null;
  delivery_provider: string | null; prep_minutes: number | null;
}

export async function bookCourierForPaidCart(
  db: SupabaseClient, cart_id: string, providerFor: (name: string, test: boolean) => DeliveryProvider | null, now = new Date(),
): Promise<PaidBookOutcome> {
  const { data: c } = await db.from("order_carts")
    .select("id, shop_id, conversation_id, order_type, test_mode, delivery_address, cart_json, subtotal_cents, driver_tip_cents, pickup_name, order_number")
    .eq("id", cart_id).maybeSingle();
  const cart = c as CartRow | null;
  if (!cart) return { booked: false, reason: "no_cart" };
  if (cart.order_type !== "delivery") return { booked: false, reason: "not_delivery" };
  const { data: s } = await db.from("shops")
    .select("id, tenant_id, name, formatted_address, latitude, longitude, phone_number_e164, courier_pickup_phone, courier_pickup_notes, delivery_provider, prep_minutes")
    .eq("id", cart.shop_id).maybeSingle();
  const shop = s as ShopRow | null;
  if (!shop) return { booked: false, reason: "no_shop" };
  if (!isCourierProvider(shop.delivery_provider)) return { booked: false, reason: "own_driver" };

  const fail = async (reason: "no_credentials" | "no_address" | "failed", error: string): Promise<PaidBookOutcome> => {
    await raiseIssue(db, shop, cart, error);
    return { booked: false, reason, error };
  };
  const test = cart.test_mode === true;
  const provider = providerFor(shop.delivery_provider, test);
  if (!provider) return fail("no_credentials", `${shop.delivery_provider} ${test ? "sandbox" : "live"} credentials are not configured`);
  const dropAddr = cart.delivery_address?.formatted;
  if (!dropAddr || !shop.formatted_address) return fail("no_address", !dropAddr ? "the cart has no delivery address" : "the shop has no formatted_address");

  const { data: conv } = await db.from("conversations").select("customer_phone").eq("id", cart.conversation_id).maybeSingle();
  const pickupPhone = e164OrNull(shop.courier_pickup_phone) ?? e164OrNull(shop.phone_number_e164);
  // a web test conversation has no phone ("web:<session>"): in test mode the courier gets the shop's number instead
  const rawPhone = (conv as { customer_phone: string | null } | null)?.customer_phone ?? null;
  const customerPhone = e164OrNull(rawPhone) ?? (test ? pickupPhone : null);
  if (!customerPhone || !pickupPhone) return fail("no_address", !customerPhone ? "no customer phone on the conversation" : "the shop has no pickup phone");

  const pickup: Place = { name: shop.name, address: shop.formatted_address, lat: shop.latitude, lng: shop.longitude, phone: pickupPhone, notes: shop.courier_pickup_notes };
  const dropoff: Place = {
    name: cart.pickup_name || "Customer", address: dropAddr,
    lat: cart.delivery_address?.lat ?? null, lng: cart.delivery_address?.lng ?? null, phone: customerPhone, notes: cart.delivery_address?.notes ?? null,
  };
  const items = (cart.cart_json ?? []).filter((i) => i.name).map((i) => ({ name: String(i.name), qty: i.type === "bundle" ? 1 : Math.max(1, i.quantity ?? 1) }));
  let r: BookResult;
  try {
    r = await bookDelivery(db, provider, {
      cart_id: cart.id, shop_id: shop.id, test_mode: test, pickup, dropoff, items,
      order_value_cents: cart.subtotal_cents ?? 0, tip_cents: cart.driver_tip_cents ?? 0,
      dropoff_notes: dropoff.notes, prep_minutes: shop.prep_minutes ?? 20, now,
    });
  } catch (e) {
    return fail("failed", `booking threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!r.ok) {
    if (r.stage === "busy") return { booked: false, reason: "failed", error: r.error }; // another delivery of this webhook is booking it
    return fail("failed", r.error);
  }
  return { booked: true, delivery_id: r.row.delivery_id!, tracking_url: r.row.tracking_url, fee_cents: r.row.fee_cents, already: r.already };
}

async function raiseIssue(db: SupabaseClient, shop: ShopRow, cart: CartRow, error: string): Promise<void> {
  console.error(`[delivery] CRITICAL: courier not booked for paid cart ${cart.id} (shop ${shop.id}): ${error}`);
  try {
    await db.from("issues").insert({
      tenant_id: shop.tenant_id, shop_id: shop.id, conversation_id: cart.conversation_id, severity: "sev_1",
      detection_rule: "courier_not_booked",
      title: `Paid delivery order #${cart.order_number ?? cart.id} has no courier`,
      description: `The customer paid for delivery but no ${shop.delivery_provider} courier was booked: ${error}. Book one by hand, have the shop deliver, or refund.`,
      metadata: { cart_id: cart.id, provider: shop.delivery_provider, error },
    });
  } catch (e) { console.error("[delivery] could not write the issue row", e); }
}
