# Readiness Board — INSTRUCTION-10

Governing spec: `2026-09-03-INSTRUCTION-10.md` (supersedes 07/08/09 sequencing).
Standard: each item built and **validated on its own** — no end-to-end walk. Jason runs
the integration test himself. Update this board whenever a status changes.

Status vocabulary: `not started` · `building` · `in verification` · `built`.

| Item | What | Status | Validated how | Blockers |
|---|---|---|---|---|
| A | Subscription code path — build step in **setup.html** (wizard.js dead) | built | 0e9cadf (build) + 486cd15 (security: removed subscription_status/pm_set/sub_id from onboarding-save back door) + 69f9018 (fix: removed broken server-side promo_code branch — allow_promotion_codes/discounts conflict + promo-code-as-coupon-id) + a51d6df (pin verify_jwt=false). Deployed **v4 ACTIVE**. All 7 deterministic checks pass: no client status write; single $99/mo price (verified live); mode:subscription + client_reference_id; webhook sole writer; payment_method_collection:'always'; go-live 13 gates intact; no pro/enterprise creation. Promo FOUNDING → coupon FOUNDING-BETA-6MO-SUB, 100%/6mo, max 15, expires 2027-01-01 (verified live). Stale coupon FOUNDING-BETA-6MO deleted. | **Remaining = live test-card walk (Jason's integration test): shop reaches active only after checkout, sub+customer ids persisted, promo redemption yields $0 first invoice WITH card attached.** Code/config support it; not provable without the walk. |
| B | Onboarding/go-live split + `onboarding_complete` completion screen | built | 539c6d6 (migration 085 founding_promo — applied), e429031 (item B — go-live phase split, migration 086 applied, setup.html completion screen). go-live unit suite 21/21 pass; gate count exactly 13 (9+4); deno check clean; deployed evaluate mode verified live: phase_a/phase_b/onboarding_complete returned correctly. save handler re-checks completion immediately. Migration 078 (first_delivery_test columns) also applied (was missing from prod, would have broken go-live for every shop). | No blockers. Jason's integration test: owner with all 9 Phase A gates passes → terminal screen appears, not blocked gates. |
| C | Resume email failure visible + resendable | built | migration 084 (welcome_email_status/error/last_attempt_at on shops). onboarding-save v48: sendWelcomeEmail() helper persists true outcome, returns email_sent/email_status/email_error on `create`, new `resend_welcome` action. signup/index.html shows warning + Resend button when email_sent=false. Deployed + columns live. | Validated by: deno check clean; columns confirmed in DB; manual test with RESEND_API_KEY unset needed to observe failure path (Jason's integration test). |
| D | Owner mobile at signup (5th field) | built | f7c9d15 — migration 087 owner_mobile (applied); collected at signup, persisted distinct from `phone_number_e164`. | No blockers. |
| E | Ticket-destination question + persistence (no API build) | built | migration 088 (ticket_destination_type default 'expo' + _detail; applied+verified prod). onboarding-save allowlist + setup.html question (Expo default / dedicated mailbox / own system / free text); mailbox mirrors to email_ticket_recipient. admin-chat SET_TICKET_DESTINATION intent (confirm-card + undo) edits email_ticket_recipient. deno check clean; both functions deployed. **AC8 proven live**: free-text answer persisted through deployed onboarding-save on a real test shop; existing rows default to 'expo'. | AC7 (owner edit via admin chat) needs an authenticated owner session to walk end-to-end — code built+deployed. API integration for own_system intentionally not built. |
| F | Menu curation by confidence | built | 2819738 — extract-menu-items prompt elicits confidence (0-100) + flag_reason per item; items with confidence < 75 inserted with flag_review=true + specific owner question in flag_reason. MenuTab splits into amber "We have questions" (flagged) and normal "Your menu" (confident); "Looks right" button clears flag via clearFlag mutation. deno check clean; tsc clean; edge fn deployed; admin-dashboard deployed to sprintai-chat-admin. Validation: next real-shop crawl will produce the split; owner surface renders both sets differently. | No migration needed (flag_review + flag_reason already existed). Jason's integration test: trigger a crawl → verify items split; click "Looks right" → item moves to confident set. |
| G | Expo Screen (promoted, always-active delivery path) | not started | paid test order queues, advances on human action, holds state across network drop | — |
| H | Ticket delivery truth (Resend webhooks vs `resend_message_id`) | not started | bad recipient → visible bounce on that order | — |
| I | Escalation rule — 7-min unacked → SMS owner (reuse issue-detector) | not started | synthetic unacked order triggers exactly one escalation | — |
| J | PROVE carrier approval chain deployed+scheduled | not started | function deployed+scheduled; `submitted` shop advances to `approved` on its own | — |
| K | PROVE website read reliability | not started | run 20 real restaurant sites; report success rate + failure copy | — |
| L | PROVE demo kit (3 codes) | not started | walk all three on a phone in order; report breakage | — |
| M | Delete/mark `signup-page/wizard.js` dead | not started | confirm nothing serves it, then remove/mark | — |
| N | Resolve uncommitted `chat-sms` change | built | 292a838 committed + deployed chat-sms v203 (2026-09-04 00:25). Deployed body: modify_item=10 refs, reduce_qty=0. Correct. |

## Log
- 2026-09-03 22:33 EDT — board created. Rehearsal stood down (leg 1 cancelled, leg 2 not
  started, `p2-rehearsal-diner` left in place). Starting item A.
- 2026-09-04 05:28 EDT — Item A → **built**. Two promo-path bugs fixed (69f9018),
  verify_jwt pinned (a51d6df), redeployed v4, stale coupon confirmed gone. All 7
  deterministic checks pass. Only live test-card walk remains (Jason's integration test).
  Starting item C.
- 2026-09-04 05:38 EDT — Item C → **built**. Commit 9885751. Migration 084 applied
  (3 columns live). onboarding-save v48 deployed. Signup surfaces email failure + resend.
- 2026-09-04 08:14 EDT — Regression: 86ec9dd deployed stripe-webhook with founding_promo
  write. Migration 085 never applied (column missing). Write guarded by unset
  STRIPE_FOUNDING_COUPON_ID so no checkout was breaking, but trap was live. Applied 085.
- 2026-09-04 ~08:30 EDT — Item B → **built**. Commits 539c6d6 + e429031. Phase A/B split
  live in go-live edge fn. Migration 086 applied. Completion screen wired in setup.html.
  Migration 078 (first_delivery_test columns) also applied — was missing, would have broken
  go-live lookups for every shop. 21/21 unit tests pass.
- 2026-09-04 10:35 EDT — CI fix committed + pushed (abe26e6). netlify-plugin-cache added to
  package.json — every git-triggered build was failing (exit 2) since 3f9031b.
- 2026-09-04 10:45 EDT — Item F → **built**. Commit 2819738. extract-menu-items confidence
  scoring live; MenuTab split display deployed to sprintai-chat-admin.
