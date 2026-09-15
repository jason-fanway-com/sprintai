// Turn Engine, Phase 3c (docs/specs/2026-09-14-turn-engine-oversight.md §4
// Phase 3) — closes the gap turn-engine-runner.ts's own header flagged: a
// cart that reached dialogue_state.phase "link_sent" on the engine path had
// no Stripe checkout session behind it (turnResult.reply rendered with no
// payment link). This module is the ONE place either path — the legacy
// submit_order case in index.ts, or the turn-engine routing branch also in
// index.ts — creates a real Stripe checkout session. Never a second copy of
// this call anywhere in the codebase.
//
// Money discipline: every cents value below (subtotal, service fee, delivery
// fee, tip) is a plain input, already computed upstream by the itemizer /
// already stamped onto each cart line's own price_cents by ask-plan-engine.ts
// at add/modify time. createCheckoutSession only SUMS these already-decided
// numbers to build Stripe's line items and the total_cents bookkeeping
// column — it never derives a price from a menu item, option group, or
// quantity itself. buildEngineCheckoutSessionInput (the engine path's own
// adapter into this contract) follows the same rule: its subtotal is a sum
// over cart lines whose price_cents was already computed by ask-plan-engine.ts
// (the same primitive DECIDE/ANSWER use to mutate the cart, see
// turn-engine.ts's header) — never a fresh price lookup.
//
// DI discipline matches propose.ts / turn-engine-runner.ts: the Supabase
// client and the Stripe client are both injected. No Deno.env access and no
// `new Stripe(...)` inside this file — callers resolve the test/live key
// (via the existing getTestModeStripeKey() hard-gate in test-mode.ts) and
// construct the Stripe client themselves, since what happens when the key is
// missing differs by caller (legacy returns a tool-result error object; the
// engine path has no tool loop to return into, so it must fall back to
// RENDER's own reply). That resolution + hard-gate logic is intentionally
// NOT extracted here — see index.ts's appendEngineCheckoutLinkIfReady for the
// engine path's copy of the identical three-line hard-gate the legacy
// submit_order case has always had.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import type Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { SERVICE_FEE_CENTS } from "../_shared/connect.ts";
import type { TurnEngineCartLine } from "./turn-engine.ts";

export interface CheckoutLineItemInput {
  name:             string;
  quantity:         number;
  unitAmountCents:  number;
  description?:     string;
}

export interface CreateCheckoutSessionInput {
  cartId:            string;
  shopName:          string;
  testMode:          boolean;
  // Already-priced lines only (menu items / bundles) — never fees. Fees are
  // their own explicit cents inputs below, appended as their own Stripe line
  // items the same way the legacy submit_order case has always done it.
  lineItems:         CheckoutLineItemInput[];
  subtotalCents:     number;
  serviceFeeCents:   number;
  deliveryFeeCents:  number;
  tipCents:          number;
  orderType:         "pickup" | "delivery";
  notes?:            string;
}

export interface CreateCheckoutSessionDeps {
  supabase:       SupabaseClient;
  stripe:         Stripe;
  // DI seam for tests — defaults to the same short-code shape the legacy
  // submit_order case has always minted (crypto.randomUUID, no hyphens,
  // first 8 chars).
  newShortCode?:  () => string;
}

export type CreateCheckoutSessionResult =
  | { ok: true; sessionId: string; checkoutUrl: string; totalCents: number }
  | { ok: false; error: string };

