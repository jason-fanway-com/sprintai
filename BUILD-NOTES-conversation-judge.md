# BUILD-NOTES — Conversation Judge (Spec 06)

**Branch:** `feat/conversation-judge` (off `origin/main` @ `fb0718c`)
**Builder:** John Walsh · **Date:** 2026-06-22 · **Status:** TEST ONLY — not merged, not deployed. Waits for Jason's explicit go.

## What this is
An async, **read-only**, out-of-band LLM judge that grades every completed diner
conversation against the Sprint rubric and surfaces failures. It NEVER sits in
the live order path. If the LLM is down or the judge crashes, the diner bot
(chat-sms) is completely unaffected — they share no code path and no table write.

## The hard invariant (proven)
- `chat-sms/index.ts` is **byte-for-byte unchanged** by this branch
  (md5 `ce3896d736f69b78bc889ffa17420d92` on both this branch and origin/main;
  full live-path `git diff` is empty). See `_proof/CHATSMS-UNCHANGED-PROOF.txt`.
- The judge writes ONLY to the new `conversation_evals` table. It READS
  conversations/messages/menus/shops/order_carts. It never writes carts,
  messages, checkout, or sends SMS.

## Files (with line ranges)
| Piece | File | Lines |
|---|---|---|
| Migration (up) | `supabase/migrations/014_conversation_evals.sql` | 1–127 |
| Migration (down) | `supabase/migrations/014_conversation_evals.down.sql` | 1–30 |
| Rubric (single source of truth) | `supabase/functions/_shared/judge-rubric.ts` | rubric text @72; `assembleJudgePrompt` @159; `parseJudgeJson` @235; `maxSeverityOf` @275 |
| Notify layer (digest + gated send) | `supabase/functions/_shared/judge-notify.ts` | `buildImmediateDigest` @81; `buildMinorRollup` @128; `sendDigest` gated seam @177 |
| Auto-fix seam (built, OFF) | `supabase/functions/_shared/judge-autofix.ts` | `autofixEnabled` @20; `maybeAutoFix` @34 |
| Judge worker (scheduled sweep) | `supabase/functions/eval-sweep/index.ts` | 501 lines (config @43; ground-truth/isolation @~100; `callJudge` @~230; candidate select @~308; `runSweep` @~360; entry @~475) |
| Function registration | `supabase/config.toml` | `[functions.eval-sweep]` block |
| Command Center panel | `admin-dashboard/src/pages/ConversationQuality.tsx` | 1–end |
| Panel route | `admin-dashboard/src/App.tsx` | new import + `conversation-quality` route |
| Panel nav link | `admin-dashboard/src/components/Layout.tsx` | nav array |

## Decisions made at build (Spec §6 open items)
- **Judge model:** `claude-haiku-4-5` (cheap/fast; same provider/key as chat-sms,
  `ANTHROPIC_API_KEY` already provisioned). Override via `JUDGE_MODEL` env.
- **Idle threshold N:** 10 minutes (locked by Jason). Env `JUDGE_IDLE_MINUTES`.
- **Daily spend ceiling:** **200¢ ($2.00/day)** — `JUDGE_DAILY_SPEND_CEILING_CENTS`.
  Haiku judges a conversation for ~$0.001–0.005, so $2/day covers ~400–2000
  conversations/day — generous at testing scale. The sweep sums today's
  `cost_cents` and STOPS judging once the ceiling is hit (logged).
- **MINOR digest cadence:** **daily** rollup (grouped by shop+check, counts), via
  `buildMinorRollup`. MINOR never per-incident pings. CRITICAL/MAJOR ping
  individually, worst-first.
- **Cap per sweep:** 50 conversations (`JUDGE_MAX_PER_SWEEP`).
- **Schedule:** set at deploy (e.g. `*/5 * * * *`); the function is invoked by the
  scheduler with the service-role key, never inline by chat-sms.

## Where the panel lives (important note for the lead)
Spec §4 says "Command Center panel." There are TWO things called Command Center
in this repo:
1. `command-center/command-center.html` (branch `feat/command-center-stage1`, NOT
   merged) — a **static program/PM dashboard** (roadmap, risks, epics). It has no
   tenant-data wiring (no Supabase reads).
2. `admin-dashboard/` (the live React admin app, reads Supabase, has Tenants /
   Conversations / drill-down) — this is the **operational tenant dashboard**.

