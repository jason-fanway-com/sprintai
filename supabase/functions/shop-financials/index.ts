/**
 * SprintAI shop-financials Edge Function
 * Shop-level financial reporting: summary KPIs, paginated ledger, CSV export, payouts.
 *
 * Auth: Bearer JWT (Supabase Auth — admin session pattern).
 * Tenant isolation: shop must belong to caller's tenant (or caller is platform admin).
 *
 * Phase 2 — REAL Stripe fees from balance transactions, per-row fees_estimated flag,
 * and read-only payout reconciliation. Falls back to estimated fee when no settled
 * balance transaction exists yet.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import type { Stripe } from "npm:stripe";
import {
  resolveStripeKey,
  batchFetchFees,
  listPayouts,
  listPayoutTransactions,
} from "../_shared/stripe-financials.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const STRIPE_FEE_PCT = 0.029;
const STRIPE_FEE_FIXED_CENTS = 30;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClientAny = any;

// ─── Types ──────────────────────────────────────────────────────────────────

interface OrderRow {
  id: string;
  created_at: string;
  order_number: number | null;
  order_type: string;
  payment_status: string;
  phase: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  delivery_fee_cents: number;
  driver_tip_cents: number;
  service_fee_cents: number;
  refunded_cents: number;
  refund_status: string;
  pickup_name: string | null;
  customer_phone: string | null;
  test_mode: boolean;
  stripe_charge_id: string | null;
  stripe_connected_account_id: string | null;
  stripe_fee_cents: number;
  fees_estimated: boolean;
}

interface OrderChargeInfo {
  stripe_charge_id: string | null;
  stripe_connected_account_id: string | null;
  test_mode: boolean;
}

interface ConvoRow {
  id: string;
  customer_phone: string | null;
}

// ─── Money helpers ──────────────────────────────────────────────────────────

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function parseCents(val: number | null | undefined): number {
  return val ?? 0;
}

/** Estimated Stripe fee: 2.9% + $0.30 per order */
function estimateStripeFeeCents(totalCents: number): number {
  return Math.round(totalCents * STRIPE_FEE_PCT + STRIPE_FEE_FIXED_CENTS);
}

function apiResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function apiError(message: string, status = 400): Response {
  return apiResponse({ error: message }, status);
}

function parseDateParam(param: string | null, fallback: string): string {
  if (!param) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(param)) return param;
  return fallback;
}

// ─── Fee resolution ─────────────────────────────────────────────────────────

interface ResolvedFeeMap {
  feeMap: Map<string, number>;          // charge_id → real fee cents (settled only)
  settledCount: number;                  // number of charges with settled balance txns
}

/**
 * Batch-fetch real Stripe fees for a list of orders with charge info.
 * Groups by mode (live vs test) and issues separate batch calls.
 * Only settled balance transactions get real fees; unsolved charges are
 * absent from the map (caller uses estimate fallback).
 */
async function resolveFeesForOrders(
  orders: OrderChargeInfo[],
): Promise<ResolvedFeeMap> {
  const feeMap = new Map<string, number>();
  const liveCharges: Array<{ charge_id: string; connected_account_id: string | null }> = [];
  const testCharges: Array<{ charge_id: string; connected_account_id: string | null }> = [];

  for (const o of orders) {
    if (!o.stripe_charge_id) continue;
    if (o.test_mode) {
      testCharges.push({ charge_id: o.stripe_charge_id, connected_account_id: o.stripe_connected_account_id });
    } else {
      liveCharges.push({ charge_id: o.stripe_charge_id, connected_account_id: o.stripe_connected_account_id });
    }
  }

  let settledCount = 0;

  if (liveCharges.length > 0) {
    const liveKey = resolveStripeKey(false);
    if (liveKey) {
      const liveFees = await batchFetchFees(liveKey, liveCharges);
      for (const [chargeId, result] of liveFees) {
        feeMap.set(chargeId, result.fee_cents);
        settledCount++;
      }
    }
  }

  if (testCharges.length > 0) {
    const testKey = resolveStripeKey(true);
    if (testKey) {
      const testFees = await batchFetchFees(testKey, testCharges);
      for (const [chargeId, result] of testFees) {
        feeMap.set(chargeId, result.fee_cents);
        settledCount++;
      }
    }
  }

  return { feeMap, settledCount };
}

