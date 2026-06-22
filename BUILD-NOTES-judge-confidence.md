# BUILD-NOTES — feat/judge-confidence

Tightly-scoped enhancement to the already-deployed Conversation Judge
(`eval-sweep`). Adds an eval **confidence** concept, prioritizes shop-resolvable
("real") conversations within the existing per-sweep cap, and renders
low-confidence evals as advisory in the admin panel. **Severity logic is
untouched** — confidence is orthogonal and never suppresses, deletes, or
downgrades a flag.

Branch: `feat/judge-confidence` (off `origin/main` @ `4aee08a`).
Not merged · not pushed · not deployed.

---

## What changed (files + line ranges)

### 1. `supabase/migrations/015_eval_confidence.sql` (NEW)
Additive, idempotent, reversible migration:
- `ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'high'` on
  `conversation_evals`.
- Guarded CHECK `confidence IN ('high','low')` (added via `pg_constraint`
  catalog guard since constraints have no `IF NOT EXISTS`).
- New sort index `idx_conversation_evals_tenant_conf_sev_judged` on
  `(tenant_id, confidence, max_severity, judged_at DESC)` — supports
  high-confidence-first ordering cheaply (text asc puts `high` before `low`).
- Comment documenting the column. No existing column/data touched; default
  `'high'` backfills existing rows non-destructively.

### 2. `supabase/migrations/015_eval_confidence.down.sql` (NEW)
Drops only what 015 created (index, CHECK constraint, column), all `IF EXISTS`,
safe to re-run. Base table untouched.

### 3. `supabase/functions/eval-sweep/index.ts` (MODIFIED)
- **~L148–214 `loadGroundTruth`**: now returns a `GroundTruthResult`
  `{ ground, shopId, menuLoaded, confidence }`. `menuLoaded` is true only when an
  in-tenant shop's latest menu has ≥1 active item. `confidence = (shopId &&
  menuLoaded) ? 'high' : 'low'`. (Signature changed from returning bare
  `JudgeGroundTruth` → `GroundTruthResult`; all call sites updated.)
- **~L351–384 `selectCandidates`**: after assembling the candidate set, queries
  `order_carts` (chunked `IN`, 200/chunk) to find cart-bearing conversations,
  then **stable-partitions** cart-bearing first, cart-less second, preserving
  each group's existing relative order, THEN applies the unchanged cap
  (`MAX_CONVERSATIONS_PER_SWEEP`). Added a secondary `.order('id')` on the idle
  query for deterministic tie-breaking. Cart-less convs are NOT skipped — they
  fill remaining cap after cart-bearing.
- **~L439–486 `runSweep`**: consumes the new `loadGroundTruth` return; persists
  `confidence` on EVERY insert (clean/flagged/errored) and now sets
  `shop_id: gt.shopId` (previously hard-coded null) on the eval row + the
  digest row. Errored evals inherit the ground-truth confidence (low when no
  menu resolved).
- Exported `loadGroundTruth`, `selectCandidates`, `runSweep` (additive; the
  `Deno.serve` entrypoint is unaffected) so the proof harness can drive the REAL
  functions.
- **Unchanged:** severity map (`CHECK_SEVERITY`), `coerceFlags`, transcript-hash
  dedup/idempotency, daily spend ceiling, safe-degrade, auto-fix seam.

### 4. `admin-dashboard/src/pages/ConversationQuality.tsx` (MODIFIED)
- Added `Confidence` type + `confidence` to `EvalRow` + the select list.
- Query orders `confidence` asc (high first) then `judged_at` desc DB-side;
  legacy rows without the column default to `'high'` in the mapper.
- Flagged list sort: **high-confidence first**, then severity worst-first, then
  newest — confidence never reorders a real CRITICAL away, it floats
  high-confidence CRITICALs above low-confidence ones.
- Muted badge `low confidence — no menu ground truth` on low-confidence rows
  (gray, with tooltip); tenant cell dimmed for low-confidence.
- New header checkbox **Show low-confidence (N)** toggling visibility
  (default ON). Existing tenant filter + drilldown/transcript link preserved.

### 5. Proof harnesses (NEW, under `supabase/functions/eval-sweep/_proof/`)
- `run-migration-confidence-proof.mjs` — pglite migration proof.
- `run-confidence-proof.ts` — deno worker-logic proof (fake Supabase + stubbed
  Anthropic; drives the real exported functions).

---

## Proofs (observable artifacts in `supabase/functions/eval-sweep/_proof/`)

| Artifact | What it proves | Result |
|---|---|---|
| `MIGRATION-CONFIDENCE-PROOF.txt` | 015 UP / re-UP (no-op) / DOWN / re-DOWN (no-op) on throwaway **pglite**; default `'high'`, CHECK rejects bad values, index+constraint added/dropped, base table survives DOWN | **ALL PASS** |
| `CONFIDENCE-PROOF.txt` | (A) cart-bearing+menu → `confidence='high'`, cart-less → `'low'`; (A2) stored low via `runSweep`; (B) selection partitions cart-bearing before cart-less within the unchanged cap (60 candidates → 50 cap, all 20 cart-bearing kept, cart-less fills remainder, deterministic); (C) real `invented_item` on real menu → **CRITICAL + high confidence, not hidden/downgraded** | **20/20 PASS** |
| `CHATSMS-UNCHANGED-CONFIDENCE-PROOF.txt` | `git diff origin/main -- chat-sms/` empty (0 bytes); md5 of `chat-sms/index.ts` identical to origin/main | **IDENTICAL** |
| `ADMIN-BUILD-CONFIDENCE-PROOF.txt` | `tsc && vite build` output, `exit=0` | **PASS** |

### How to re-run
```sh
# migration (node + @electric-sql/pglite). Resolves pglite from PGLITE_PATH or
# the /tmp/node_modules install used in this env; MIGRATIONS_DIR overridable:
node supabase/functions/eval-sweep/_proof/run-migration-confidence-proof.mjs

