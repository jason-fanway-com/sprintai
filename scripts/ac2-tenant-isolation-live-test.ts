#!/usr/bin/env -S deno run --allow-env --allow-net
/**
 * AC2 two-tenant isolation live test (docs/specs/2026-09-03-customer-crm.md)
 *
 * Proves that a phone number with order history at NJB gets a completely cold
 * start at Vito's — and vice versa — with NO cross-tenant bleed. Also covers
 * AC3 (opt-out suppression), AC6 (regular eligibility threshold), and AC7
 * (single indexed lookup, demonstrated by code path in lookupCustomerContext).
 *
 * Run: SPRINTAI_CHAT_SUPABASE_URL=... SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY=...
 *      deno run --allow-env --allow-net scripts/ac2-tenant-isolation-live-test.ts
 *
 * Uses a clearly synthetic test phone number (+15550000099) that cannot
 * belong to a real customer. Cleans up after itself on pass or fail.
 *
 * sms_opt_outs schema (migration 056): columns are tenant_id, customer_phone,
 * opted_back_at (NULL = active opt-out; NOT NULL = opted back in). The live
 * isOptedOut() in index.ts queries: .eq("customer_phone", phone)
 * .eq("tenant_id", tenantId).is("opted_back_at", null).
 *
 * customers.last_order_id is a FK to order_carts(id) — seeded with a real
 * existing paid order ID to satisfy the FK constraint, since this test does
 * not create order_carts rows.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  lookupCustomerContext,
  computeFavoriteItemsUpdate,
  regularEligibility,
} from "../supabase/functions/_shared/customer-profile.ts";

const SUPABASE_URL =
  Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ??
  "https://rvdqfxtrskxekfkqnegx.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!SERVICE_ROLE_KEY) {
  console.error("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY not set");
  Deno.exit(1);
}

// Real tenant IDs and shop IDs — verified from live DB 2026-09-08.
const NJB_TENANT_ID   = "a0000000-0000-0000-0000-000000000001";
const NJB_SHOP_ID     = "b0000000-0000-0000-0000-000000000001";
const VITOS_TENANT_ID = "e0000000-0000-0000-0000-000000000001";
const VITOS_SHOP_ID   = "e0000000-0000-0000-0000-000000000001";

// Synthetic test phone — no real customer; cleaned up at end.
const TEST_PHONE = "+15550000099";

// A real existing paid order_carts.id used to satisfy the FK on customers.last_order_id.
// This order pre-exists in the live DB; this test only reads it (never modifies it).
const REAL_ORDER_ID = "210263a8-a521-4de1-b63b-6151ddf2d1bb";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

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

async function cleanup() {
  await supabase.from("customers").delete()
    .eq("customer_phone", TEST_PHONE);
  await supabase.from("sms_opt_outs").delete()
    .eq("customer_phone", TEST_PHONE);
}

console.log("\n═══════════════════════════════════════════════════════");
console.log("  AC2 two-tenant isolation live test  (2026-09-08)");
console.log("═══════════════════════════════════════════════════════\n");

// ── SETUP: clean any stale test data ───────────────────────────────────────
await cleanup();

// ── PHASE 1: seed a customer profile at NJB only (direct insert, no FK pain) ─
console.log("Phase 1 — Seed customer at NJB (Not Just Bagels)");

const njbFavorites = computeFavoriteItemsUpdate([], ["Everything Bagel with Cream Cheese", "Coffee"]);
const njbFavoritesX3 = computeFavoriteItemsUpdate(
  computeFavoriteItemsUpdate(njbFavorites, ["Everything Bagel with Cream Cheese"]),
  ["Everything Bagel with Cream Cheese"],
);

const { error: insertNjbErr } = await supabase.from("customers").insert({
  tenant_id:         NJB_TENANT_ID,
  customer_phone:    TEST_PHONE,
  name:              "TestJason",
  order_count:       3,
  total_spent_cents: 3897,
  favorite_items:    njbFavoritesX3,
  last_order_id:     REAL_ORDER_ID, // FK satisfied with a real existing order
  last_order_at:     new Date().toISOString(),
  first_seen_at:     new Date().toISOString(),
  last_seen_at:      new Date().toISOString(),
});
assert("insert NJB customer row succeeds", !insertNjbErr, insertNjbErr?.message);

// ── PHASE 2: AC7 — single indexed lookup at NJB returns the row ────────────
console.log("\nPhase 2 — AC7: single indexed lookup at NJB");
const njbRow = await lookupCustomerContext(supabase, NJB_TENANT_ID, TEST_PHONE);
assert("NJB lookup returns a row (not cold)",          njbRow !== null);
assert("NJB row has name 'TestJason'",                 njbRow?.name === "TestJason");
assert("NJB row order_count = 3",                      njbRow?.order_count === 3);
assert("NJB row has favorite_items",                   (njbRow?.favorite_items?.length ?? 0) > 0);

// ── PHASE 3: AC2 — same phone at Vito's gets a cold start ─────────────────
console.log("\nPhase 3 — AC2: same phone at Vito's gets cold start (no bleed)");
const vitosRow = await lookupCustomerContext(supabase, VITOS_TENANT_ID, TEST_PHONE);
assert("Vito's lookup returns null (cold start — no cross-tenant bleed)",
  vitosRow === null,
  vitosRow ? `LEAK DETECTED: ${JSON.stringify({ name: vitosRow.name, order_count: vitosRow.order_count })}` : undefined);

// ── PHASE 4: AC3 — opt-out suppression (mirrors exact isOptedOut() query) ──
console.log("\nPhase 4 — AC3: opt-out suppression");

// Confirm not opted out before inserting.
const { data: notOptedOut, error: notOptedOutErr } = await supabase
  .from("sms_opt_outs")
  .select("id")
  .eq("tenant_id", NJB_TENANT_ID)
  .eq("customer_phone", TEST_PHONE)
  .is("opted_back_at", null)
  .maybeSingle();
assert("opt-out infrastructure query works", !notOptedOutErr, notOptedOutErr?.message);
assert("test phone not opted out initially", notOptedOut === null);

// Insert an active opt-out (opted_back_at IS NULL = opted out).
// The live sms_opt_outs table has legacy not-null columns phone_number and shop_id
// from before migration 056 ran — both must be supplied even though the application
// code only queries/writes via customer_phone + tenant_id.
const { error: insertOptOutErr } = await supabase
  .from("sms_opt_outs")
  .insert({
    tenant_id:      NJB_TENANT_ID,
    customer_phone: TEST_PHONE,
    phone_number:   TEST_PHONE,  // legacy not-null column; application code uses customer_phone
    shop_id:        NJB_SHOP_ID, // legacy not-null column
    opted_back_at:  null,
  });
assert("insert opt-out row succeeds", !insertOptOutErr, insertOptOutErr?.message);

// Re-run the same query isOptedOut() uses — must find the row.
const { data: optedOutRow, error: optedOutErr2 } = await supabase
  .from("sms_opt_outs")
  .select("id")
  .eq("tenant_id", NJB_TENANT_ID)
  .eq("customer_phone", TEST_PHONE)
  .is("opted_back_at", null)
  .maybeSingle();
assert("opted-out phone detected by isOptedOut() query (AC3)", optedOutRow !== null,
  optedOutErr2?.message ?? "query returned null");
// When isOptedOut() returns true, chat-sms never calls lookupCustomerContext
// → customerRow stays null → no greeting/personalization block injected.
// That gate is at index.ts:4434-4438.

// Clean up opt-out.
await supabase.from("sms_opt_outs").delete()
  .eq("tenant_id", NJB_TENANT_ID).eq("customer_phone", TEST_PHONE);

// ── PHASE 5: AC6 — regular eligibility threshold ───────────────────────────
console.log("\nPhase 5 — AC6: regular eligibility threshold");
const regular = regularEligibility(njbFavoritesX3);
assert("Everything Bagel with Cream Cheese qualifies as 'the regular' at count >= 3",
  regular?.name === "Everything Bagel with Cream Cheese" && (regular?.count ?? 0) >= 3,
  `got: ${JSON.stringify(regular)}`);

const twoOrderFavorites = [{ name: "Large Cheese Pizza", count: 2 }];
assert("item with count 2 is NOT eligible as regular (AC6 under-threshold guard)",
  regularEligibility(twoOrderFavorites) === null);

// ── PHASE 6: reverse isolation — seed Vito's; NJB row unaffected ───────────
console.log("\nPhase 6 — AC2 reverse: seed Vito's; NJB row is untouched");
const vitosFavorites = computeFavoriteItemsUpdate([], ["Large Pepperoni Pizza"]);
const { error: insertVitosErr } = await supabase.from("customers").insert({
  tenant_id:         VITOS_TENANT_ID,
  customer_phone:    TEST_PHONE,
  name:              "TestJasonVitos",
  order_count:       1,
  total_spent_cents: 2499,
  favorite_items:    vitosFavorites,
  last_order_id:     REAL_ORDER_ID,
  last_order_at:     new Date().toISOString(),
  first_seen_at:     new Date().toISOString(),
  last_seen_at:      new Date().toISOString(),
});
assert("insert Vito's customer row succeeds", !insertVitosErr, insertVitosErr?.message);

const vitosRow2 = await lookupCustomerContext(supabase, VITOS_TENANT_ID, TEST_PHONE);
assert("Vito's now has its own row", vitosRow2 !== null);
assert("Vito's row name is 'TestJasonVitos'", vitosRow2?.name === "TestJasonVitos");
assert("Vito's row order_count = 1 (NOT NJB's 3)", vitosRow2?.order_count === 1);

// NJB row must be completely unaffected by the Vito's insert.
const njbRowFinal = await lookupCustomerContext(supabase, NJB_TENANT_ID, TEST_PHONE);
assert("NJB row name still 'TestJason' (not contaminated by Vito's insert)",
  njbRowFinal?.name === "TestJason");
assert("NJB row order_count still 3 (not contaminated by Vito's 1)",
  njbRowFinal?.order_count === 3);

// ── CLEANUP ────────────────────────────────────────────────────────────────
await cleanup();

// ── RESULTS ────────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════════════════`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`═══════════════════════════════════════════════════════\n`);
if (failed > 0) Deno.exit(1);
