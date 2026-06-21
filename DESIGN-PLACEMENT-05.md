# Design-Placement Note — Spec 05 Onboarding Wizard (John Walsh, pre-build)

Posted BEFORE building UI, per spec ("Builder proposes exact placement in a short design note before coding UI").

## Branch
- Working branch: `wizard-05`, cut from `feat/stripe-connect-payments` (has Connect specs 01/02/03 + `_shared/connect.ts`, `isShopLive`).
- Merged `menu-intake-04` into it (clean, no conflicts) so the **real** menu pipeline (`menu-pipeline/core/*`, `import-menu-csv` Edge Function, migration 010) is on disk and callable. Verified: `menu-pipeline/core/{parse,csv,validate,import-plan,serialize,types,ordering}.ts` + `supabase/functions/import-menu-csv/index.ts` present after merge.
- Rationale: the wizard orchestrates BOTH Connect and menu; both must exist on one branch. Both base off `main` and are disjoint → merged without conflict.

## Exact file placement
Per spec recommendation, the **public self-serve `signup-page/`** is the merchant wizard; `admin-dashboard/` stays Sprint-ops only.

- `signup-page/index.html` — REPLACED. The current file is the old generic-SaaS "Free Trial" page (purple `#4f46e5`, system fonts) — off-brand. New file is the two-panel guided-signup wizard built from `DESIGN-TOKENS.md`.
- `signup-page/wizard.js` — NEW. Wizard state machine, save-and-resume, step controllers, backend calls, scripted guided-chat engine.
- `signup-page/wizard.css` — NEW. Wizard-only layout on top of the site tokens (no new colors/fonts/radii).
- Backend additions:
  - `supabase/migrations/011_onboarding.sql` — ADDITIVE only. Adds `shops.onboarding_step`, `ai_instructions`, `display_name`, `reply_from_e164`, `tax_rate_bps`, `cash_discount_mode`, `catering_mode`, `wing_flavors_included`, plus `subscription_status`/`subscription_payment_method_set`, and a `daily_number_provision` audit table for the 25/day cap. No drops, no destructive mutation.
  - `supabase/functions/onboarding-save/index.ts` — NEW. Save-and-resume persistence per step (writes `shops.onboarding_step` + step fields).
  - `supabase/functions/provision-number/index.ts` — NEW. Twilio search/buy + attach to A2P Messaging Service `MG76067b4fbbb54eb914c3087f559c2f8b`, set webhook → chat-sms, with the three system guardrails (subscription-first, one-number-per-shop, 25/day cap). TEST MODE.
  - `supabase/functions/go-live/index.ts` — NEW. Calls `isShopLive()`; REFUSES to flip `active` while Connect unconfigured (Phase-1 correct behavior).

## Reuse (verbatim, no new components)
- **Phone**: `.phone-outer/.phone-frame/.phone-screen/.phone-header/.msgs-*/.msg.{you,resto,them}/.typing-bub/.phone-input-bar` copied from `index.html` (lines ~111-185 CSS, ~478-512 markup). The guided agent speaks in `.msg.resto`; owner replies in `.msg.you`.
- **Tokens**: `:root` custom properties copied verbatim from `index.html` (`--brand:#E8521A`, Fraunces/DM Sans, `--r/--r-sm/--r-lg`, shadows).
- **Nav + footer**: reused from `index.html` markup verbatim.

## Two-panel layout
- LEFT: step form/content (the source-of-truth path — every step completable here alone).
- RIGHT: the homepage phone running the SCRIPTED guided-onboarding chat (Option A, deterministic). Chat is ADDITIVE — never gates a step. It surfaces the real Jack's Open Questions (side-sub upcharges ×9, cash-discount, catering, wing flavors) as `.msg.resto` bubbles; owner answers in `.msg.you`; answers write back to wizard state → DB and into the menu CSV before Stage B.

## Phase-1 gating (correct, proven, not worked around)
- Stripe steps render but DEGRADE GRACEFULLY ("payments not yet configured") because Connect endpoints already return `Stripe not configured` / `blocked-on-secrets` until Jason flips config. Code paths wired so they light up on config flip (Phase 2).
- Go-live gate uses `isShopLive()` (requires `charges_enabled===true`) → will REFUSE to go live in Phase 1. This is demonstrated, not bypassed.

## Open-Question gate (menu)
- The strict validator allows blank prices (flags, doesn't hard-error). Therefore the WIZARD review step is the real gate: confirm is BLOCKED until all 9 `Upcharge TBD` rows + cash-discount/catering/wing questions are resolved. Resolved upcharge prices are written into the CSV `price` column before POSTing the confirmed CSV to `import-menu-csv`. Never invent a price — always ask.
