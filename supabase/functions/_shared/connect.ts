/**
 * _shared/connect.ts — Stripe Connect shared helpers (DIRECT-CHARGE model)
 *
 * Confirmed economics (Jason 2026-06-20): order charges are DIRECT charges
 * created ON the connected account via the `Stripe-Account` header. Sprint
 * keeps a flat $0.99 `application_fee_amount` on top; the restaurant bears
 * Stripe's processing fee and owns disputes (Express => fees_payer
 * `application_express`; Standard => `account`). No destination charges,
 * no transfer_data, no on_behalf_of on order charges.
 *
 * VERIFY results recorded in repo VERIFIED.md.
 */

import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

/** Flat SprintAI platform service fee, in cents. Rides on top of food+tax. */
export const SERVICE_FEE_CENTS = 99;

/** Restaurant MCC — "Eating Places". */
export const RESTAURANT_MCC = "5812";

/** Capabilities every connected account must request. */
export const REQUIRED_CAPABILITIES = ["card_payments", "transfers"] as const;

/**
 * Minimal shape of a shop row used by the go-live gate. Only the fields the
 * gate needs are required; callers may pass the full row.
 */
export interface ShopLiveFields {
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  connect_status?: string | null;
  stripe_connected_account_id?: string | null;
}

/**
 * Go-live gate. A shop may route a LIVE order only when Stripe has fully
 * enabled the connected account. This is the single source of truth used by
 * create-checkout (spec 02) and the wizard (spec 05).
 *
 * Returns true ONLY when:
 *   - a connected account id exists, AND
 *   - charges_enabled === true, AND
 *   - payouts_enabled === true, AND
 *   - connect_status === 'enabled'.
 */
export function isShopLive(shop: ShopLiveFields | null | undefined): boolean {
  if (!shop) return false;
  return (
    !!shop.stripe_connected_account_id &&
    shop.charges_enabled === true &&
    shop.payouts_enabled === true &&
    shop.connect_status === "enabled"
  );
}

/**
 * Build a Stripe client from the deploy-time secret.
 *
 * ⚠️ SECRET HYGIENE: this reads `STRIPE_SECRET_KEY`. In Supabase that var
 * currently resolves to a LIVE key (see BUILD-REPORT). For any test-mode work
 * it MUST be repointed to the test key first. We never print the key.
 */
export function makeStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/**
 * Per-connected-account request options for DIRECT charges / reads.
 * `stripeAccount` sets the `Stripe-Account` header so the call runs ON the
 * connected account (direct charge), and `idempotencyKey` (when given)
 * de-dupes retries. The idempotency key is scoped per connected account by
 * Stripe automatically because the header changes the request context.
 */
export function connectedAccountOpts(
  connectedAccountId: string,
  idempotencyKey?: string,
): Stripe.RequestOptions {
  const opts: Stripe.RequestOptions = { stripeAccount: connectedAccountId };
  if (idempotencyKey) opts.idempotencyKey = idempotencyKey;
  return opts;
}

/**
 * Derive connect_status from a freshly-retrieved Stripe account object.
 *  - 'enabled'  when charges+payouts enabled AND no currently_due items
 *  - 'pending'  when capabilities not yet both enabled OR items still due
 *  - 'disabled' when Stripe has disabled charges on a previously-known account
 *
 * `previouslyKnown` lets us distinguish a brand-new pending account from one
 * Stripe actively disabled. Callers pass the shop's prior connect_status.
 */
export function deriveConnectStatus(
  account: Stripe.Account,
  previouslyKnown: string | null | undefined,
): "pending" | "enabled" | "disabled" {
  const charges = account.charges_enabled === true;
  const payouts = account.payouts_enabled === true;
  const due = account.requirements?.currently_due ?? [];
  const disabledReason = account.requirements?.disabled_reason ?? null;

  if (charges && payouts && due.length === 0) return "enabled";

  // If Stripe set a disabled_reason and we'd previously enabled the account,
  // treat it as disabled rather than pending.
  if (disabledReason && (previouslyKnown === "enabled" || previouslyKnown === "disabled")) {
    return "disabled";
  }

  return "pending";
}