// ─── CSV Generation ─────────────────────────────────────────────────────────

function escapeCsvField(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/** BOM for UTF-8 so Excel opens correctly */
const UTF8_BOM = "\uFEFF";

function generateSimpleCSV(rows: OrderRow[], shopName: string, from: string, to: string): string {
  const lines: string[] = [UTF8_BOM + "Date,Description,Amount"];
  for (const row of rows) {
    const date = new Date(row.created_at).toLocaleDateString("en-US", {
      month: "2-digit", day: "2-digit", year: "numeric",
    });
    const orderLabel = row.order_number ? `Order #${row.order_number}` : "Order";
    const phoneSuffix = row.customer_phone ? ` - ${row.customer_phone.slice(-4)}` : "";
    const desc = `${orderLabel}${phoneSuffix}`;
    const amount = centsToDollars(row.total_cents - parseCents(row.refunded_cents));

    lines.push(`${date},${escapeCsvField(desc)},${amount}`);

    // Stripe fee as separate line
    const fee = row.stripe_fee_cents;
    if (fee > 0) {
      lines.push(`${date},"Stripe Processing Fee",-${centsToDollars(fee)}`);
    }

    // Refund line if applicable
    if (row.refunded_cents > 0) {
      lines.push(`${date},"Refund - ${escapeCsvField(desc)}",-${centsToDollars(row.refunded_cents)}`);
    }
  }
  return lines.join("\n");
}

function generateQuickBooksCSV(rows: OrderRow[], shopName: string, from: string, to: string): string {
  const lines: string[] = [UTF8_BOM + "Date,Description,Credit,Debit"];
  for (const row of rows) {
    const date = new Date(row.created_at).toLocaleDateString("en-US", {
      month: "2-digit", day: "2-digit", year: "numeric",
    });
    const orderLabel = row.order_number ? `Order #${row.order_number}` : "Order";
    const phoneSuffix = row.customer_phone ? ` - ${row.customer_phone.slice(-4)}` : "";
    const desc = `${orderLabel}${phoneSuffix}`;
    const netAmount = row.total_cents - parseCents(row.refunded_cents);

    lines.push(`${date},${escapeCsvField(desc)},${centsToDollars(netAmount)},`);

    // Stripe fee on debit column
    const fee = row.stripe_fee_cents;
    if (fee > 0) {
      lines.push(`${date},"Stripe Processing Fee",,${centsToDollars(fee)}`);
    }

    // Refund on debit column
    if (row.refunded_cents > 0) {
      lines.push(`${date},"Refund - ${escapeCsvField(desc)}",,${centsToDollars(row.refunded_cents)}`);
    }
  }
  return lines.join("\n");
}

// ─── Batch Phone Lookup ────────────────────────────────────────────────────

async function batchFetchPhones(
  supabase: SupabaseClientAny,
  conversationIds: string[],
): Promise<Record<string, string>> {
  const phoneMap: Record<string, string> = {};
  if (conversationIds.length === 0) return phoneMap;

  const { data: convos, error } = await supabase
    .from("conversations")
    .select("id, customer_phone")
    .in("id", conversationIds);

  if (error || !convos) return phoneMap;

  for (const c of convos as unknown as ConvoRow[]) {
    phoneMap[c.id] = c.customer_phone ?? "";
  }
  return phoneMap;
}

// ─── Tenant / Shop Verification ─────────────────────────────────────────────

async function verifyShopAccess(
  supabase: SupabaseClientAny,
  shopId: string,
  tenantId: string | null,
): Promise<{ allowed: boolean; shopName: string; testMode: boolean; connectedAccountId: string | null }> {
  const { data, error } = await supabase
    .from("shops")
    .select("id, name, tenant_id, test_mode, stripe_connected_account_id")
    .eq("id", shopId);

  if (error || !data || !Array.isArray(data) || data.length === 0) {
    return { allowed: false, shopName: "", testMode: false, connectedAccountId: null };
  }

  const shop = data[0] as unknown as {
    id: string;
    name: string;
    tenant_id: string;
    test_mode?: boolean;
    stripe_connected_account_id: string | null;
  };

  // Platform admin (no tenant_id restriction) sees everything
  if (tenantId === null) {
    return {
      allowed: true,
      shopName: shop.name,
      testMode: shop.test_mode === true,
      connectedAccountId: shop.stripe_connected_account_id,
    };
  }

  // Tenant-scoped: shop must belong to caller's tenant
  if (shop.tenant_id === tenantId) {
    return {
      allowed: true,
      shopName: shop.name,
      testMode: shop.test_mode === true,
      connectedAccountId: shop.stripe_connected_account_id,
    };
  }

  return { allowed: false, shopName: "", testMode: false, connectedAccountId: null };
}

// ─── Route Handlers ─────────────────────────────────────────────────────────

async function getSummary(
  supabase: SupabaseClientAny,
  shopId: string,
  from: string,
  to: string,
  includeTest: boolean,
): Promise<Response> {
  const fromDate = `${from}T00:00:00Z`;
  const toDate = `${to}T23:59:59.999Z`;

  let query = supabase
    .from("order_carts")
    .select(
      "id, total_cents, subtotal_cents, tax_cents, delivery_fee_cents, driver_tip_cents, service_fee_cents, refunded_cents, stripe_charge_id, stripe_connected_account_id, test_mode"
    )
    .eq("shop_id", shopId)
    .eq("phase", "confirmed")
    .gte("created_at", fromDate)
    .lte("created_at", toDate);

  if (!includeTest) {
    query = query.eq("test_mode", false);
  }

  const { data: orders, error } = await query;

  if (error) return apiError(error.message);

  const rows = orders as unknown as Array<{
    total_cents: number | null;
    subtotal_cents: number | null;
    tax_cents: number | null;
    delivery_fee_cents: number | null;
    driver_tip_cents: number | null;
    service_fee_cents: number | null;
    refunded_cents: number | null;
    stripe_charge_id: string | null;
    stripe_connected_account_id: string | null;
    test_mode: boolean;
  }>;

  // Resolve real fees
  const { feeMap, settledCount } = await resolveFeesForOrders(
    rows.map((r) => ({
      stripe_charge_id: r.stripe_charge_id,
      stripe_connected_account_id: r.stripe_connected_account_id,
      test_mode: r.test_mode,
    })),
  );

  const orderCount = rows.length;
  const grossSalesCents = rows.reduce((sum, r) => sum + parseCents(r.total_cents), 0);
  const totalTaxCents = rows.reduce((sum, r) => sum + parseCents(r.tax_cents), 0);
  const totalDeliveryFeesCents = rows.reduce((sum, r) => sum + parseCents(r.delivery_fee_cents), 0);
  const totalDriverTipCents = rows.reduce((sum, r) => sum + parseCents(r.driver_tip_cents), 0);
  const totalServiceFeeCents = rows.reduce((sum, r) => sum + parseCents(r.service_fee_cents), 0);
  const totalRefundedCents = rows.reduce((sum, r) => sum + parseCents(r.refunded_cents), 0);

  // Fee total: real where available, estimate fallback
  let realFeesTotal = 0;
  let estimatedFeesTotal = 0;
  let anyEstimated = false;

  for (const r of rows) {
    const total = parseCents(r.total_cents);
    if (r.stripe_charge_id && feeMap.has(r.stripe_charge_id)) {
      realFeesTotal += feeMap.get(r.stripe_charge_id)!;
    } else {
      estimatedFeesTotal += estimateStripeFeeCents(total);
      if (total > 0) anyEstimated = true;
    }
  }

  const totalStripeFeesCents = realFeesTotal + estimatedFeesTotal;
  const netRevenueCents = grossSalesCents - totalRefundedCents - totalStripeFeesCents;
  const avgTicketCents = orderCount > 0 ? Math.round(grossSalesCents / orderCount) : 0;

  return apiResponse({
    order_count: orderCount,
    gross_sales_cents: grossSalesCents,
    gross_sales: centsToDollars(grossSalesCents),
    net_revenue_cents: netRevenueCents,
    net_revenue: centsToDollars(netRevenueCents),
    total_tips_cents: totalDriverTipCents,
    total_tips: centsToDollars(totalDriverTipCents),
    total_tax_cents: totalTaxCents,
    total_tax: centsToDollars(totalTaxCents),
    total_delivery_fees_cents: totalDeliveryFeesCents,
    total_delivery_fees: centsToDollars(totalDeliveryFeesCents),
    total_service_fees_cents: totalServiceFeeCents,
    total_service_fees: centsToDollars(totalServiceFeeCents),
    total_refunded_cents: totalRefundedCents,
    total_refunded: centsToDollars(totalRefundedCents),
    stripe_fees_cents: totalStripeFeesCents,
    stripe_fees: centsToDollars(totalStripeFeesCents),
    avg_ticket_cents: avgTicketCents,
    avg_ticket: centsToDollars(avgTicketCents),
    fees_estimated: anyEstimated,
    settled_charge_count: settledCount,
    period: { from, to },
  });
}

async function getLedger(
  supabase: SupabaseClientAny,
  shopId: string,
  params: URLSearchParams,
): Promise<Response> {
  const page = Math.max(1, parseInt(params.get("page") ?? "1"));
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get("page_size") ?? "50")));
  const offset = (page - 1) * pageSize;
  const from = parseDateParam(params.get("from"), "2000-01-01");
  const to = parseDateParam(params.get("to"), new Date().toISOString().split("T")[0]);
  const sortField = params.get("sort") ?? "created_at";
  const sortDir = params.get("dir") === "asc" ? "asc" : "desc";
  const search = params.get("search") ?? "";
  const orderType = params.get("order_type") ?? "";
  const paymentStatus = params.get("payment_status") ?? "";
  const includeTest = params.get("include_test") === "true";

  // Whitelist sort fields
  const allowedSorts = new Set([
    "created_at", "order_number", "order_type", "payment_status",
    "subtotal_cents", "tax_cents", "total_cents", "driver_tip_cents",
  ]);
  const safeSort = allowedSorts.has(sortField) ? sortField : "created_at";
  const safeDir = sortDir === "asc" ? "asc" : "desc";

  const fromDate = `${from}T00:00:00Z`;
  const toDate = `${to}T23:59:59.999Z`;

  let query = supabase
    .from("order_carts")
    .select(
      `id, created_at, order_number, order_type, payment_status, phase,
       subtotal_cents, tax_cents, total_cents,
       delivery_fee_cents, driver_tip_cents, service_fee_cents,
       refunded_cents, refund_status,
       pickup_name, conversation_id, test_mode,
       stripe_charge_id, stripe_connected_account_id`,
      { count: "exact" }
    )
    .eq("shop_id", shopId)
    .eq("phase", "confirmed")
    .gte("created_at", fromDate)
    .lte("created_at", toDate)
    .order(safeSort, { ascending: safeDir === "asc" })
    .range(offset, offset + pageSize - 1);

  if (!includeTest) {
    query = query.eq("test_mode", false);
  }
  if (orderType) {
    query = query.eq("order_type", orderType);
  }
  if (paymentStatus) {
    query = query.eq("payment_status", paymentStatus);
  }
  if (search) {
    if (/^\d+$/.test(search)) {
      query = query.eq("order_number", parseInt(search));
    } else {
      query = query.ilike("pickup_name", `%${search}%`);
    }
  }

  const { data, error, count } = await query;

  if (error) return apiError(error.message);

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    created_at: string;
    order_number: number | null;
    order_type: string;
    payment_status: string;
    phase: string;
    subtotal_cents: number | null;
    tax_cents: number | null;
    total_cents: number | null;
    delivery_fee_cents: number | null;
    driver_tip_cents: number | null;
    service_fee_cents: number | null;
    refunded_cents: number | null;
    refund_status: string | null;
    pickup_name: string | null;
    conversation_id: string;
    test_mode: boolean;
    stripe_charge_id: string | null;
    stripe_connected_account_id: string | null;
  }>;

  // Resolve real fees for this page
  const { feeMap } = await resolveFeesForOrders(
    rows.map((r) => ({
      stripe_charge_id: r.stripe_charge_id,
      stripe_connected_account_id: r.stripe_connected_account_id,
      test_mode: r.test_mode,
    })),
  );

  const conversationIds = [...new Set(rows.map((r) => r.conversation_id).filter(Boolean))] as string[];
  const phoneMap = await batchFetchPhones(supabase, conversationIds);

  // Per-row flag detection — set fees_estimated true if ANY row uses an estimate
  let anyEstimated = false;

  const orders = rows.map((r) => {
    const totalCents = parseCents(r.total_cents);
    const refundedCents = parseCents(r.refunded_cents);

    // Use real fee if charge_id has a settled balance txn, else fall back
    const hasRealFee = !!(r.stripe_charge_id && feeMap.has(r.stripe_charge_id));
    if (totalCents > 0 && !hasRealFee) anyEstimated = true;

    const feeCents = hasRealFee
      ? feeMap.get(r.stripe_charge_id!)!
      : estimateStripeFeeCents(totalCents);
    const netCents = totalCents - refundedCents - feeCents;

    return {
      id: r.id,
      created_at: r.created_at,
      order_number: r.order_number,
      order_type: r.order_type,
      payment_status: r.payment_status,
      subtotal_cents: parseCents(r.subtotal_cents),
      subtotal: centsToDollars(parseCents(r.subtotal_cents)),
      tax_cents: parseCents(r.tax_cents),
      tax: centsToDollars(parseCents(r.tax_cents)),
      total_cents: totalCents,
      total: centsToDollars(totalCents),
      delivery_fee_cents: parseCents(r.delivery_fee_cents),
      delivery_fee: centsToDollars(parseCents(r.delivery_fee_cents)),
      driver_tip_cents: parseCents(r.driver_tip_cents),
      driver_tip: centsToDollars(parseCents(r.driver_tip_cents)),
      service_fee_cents: parseCents(r.service_fee_cents),
      service_fee: centsToDollars(parseCents(r.service_fee_cents)),
      refunded_cents: refundedCents,
      refunded: centsToDollars(refundedCents),
      refund_status: r.refund_status ?? "none",
      stripe_fee_cents: feeCents,
      stripe_fee: centsToDollars(feeCents),
      net_cents: netCents,
      net: centsToDollars(netCents),
      pickup_name: r.pickup_name,
      customer_phone: phoneMap[r.conversation_id] ?? null,
      test_mode: r.test_mode,
      fees_estimated: !hasRealFee,
    };
  });

  return apiResponse({
    orders,
    total: count ?? 0,
    page,
    page_size: pageSize,
    total_pages: Math.ceil((count ?? 0) / pageSize),
    fees_estimated: anyEstimated,
  });
}

