# Security 012 — Proof & Verification

**Branch:** `sec/merchant-rls-lockdown` (off `wizard-05`) — committed, NOT merged.
**Constraint honored:** No production deploy. No live DB. No secrets committed.

## What changed

| Artifact | Path |
|---|---|
| Dependency inventory | `supabase/migrations/SECURITY-012-merchant-rls-inventory.md` |
| Lockdown migration | `supabase/migrations/012_merchant_rls_lockdown.sql` |
| Server-side PIN + writes | `supabase/functions/merchant-auth/index.ts` |
| Function registration | `supabase/config.toml` (`[functions.merchant-auth] verify_jwt=false`) |
| Merchant UI rewired | `merchant-ui/index.html` |
| This proof | `supabase/migrations/SECURITY-012-PROOF.md` |

## Required new env var (deploy-time, NOT committed)

`MERCHANT_AUTH_SECRET` — random string used to HMAC-sign the merchant session
token. Set in Supabase function secrets before deploying `merchant-auth`. No
value is stored in the repo. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
already provided to edge functions by the platform.

---

## Static-analysis proof (no live DB available locally)

I could not run a live Supabase instance (no local DB, and the task forbids
hitting production). Proof is by code + policy reasoning. Melvin should run the
SQL checks in the next section against a TEST project to confirm dynamically.

### (a) anon can no longer read `merchant_pin`
- `004` policy `"Public can read shops"` (anon SELECT USING true) is **dropped**
  by `012` line: `DROP POLICY IF EXISTS "Public can read shops" ON shops;`
- `012` also `REVOKE ALL ON shops FROM anon;`. With no anon policy AND no anon
  table grant, PostgREST returns permission-denied for anon on `shops`. There is
  no remaining anon SELECT path to any `shops` column, including `merchant_pin`.
- merchant-ui no longer requests `merchant_pin` at all: the only reference left
  is a comment (line ~477). PIN now travels client→`merchant-auth` and is
  compared server-side via the service-role read; it is never returned.

### (b) anon can no longer write `availability_overrides` or shop pause
- `004` policies `"Public can manage availability overrides"` (anon ALL) and
  `"Public can update shop pause status"` (anon UPDATE) are **dropped** by `012`.
- `012` `REVOKE ALL ON availability_overrides FROM anon;` and
  `REVOKE ALL ON shops FROM anon;` remove the privilege entirely.
- merchant-ui's direct anon REST helpers (`sbPost/sbDelete/sbPatch`) were
  **removed**; all writes go through `sbFn` → `merchant-auth` (service-role).

### (c) the diner bot's service-role reads still work
- `chat-sms` builds its client with `SUPABASE_SERVICE_ROLE_KEY`
  (`index.ts:1173-1176`). Service-role **bypasses RLS** and is **unaffected by
  REVOKEs** on the `anon` role. Its reads of `shops` (`:1212,:1242`),
  `availability_overrides` (`:289`), and pause (`shop.is_paused`) are untouched.
- Same for `onboarding-save`, `go-live`, `scrape-shop`, `connect-*`,
  `provision-number`, `import-menu-csv`, `parse-menu-pdf`, `stripe-webhook`.

### (d) the merchant Sold-Out flow still works via the new verified path
- Login: `handlePinSubmit` → `sbFn({action:'verify',slug,pin})` →
  `merchant-auth` reads PIN server-side, compares, returns a 12h HMAC token.
- Load: `loadMenu` → `sbFn({action:'state',token})` returns shop pause + menu
  items + today's sold-out set in one call (token-scoped to one shop).
- 86 toggle: `applyToggle` → `sbFn({action:'set_availability',token,...})`
  (re-verifies token, checks item belongs to the shop, writes with service-role).
- Reset: `sbFn({action:'reset_availability',token})`.
- Pause: `togglePause` → `sbFn({action:'set_pause',token,paused})`.
- Session restore requires a stored `token`; an expired/invalid token yields 401
  and forces re-auth (no client-side trust).
- merchant-ui JS passes `node --check` (syntax OK).

### Tenant isolation
- Every write derives `shop_id` from the **token**, never from the request body.
  `set_availability` additionally verifies the item belongs to the token's shop
  (`itemBelongsToShop`). A merchant token for shop A cannot touch shop B.

---

## Dynamic verification commands for Melvin (run against a TEST project)

Apply migrations through 012 to a throwaway/test Supabase, then:

```sql
-- 1) Confirm the three wide-open anon policies are gone:
SELECT polname FROM pg_policy
 WHERE polname IN ('Public can read shops',
                   'Public can update shop pause status',
                   'Public can manage availability overrides');
-- EXPECT: 0 rows.

-- 2) Confirm anon has no table privileges on the two locked tables:
SELECT grantee, privilege_type, table_name
  FROM information_schema.role_table_grants
 WHERE grantee='anon' AND table_name IN ('shops','availability_overrides');
-- EXPECT: 0 rows.

-- 3) Confirm service-role / authenticated are untouched (admin policies remain):
SELECT polname FROM pg_policy WHERE polname LIKE 'Admins have full access%';
-- EXPECT: includes shops + availability_overrides admin policies.
```

REST checks with the public anon key against the TEST project:

```bash
ANON="<test-project-anon-key>"; URL="https://<test-ref>.supabase.co"
# anon read of merchant_pin -> EXPECT 401/empty, NOT the PIN:
curl -s "$URL/rest/v1/shops?select=merchant_pin&limit=1" -H "apikey:$ANON" -H "Authorization:Bearer $ANON"
# anon insert override -> EXPECT permission denied:
curl -s -X POST "$URL/rest/v1/availability_overrides" -H "apikey:$ANON" \
  -H "Authorization:Bearer $ANON" -H "Content-Type:application/json" \
  -d '{"shop_id":"<id>","menu_item_id":"<id>","business_date":"2026-06-21"}'
# anon pause update -> EXPECT permission denied:
curl -s -X PATCH "$URL/rest/v1/shops?id=eq.<id>" -H "apikey:$ANON" \
  -H "Authorization:Bearer $ANON" -H "Content-Type:application/json" -d '{"is_paused":true}'
```

merchant-auth happy path (after deploying the function to the TEST project with
`MERCHANT_AUTH_SECRET` set):

```bash
# verify -> returns token (never the PIN):
curl -s -X POST "$URL/functions/v1/merchant-auth" -H "apikey:$ANON" \
  -H "Authorization:Bearer $ANON" -H "Content-Type:application/json" \
  -d '{"action":"verify","slug":"<slug>","pin":"<correct-pin>"}'
# wrong PIN -> EXPECT 401 {"error":"Incorrect PIN"}.
# then state / set_availability / set_pause with the returned token.
```

---

## Constraints confirmation
- NO production deploy was performed.
- NO live/production DB was touched.
- NO secrets are committed (the function reads `MERCHANT_AUTH_SECRET` and
  `SUPABASE_SERVICE_ROLE_KEY` from env; only the public anon JWT — which is
  designed to be public and was already in the repo — appears in merchant-ui).
- Work is on branch `sec/merchant-rls-lockdown`, committed, NOT merged.

## Seam left for future SprintAdmin auth
`merchant-auth` is a minimal PIN→token bridge. When real accounts land, replace
`verifyPin` + token minting with the identity provider; the write handlers and
their "token resolves to exactly one shop_id" contract stay as-is.
