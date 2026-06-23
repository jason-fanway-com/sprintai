# BUILD NOTES — Conversation Judge AUTO-TIMER (`feat/judge-autotimer`)

**Builder:** John Walsh · **Branch:** `feat/judge-autotimer` (off `origin/main` @ `0ebbecd`)
**One-liner:** make the already-deployed `eval-sweep` edge function fire automatically every 5 minutes via Supabase `pg_cron` + `pg_net`, with the auth bearer pulled from Supabase Vault — never from a literal.

This branch is **additive only**. It adds one migration (+ its down) and a proof folder. It changes **no** live function and **no** existing table.

---

## Files added (exact)

| File | Lines | What |
|---|---|---|
| `supabase/migrations/017_judge_autotimer.sql` | 1–93 | UP: `CREATE EXTENSION IF NOT EXISTS pg_cron, pg_net`; guarded unschedule; `cron.schedule('judge-eval-sweep','*/5 * * * *', …)` doing a `net.http_post` to the eval-sweep endpoint with the bearer read from Vault. |
| `supabase/migrations/017_judge_autotimer.down.sql` | 1–27 | DOWN: guarded `cron.unschedule('judge-eval-sweep')`. Leaves extensions + Vault secret in place (documented). |
| `proof-judge-autotimer/*` | — | All proofs (see below). |
| `BUILD-NOTES-judge-autotimer.md` | this file | — |

Key SQL line ranges in `017_judge_autotimer.sql`:
- `CREATE EXTENSION` (pg_cron, pg_net): **lines 56–57**
- guarded unschedule (idempotency): **lines 64–72**
- `cron.schedule(...)` + `net.http_post` body with Vault lookup: **lines 79–96**
- Vault reference (`vault.decrypted_secrets where name = 'eval_sweep_bearer'`): **lines 80–84**

---

## Scheduling pattern (verified against Supabase docs, 2026-06)

Sources read before finalizing (not guessed):
- `supabase.com/docs/guides/functions/schedule-functions` — the canonical pg_cron + pg_net pattern: `cron.schedule(name, cron_expr, $$ select net.http_post(url:=…, headers:=jsonb_build_object(...), body:=…) $$)`, with auth pulled from **Supabase Vault** (`vault.decrypted_secrets`).
- `supabase.com/docs/guides/cron` — pg_cron lives in schema `cron`; jobs are rows in `cron.job`; run history in `cron.job_run_details`. Recommendation: ≤8 concurrent jobs, each ≤10 min.
- `supabase.com/docs/guides/database/vault` — `vault.create_secret(secret, name, description)` stores encrypted; read via the `vault.decrypted_secrets` view.