async function getRevenueChart(
  supabase: SupabaseClientAny,
  shopId: string,
  from: string,
  to: string,
  includeTest: boolean,
): Promise<Response> {
  const fromDate = `${from}T00:00:00Z`;
  const toDate = `${to}T23:59:59.999Z`;

  let query = supabase
    .from("order_carts")
    .select("created_at, total_cents, subtotal_cents, stripe_charge_id, stripe_connected_account_id, test_mode")
    .eq("shop_id", shopId)
    .eq("phase", "confirmed")
    .gte("created_at", fromDate)
    .lte("created_at", toDate)
    .order("created_at", { ascending: true });

  if (!includeTest) {
    query = query.eq("test_mode", false);
  }

  const { data, error } = await query;

  if (error) return apiError(error.message);

  const chartRows = (data ?? []) as Array<{
    created_at: string;
    total_cents: number | null;
    subtotal_cents: number | null;
    stripe_charge_id: string | null;
    stripe_connected_account_id: string | null;
    test_mode: boolean;
  }>;

  // Resolve real fees
  const { feeMap } = await resolveFeesForOrders(
    chartRows.map((r) => ({
      stripe_charge_id: r.stripe_charge_id,
      stripe_connected_account_id: r.stripe_connected_account_id,
      test_mode: r.test_mode,
    })),
  );

  // Group by day
  const dayMap = new Map<string, { gross_cents: number; net_cents: number; count: number }>();
  for (const row of chartRows) {
    const day = row.created_at.split("T")[0];
    const entry = dayMap.get(day) ?? { gross_cents: 0, net_cents: 0, count: 0 };
    const gross = parseCents(row.total_cents);

    // Use real fee where available, else estimate
    const hasRealFee = !!(row.stripe_charge_id && feeMap.has(row.stripe_charge_id));
    const fee = hasRealFee ? feeMap.get(row.stripe_charge_id!)! : estimateStripeFeeCents(gross);

    entry.gross_cents += gross;
    entry.net_cents += gross - fee;
    entry.count += 1;
    dayMap.set(day, entry);
  }

  const days = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({
      date: day,
      gross: centsToDollars(v.gross_cents),
      gross_cents: v.gross_cents,
      net: centsToDollars(v.net_cents),
      net_cents: v.net_cents,
      order_count: v.count,
    }));

  return apiResponse({ days });
}

