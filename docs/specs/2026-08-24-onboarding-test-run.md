# Spec: Onboarding creates a real Production Readiness test RUN

**Owner:** SprintAI_bot → John Walsh → Melvin
**Date:** 2026-08-24
**Directive (Jason):** Onboarding must **create a test run** — generate the shop's ~100 cases, run them, judge them, and persist a scored `test_runs` row. The current `generate-test-cases` edge function only builds case defs in memory and discards them (Melvin escalation, #3435). Fix that.

## Constraint (why a worker)
`scripts/test-suite/run.ts` already does the full pipeline: `generateCases` → `runCase` (multi-turn chat-sms calls) → `judgeCase` (LLM via OpenRouter/Anthropic) → `buildScorecard` → `persistResults` (writes `test_runs` + `test_case_results`). ~100 cases = hundreds of calls over minutes. This **cannot** run in the signup request or a single Supabase edge function (timeout/CPU). Run it async via a worker. **Reuse run.ts — do not reimplement the pipeline.**

## Tasks

1. **Queue table** — migration `supabase/migrations/064_test_run_queue.sql`:
   ```sql
   CREATE TABLE IF NOT EXISTS test_run_queue (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
     tenant_id uuid NOT NULL,
     status text NOT NULL DEFAULT 'pending',   -- pending | running | done | error
     reason text,                              -- 'onboarding' | 'manual' | ...
     error text,
     test_run_id uuid,                         -- FK to test_runs once complete (nullable)
     requested_at timestamptz NOT NULL DEFAULT now(),
     started_at timestamptz,
     finished_at timestamptz
   );
   CREATE INDEX IF NOT EXISTS idx_test_run_queue_status ON test_run_queue(status, requested_at);
   ```
   RLS: service-role only (same posture as other ops tables — no anon/authenticated). Apply to live project rvdqfxtrskxekfkqnegx.

2. **Enqueue at onboarding** — replace the fire-into-void behavior:
   - `supabase/functions/generate-test-cases/index.ts`: instead of (or in addition to) returning counts, INSERT a `test_run_queue` row `{shop_id, tenant_id, status:'pending', reason:'onboarding'}`. **Idempotency:** if a `pending` or `running` row already exists for this shop, do NOT insert another. (setup.html already calls this via `fireTestGen()` after menu save — keep that call.)
   - Keep it fire-and-forget from setup.html; a failure must never block menu save.

3. **Worker** — `scripts/test-suite/worker.ts` (Deno), run under launchd like the imsg-bridge:
   - Poll `test_run_queue` for the oldest `pending` row (`limit 1`), mark it `running` (set `started_at`).
   - Run the existing pipeline for that `shop_id` (import `generateCases`, `runCase`, `judgeCase`, `buildScorecard`, `persistResults` from `scripts/test-suite/` — the same calls `run.ts` makes). Capture the resulting `test_runs.id`.
   - On success: set queue row `status='done'`, `test_run_id`, `finished_at`.
   - On failure: `status='error'`, `error=<message>`, `finished_at`. Retriable (leave for manual requeue; do not infinite-loop a poison row — an errored row is terminal).
   - Idle poll interval: default 15s, env-overridable (`WORKER_POLL_INTERVAL`), same lightweight pattern as imsg-bridge. Only does DB work when a row is pending.
   - Secrets from env: `SPRINTAI_CHAT_SUPABASE_URL`, `SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` (already on the Mac).
   - launchd plist `com.sprintai.test-run-worker.plist` in `~/Library/LaunchAgents` (mirror com.sprintai.imsg-bridge.plist: RunAtLoad, KeepAlive, stdout/err to /tmp). Provide the plist; do NOT auto-load it — the lead loads it after review.

4. **Do NOT auto-run on every menu edit.** Only enqueue on onboarding menu save (reason='onboarding') and via an explicit manual trigger later. Debounce via the idempotency guard in task 2.

## Acceptance (Melvin, live)
- Migration 064 applied; `test_run_queue` exists, service-role-only.
- Saving a menu at onboarding inserts exactly ONE pending queue row per shop (re-saving does NOT add a second while one is pending/running).
- With the worker running, a queued row transitions pending → running → done, and a **real `test_runs` row + `test_case_results`** are written for that shop, tenant-scoped, visible in the Production Readiness tab.
- A forced failure marks the row `error` with a message and never blocks onboarding.
- Non-onboarding paths unaffected; no cross-tenant writes.

## Out of scope (v1)
- Go-live hard gate on the score (separate task).
- Hosted/multi-worker scaling (single launchd worker for now; flagged ceiling).
- Auto-run on menu edits.
