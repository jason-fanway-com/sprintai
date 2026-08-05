# Phase 1 — Issue Detection Loop: TODOs

## Pre-deploy
- [ ] **Apply migration** `030_issue_detection.sql` to TEST Supabase project
  - `npx supabase db push` or run SQL in Supabase dashboard
  - Verify tables exist: `issues`, `resolution_log`
  - Verify RLS policies applied correctly

## Edge function deploy
- [ ] **Deploy `issue-detector` edge function**
  - `npx supabase functions deploy issue-detector`
  - Set env var: `SUPABASE_SERVICE_ROLE_KEY`
  - Test: `curl -H "Authorization: Bearer $ANON_KEY" https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/issue-detector`
- [ ] **Schedule the edge function**
  - Option A: pg_cron is in the migration — if pg_cron + pg_net + vault are available, it'll auto-schedule
  - Option B: External cron: `*/15 * * * * curl ... https://...issue-detector` or CI/CD schedule
  - Verify the function runs and creates issues when detection rules fire

## Heartbeat script
- [ ] **Set up check-issues.sh as cron/launchd**
  - env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - Test: `./scripts/check-issues.sh --help`
  - Dry run: `CHECK_ISSUES_DRY_RUN=1 ./scripts/check-issues.sh`
  - Wire to cron (every 5 min recommended)
  - Verify trigger files land in `spec-inbox/.triggers/`

## Post-deploy verification
- [ ] **Visit Admin Dashboard → Issues** at `getsprintai.com/admin/issues`
  - Load list, verify empty state / seeded issues
  - Click into a detail page, check diagnosis view
  - Test acknowledge / resolve / dismiss actions
  - Check resolution log entries appear
  - Check navigation link shows in sidebar

## Known limitations (future phases)
- Detection rules are conservative to avoid noise — thresholds may need tuning
- Sev-1 trigger files require the heartbeat script (edge functions can't write local filesystem)
- Auto-resolve logic checks for clean subsequent evals but doesn't auto-close manually acknowledged issues
- No Slack/webhook notifications yet (Phase 2 candidate)
- No tenant-facing issue visibility