# worker logic (deno; ANTHROPIC_API_KEY value irrelevant — fetch is stubbed):
export PATH="$HOME/.deno/bin:$PATH"
cd supabase/functions/eval-sweep/_proof
ANTHROPIC_API_KEY=x deno run --allow-env --allow-net run-confidence-proof.ts

# admin build:
cd admin-dashboard && npm run build
```

---

## Decisions made
- **`menuLoaded` definition:** HIGH requires shopId AND ≥1 active menu item. A
  resolvable shop with an empty menu is LOW — without menu items the
  `invented_item`/price checks have no real ground truth, which is exactly the
  low-trust case we're labeling.
- **`shop_id` on eval rows:** the worker previously inserted `shop_id: null`
  unconditionally (a latent gap). Since we now compute the resolved in-tenant
  `shopId` for confidence anyway, I persist it on the eval + digest row. Still
  null when no shop resolves; tenant-isolation guard in `loadGroundTruth`
  unchanged. This is additive and consistent with the new index.
- **Exports for testability:** exported three worker functions rather than
  duplicating logic in the proof. The `Deno.serve` entrypoint still runs on
  import (the proof calls `Deno.exit` to terminate, since the listener keeps the
  event loop alive).
- **Selection determinism:** used a stable partition (two filters) instead of a
  comparator sort, so equal keys never reshuffle; added `.order('id')` as a
  deterministic tie-break on the idle query.
- **Cap untouched:** `MAX_CONVERSATIONS_PER_SWEEP` is unchanged; only ordering
  within the cap changed.

## Safety confirmations
- chat-sms: **byte-identical** to origin/main (0-byte diff, md5 match).
- No imsg bridge / order-path / checkout / stripe / webhook files touched
  (`git diff --name-only origin/main` → only `eval-sweep/index.ts` and
  `ConversationQuality.tsx` among tracked source).
- eval-sweep remains read-only & out-of-band: writes ONLY to
  `conversation_evals`. No new writes to any live table.
- No secrets in diff (scanned). Build artifacts (`dist/`, `deno.lock`) NOT
  committed.
- Migration applied ONLY to ephemeral local pglite — never remote/prod (lead +
  Melvin handle remote apply).
- Not merged · not pushed · not deployed.