**Deviation from the doc example, and why:** the doc example sends a `publishable_key` in an `apikey` header. `eval-sweep` is a privileged, write-capable sweep (it judges every tenant's conversations using the service-role client inside the function) and is invoked with a **service-role bearer**, exactly as it is today when invoked manually. So the cron job sends `Authorization: Bearer <service-role>` instead of an `apikey` publishable key. The bearer is the only secret, and it is read from Vault at call time.

**Project URL is public**, not a secret, so it is embedded directly in the job body (`https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/eval-sweep`). Only the bearer goes through Vault.

**Missing-secret behavior (NOT auth fail-closed — corrected):** if the Vault secret `eval_sweep_bearer` does not exist yet, the `COALESCE(..., '')` makes the header `Bearer ` (empty). This does **not** 401. `eval-sweep` is configured with `verify_jwt = false` (see `supabase/config.toml`) and its handler never inspects the inbound `Authorization` header, so an empty/absent bearer still returns **HTTP 200 and the sweep still runs**. The bearer is pulled from Vault for correctness / best-practice, not as an enforced gate.

This is safe regardless of the bearer, because the sweep:
- is **read-only w.r.t. customer data** — it writes only `conversation_evals`, and it does so with its **own env service-role key** (`SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY` inside the function), *not* the inbound bearer;
- is **idempotent** on the unique index `(conversation_id, transcript_hash)` — unchanged re-runs return `skipped_unchanged` at ~0 cost;
- is **spend-capped** by `JUDGE_DAILY_SPEND_CEILING_CENTS` (~200¢/day).

So a missing Vault secret degrades to **"a free, capped, dedup-gated sweep,"** not an open or elevated-access hole. (**Future option, NOT done here:** if a true auth fail-closed is ever wanted, add an app-level service-role check inside `eval-sweep` that rejects a missing/empty bearer.)

---

## How secrets are kept out

- The migration **never contains the service-role key**. The cron job body reads it from Vault: `(select decrypted_secret from vault.decrypted_secrets where name = 'eval_sweep_bearer')`.
- The lead injects the secret **once, out-of-band** (see lead steps). It is therefore never in the migration file, never in `cron.job.command` as a literal, and never in git.
- Secret-safety scan result (see `proof-judge-autotimer/SECRET-SAFETY-PROOF.txt`): **0** literal hits for the real service-role key value; **0** `service_role`/`sk_`/`sbp_`/JWT-shaped strings in the migration files; **0** real-token-shaped strings anywhere in the proof dir. The only Vault reference is the `decrypted_secrets` lookup.

---

## Over-fire / overspend analysis

**Is a 5-min cadence safe?** Yes, proven. `eval-sweep` already:
1. Only judges conversations that are terminal (`confirmed`/`expired` cart) OR idle ≥ `JUDGE_IDLE_MINUTES` (10).
2. Is **idempotent on `(conversation_id, transcript_hash)`** — a unique index. If the transcript hasn't changed, the row already exists → it returns `skipped_unchanged` and makes **zero** LLM calls.
3. Enforces a hard daily spend ceiling (`JUDGE_DAILY_SPEND_CEILING_CENTS`, default 200¢ ≈ $2/day) and stops once hit.
4. Caps work per sweep (`JUDGE_MAX_PER_SWEEP`, default 50).

**Proof (`DEDUP-COST-PROOF.txt`):** two back-to-back invocations of the deployed TEST function both returned `judged=0, skipped_unchanged=12, spend_cents=0`. A repeat tick on unchanged data costs nothing. The only spend happens when a NEW conversation becomes judgeable — exactly what we want.

**Overlap between ticks?** Possible in principle but practically negligible, and already safe:
- Worst case per sweep ≈ 50 conversations × ~1 LLM call each. On Haiku that is well under the 5-minute (300 s) gap; the proof runs returned in ~1–2 s on the current test data.
- Even if two ticks overlapped, the **unique index on `(conversation_id, transcript_hash)`** makes concurrent inserts race-safe: the loser's insert errors and the code already treats that as `skipped_unchanged` (see `index.ts` "Unique-index race" branch). No double-judging, no double-spend.
- **Decision: no extra advisory lock / "sweep in progress" row added.** It would be dead weight — the existing dedup + unique index already make overlap a no-op. Adding a lock would be complexity for a problem that can't manifest here. (Revisit only if `JUDGE_MAX_PER_SWEEP` is raised so high that a sweep can exceed ~5 min; then either lower the cadence or add a lock.)

---

## Proofs (in `proof-judge-autotimer/`)

| File | Proves |
|---|---|
| `MIGRATION-PROOF.txt` | UP → re-UP (idempotent, exactly 1 job) → DOWN (job gone) → re-DOWN (clean no-op), on a **real pg_cron** DB (`supabase/postgres:15.8.1.060`, which boots the pg_cron scheduler and bundles pg_net + supabase_vault — a faithful local mirror). Shows the `cron.job` row appears after UP and is gone after DOWN, and the job command references Vault (no literal). |
| `SECRET-SAFETY-PROOF.txt` | 0 literal service-role key hits; 0 token-shaped strings in migrations; cron command references `vault.decrypted_secrets`, not a literal. |
| `DEDUP-COST-PROOF.txt` | Two back-to-back deployed-function invocations both `judged=0, skipped_unchanged=12, spend_cents=0` → 5-min repeats are cheap. (Bearer came from `$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY` in-shell; **not committed**.) |
| `ORDERPATH-UNCHANGED-PROOF.txt` + `ORDERPATH-BASELINE.md5` | chat-sms / create-checkout / refund-order / stripe-webhook / toast-order / imsg-bridge byte-identical to `origin/main` (empty diff + matching md5). |

### How the migration proof was produced
1. `open -a OrbStack` to bring up the Docker daemon.
2. `docker run -d supabase/postgres:15.8.1.060` (logs show `pg_cron scheduler started`; `pg_available_extensions` lists pg_cron, pg_net, supabase_vault).
3. Enable `supabase_vault` and seed a **placeholder** secret named `eval_sweep_bearer` (mimics the lead's out-of-band step — the value is the literal string `PLACEHOLDER_NOT_A_REAL_KEY`, not a real key).
4. Pipe `017_judge_autotimer.sql` into `psql -v ON_ERROR_STOP=1`; inspect `cron.job`; re-apply; apply the `.down.sql`; re-apply the down.

> Note: this validated the migration against a **real, running pg_cron** locally — not merely a static read. The remote project (`rvdqfxtrskxekfkqnegx`) was NOT modified by this build (no extension enabled, no cron scheduled, no secret created remotely).

---

## LEAD: exact steps to apply remotely

Run against project **`rvdqfxtrskxekfkqnegx`** (SprintAI Chat). Do these in order.

**1. Inject the Vault secret (out-of-band, ONE time).** Replace the placeholder with the real service-role JWT for this project (it's `SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY` in `~/.openclaw/.secrets`). Run in the Supabase SQL editor or via `psql`:

```sql
select vault.create_secret(
  '<PASTE_SPRINTAI_CHAT_SERVICE_ROLE_JWT_HERE>',  -- the real key; NEVER commit it
  'eval_sweep_bearer',
  'Bearer token used by the judge-eval-sweep cron job to invoke eval-sweep'
);
```
(If a secret of that name already exists and you want to rotate it, instead:
`update vault.secrets set secret = '<NEW_JWT>' where name = 'eval_sweep_bearer';`)

**2. Apply migration 017** (enables extensions + schedules the job):
```bash
# via Supabase CLI db push, or paste 017_judge_autotimer.sql into the SQL editor
supabase db push   # or run the file's contents in the SQL editor
```

**3. Confirm the job is registered:**
```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'judge-eval-sweep';
-- expect one row: '*/5 * * * *', active = t
```

**4. Confirm it actually fires (after up to ~5 min):**
```sql
select runid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'judge-eval-sweep')
order by start_time desc limit 5;
-- status should be 'succeeded'; net.http_post returns a request_id (fire-and-forget)
```
To confirm the sweep itself ran, check for fresh `conversation_evals` rows or eval-sweep function logs in the Supabase dashboard.

**Order of operations:** inject the secret **before** (or right after) applying 017. NOTE: if 017 is applied first, the job does **not** 401 — because `eval-sweep` runs with `verify_jwt = false` and ignores the inbound bearer, an unauthenticated tick still returns 200 and runs the (read-only, dedup-gated, spend-capped) sweep. No harm and no open hole; the sweep simply runs for free on unchanged data until a new conversation becomes judgeable. Injecting the secret is best-practice, not a gate.

### To roll back
```sql
-- run 017_judge_autotimer.down.sql  (unschedules the job; leaves extensions + secret)
-- optional, to also revoke the secret:
delete from vault.secrets where name = 'eval_sweep_bearer';
```

---

## Status / guardrails honored

- **NOT merged, NOT pushed, NOT deployed.** Commit lives only on local `feat/judge-autotimer`.
- **No remote change by the builder:** no extension enabled, no cron scheduled, no Vault secret created on `rvdqfxtrskxekfkqnegx`. The lead applies migration 017 + injects the secret.
- **No order-path file touched** (byte-identical proof).
- **No secret committed** (scan = 0 hits).
- Extensions intentionally left enabled on DOWN (dropping shared extensions can cascade).

---

## Changelog

- **2026-06-22 — doc-accuracy correction (comments/notes only, no code/SQL behavior change).** Melvin's QA found that the original "fail-closed: empty bearer → 401, no judging, no spend" claim in `017_judge_autotimer.sql` and this file was **false**. `eval-sweep` has `verify_jwt = false` and never reads the inbound `Authorization` header, so a missing/empty Vault bearer still returns HTTP 200 and runs the sweep. Corrected the wording in three places (SQL header note, SQL inline `COALESCE` comment, and the BUILD-NOTES "missing-secret behavior" + LEAD "order of operations" sections) to describe the **actual** mechanism: the bearer is best-practice not an enforced gate, and safety comes from the sweep being read-only (own env service-role key), idempotent via the `(conversation_id, transcript_hash)` unique index, and spend-capped (`JUDGE_DAILY_SPEND_CEILING_CENTS`). **No executable SQL line changed; `eval-sweep/index.ts` untouched; order path byte-unchanged.**
