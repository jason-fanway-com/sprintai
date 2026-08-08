# Tenant Isolation Verification — FINAL RESULTS
**Date:** 2026-08-07  
**Project:** `rvdqfxtrskxekfkqnegx` (SPRINTAI_CHAT)  
**Verifier:** Melvin (DeepSeek V4 Pro)

---

## VERDICT: CRITICAL FAIL (2 exploitable gaps, 1 medium-risk gap)

The core tenant isolation model **works** for tables with RLS. However, **2 tables have RLS disabled** and are fully accessible (read/write/delete) via the anon key, exposing real customer PII and phone numbers.

---

## METHODOLOGY

Three-pronged approach against the live Supabase project:
1. **Management API SQL** — Policy audit (68 RLS policies catalogued)
2. **Direct RLS SQL simulation** — SET LOCAL role/jwt.claims to simulate shop_owner, super_admin
3. **Unauthenticated REST API testing** — anon key against all tables

All tests ran against the production Supabase project. No data was modified (test rows inserted and deleted).

---

## FINDING 1: CRITICAL — `outbound_queue` fully exposed (no RLS)

**Impact:** Anyone with the anon key (public) can read, insert, or delete any row.

**Exposed data (10 rows):**
- Customer phone numbers (4 unique: +16102565023, +16107374183, +14847888671, +16102565023)
- SMS message content including payment confirmations with customer names and order details
- Example: `"Payment confirmed! Order for Jason: Half Dozen Bagels. Total: $7.50"`

**Verified attacks:**
| Action | Method | Result |
|---|---|---|
| READ all rows | `GET /rest/v1/outbound_queue` (anon) | 200 — 10 rows returned |
| INSERT row | `POST /rest/v1/outbound_queue` (anon) | 201 — row created |
| DELETE row | `DELETE /rest/v1/outbound_queue` (anon) | 204 — row deleted |

**Root cause:** Table has no RLS enabled and no tenant_id column.

---

## FINDING 2: CRITICAL — `number_provision_log` fully exposed (no RLS)

**Impact:** Same — anon key has full CRUD.

**Exposed data (2 rows):**
- Twilio phone numbers: +17373126046, +16109366213
- Twilio SIDs (PN6583a023..., PN4f522bd1...)
- Shop provisioned dates

**Verified attacks:**
| Action | Method | Result |
|---|---|---|
| READ all rows | `GET /rest/v1/number_provision_log` (anon) | 200 — 2 rows returned |
| INSERT row | `POST /rest/v1/number_provision_log` (anon) | 201 — row created |
| DELETE row | `DELETE /rest/v1/number_provision_log` (anon) | 204 — row deleted |

---

## FINDING 3: MEDIUM — `admin_chat_transcripts` INSERT `check=true`

The policy "Service can insert chat transcripts" has `with_check=true`, meaning **any authenticated user from any tenant** can INSERT rows. An authenticated user could flood the table with junk from a malicious tenant.

**Current state:** RLS policies on SELECT work correctly (anon returns 0 rows, shop_owners scoped). The INSERT gap is noisy-neighbor, not cross-tenant data theft.

---

## CORE TENANT ISOLATION: ✅ PASS

For all tables with RLS, tenant isolation works correctly via SQL simulation:

| Test | Result |
|---|---|
| NJB shop_owner reads shops | ✅ 1 shop (own only) |
| NJB updates Melvin's shop | ✅ DENIED (0 rows) |
| NJB updates own shop | ✅ ALLOWED |
| NJB reads tenants | ✅ 1 tenant (own only) |
| NJB spoofs user_metadata → Melvin | ✅ Spoof ignored — NJB data only |
| Super admin reads shops | ✅ All 6 across all tenants |

RLS correctly uses `app_metadata.tenant_id` for enforcement. `user_metadata` has no authorization effect.

---

## ADDITIONAL GAPS (lower severity)

| Severity | Issue |
|---|---|
| LOW | `availability_overrides` "Public can manage" policy (cmd=ALL). Table is empty today, but policy grants anon full CRUD if data existed. Intentional for ordering flow but over-permissive. |
| LOW | `stripe_webhook_events` — no RLS. Empty table today, low PII risk. |
| NOTE | `integrations` and `usage_events` have only admin policies — shop owners can't access own data via REST API. Likely service_role-only. |
| NOTE | 32 tenants exist, mostly E2E test tenants. 2 real: NJB + Melvin QA. No cross-tenant data integrity issues found. |

---

## REQUIRED ACTIONS

1. **`outbound_queue`** — Add RLS immediately. At minimum, enable RLS and deny all (table is accessed via service_role edge functions). Add a tenant_id or shop_id column for proper scoping.
2. **`number_provision_log`** — Same. Enable RLS and add shop_id-scoped policy. Table already has `shop_id` column — use it.
3. **`admin_chat_transcripts` INSERT** — Change `check=true` to `check = is_super_admin()`.
4. **`availability_overrides`** — Review "Public can manage" policy. If ordering flow needs public reads only, split into SELECT (public) + scoped CUD policies.