The "Conversation Quality" panel is tenant-DATA (reads `conversation_evals` per
tenant, drills into transcripts). That belongs in the **admin-dashboard** app,
which already has the auth, tenant filter, and `/conversations/:id` drill-down
the spec requires. I added it there as a new route + nav item. The static
program HTML is the wrong home (no data layer). **Flagging this for the lead:** if
Jason specifically wants the tile inside the static program HTML too, that's a
small follow-up — but the functional, data-backed panel is in admin-dashboard.
Existing panels are untouched (vite build passes, 1531 modules).

## Tenant isolation (absolute)
`loadGroundTruth` resolves the shop from THIS conversation's own cart/tenant and
includes an explicit guard: if a resolved shop's `tenant_id` does not match the
conversation's `tenant_id`, it refuses the ground truth (logs ISOLATION error).
One tenant's menu/hours can never judge another tenant's conversation. Proven by
the isolation probe in `_proof/RUBRIC-PROOF.txt`.

## Notify stub (how the real send is gated)
`sendDigest` is gated: it only really hits Telegram when
`JUDGE_TELEGRAM_SEND_ENABLED === "true"` AND `TELEGRAM_BOT_TOKEN` +
`JUDGE_TELEGRAM_CHAT_ID` are set. In TEST mode (default) it logs the full digest
payload and returns `{sent:false, stubbed:true}`. No real Telegram message is
sent during this build. The digest text artifacts are in `_proof/PIPELINE-PROOF.txt`.

## Auto-fix seam (OFF)
`EVAL_AUTOFIX_ENABLED` defaults false → `maybeAutoFix` is a pure no-op
(`{dispatched:false, reason:"disabled"}`). Even if flipped true, actual crew
dispatch is intentionally NOT wired (the seam logs and returns
`dispatched:false`), so the env flag alone cannot fire auto-dispatch. Enabling
it for real is a deliberate later task. Proven in `_proof/PIPELINE-PROOF.txt`.

## Proofs (all under `supabase/functions/eval-sweep/_proof/`)
- `RUBRIC-PROOF.txt` — REAL `claude-haiku-4-5` run on seeded transcripts:
  phantom-link→CRITICAL, wrong-total→CRITICAL, invented-item→CRITICAL,
  cold-tone→MINOR, clean→no flag; clean batch→zero flags; tenant isolation
  flags T1-orders-sushi. **ALL PASS.**
- `MIGRATION-PROOF.txt` — REAL Postgres (pglite): up applies, re-run up = no-op,
  4 indexes + 2 RLS policies, FKs resolve, unique(conv,hash) + verdict CHECK
  enforced, down drops, re-run down = no-op. **ALL PASS.**
- `PIPELINE-PROOF.txt` — idempotency hashing, digest severity-order + MINOR
  rollup, quiet-on-clean, safe-degrade parse, auto-fix OFF. **ALL PASS.**
- `DEGRADE-PROOF.txt` — LLM-down → judge throws after retries → eval errored →
  sweep continues. **ALL PASS.**
- `CHATSMS-UNCHANGED-PROOF.txt` — live path byte-unchanged.
- `migration-proof.sql` — psql harness Melvin can run against any throwaway PG.
- `seeds.ts` — the seeded ground-truth + transcripts (2 tenants).

## How to re-run the proofs
```
export PATH="$HOME/.deno/bin:$PATH"
cd supabase/functions/eval-sweep/_proof
# pipeline + degrade (no key needed):
deno run --allow-env run-pipeline-proof.ts
deno run --allow-net run-degrade-proof.ts
# real LLM rubric (needs ANTHROPIC_API_KEY):
ANTHROPIC_API_KEY=... deno run --allow-env --allow-net run-rubric-proof.ts
# migration (needs node + @electric-sql/pglite):  see /tmp/migproof.mjs pattern
```

## Confirmations
- Committed to `feat/conversation-judge` ONLY. Not merged, not pushed to main, not deployed.
- chat-sms unchanged (md5 identical). Live bridge PID 18724 untouched (never started/killed/restarted).
- No real Telegram send (gated stub). No secrets committed (key read from `~/.openclaw/.secrets` only at proof runtime, never written to repo).
- `deno check` clean on all new function files; admin-dashboard `tsc` + `vite build` pass.
- Migration NOT applied to any remote DB (only ephemeral pglite locally).
