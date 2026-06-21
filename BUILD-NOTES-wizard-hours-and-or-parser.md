# BUILD NOTES — wizard hours + menu "or" parser

Branch: `fix/wizard-hours-and-or-parser` (off `sec/merchant-rls-lockdown`).
Two fixes, two separate commits. **Not merged. No prod deploy. No live services. No secrets.**

Node: v22.22.0. TS run via `node --experimental-strip-types`.

---

## FIX 1 — Menu parser "or" phrasing (commit `19ad587`)

**Context.** The original "or" gap (Jack's `shrimp +$6 or salmon +$8` -> 422) was
already fixed upstream in commit `5b379f6` (on the branch I forked): it strips
leading/trailing `or`/`and` connectors in `extractUpsellAddons` and tightened
`resolves()` to whole-word matching, and **restored the real fixture** (line 104
of `menu-pipeline/fixtures/jacks-slice-menu.csv` reads the real
`shrimp +$6 or salmon +$8`, not doctored comma phrasing). I independently
re-verified that fix (see proof below) — it holds.

**What I added.** While verifying, I found a remaining edge `5b379f6` missed:
when an option in an "or" list has **no price**, the regex glues the unpriced
name onto the priced one.

```
"shrimp or salmon +$8"   was -> ["shrimp or salmon"]   (wrong)   now -> ["salmon"]
"shrimp +$6 or salmon"   ->     ["shrimp"]              (already correct; salmon unpriced -> dropped)
```

Fix in `menu-pipeline/core/validate.ts` (`stripJoinWords`): after peeling
leading/trailing connectors, if an **interior** ` or ` remains, keep only the
segment adjacent to the `+$amount` (the priced option). The unpriced option gets
**no invented price** (golden rule preserved). Split on `or` **only**, never
`and` — `and` legitimately appears inside option names (`mac and cheese`,
`surf and turf`); regression tests guard both.

**Files**
- `menu-pipeline/core/validate.ts` — interior-"or" split in `stripJoinWords`.
- `menu-pipeline/scripts/extract-upsell-addons.test.mjs` — added: interior-or
  (leading/trailing unpriced), chained-or, mixed comma+or, `and`-in-name
  preservation, and a **no-price golden-rule** check (`priceDelta=null` ->
  blank + `Upcharge TBD`, never `0.00`).

**Proof** (`signup-page/_proof/`)
- `extract-upsell-addons.test.log` — all unit cases (or / comma / mixed /
  chained / case-insensitive / no-price-flag) PASS.
- `jacks-phase1-e2e-or-fix.log` — full pipeline on the **real** restored fixture:
  PASS, no 422 (221 items / 39 option_groups / 110 option_choices).
- `stage-a-determinism-or-fix.log` — `parse -> serialize` byte-identical across
  two runs (sha256 `6673cc985ca57f7c1e4087f707e28bbfda5f079ba6282fac7ae2946a52e071f4`).

**Run it**
```
node --experimental-strip-types menu-pipeline/scripts/extract-upsell-addons.test.mjs
node --experimental-strip-types menu-pipeline/scripts/jacks-phase1-e2e.mjs
node --experimental-strip-types menu-pipeline/scripts/test-validate.mjs
node --experimental-strip-types menu-pipeline/scripts/test-import-diff.mjs
```

---

## FIX 2 — Hours capture in the signup wizard (commit see below)

**Context.** Storage already existed: `shops.open_hours JSONB` + `shops.timezone`
(migration 003), and `open_hours` is already whitelisted in the **server-side,
service-role** save path `supabase/functions/onboarding-save/index.ts`
(uses `SUPABASE_SERVICE_ROLE_KEY`, not anon — RLS lockdown respected). The diner
bot `chat-sms` already read `open_hours` and had an "are we open?" check.

**The real gaps fixed:**

1. **Wizard collected fake hours.** The fulfillment step took a comma list of
   open *days* and hard-coded every day to `11:00–21:00`. Owners couldn't set
   real open/close times or mark days closed. Replaced with a **per-day grid**:
   each day has a `Closed` toggle + open/close `time` inputs, plus
   **"Copy Monday's hours to all days"**. Writes the canonical shape
   `{ mon:[{open,close}], ... }` (closed day = omitted). Single window/day for
   simplicity; the schema + bot already support multi-window (lunch+dinner) —
   collecting a second window in the UI is a documented follow-up.
   - `signup-page/wizard.js` — `RENDERERS.fulfillment` rewritten;
     `hoursToEditorModel` / `editorModelToHours` helpers.
   - `signup-page/wizard.css` — `.hours-grid` / `.hours-row` styles (responsive).

2. **Diner-bot timezone bug (launch-critical correctness).** The bot picked the
   day-of-week with `new Date().getDay()` (server/**UTC** day) while comparing
   times in the shop's timezone. Near midnight this reads the **wrong day's**
   hours (e.g. 11:30pm Sun ET is Mon in UTC). Added `getBusinessDayKey(tz)` and
   `getLocalMinutes(tz)` (both via `Intl.DateTimeFormat` in the shop tz) and used
   them in all three hours spots in `supabase/functions/chat-sms/index.ts`
   (system-prompt hours line, order-confirm hours line, and the "are we open?"
   gate). The open-check also now cleanly supports multi-window days.

3. **Migration `013_shop_hours.sql`** — ADDITIVE, idempotent, reversible notes.
   `open_hours`/`timezone` already exist (003), so this is defensive
   (`ADD COLUMN IF NOT EXISTS`) + backfills NULL `open_hours` to `'{}'` +
   `COMMENT ON COLUMN` pinning the canonical shape and the
   "local-timezone, never UTC" contract. No CHECK constraint (validation lives
   in the server write path; a strict JSONB CHECK would risk future shapes).

**Save path confirmation** — server-side, not anon:
`onboarding-save/index.ts:62` uses `SUPABASE_SERVICE_ROLE_KEY`;
`open_hours` is in `ALLOWED_FIELDS` (line 40). No new anon write path added.

**Tests / proof** (`signup-page/_proof/`)
- `hours-roundtrip.test.log` — Part A: editor-model <-> canonical round-trip,
  closed-day handling (closed -> omitted -> reads back closed), fresh-shop
  default. Part B: bot "are we open?" at known times incl. the **near-midnight
  UTC-day bug proof** (11:30pm Sun ET resolves to `sun`, not `mon`) and
  multi-window (lunch/dinner gap). All PASS.
- `hours-ui-preview.html` — standalone preview of the hours grid markup.
  Browser navigation is blocked by policy in this env, so view it manually:
  ```
  cd signup-page && python3 -m http.server 8755
  # open http://localhost:8755/_proof/hours-ui-preview.html
  ```

**Run it**
```
node signup-page/_proof/hours-roundtrip.test.mjs
node --check signup-page/wizard.js
node --experimental-strip-types --check supabase/functions/chat-sms/index.ts
```

---

## Constraints honored
- No production deploy, no live services (Stripe/Twilio/live DB), no secrets committed.
- Branch not merged. Two separate commits (FIX 1, FIX 2) for independent review.
- RLS lockdown NOT weakened — hours save goes through the existing service-role
  `onboarding-save`.
- Menu: never invents a price; deterministic output preserved (byte-identical sha256).

## Known follow-ups (flagged, not silently deferred)
- Wizard collects ONE window/day. Multi-window (lunch+dinner) is supported by the
  schema and the bot's open-check; adding a "+ add window" control to the wizard
  is a small follow-up.
- The bot's day/time logic was unit-proven in isolation (`hours-roundtrip.test`).
  A live end-to-end SMS test needs a running Supabase + Twilio test env (out of
  scope: no live services).
