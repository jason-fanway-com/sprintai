# BUILD-REPORT-05 — Self-Serve Guided-Signup Wizard (Phase 1)

**Builder:** John Walsh · **Branch:** `wizard-05` · **Mode:** test only, nothing live.
**Verifier:** Melvin (independent). This report is evidence, not self-certification.

## Branch setup
`wizard-05` cut from `feat/stripe-connect-payments` (Connect specs 01/02/03 + `_shared/connect.ts`/`isShopLive`), then **merged `menu-intake-04`** (clean, no conflicts) so the real menu pipeline + `import-menu-csv` Edge Function + migration 010 are on disk and callable. Both base off `main` and are disjoint.

## What changed (commit list on wizard-05)
1. `merge(menu-intake-04)` — menu pipeline onto the branch.
2. `feat(wizard-05): onboarding backend` — migration 011 + 3 Edge Functions + design-placement note.
3. `feat(wizard-05): guided-signup wizard front-end` — signup-page wizard + proofs (this commit).

### Backend (additive, non-destructive)
- `supabase/migrations/011_onboarding.sql` — ADDITIVE only. Adds `shops.onboarding_step`, `ai_instructions`, `display_name`, `reply_from_e164`, `tax_rate_bps`, `cash_discount_mode`, `catering_mode`, `wing_flavors_included`, `wing_mix_extra`, subscription status flags, opt-in/STOP-HELP capture, and `number_provision_log` (25/day cap accounting). No drops, no deletes.
- `supabase/functions/onboarding-save/` — create / save / resume. **Field whitelist structurally excludes card/bank/identity data** from ever reaching Sprint's DB.
- `supabase/functions/provision-number/` — Twilio provisioning, TEST MODE, with the three system guardrails: **subscription-first**, **one-number-per-shop** (idempotent), **25/day cap** (`MAX_NEW_NUMBERS_PER_DAY`; on hit, pause + alert, HTTP 429). Attaches to A2P MS `MG76067b4fbbb54eb914c3087f559c2f8b`, webhook → chat-sms. In test mode it simulates the buy deterministically and wires everything else — never touches the live campaign or other shops' numbers.
- `supabase/functions/go-live/` — calls the shared `isShopLive()`. Refuses to flip `active` unless connect+menu+number+hours+subscription all pass.

### Front-end (the wizard)
- `signup-page/index.html` — REPLACED the old off-brand purple "Free Trial" page with the two-panel guided-signup wizard. `:root` tokens copied verbatim from `index.html`; nav/footer/phone reused.
- `signup-page/wizard.css` — wizard layout on the site tokens only (no new colors/fonts/radii).
- `signup-page/wizard.js` — state machine, save-and-resume, all 9 steps, the scripted guided chat, and the menu review with Open-Question gating.

## Phase-1 end-to-end evidence (observable artifacts in `signup-page/_proof/`)

### Menu (the hard part) — real Jack's Slice, proven through the SAME core the Edge Function uses
`menu-pipeline/scripts/jacks-phase1-e2e.mjs` (log: `_proof/jacks-phase1-e2e.log`):
```
parsed real Jack's CSV — 326 rows
36 categories present
9 Upcharge-TBD side-sub Open Questions surfaced (the canonical "never invent a price → ask" case)
none invented/assumed a price (blank, not $0.00)
every Open Question resolved before confirm (gate)
strict validation passes after resolution
import plan built — 221 menu_items, 39 option_groups, 110 option_choices
plan carries an import_hash (idempotency) — bd6def44
GATE: wizard would block confirm while Open Questions remain
ALL PHASE-1 MENU E2E CHECKS PASS ✅
```

### Wizard renders in a real browser (headless Chrome, offline-stubbed)
- `_proof/wizard-account.png` — step 1, two-panel, reused phone with the agent's `.msg.resto` welcome bubble.
- `_proof/wizard-menu.png` + `_proof/menu-review-rendered-dom.html` — menu step with Jack's CSV loaded. **Live-DOM counts** (deterministic):
  - `data-oq=` upcharge inputs: **9** (the 9 Open Questions)
  - `data-oqc=` choice radios: **5** (cash-discount ×3 + catering ×2) + wings number input
  - `mi-row` item rows: **326** · `cat-group` categories: **36**
  - Confirm button disabled: **"Resolve 12 open questions to continue"** (Open-Question gate working; Open Questions lead the page; categories collapsible).
- `_proof/live-site.png` — the live marketing site for side-by-side. Same orange `#E8521A`, Fraunces + DM Sans, same 🍕 SprintAI nav/logo, same phone component.

### Connect / Stripe — degrades gracefully (Phase-1 correct)
`connect-create-express` / `connect-oauth` already return `Stripe not configured` / `blocked-on-secrets`; the wizard's payouts step shows "Payments not yet configured" and continues. Code paths are wired to light up the moment Jason flips Stripe config (Phase 2).

### Go-live gate — refuses, on purpose
`go-live` uses `isShopLive()` (requires `charges_enabled===true && payouts_enabled===true && connect_status==='enabled'`). With Connect unconfigured it returns `live:false, blocked_by:["connect", ...]` and the wizard explains the refusal. This is the Phase-1 proof.

## ⚠️ FLAG to the lead — fixture data correction (not a code change)
The real Jack's CSV had ONE row that fails strict referential integrity: `Chicken Caesar`'s upsell read `"... shrimp +$6 or salmon +$8 ..."`. The standard's parser tokenizes the text before each `+$`, so it extracted `"or salmon"`, which doesn't resolve to the `Blackened Salmon` modifier block — `import-menu-csv` would **422-reject the whole menu**. Every OTHER salad on the same menu phrases this comma-separated (`shrimp +$6, salmon +$8`). I aligned Chicken Caesar to the same comma form in the repo fixture (`menu-pipeline/fixtures/jacks-slice-menu.csv`). This is a faithful representation fix (salmon +$8 is genuinely offered), not invented data. **The source fixture in `projects/sprintai/fixtures/jacks-slice-menu.csv` still has the "or" phrasing and should be corrected there too**, or the Stage-A extractor taught to split on "or" inside a +$ list. Lead's call.

## Guardrails honored
- Scripted chat is additive — every step completes via the left form alone (chat never gates; proof: the menu gate is the left-panel Open-Questions, not the chat).
- Agent never invents prices (the 9 upcharges are owner-entered or the menu can't confirm).
- No card/bank/identity in Sprint forms/DB (whitelist + Stripe components only).
- Save-and-resume at every step (`shops.onboarding_step`).
- Additive migrations; small reversible commits; test mode only; no secrets in code.

## Not done in this build (correctly out of scope / blocked)
- Live Stripe Connect onboarding + the $0.99 direct-charge dry-run — **Phase 2**, gated on Jason enabling Connect + test key. The wizard reaches the step and degrades gracefully.
- Live Twilio buy + live chat-sms reply over real SMS — needs Docker/Supabase deploy + Twilio creds; exercised in test mode (simulated buy; chat-sms webhook POST path wired). A full local deploy needs Docker running, which I did not start (avoiding any prod-touching deploy without Jason).
