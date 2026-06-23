# BUILD-NOTES — Command Center (LIVE, self-updating)

Branch: `feat/command-center-live` (off `origin/main` @ cffefbb)
Author: John Walsh (builder)
Scope: Replace the static, hand-maintained Command Center with a LIVE operator
page inside the existing `admin-dashboard` React app. It derives **all** content
from real sources at view-time, so it can never go stale.

NOT merged, NOT pushed to main, NOT deployed. No order-path file touched. No
secret in code or committed files.

---

## Why this design

The prior Command Center was a hand-edited HTML page (`command-center/command-center.html`
on `feat/command-center-stage1`/`-auth-gate`). It drifts because a human must
update it. This rebuild makes every panel a live query against the same data the
admin app already has access to, behind the app's existing auth.

It lives in `admin-dashboard/` because that app already has: Supabase client,
auth (`ProtectedRoute`), tenant context, the `card`/`btn-secondary` design system,
and a deploy pipeline. New route `/command-center` + a nav entry, mounted under
the authed `Layout` — internal super-admin, not public.

---

## Files changed

| File | Change | Lines |
|---|---|---|
| `admin-dashboard/src/pages/CommandCenter.tsx` | **NEW** — the page (4 panels + vitals) | 1–360 |
| `admin-dashboard/src/App.tsx` | import + `<Route path="command-center">` under authed Layout | import added after ConversationQuality import; route added after `conversation-quality` |
| `admin-dashboard/src/components/Layout.tsx` | nav entry "Command Center" (Activity icon), first item | import line + `nav` array first element |
| `supabase/migrations/016_command_center.sql` | **NEW** migration — `program_items` table + seed + `command_center_deploy_status()` SECURITY DEFINER fn | whole file |
| `supabase/migrations/016_command_center.down.sql` | **NEW** reversible down | whole file |
| `admin-dashboard/dist/**` | rebuilt bundle (dist is tracked on origin/main) | generated |
| `proof-command-center/**` | **NEW** proof artifacts (not app code) | — |

---

## Data source per panel (all read with the admin user's JWT — no secret)

1. **Platform health / deploy state**
   - *Applied migrations*: `supabase.rpc('command_center_deploy_status')`. This is
     a NEW **SECURITY DEFINER** function (migration 016) that reads
     `supabase_migrations.schema_migrations`. That schema is **not exposed by
     PostgREST** (proven: REST returns `PGRST106 Invalid schema`), so no browser
     client — even with service role over REST — can read the ledger directly.
     The function runs as its owner (can read the ledger), is **admin-gated inside
     the body** (`auth.jwt()->'user_metadata'->>'is_admin' = 'true'`, else raises
     42501), and returns ONLY `version` + `name`. No secret involved; the browser
     calls it with the admin user's JWT.
   - *Edge functions*: rendered from a NON-secret static manifest of function
     names (public repo facts). Per-function **deploy versions** are **not
     available client-side** without a secret, so they are intentionally omitted
     with a visible note — per the no-secret hard rule.

2. **Conversation-quality rollup** — `conversation_evals` via the admin Supabase
   client (table has an "Admins have full access" RLS policy). Computes
   clean/flagged/errored counts, high- vs low-confidence flagged counts, most
   recent `judged_at` (last sweep), and total `cost_cents` (sweep spend). Worst-
   first list of recent high-confidence flags, each with a drill-through link to
   the existing `/conversations/:id` drilldown. Also links to `/conversation-quality`.

3. **Onboarding / tenant state** — `shops` + `tenants` via the admin client (both
   have admin-full-access RLS). Aggregate counts: total shops, live
   (`onboarding_step = 'done'`), paused, subscription-active, Connect-enabled,
   tenant count, and a breakdown by `onboarding_step`. Aggregate operator view;
   RLS still applies.

4. **Known open items / blockers** — `program_items` (NEW table, migration 016),
   admin-only RLS. The one legitimately editorial slice — stored as ROWS so an
   update is a row write, not a redeploy. Seeded with the three current known
   items (judge auto-timer not enabled; welcome/index.html 0-byte Stripe success
   target; subscription billing spec 03 not built).

---

## How secrets are kept out of the bundle

- The page uses only the existing `supabase` client (anon key + the logged-in
  admin's JWT). It never imports or references a service-role key or access token.
- The migrations ledger — the one thing not client-readable — is reached via an
  **admin-gated SECURITY DEFINER RPC**, not by handing the browser elevated creds.
- **Verified** by scanning the built bundle (`dist/assets/index-*.js`):
  - no `service_role` / `sbp_` / `sb_secret` literal,
  - the only embedded JWT is the public **anon** key (`"role":"anon"`),
  - exact-value `grep -F` for the chat service-role key, `SUPABASE_SERVICE_ROLE_KEY`,
    and `SUPABASE_ACCESS_TOKEN` all **NOT present**.
  See `proof-command-center/bundle-secret-scan.txt`.

---

## Proof artifacts (`proof-command-center/`)

- `migration-proof.txt` — migration 016 applied to a **throwaway local Postgres
  16.14** cluster (no docker; spun up via Homebrew `postgresql@16` in `/tmp`,
  then stopped). Proves: UP, REUP (idempotent, seed stays 3 rows, no dup), DOWN
  (table + fn dropped), REDOWN (idempotent), UP-AFTER-DOWN (3 rows again). Also
  shows the admin-gated fn returning migration versions and **rejecting a
  non-admin** caller (42501).
- `bundle-secret-scan.txt` — the secret scan result above (PASS).
- `live-data-proof.txt` — the real values each panel computes, read from the test
  project with the SPRINTAI_CHAT service-role key **from the shell, for proof
  only** (never baked into the app): 62 evals (20 clean / 42 flagged, 42 high-
  confidence, 0 errored), last sweep 2026-06-23T00:00Z, spend $0.18; 6 shops (1
  live, 4 paused), 32 tenants; and the `PGRST106` proof that the ledger is not
  REST-reachable.
- `rendered-proof.html` + `rendered-proof.png` — a render of the page populated
  with those exact real values (headless-Chrome screenshot), showing the 4-vital
  + 4-panel layout.

---

## Constraints / Definition of Done — status

- Reuses `ProtectedRoute` (mounted under authed `Layout`). Not public; not added
  to any publish allowlist. ✅
- No service-role key / access token / secret in the client bundle — scanned. ✅
- New migration additive/idempotent/reversible with `.down`; applied only to a
  throwaway local DB. Remote left for the lead. ✅
- chat-sms / order-path BYTE-UNCHANGED — empty `git diff origin/main` for
  chat-sms, create-checkout, refund-order, stripe-webhook, toast-order, and
  `scripts/imsg-bridge.sh`; md5 identical to origin/main blobs. ✅
- admin-dashboard `tsc` + `vite build` pass. ✅

## Deploy steps left for the lead (NOT done here)
1. Apply migration `016_command_center.sql` to the remote project (via the
   normal migration pipeline). The down is `016_command_center.down.sql`.
2. Build + deploy `admin-dashboard` (existing pipeline). No edge-function deploy
   is required — this build adds **no** new/changed edge function (the deploy-
   status data comes from the in-DB RPC created by migration 016).
3. Optionally curate `program_items` rows as items open/close (row writes).
