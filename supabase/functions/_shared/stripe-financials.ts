/**
 * _shared/stripe-financials.ts — Stripe fee + payout helpers for shop-financials.
 *
 * Phase 2: replaces estimated fees with REAL fees from Stripe Balance Transactions
 * tied to each order's charge. Supports both live (STRIPE_SECRET_KEY) and test-mode
 * (STRIPE_TEST_SECRET_KEY) shops, routing lookups through the connected account when
 * the charge lives there (direct-charge model).
 */

import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { makeStripe, connectedAccountOpts } from "./connect.ts";
import { isTestKey } from "./test-mode.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StripeFeeResult {
  fee_cents: number;
  net_cents: number;
  status: string;
}

export interface StripePayoutSummary {
  id: string;
  arrival_date: number; // unix seconds
  amount_cents: number;
  amount: string;
  status: string;
  automatic: boolean;
  transaction_count: number;
  matched_order_count: number;
}

// ─── Key resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the correct Stripe key for a shop's mode.
 * Live orders → STRIPE_SECRET_KEY; test orders → STRIPE_TEST_SECRET_KEY (allowlist-gated).
 * Returns empty string if the required key is missing/invalid.
 */
export function resolveStripeKey(isTestMode: boolean): string {
  if (isTestMode) {
    const key = (Deno.env.get("STRIPE_TEST_SECRET_KEY") ?? "").trim();
    if (!key || !isTestKey(key)) {
      console.error(
        "[stripe-financials] HARD-GATE: test_mode=true but STRIPE_TEST_SECRET_KEY missing or invalid.",
      );
      return "";
    }
    return key;
  }
  return (Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim();
}

// ─── Fee lookup ─────────────────────────────────────────────────────────────

/**
 * Batch-fetch real Stripe fees for a set of charge IDs.
 *
 * Each entry: { charge_id, connected_account_id (null for platform/test charges) }.
 * Returns a map: chargeId → StripeFeeResult.
 *
 * Uses expand: ['balance_transaction'] on charge retrieval so the balance txn
 * is inlined — one API call per charge instead of two.
 */
export async function batchFetchFees(
  stripeKey: string,
  charges: Array<{ charge_id: string; connected_account_id: string | null }>,
): Promise<Map<string, StripeFeeResult>> {
  const result = new Map<string, StripeFeeResult>();
  if (!stripeKey || charges.length === 0) return result;

  const stripe = makeStripe(stripeKey);

  const resolutions = await Promise.allSettled(
    charges.map(async ({ charge_id, connected_account_id }) => {
      const opts: Stripe.RequestOptions = connected_account_id
        ? connectedAccountOpts(connected_account_id)
        : {};

      const charge = await stripe.charges.retrieve(charge_id, {
        expand: ["balance_transaction"],
      }, opts);

      const bt =
        typeof charge.balance_transaction === "string"
          ? null
          : (charge.balance_transaction as Stripe.BalanceTransaction | null);

      return { charge_id, bt };
    }),
  );

  for (const r of resolutions) {
    if (r.status === "rejected") {
      console.warn(`[stripe-financials] Failed to fetch charge: ${r.reason}`);
      continue;
    }
    const { charge_id, bt } = r.value;
    if (bt && bt.status === "available" && typeof bt.fee === "number") {
      result.set(charge_id, {
        fee_cents: bt.fee,
        net_cents: bt.net,
        status: bt.status,
      });
    }
    // If bt is null or status is "pending" — balance not yet settled → no entry in map.
    // Caller falls back to estimate.
  }

  return result;
}

// ─── Aggregate helpers ──────────────────────────────────────────────────────

/**
 * Build a map of charge_id → fee_cents from resolved balance transactions.
 */
export function buildFeeMap(fees: Map<string, StripeFeeResult>): Map<string, number> {
  const m = new Map<string, number>();
  for (const [chargeId, result] of fees) {
    m.set(chargeId, result.fee_cents);
  }
  return m;
}

// ─── Payout listing ─────────────────────────────────────────────────────────

/**
 * List recent payouts for a connected account. Falls back to platform account
 * if connectedAccountId is null (test-mode shops may not have Connect).
 */
export async function listPayouts(
  stripeKey: string,
  connectedAccountId: string | null,
  limit: number,
): Promise<Stripe.Payout[]> {
  if (!stripeKey) return [];

  const stripe = makeStripe(stripeKey);
  const opts: Stripe.RequestOptions = connectedAccountId
    ? connectedAccountOpts(connectedAccountId)
    : {};

  const payouts = await stripe.payouts.list({ limit: Math.min(limit, 100) }, opts);
  return payouts.data;
}

/**
 * List balance transactions for a specific payout on a connected account.
 * Returns up to `limit` transactions (max 100).
 */
export async function listPayoutTransactions(
  stripeKey: string,
  payoutId: string,
  connectedAccountId: string | null,
  limit: number,
): Promise<Stripe.BalanceTransaction[]> {
  if (!stripeKey) return [];

  const stripe = makeStripe(stripeKey);
  const opts: Stripe.RequestOptions = connectedAccountId
    ? connectedAccountOpts(connectedAccountId)
    : {};

  const txnList = await stripe.balanceTransactions.list(
    { payout: payoutId, limit: Math.min(limit, 100) },
    opts,
  );
  return txnList.data;
}
