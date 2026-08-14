# Prod Data Safety + NJB Menu Restore — Incident & Prevention Spec

**Date:** 2026-08-12
**Severity:** P0 — destructive prod-data loss on the primary demo shop, days before the NJB demo. Live customers imminent.
**Owner:** Lead (SprintAI_bot). Direct edits + careful DB ops. NO crew loops, no OpenRouter spend.

## Incident

On 2026-08-09 ~17:21 EDT, a menu-intake **test run** POSTed a PDF parse against Not Just Bagels' **real shop_id** `b0000000-0000-0000-0000-000000000001`. `parse-menu-pdf` hard-deletes a shop's existing menus + items before inserting the new parse. The parse produced 0 items, so NJB was left with a single empty menu named "test" — its real, months-tuned 20-item bagel menu and all children were deleted. Shop record, number, settings, orders, conversations were untouched.

## Root cause (stacked)

1. **Destructive-before-confirm.** `parse-menu-pdf` does an unconditional hard `DELETE` of `menus` + `menu_items` for the shop, then inserts — **not in a transaction, no guard**. A parse that yields 0 items leaves the shop menu-less and is irreversible.
2. **Test used a real shop_id.** A QA/harness run pointed the destructive path at production data (likely grabbed a known-valid ID to satisfy the FK constraint).
3. **Deepest cause: one shared database.** Test and prod share the single Supabase project (`rvdqfxtrskxekfkqnegx`). Every test runs against live data. No staging isolation.
4. **Process:** running QA/harness tooling against the live DB with real shop IDs at all.

## Recovery — exact from last known good

- Supabase daily physical backup **1325430455 @ 2026-08-09 04:26 UTC** predates the wipe (17:21 EDT = 21:21 UTC) by ~17h. It holds NJB's real menu. PITR is **off** (daily snapshots only; enable — see prevention #4).
- **Method (non-destructive to current prod):** restore that backup to an **isolated** target (new/temp project), extract NJB rows from `menus`, `menu_items`, `option_groups`, `option_choices` for shop `b0000000…0001`, re-insert into prod under the same shop_id. **Never** an in-place restore (would roll the whole DB back).
- Current empty NJB state snapshotted to `incident-njb-2026-08-12/` before any change.

## Prevention — best practices (implement before any further menu-intake work ships)

### P0-A — `parse-menu-pdf` must be non-destructive
- Wrap replace in a **transaction**: insert new menu + items, **verify item count > 0**, only then deactivate the prior menu. On any failure/empty parse → roll back, leave existing menu intact.
- **Reject overwriting a populated menu with a 0-item parse** (hard error, no write).
- **Soft-archive, never hard-delete:** set prior menu `active=false` / archived, keep rows. Menus become recoverable in-DB.

### P0-B — Protected shops
- Add `shops.protected boolean not null default false` (migration).
- `parse-menu-pdf` and any destructive menu op **refuse to mutate a protected shop** unless an explicit override token is passed (tests never receive it).
- Mark NJB + the permanent demo shops (bagel, pizza) `protected = true`.

### P0-C — Test isolation
- QA/harness tooling **must never accept a real shop_id**. It creates disposable shops in a reserved namespace and tears them down.
- Target state: a **separate Supabase project** for QA/test, distinct from prod. Until then, enforce throwaway-shop-only in the harness + the protected-shop guard as the backstop.

### P1 — Backups / PITR
- **Enable PITR** on the prod project (paid) for minute-level recovery. Verify daily physical backups continue.

### P0-D — Process rule (to memory)
- Never run test/QA against real or demo shops on the prod DB. Destructive DB ops require explicit approval + a backup check first.

## Rollout order
1. Exact NJB restore (get demo shop whole again).
2. P0-A + P0-B guard edits (non-destructive parse + protected shops) — the "never again" core.
3. P0-C harness isolation + P0-D memory rule.
4. P1 PITR (Jason decision, cost).

No further menu-intake changes ship to prod until P0-A/B are in place.
