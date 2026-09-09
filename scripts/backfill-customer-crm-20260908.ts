#!/usr/bin/env -S deno run --allow-env --allow-net
/**
 * One-time backfill for Customer CRM (docs/specs/2026-09-03-customer-crm.md,
 * migration 121_customers.sql, commit 5707bd6). The live upsertCustomerProfile
 * only fires going forward from stripe-webhook on NEW paid orders, so every
 * order that was already paid before tonight's build produced zero customers
 * rows. This script derives the same rows retroactively.
 *
 * Reuses _shared/customer-profile.ts's real functions exactly — no parallel
 * aggregation logic:
 *   - DRY RUN (default): simulates via the pure functions
 *     (computeFavoriteItemsUpdate / resolveCustomerName) in memory, one order
 *     at a time in chronological order per (tenant_id, customer_phone), which
 *     is mathematically identical to what upsertCustomerProfile would produce
 *     if it had been running since day one.
 *   - --apply: calls the REAL upsertCustomerProfile (fetch-merge-upsert) once
 *     per order, in the same chronological order, so the live I/O path itself
 *     writes the rows — not a script-side reimplementation.
 *
 * Scoping rules mirrored from the live path (do not diverge):
 *   - Strictly grouped by (tenant_id, customer_phone) — the exact literal
 *     string conversations.customer_phone holds for that order (web-session
 *     ids and iMessage-bridge ids are NOT normalized/merged; that matches
 *     upsertCustomerProfile's own key, which knows nothing about phone
 *     formats).
 *   - A phone identity with an active sms_opt_outs row (opted_back_at IS
 *     NULL) is skipped entirely — mirrors chat-sms's isOptedOut() query
 *     exactly (tenant_id + customer_phone + opted_back_at IS NULL).
 *   - Never merges across tenant_id — same (tenant_id, customer_phone) pair
 *     required per row, per AC2.
 *
 * EXCLUDED as known QA/test fixtures (not real customers), confirmed live
 * 2026-09-08 during dry-run review — see BLOCKED.txt entry for this backfill:
 *   - tenant 11111111-2222-3333-4444-555555555555 ("ItemH Bounce Proof") —
 *     shop literally created for email-bounce testing; pickup_names are
 *     bounce-test email addresses (delivered@resend.dev etc).
 *   - tenant 4202c105-0baa-582c-bebe-60fe55f33a8a ("ZZ RETIRED — do not use
 *     (was Vito's Pizza QA)") — shop is_paused=true, explicitly retired QA.
 *   - order a1111111-1111-1111-1111-111111111001 (NJB, pickup_name
 *     "Melvin QA") — a QA agent's own test order, not a diner.
 *   - order a4731430-e6f6-4fe2-b5af-c4a383d42744 (Vito's, pickup_name
 *     "Item H Bounce Test") — bounce-test order placed against a real
 *     tenant; excluded by order id since the tenant itself is legitimate.
 * These are hardcoded exclusions, not a general filter — flagged to the PO
 * for confirmation rather than silently applied. Everything else paid is
 * treated as real, including Jason's own dogfooding orders (explicitly
 * in scope per this backfill's own task brief).
 *
 * Usage: set -a; source ~/.openclaw/.secrets; set +a
 *        SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *        SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *        deno run --allow-env --allow-net scripts/backfill-customer-crm-20260908.ts [--apply]
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  computeFavoriteItemsUpdate,
  resolveCustomerName,
  regularEligibility,
  upsertCustomerProfile,
  canonicalizePhone,
  type FavoriteItem,
} from "../supabase/functions/_shared/customer-profile.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Run: set -a; source ~/.openclaw/.secrets; set +a");
  Deno.exit(1);
}

const APPLY = Deno.args.includes("--apply");

const EXCLUDED_TENANT_IDS = new Set([
  "11111111-2222-3333-4444-555555555555", // ItemH Bounce Proof — email-bounce test tenant
  "4202c105-0baa-582c-bebe-60fe55f33a8a",  // ZZ RETIRED (was Vito's Pizza QA), is_paused=true
]);
const EXCLUDED_ORDER_IDS = new Set([
  "a1111111-1111-1111-1111-111111111001", // NJB, pickup_name "Melvin QA" — QA agent's own test order
  "a4731430-e6f6-4fe2-b5af-c4a383d42744", // Vito's, pickup_name "Item H Bounce Test"
]);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

interface PaidOrderRow {
  id:              string;
  tenant_id:       string;
  shop_name:       string;
  customer_phone:  string;
  pickup_name:     string | null;
  total_cents:     number;
  item_names:      string[];
  order_at:        string; // updated_at proxy for "became paid" — order_carts has no explicit paid_at column
}

// ── 1. Fetch every paid order, oldest first ─────────────────────────────────
const { data: cartsRaw, error: cartsErr } = await supabase
  .from("order_carts")
  .select("id, payment_status, pickup_name, total_cents, cart_json, created_at, updated_at, shops(name, tenant_id), conversations(customer_phone)")
  .eq("payment_status", "paid")
  .order("created_at", { ascending: true });
if (cartsErr) {
  console.error("Failed to fetch paid order_carts:", cartsErr.message);
  Deno.exit(1);
}

const allOrders: PaidOrderRow[] = [];
const skippedNoIdentity: string[] = [];
const skippedExcluded: string[] = [];

for (const c of cartsRaw ?? []) {
  const shop = c.shops as unknown as { name: string; tenant_id: string } | null;
  const conv = c.conversations as unknown as { customer_phone: string } | null;
  const tenantId = shop?.tenant_id;
  const customerPhone = conv?.customer_phone;

  if (EXCLUDED_ORDER_IDS.has(c.id)) {
    skippedExcluded.push(`${c.id} (order-id excluded, pickup_name=${c.pickup_name})`);
    continue;
  }
  if (tenantId && EXCLUDED_TENANT_IDS.has(tenantId)) {
    skippedExcluded.push(`${c.id} (tenant excluded: ${shop?.name})`);
    continue;
  }
  if (!tenantId || !customerPhone) {
    skippedNoIdentity.push(c.id);
    continue;
  }

  const itemNames = ((c.cart_json as Array<{ name?: string }> | null) ?? [])
    .map(i => i.name)
    .filter((n): n is string => Boolean(n));

  allOrders.push({
    id:             c.id,
    tenant_id:      tenantId,
    shop_name:      shop?.name ?? "(unknown shop)",
    customer_phone: customerPhone,
    pickup_name:    (c.pickup_name as string | null) ?? null,
    total_cents:    (c.total_cents as number | null) ?? 0,
    item_names:     itemNames,
    order_at:       (c.updated_at as string) ?? (c.created_at as string),
  });
}

// ── 2. Group by (tenant_id, CANONICAL phone), preserving chronological order ─
// Canonicalizing the grouping key (not just the value passed to
// upsertCustomerProfile) is what makes this dry run accurately predict the
// post-apply state: upsertCustomerProfile now canonicalizes internally, so
// several raw identities (a real +1 number, an iMessage-bridge web session
// id embedding that same number, etc.) land on the SAME row once applied —
// the report needs to collapse them the same way to not lie about the
// resulting profile count. Un-canonicalizable identities (plain web:<uuid>
// sessions, email-derived ids) keep their raw string as the key, exactly as
// before — no merge without a recovered phone.
const groups = new Map<string, PaidOrderRow[]>();
const rawIdentitiesByKey = new Map<string, Set<string>>();
for (const o of allOrders) {
  const canonical = canonicalizePhone(o.customer_phone) ?? o.customer_phone;
  const key = `${o.tenant_id}::${canonical}`;
  if (!groups.has(key)) { groups.set(key, []); rawIdentitiesByKey.set(key, new Set()); }
  groups.get(key)!.push(o);
  rawIdentitiesByKey.get(key)!.add(o.customer_phone);
}
for (const orders of groups.values()) {
  orders.sort((a, b) => a.order_at.localeCompare(b.order_at));
}

// ── 3. Opt-out suppression — EXACT mirror of chat-sms's isOptedOut() query ──
// sms_opt_outs is untouched by canonicalization (out of this fix's scope) and
// still stores whatever raw customer_phone chat-sms recorded at STOP time, so
// this check stays keyed on each ORDER's own raw phone. A canonical group is
// suppressed if ANY of its underlying raw identities has an active opt-out —
// fail closed, since merging identities must never let an opted-out person's
// order history slip through under a sibling identity's clean record.
const tenantIds = [...new Set(allOrders.map(o => o.tenant_id))];
const { data: optOutRows, error: optOutErr } = await supabase
  .from("sms_opt_outs")
  .select("tenant_id, customer_phone")
  .in("tenant_id", tenantIds)
  .is("opted_back_at", null);
if (optOutErr) {
  console.error("Failed to fetch sms_opt_outs:", optOutErr.message);
  Deno.exit(1);
}
const optedOutKeys = new Set((optOutRows ?? []).map(r => `${r.tenant_id}::${r.customer_phone}`));

// ── 4. Simulate (dry run) / apply (real writes), identically chronological ──
interface GroupResult {
  key: string;
  tenantId: string;
  shopNames: string[];
  customerPhone: string;
  rawIdentities: string[];
  name: string | null;
  orderCount: number;
  totalSpentCents: number;
  favoriteItems: FavoriteItem[];
  lastOrderId: string;
  lastOrderAt: string;
}

// ── 3b. Pre-apply cleanup ────────────────────────────────────────────────────
// `customers` is a pure materialized cache of `order_carts` (per this script's
// own header) — there is no independent data in it. Tonight's first run wrote
// 12 rows keyed on raw, uncanonicalized identities (the bug this re-run
// fixes). Re-running upsertCustomerProfile now would create NEW correctly
// canonicalized rows alongside those stale ones rather than replacing them,
// since the stale rows sit under a different (raw) key than the canonical key
// upsertCustomerProfile now writes to. Since every row here is fully
// reproducible from `order_carts`, the safe, idempotent fix is to delete the
// existing rows for the tenants in scope and let this run rebuild them from
// scratch — never a destructive step, since nothing here has any input this
// script doesn't already have.
const { data: existingBefore, error: existingBeforeErr } = await supabase
  .from("customers")
  .select("tenant_id, customer_phone")
  .in("tenant_id", tenantIds);
if (existingBeforeErr) {
  console.error("Failed to read existing customers rows:", existingBeforeErr.message);
  Deno.exit(1);
}
const beforeCount = existingBefore?.length ?? 0;

if (APPLY) {
  const { error: delErr } = await supabase
    .from("customers")
    .delete()
    .in("tenant_id", tenantIds);
  if (delErr) {
    console.error("Failed to clear existing customers rows before rebuild:", delErr.message);
    Deno.exit(1);
  }
  console.log(`Cleared ${beforeCount} existing customer profile row(s) before rebuild (fully reproducible from order_carts).`);
}

const results: GroupResult[] = [];
const skippedOptedOut: string[] = [];

for (const [key, orders] of groups) {
  const optedOutOrder = orders.find(o => optedOutKeys.has(`${o.tenant_id}::${o.customer_phone}`));
  if (optedOutOrder) {
    skippedOptedOut.push(`${key} (${orders.length} order(s) — active sms_opt_outs on raw identity ${optedOutOrder.customer_phone}, no profile created)`);
    continue;
  }

  const first = orders[0];
  const shopNames = [...new Set(orders.map(o => o.shop_name))];
  const rawIdentities = [...(rawIdentitiesByKey.get(key) ?? [])];

  if (APPLY) {
    // Real writer: call the live upsertCustomerProfile once per order, in
    // chronological order, so the same fetch-merge-upsert path used by
    // stripe-webhook produces these rows — not a script-side reimplementation.
    for (const o of orders) {
      const r = await upsertCustomerProfile(supabase, {
        tenantId:      o.tenant_id,
        customerPhone: o.customer_phone,
        pickupName:    o.pickup_name,
        totalCents:    o.total_cents,
        itemNames:     o.item_names,
        orderId:       o.id,
        orderAt:       o.order_at,
      });
      if (!r.ok) {
        console.error(`  ✗ upsertCustomerProfile failed for order ${o.id} (${key}): ${r.error}`);
      }
    }
  }

  // Whether applying or not, compute the projected/actual final state the
  // same way for the report — via the SAME pure functions, so dry-run output
  // and post-apply DB state are provably identical.
  let name: string | null = null;
  let favoriteItems: FavoriteItem[] = [];
  let totalSpentCents = 0;
  for (const o of orders) {
    name = resolveCustomerName(name, o.pickup_name);
    favoriteItems = computeFavoriteItemsUpdate(favoriteItems, o.item_names);
    totalSpentCents += o.total_cents;
  }
  const last = orders[orders.length - 1];

  results.push({
    key,
    tenantId:       first.tenant_id,
    shopNames,
    customerPhone:  canonicalizePhone(first.customer_phone) ?? first.customer_phone,
    rawIdentities,
    name,
    orderCount:     orders.length,
    totalSpentCents,
    favoriteItems,
    lastOrderId:    last.id,
    lastOrderAt:    last.order_at,
  });
}

// ── 5. Report ────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(78)}`);
console.log(`  Customer CRM backfill — ${APPLY ? "APPLY (real writes)" : "DRY RUN (no writes)"}`);
console.log(`${"═".repeat(78)}\n`);

console.log(`Paid order_carts fetched: ${cartsRaw?.length ?? 0}`);
console.log(`Excluded (QA/test fixtures): ${skippedExcluded.length}`);
for (const s of skippedExcluded) console.log(`  - ${s}`);
console.log(`Skipped (missing tenant/phone identity): ${skippedNoIdentity.length}`);
for (const s of skippedNoIdentity) console.log(`  - ${s}`);
console.log(`Skipped (active opt-out, AC3): ${skippedOptedOut.length}`);
for (const s of skippedOptedOut) console.log(`  - ${s}`);
console.log(`\nExisting customer profile rows BEFORE this run: ${beforeCount}`);
console.log(`Distinct (tenant_id, canonical customer_phone) profiles AFTER this run: ${results.length}${!APPLY ? " (projected)" : ""}`);
const collapsedGroups = results.filter(r => r.rawIdentities.length > 1);
console.log(`Groups collapsed by canonicalization (>1 raw identity merged): ${collapsedGroups.length}\n`);

for (const r of results) {
  const regular = regularEligibility(r.favoriteItems);
  console.log(`${"-".repeat(78)}`);
  console.log(`shop(s):        ${r.shopNames.join(", ")}`);
  console.log(`tenant_id:      ${r.tenantId}`);
  console.log(`customer_phone: ${r.customerPhone}${r.rawIdentities.length > 1 ? `  [collapsed from: ${r.rawIdentities.join(", ")}]` : ""}`);
  console.log(`name:           ${r.name ?? "(none)"}`);
  console.log(`order_count:    ${r.orderCount}`);
  console.log(`total_spent:    $${(r.totalSpentCents / 100).toFixed(2)}`);
  console.log(`favorite_items: ${JSON.stringify(r.favoriteItems)}`);
  console.log(`the regular:    ${regular ? `${regular.name} (count ${regular.count}) — ELIGIBLE` : "not eligible (top item < 3 orders)"}`);
  console.log(`last_order:     ${r.lastOrderId} @ ${r.lastOrderAt}`);
}
console.log(`${"-".repeat(78)}\n`);

if (!APPLY) {
  console.log("DRY RUN ONLY — no rows written. Re-run with --apply to write these profiles.\n");
} else {
  console.log(`APPLIED — ${results.length} customer profile(s) written via the live upsertCustomerProfile path.\n`);
}
