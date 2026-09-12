#!/usr/bin/env -S deno run --allow-env --allow-net
/**
 * One-time backfill for returning-customer delivery memory
 * (docs/specs/2026-09-12-returning-customer-delivery-memory.md, migration
 * 135_customer_delivery_memory.sql). The only writers of
 * last_order_type/last_delivery_address are chat-sms at order-submission
 * time (see upsertOrderFulfillmentMemory, added alongside this script) and
 * stripe-webhook at paid-order time — both go forward only. Every existing
 * `customers` row predates both writers, so both columns are 100% NULL today
 * regardless of real order history. This script derives them retroactively
 * from order_carts.
 *
 * Algorithm: for each `customers` row, find that (tenant_id, customer_phone)
 * pair's most recent order_cart (by created_at) that has a non-null
 * delivery_address, across ANY payment_status — confirmed live 2026-09-12
 * that 0 of the last 40 order_carts have payment_status='paid', so a
 * paid-only backfill would touch almost nothing. Not "the true most-recent
 * order regardless of address": live data has abandoned/incomplete test
 * carts (order_type set, no address, no items) sitting AFTER a customer's
 * real last order chronologically — e.g. Jason's own Vito's history has a
 * cart from minutes ago with order_type='delivery' and delivery_address
 * still null. Backfilling from the true-latest-regardless-of-address cart
 * would set last_order_type='delivery' with a null address, which
 * computeDeliveryOffer (delivery-memory-offer.ts) treats as "downgrade to
 * pickup" — the opposite of what this backfill is for. Filtering to
 * address-bearing carts routes around that noise.
 *
 * Writes ONLY last_order_type/last_delivery_address directly — deliberately
 * does NOT go through upsertOrderFulfillmentMemory's shouldUpdateLastOrder
 * guard, and does NOT touch last_order_id/last_order_at. That guard compares
 * a candidate's created_at against the ALREADY-STORED last_order_at, but
 * every existing customers row's last_order_at was stamped by the
 * pre-this-fix stripe-webhook using wall-clock PAYMENT time, not the order's
 * own created_at (fixed alongside this script) — for an order placed at
 * 14:07 and paid at 14:12, the stored last_order_at reads 14:12, later than
 * that SAME order's own created_at, so the guard would wrongly call a
 * correct backfill "already fresher" and no-op it (caught in dry-run review
 * before this script was finalized). last_order_id/last_order_at are left
 * alone because they were already populated correctly by the existing
 * paid-order writer for these same rows; this script's only job is the two
 * columns nothing has ever written.
 *
 * Usage: set -a; source ~/.openclaw/.secrets; set +a
 *        SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *        SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *        deno run --allow-env --allow-net scripts/backfill-delivery-memory-20260912.ts [--apply]
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { canonicalizePhone } from "../supabase/functions/_shared/customer-profile.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Run: set -a; source ~/.openclaw/.secrets; set +a");
  Deno.exit(1);
}

const APPLY = Deno.args.includes("--apply");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ── 1. Every customers row currently missing delivery memory ───────────────
const { data: customerRows, error: customersErr } = await supabase
  .from("customers")
  .select("tenant_id, customer_phone, name, last_order_type, last_delivery_address");
if (customersErr) {
  console.error("Failed to fetch customers:", customersErr.message);
  Deno.exit(1);
}
console.log(`customers rows fetched: ${customerRows?.length ?? 0}`);

// ── 2. Every order_cart with a delivery address on file, newest first ──────
const { data: cartsRaw, error: cartsErr } = await supabase
  .from("order_carts")
  .select("id, created_at, order_type, delivery_address, payment_status, conversations(tenant_id, customer_phone)")
  .not("delivery_address", "is", null)
  .order("created_at", { ascending: false });
if (cartsErr) {
  console.error("Failed to fetch order_carts:", cartsErr.message);
  Deno.exit(1);
}
console.log(`order_carts with a non-null delivery_address: ${cartsRaw?.length ?? 0}`);

// ── 3. Latest address-bearing cart per (tenant_id, canonical phone) ────────
// cartsRaw is already newest-first, so the first hit per key wins.
interface CandidateCart {
  id: string;
  created_at: string;
  order_type: "pickup" | "delivery" | null;
  delivery_address: Record<string, unknown>;
  payment_status: string;
}
const latestByKey = new Map<string, CandidateCart>();
for (const c of cartsRaw ?? []) {
  const conv = c.conversations as unknown as { tenant_id?: string; customer_phone?: string } | null;
  if (!conv?.tenant_id || !conv?.customer_phone) continue;
  const canonical = canonicalizePhone(conv.customer_phone) ?? conv.customer_phone;
  const key = `${conv.tenant_id}::${canonical}`;
  if (!latestByKey.has(key)) {
    latestByKey.set(key, {
      id: c.id,
      created_at: c.created_at as string,
      order_type: (c.order_type as "pickup" | "delivery" | null) ?? null,
      delivery_address: c.delivery_address as Record<string, unknown>,
      payment_status: c.payment_status as string,
    });
  }
}

// ── 4. Match each customers row to its candidate, write, report ────────────
interface ReportRow {
  tenantId: string;
  customerPhone: string;
  name: string | null;
  outcome: "backfilled" | "no-candidate" | "write-failed";
  detail: string;
}
const report: ReportRow[] = [];
let backfilledCount = 0;

for (const row of customerRows ?? []) {
  const key = `${row.tenant_id}::${row.customer_phone}`;
  const candidate = latestByKey.get(key);
  if (!candidate) {
    report.push({
      tenantId: row.tenant_id, customerPhone: row.customer_phone, name: row.name,
      outcome: "no-candidate",
      detail: "no order_cart anywhere for this customer has a non-null delivery_address (their history is pickup-only, or has no submitted orders at all)",
    });
    continue;
  }

  const orderType = candidate.order_type ?? "delivery"; // an address-bearing cart with a null order_type never happened live, but default sensibly rather than write a null type
  const detail = `set last_order_type=${orderType}, last_delivery_address=${JSON.stringify(candidate.delivery_address)} from cart ${candidate.id} (${candidate.created_at}, payment_status=${candidate.payment_status})`;

  if (!APPLY) {
    report.push({ tenantId: row.tenant_id, customerPhone: row.customer_phone, name: row.name, outcome: "backfilled", detail: `[DRY RUN] would ${detail}` });
    backfilledCount++;
    continue;
  }

  const { error: updateErr } = await supabase
    .from("customers")
    .update({
      last_order_type:       orderType,
      last_delivery_address: candidate.delivery_address,
    })
    .eq("tenant_id", row.tenant_id)
    .eq("customer_phone", row.customer_phone);
  if (updateErr) {
    report.push({ tenantId: row.tenant_id, customerPhone: row.customer_phone, name: row.name, outcome: "write-failed", detail: updateErr.message });
  } else {
    report.push({ tenantId: row.tenant_id, customerPhone: row.customer_phone, name: row.name, outcome: "backfilled", detail });
    backfilledCount++;
  }
}

// ── 5. Report ────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(78)}`);
console.log(`  Delivery-memory backfill — ${APPLY ? "APPLY (real writes)" : "DRY RUN (no writes)"}`);
console.log(`${"═".repeat(78)}\n`);

for (const r of report) {
  console.log(`${"-".repeat(78)}`);
  console.log(`tenant_id:      ${r.tenantId}`);
  console.log(`customer_phone: ${r.customerPhone}`);
  console.log(`name:           ${r.name ?? "(none)"}`);
  console.log(`outcome:        ${r.outcome}`);
  console.log(`detail:         ${r.detail}`);
}
console.log(`${"-".repeat(78)}\n`);

console.log(`TOTAL customers rows:        ${customerRows?.length ?? 0}`);
console.log(`${APPLY ? "Backfilled" : "Would backfill"}:              ${backfilledCount}`);
console.log(`No candidate cart at all:    ${report.filter(r => r.outcome === "no-candidate").length}`);
if (APPLY) {
  console.log(`Write failed:                ${report.filter(r => r.outcome === "write-failed").length}`);
}

if (backfilledCount === 0) {
  console.log(`\n⚠️  ZERO rows ${APPLY ? "were" : "would be"} backfilled. This means no order_cart anywhere, for any customer, has a non-null delivery_address — a separate, worse finding than "the backfill ran and helped nobody": it means the underlying order data never captured delivery addresses at all.`);
}

if (!APPLY) {
  console.log("\nDRY RUN ONLY — no rows written. Re-run with --apply to write these.\n");
} else {
  console.log(`\nAPPLIED.\n`);
}
