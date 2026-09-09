#!/usr/bin/env -S deno run --allow-env --allow-net
/**
 * Live verification for the owner-facing Customer CRM screen's edge function
 * (supabase/functions/customer-crm/index.ts), the endpoint underlying
 * admin-dashboard/src/pages/ShopOwnerCustomers.tsx.
 *
 * Signs in as REAL shop-owner accounts (test fixtures already provisioned via
 * set-app-metadata — shopowner-njb@sprintai-test.com for NJB,
 * wingfix@sprintai-test.local for Vito's) and drives the deployed HTTP
 * endpoint exactly as the browser would: Bearer JWT from a real Supabase Auth
 * session, no service-role key.
 *
 * Proves:
 *  - NJB owner GET /customer-crm/<NJB shop>/customers returns NJB's own
 *    profiles (AC2 positive case).
 *  - The merged Jason identity backfilled by scripts/backfill-customer-crm-
 *    20260908.ts (11 orders / $141.26 / "Half Dozen Bagels") appears with a
 *    clean formatted phone and is flagged as a "regular".
 *  - An unresolvable identity (web:<uuid> / web:imsg-<email>-* — the
 *    canonicalizer could not recover a phone) shows "No phone on file", never
 *    the raw internal id.
 *  - Summary counts (total/returning/regulars) match the known live state.
 *  - AC2 cross-tenant isolation at the HTTP layer: the NJB owner's own valid
 *    session token, pointed at VITO'S shop id, gets rejected (never Vito's
 *    data) — and vice versa. This is the "manipulated request params" check
 *    the task calls out: a client can send any shopId it wants, but the
 *    function resolves that shopId's tenant server-side and checks it against
 *    the caller's own JWT-derived tenant_id, so the request itself can never
 *    make the function query a foreign tenant, no matter what shopId is sent.
 *
 * Run: set -a; source ~/.openclaw/.secrets; set +a
 *      SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *      SUPABASE_ANON_KEY="$SPRINTAI_CHAT_SUPABASE_ANON_KEY" \
 *      deno run --allow-env --allow-net scripts/customer-crm-live-verify-20260908.ts
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY.");
  Deno.exit(1);
}

const NJB_SHOP_ID = "b0000000-0000-0000-0000-000000000001";
const VITOS_SHOP_ID = "e0000000-0000-0000-0000-000000000001";
const CUSTOMER_CRM_URL = `${SUPABASE_URL}/functions/v1/customer-crm`;

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    console.error(`  ✗  ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function signIn(email: string, password: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    console.error(`Sign-in failed for ${email}: ${error?.message}`);
    Deno.exit(1);
  }
  return data.session.access_token;
}

async function fetchCustomers(token: string, shopId: string) {
  const res = await fetch(`${CUSTOMER_CRM_URL}/${shopId}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

console.log("\n═══════════════════════════════════════════════════════");
console.log("  Customer CRM screen — live HTTP verification (2026-09-08)");
console.log("═══════════════════════════════════════════════════════\n");

const njbToken = await signIn("shopowner-njb@sprintai-test.com", "TestOwner2026!");
const vitosToken = await signIn("wingfix@sprintai-test.local", "TestOwner2026!");

// ── NJB owner, own shop ─────────────────────────────────────────────────────
console.log("Phase 1 — NJB owner fetches NJB's own customers");
const njbOwn = await fetchCustomers(njbToken, NJB_SHOP_ID);
assert("NJB own-shop request succeeds (200)", njbOwn.status === 200, JSON.stringify(njbOwn.body));

const njbCustomers = (njbOwn.body.customers ?? []) as Array<Record<string, unknown>>;
assert("NJB returns 4 customer profiles", njbCustomers.length === 4, `got ${njbCustomers.length}`);

const jasonMerged = njbCustomers.find(c => c.order_count === 11);
assert("Merged Jason identity present (11 orders)", !!jasonMerged);
assert("Merged Jason total_spent_cents = 14126 ($141.26)", jasonMerged?.total_spent_cents === 14126,
  JSON.stringify(jasonMerged?.total_spent_cents));
assert("Merged Jason top_item = 'Half Dozen Bagels'", jasonMerged?.top_item === "Half Dozen Bagels",
  JSON.stringify(jasonMerged?.top_item));
assert("Merged Jason is flagged is_regular (favorite count >= 3)", jasonMerged?.is_regular === true);
assert("Merged Jason phone_display is a clean formatted number, not a raw identity",
  /^\(\d{3}\) \d{3}-\d{4}$/.test(String(jasonMerged?.phone_display)),
  JSON.stringify(jasonMerged?.phone_display));

const unresolvable = njbCustomers.find(c =>
  typeof c.id === "string" && (jasonMerged ? c.id !== jasonMerged.id : true) && c.phone_display === "No phone on file");
assert("At least one unresolvable identity shows 'No phone on file'", !!unresolvable,
  JSON.stringify(njbCustomers.map(c => c.phone_display)));

const rawLeak = njbCustomers.some(c => String(c.phone_display).startsWith("web:") || String(c.phone_display).includes("imsg"));
assert("NO row ever renders a raw internal identity string", !rawLeak,
  JSON.stringify(njbCustomers.map(c => c.phone_display)));

assert("Summary total = 4", njbOwn.body.summary?.total === 4, JSON.stringify(njbOwn.body.summary));
assert("Summary returning = 2 (merged Jason at 11 orders + the second Jason identity at 2 orders)",
  njbOwn.body.summary?.returning === 2, JSON.stringify(njbOwn.body.summary));
assert("Summary regulars = 1", njbOwn.body.summary?.regulars === 1, JSON.stringify(njbOwn.body.summary));

// ── Vito's owner, own shop ──────────────────────────────────────────────────
console.log("\nPhase 2 — Vito's owner fetches Vito's own customers");
const vitosOwn = await fetchCustomers(vitosToken, VITOS_SHOP_ID);
assert("Vito's own-shop request succeeds (200)", vitosOwn.status === 200, JSON.stringify(vitosOwn.body));
const vitosCustomers = (vitosOwn.body.customers ?? []) as Array<Record<string, unknown>>;
assert("Vito's returns 4 customer profiles", vitosCustomers.length === 4, `got ${vitosCustomers.length}`);

// ── AC2: cross-tenant isolation at the HTTP layer ───────────────────────────
console.log("\nPhase 3 — AC2: NJB owner's own valid token cannot read Vito's data");
const njbTryingVitos = await fetchCustomers(njbToken, VITOS_SHOP_ID);
assert("NJB token against Vito's shopId is rejected (never 200 with data)",
  njbTryingVitos.status !== 200,
  `status=${njbTryingVitos.status} body=${JSON.stringify(njbTryingVitos.body)}`);
assert("No Vito's customer data present in the rejected response",
  !njbTryingVitos.body.customers, JSON.stringify(njbTryingVitos.body));

console.log("\nPhase 4 — AC2 reverse: Vito's owner's own valid token cannot read NJB's data");
const vitosTryingNjb = await fetchCustomers(vitosToken, NJB_SHOP_ID);
assert("Vito's token against NJB's shopId is rejected (never 200 with data)",
  vitosTryingNjb.status !== 200,
  `status=${vitosTryingNjb.status} body=${JSON.stringify(vitosTryingNjb.body)}`);
assert("No NJB customer data (incl. merged Jason) present in the rejected response",
  !vitosTryingNjb.body.customers, JSON.stringify(vitosTryingNjb.body));

// ── Search + sort ────────────────────────────────────────────────────────────
console.log("\nPhase 5 — search + sort");
const searchRes = await fetch(`${CUSTOMER_CRM_URL}/${NJB_SHOP_ID}/customers?search=jason`, {
  headers: { Authorization: `Bearer ${njbToken}` },
});
const searchBody = await searchRes.json();
assert("Search 'jason' (case-insensitive) matches all 3 Jason-named NJB rows",
  (searchBody.customers ?? []).length === 3, `got ${searchBody.customers?.length}`);

const sortRes = await fetch(`${CUSTOMER_CRM_URL}/${NJB_SHOP_ID}/customers?sort=order_count&dir=desc`, {
  headers: { Authorization: `Bearer ${njbToken}` },
});
const sortBody = await sortRes.json();
const counts = (sortBody.customers ?? []).map((c: { order_count: number }) => c.order_count);
assert("sort=order_count&dir=desc returns non-increasing order_count",
  counts.every((v: number, i: number) => i === 0 || counts[i - 1] >= v), JSON.stringify(counts));

// ── RESULTS ───────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════════════════`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`═══════════════════════════════════════════════════════\n`);
if (failed > 0) Deno.exit(1);