async function getExport(
  supabase: SupabaseClientAny,
  shopId: string,
  shopName: string,
  params: URLSearchParams,
): Promise<Response> {
  const from = parseDateParam(params.get("from"), "2000-01-01");
  const to = parseDateParam(params.get("to"), new Date().toISOString().split("T")[0]);
  const format = params.get("format") === "simple" ? "simple" : "quickbooks";
  const includeTest = params.get("include_test") === "true";

  const fromDate = `${from}T00:00:00Z`;
  const toDate = `${to}T23:59:59.999Z`;

  let query = supabase
    .from("order_carts")
    .select(
      `id, created_at, order_number, order_type, payment_status,
       subtotal_cents, tax_cents, total_cents,
       delivery_fee_cents, driver_tip_cents, service_fee_cents,
       refunded_cents, refund_status,
       pickup_name, conversation_id,
       stripe_charge_id, stripe_connected_account_id, test_mode`
    )
    .eq("shop_id", shopId)
    .eq("phase", "confirmed")
    .gte("created_at", fromDate)
    .lte("created_at", toDate)
    .order("created_at", { ascending: true });

  if (!includeTest) {
    query = query.eq("test_mode", false);
  }

  const { data, error } = await query;

  if (error) return apiError(error.message);

  const rows = data ?? [];

  // Batch-fetch customer phones
  const conversationIds = [...new Set(rows.map((r: { conversation_id: string }) => r.conversation_id).filter(Boolean))] as string[];
  const phoneMap = await batchFetchPhones(supabase, conversationIds);

  // Resolve real fees
  const { feeMap } = await resolveFeesForOrders(
    rows.map((r: Record<string, unknown>) => ({
      stripe_charge_id: r.stripe_charge_id as string | null,
      stripe_connected_account_id: r.stripe_connected_account_id as string | null,
      test_mode: (r.test_mode as boolean) ?? false,
    })),
  );

  const orders: OrderRow[] = rows.map((r: Record<string, unknown>) => {
    const totalCents = parseCents(r.total_cents as number | null);
    const chargeId = (r.stripe_charge_id as string) ?? null;
    const hasRealFee = !!(chargeId && feeMap.has(chargeId));
    const stripe_fee_cents = hasRealFee
      ? feeMap.get(chargeId!)!
      : estimateStripeFeeCents(totalCents);

    return {
      id: r.id as string,
      created_at: r.created_at as string,
      order_number: r.order_number as number | null,
      order_type: r.order_type as string,
      payment_status: r.payment_status as string,
      phase: "confirmed",
      subtotal_cents: parseCents(r.subtotal_cents as number | null),
      tax_cents: parseCents(r.tax_cents as number | null),
      total_cents: totalCents,
      delivery_fee_cents: parseCents(r.delivery_fee_cents as number | null),
      driver_tip_cents: parseCents(r.driver_tip_cents as number | null),
      service_fee_cents: parseCents(r.service_fee_cents as number | null),
      refunded_cents: parseCents(r.refunded_cents as number | null),
      refund_status: (r.refund_status as string) ?? "none",
      pickup_name: r.pickup_name as string | null,
      customer_phone: phoneMap[r.conversation_id as string] ?? null,
      test_mode: (r.test_mode as boolean) ?? false,
      stripe_charge_id: chargeId,
      stripe_connected_account_id: (r.stripe_connected_account_id as string) ?? null,
      stripe_fee_cents,
      fees_estimated: !hasRealFee,
    };
  });

  const safeName = shopName.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);
  const filename = `${safeName}-financials-${from}-to-${to}.csv`;

  const csv = format === "simple"
    ? generateSimpleCSV(orders, shopName, from, to)
    : generateQuickBooksCSV(orders, shopName, from, to);

  return new Response(csv, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

// ─── Payouts ────────────────────────────────────────────────────────────────

async function getPayouts(
  supabase: SupabaseClientAny,
  shopId: string,
  connectedAccountId: string | null,
  testMode: boolean,
): Promise<Response> {
  const stripeKey = resolveStripeKey(testMode);
  if (!stripeKey) {
    return apiError("Stripe not configured for this shop's mode", 500);
  }

  const payouts = await listPayouts(stripeKey, connectedAccountId, 50);
  if (payouts.length === 0) {
    return apiResponse({ payouts: [] });
  }

  // Fetch balance transactions once per payout, collecting charge IDs for cross-reference
  const payoutTxnMap = new Map<string, Stripe.BalanceTransaction[]>();
  const allChargeIds: string[] = [];

  for (const p of payouts) {
    const txns = await listPayoutTransactions(stripeKey, p.id, connectedAccountId, 100);
    payoutTxnMap.set(p.id, txns);
    for (const t of txns) {
      const source = typeof t.source === "string" ? t.source : null;
      if (source && source.startsWith("ch_")) {
        allChargeIds.push(source);
      }
    }
  }

  // Batch-resolve charge IDs → order_carts
  const ordersByCharge = new Map<
    string,
    { order_cart_id: string; order_number: number | null; total_cents: number; created_at: string }
  >();

  if (allChargeIds.length > 0) {
    const { data: orderData, error: orderErr } = await supabase
      .from("order_carts")
      .select("id, stripe_charge_id, order_number, total_cents, created_at")
      .eq("shop_id", shopId)
      .in("stripe_charge_id", allChargeIds);

    if (!orderErr && orderData) {
      for (const row of orderData as unknown as Array<{
        id: string;
        stripe_charge_id: string | null;
        order_number: number | null;
        total_cents: number | null;
        created_at: string;
      }>) {
        if (row.stripe_charge_id) {
          ordersByCharge.set(row.stripe_charge_id, {
            order_cart_id: row.id,
            order_number: row.order_number,
            total_cents: parseCents(row.total_cents),
            created_at: row.created_at,
          });
        }
      }
    }
  }

  // Build response from cached transactions
  const detailedPayouts = payouts.map((p) => {
    const txns = payoutTxnMap.get(p.id) ?? [];

    const details = txns.map((t) => {
      const source = (typeof t.source === "string" ? t.source : null) ?? "";
      const order = source ? ordersByCharge.get(source) : undefined;

      return {
        balance_transaction_id: t.id,
        amount_cents: t.amount,
        amount: centsToDollars(t.amount),
        fee_cents: t.fee,
        fee: centsToDollars(t.fee),
        net_cents: t.net,
        net: centsToDollars(t.net),
        created: t.created,
        type: t.type,
        status: t.status,
        source_id: source || null,
        description: t.description ?? null,
        matched_order: order ? {
          order_cart_id: order.order_cart_id,
          order_number: order.order_number,
          total_cents: order.total_cents,
          total: centsToDollars(order.total_cents),
          created_at: order.created_at,
        } : null,
      };
    });

    const chargeCount = txns.filter((t) => {
      const s = typeof t.source === "string" ? t.source : null;
      return s !== null && s.startsWith("ch_");
    }).length;

    return {
      id: p.id,
      arrival_date: p.arrival_date,
      amount_cents: p.amount,
      amount: centsToDollars(p.amount),
      status: p.status,
      automatic: p.automatic,
      type: p.type,
      currency: p.currency,
      method: p.method,
      statement_descriptor: p.statement_descriptor ?? null,
      arrival_date_readable: new Date(p.arrival_date * 1000).toISOString().split("T")[0],
      transaction_count: txns.length,
      matched_order_count: chargeCount,
      balances: details,
    };
  });

  return apiResponse({ payouts: detailedPayouts });
}

// ─── Main Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/shop-financials/, "").replace(/^\/shop-financials/, "");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  // ── JWT Validation ──────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return apiError("Unauthorized", 401);
  }

  const token = authHeader.replace("Bearer ", "");
  let callerTenantId: string | null = null;

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (token === serviceKey) {
    callerTenantId = null;
  } else {
    const userRes = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/auth/v1/user`,
      { headers: { Authorization: `Bearer ${token}`, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" } }
    );
    if (!userRes.ok) {
      return apiError("Unauthorized", 401);
    }
    const user = await userRes.json();
    const isAdmin = user.user_metadata?.is_admin === true || user.app_metadata?.is_admin === true;
    if (!isAdmin) {
      return apiError("Forbidden - admin access required", 403);
    }
    callerTenantId = (user.app_metadata?.tenant_id as string)
      || (user.user_metadata?.tenant_id as string)
      || null;
  }

  try {
    // ── Route: GET /:shopId/summary ────────────────────────────────────────
    const summaryMatch = path.match(/^\/([a-f0-9-]+)\/summary$/);
    if (summaryMatch && req.method === "GET") {
      const shopId = summaryMatch[1];
      const { allowed } = await verifyShopAccess(supabase, shopId, callerTenantId);
      if (!allowed) return apiError("Not found", 404);

      const from = parseDateParam(url.searchParams.get("from"), "2000-01-01");
      const to = parseDateParam(url.searchParams.get("to"), new Date().toISOString().split("T")[0]);
      const includeTest = url.searchParams.get("include_test") === "true";
      return await getSummary(supabase, shopId, from, to, includeTest);
    }

    // ── Route: GET /:shopId/ledger ─────────────────────────────────────────
    const ledgerMatch = path.match(/^\/([a-f0-9-]+)\/ledger$/);
    if (ledgerMatch && req.method === "GET") {
      const shopId = ledgerMatch[1];
      const { allowed } = await verifyShopAccess(supabase, shopId, callerTenantId);
      if (!allowed) return apiError("Not found", 404);
      return await getLedger(supabase, shopId, url.searchParams);
    }

    // ── Route: GET /:shopId/chart ──────────────────────────────────────────
    const chartMatch = path.match(/^\/([a-f0-9-]+)\/chart$/);
    if (chartMatch && req.method === "GET") {
      const shopId = chartMatch[1];
      const { allowed } = await verifyShopAccess(supabase, shopId, callerTenantId);
      if (!allowed) return apiError("Not found", 404);
      const from = parseDateParam(url.searchParams.get("from"), "2000-01-01");
      const to = parseDateParam(url.searchParams.get("to"), new Date().toISOString().split("T")[0]);
      const includeTest = url.searchParams.get("include_test") === "true";
      return await getRevenueChart(supabase, shopId, from, to, includeTest);
    }

    // ── Route: GET /:shopId/export ─────────────────────────────────────────
    const exportMatch = path.match(/^\/([a-f0-9-]+)\/export$/);
    if (exportMatch && req.method === "GET") {
      const shopId = exportMatch[1];
      const { allowed, shopName } = await verifyShopAccess(supabase, shopId, callerTenantId);
      if (!allowed) return apiError("Not found", 404);
      return await getExport(supabase, shopId, shopName, url.searchParams);
    }

    // ── Route: GET /:shopId/payouts ────────────────────────────────────────
    const payoutsMatch = path.match(/^\/([a-f0-9-]+)\/payouts$/);
    if (payoutsMatch && req.method === "GET") {
      const shopId = payoutsMatch[1];
      const { allowed, testMode, connectedAccountId } = await verifyShopAccess(supabase, shopId, callerTenantId);
      if (!allowed) return apiError("Not found", 404);
      return await getPayouts(supabase, shopId, connectedAccountId, testMode);
    }

    return apiError(`Route not found: ${req.method} ${path}`, 404);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[shop-financials] Error on ${req.method} ${path}:`, errMsg);
    return apiError(errMsg, 500);
  }
});