// The ONE Stripe checkout-session-create call site in this codebase (see
// this file's header). Defensive empty-cart check below exists because the
// legacy submit_order case already rejects an empty cart BEFORE ever
// reaching this function (see index.ts's submit_order case, unchanged) — but
// the turn-engine routing branch has no equivalent pre-check of its own (see
// index.ts's appendEngineCheckoutLinkIfReady header note), so this function
// is the only choke point that protects that caller from ever creating a
// zero-item Stripe session. Flagged in the dispatch report as a gate that
// moved here rather than staying legacy-only, because the engine path
// genuinely has nothing else guarding it.
export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
  deps: CreateCheckoutSessionDeps,
): Promise<CreateCheckoutSessionResult> {
  if (input.lineItems.length === 0) {
    return { ok: false, error: "Cart is empty. Please add items before submitting." };
  }

  // deno-lint-ignore no-explicit-any
  const stripeLineItems: any[] = input.lineItems.map(li => ({
    price_data: {
      currency:     "usd",
      unit_amount:  li.unitAmountCents,
      product_data: { name: li.name, description: li.description || undefined },
    },
    quantity: li.quantity,
  }));

  if (input.notes) {
    stripeLineItems.push({
      price_data: {
        currency:     "usd",
        unit_amount:  0,
        product_data: { name: `Prep Notes: ${input.notes}`, description: undefined },
      },
      quantity: 1,
    });
  }

  if (input.orderType === "delivery" && input.deliveryFeeCents > 0) {
    stripeLineItems.push({
      price_data: {
        currency:     "usd",
        unit_amount:  input.deliveryFeeCents,
        product_data: { name: "Delivery fee", description: undefined },
      },
      quantity: 1,
    });
  }

  if (input.tipCents > 0) {
    stripeLineItems.push({
      price_data: {
        currency:     "usd",
        unit_amount:  input.tipCents,
        product_data: { name: "Driver tip", description: undefined },
      },
      quantity: 1,
    });
  }

  stripeLineItems.push({
    price_data: {
      currency:     "usd",
      unit_amount:  input.serviceFeeCents,
      product_data: { name: "Service fee", description: "SprintAI platform service fee" },
    },
    quantity: 1,
  });

  const totalCents = input.subtotalCents + input.serviceFeeCents + input.deliveryFeeCents + input.tipCents;

  const session = await deps.stripe.checkout.sessions.create({
    mode:                 "payment",
    payment_method_types: ["card"],
    line_items:           stripeLineItems,
    metadata:             { order_cart_id: input.cartId, notes: input.notes ?? "" },
    custom_text:          { submit: { message: `Your order from ${input.shopName}${input.notes ? ` -- ${input.notes}` : ""}` } },
    success_url:          input.testMode
      ? `https://getsprintai.com/order-success-test?cart=${input.cartId}`
      : `https://getsprintai.com/order-success?cart=${input.cartId}`,
    cancel_url:           `https://getsprintai.com/order-cancel?cart=${input.cartId}`,
  });

  await deps.supabase.from("order_carts").update({
    subtotal_cents:              input.subtotalCents,
    service_fee_cents:           input.serviceFeeCents,
    total_cents:                 totalCents,
    delivery_fee_cents:          input.deliveryFeeCents,
    driver_tip_cents:            input.tipCents,
    stripe_checkout_session_id:  session.id,
    phase:                       "checkout",
  }).eq("id", input.cartId);

  // Short branded link: pay.getsprintai.com/o/<code> → 302 → Supabase → 302 →
  // Stripe. Fire-and-forget, same as the legacy submit_order case — the
  // returned checkoutUrl never depends on this insert succeeding, only ever
  // on the Stripe session itself.
  const shortCode = (deps.newShortCode ?? (() => crypto.randomUUID().replace(/-/g, "").slice(0, 8)))();
  deps.supabase.from("pay_links").insert({
    cart_id:    input.cartId,
    short_code: shortCode,
    stripe_url: session.url!,
    // deno-lint-ignore no-explicit-any
  }).then(({ error }: { error: unknown }) => {
    if (error) console.error("[checkout-session] Failed to insert pay_link:", error);
  });

  const checkoutUrl = `https://pay.getsprintai.com/o/${shortCode}`;
  return { ok: true, sessionId: session.id, checkoutUrl, totalCents };
}

// ─── Engine-path adapter ────────────────────────────────────────────────────
//
// Turns the engine's own cart-line shape (TurnEngineCartLine, from
// ask-plan-engine.ts via turn-engine.ts) into CreateCheckoutSessionInput.
// Pure — no I/O — so it's unit-testable with plain fixtures. Bundles never
// appear on this path (TurnEngineCartLine has no "type: bundle" variant —
// see turn-engine.ts's TurnEngineCartLine = CompiledCartLine), so unlike the
// legacy submit_order case's own line-item mapping, there is no bundle
// branch to carry over here.

export function buildEngineCheckoutSessionInput(params: {
  cartId:            string;
  shopName:          string;
  testMode:          boolean;
  cartLines:         TurnEngineCartLine[];
  notes?:            string | null;
  orderType:         "pickup" | "delivery";
  deliveryFeeCents?: number | null;
  tipCents?:         number | null;
}): CreateCheckoutSessionInput {
  const realLines = params.cartLines.filter(l => typeof l.menu_item_id === "string");

  const lineItems: CheckoutLineItemInput[] = realLines.map(l => ({
    name:            l.name,
    quantity:        l.quantity || 1,
    unitAmountCents: l.price_cents,
    description:     l.modifiers && l.modifiers.length > 0
      ? l.modifiers.join(", ")
      : (l.options ? Object.entries(l.options).map(([k, v]) => `${k}: ${v.join(", ")}`).join("; ") : undefined),
  }));

  const subtotalCents = realLines.reduce((s, l) => s + l.price_cents * (l.quantity || 1), 0);

  return {
    cartId:           params.cartId,
    shopName:         params.shopName,
    testMode:         params.testMode,
    lineItems,
    subtotalCents,
    serviceFeeCents:  SERVICE_FEE_CENTS,
    deliveryFeeCents: params.deliveryFeeCents ?? 0,
    tipCents:         params.tipCents ?? 0,
    orderType:        params.orderType,
    notes:            params.notes ?? undefined,
  };
}

// Mirrors index.ts's own checkoutUrl-append logic verbatim (search
// "checkoutUrl && !finalReply.includes(checkoutUrl)" in index.ts) — same SMS
// length handling, same "Pay here:" phrasing. Extracted so the engine path's
// append (index.ts's appendEngineCheckoutLinkIfReady) calls this instead of
// hand-writing a second, potentially-divergent truncation rule. The legacy
// site itself is untouched — it is reachable only from `runOrderingLoop`,
// which this dispatch does not modify.
export function appendCheckoutLink(reply: string, checkoutUrl: string | undefined, isSms: boolean): string {
  if (!checkoutUrl || reply.includes(checkoutUrl)) return reply;
  const combined = `${reply}\n\nPay here: ${checkoutUrl}`;
  return isSms
    ? (combined.length <= 1600 ? combined : `${reply.substring(0, 1200)}\n${checkoutUrl}`)
    : combined;
}
