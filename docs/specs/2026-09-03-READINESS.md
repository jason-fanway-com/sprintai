# Readiness Board — INSTRUCTION-10

Governing spec: `2026-09-03-INSTRUCTION-10.md` (supersedes 07/08/09 sequencing).
Standard: each item built and **validated on its own** — no end-to-end walk. Jason runs
the integration test himself. Update this board whenever a status changes.

Status vocabulary: `not started` · `building` · `in verification` · `built`.

| Item | What | Status | Validated how | Blockers |
|---|---|---|---|---|
| A | Subscription code path — build step in **setup.html** (wizard.js dead) | built | 0e9cadf (build) + 486cd15 (security: removed subscription_status/pm_set/sub_id from onboarding-save back door) + 69f9018 (fix: removed broken server-side promo_code branch — allow_promotion_codes/discounts conflict + promo-code-as-coupon-id) + a51d6df (pin verify_jwt=false). Deployed **v4 ACTIVE**. All 7 deterministic checks pass: no client status write; single $99/mo price (verified live); mode:subscription + client_reference_id; webhook sole writer; payment_method_collection:'always'; go-live 13 gates intact; no pro/enterprise creation. Promo FOUNDING → coupon FOUNDING-BETA-6MO-SUB, 100%/6mo, max 15, expires 2027-01-01 (verified live). Stale coupon FOUNDING-BETA-6MO deleted. | **Remaining = live test-card walk (Jason's integration test): shop reaches active only after checkout, sub+customer ids persisted, promo redemption yields $0 first invoice WITH card attached.** Code/config support it; not provable without the walk. |
| B | Onboarding/go-live split + `onboarding_complete` completion screen | not started | 9 owner gates pass → completion screen while 4 QA gates unmet; go-live still 13, fail-closed | — |
| C | Resume email failure visible + resendable | built | migration 084 (welcome_email_status/error/last_attempt_at on shops). onboarding-save v48: sendWelcomeEmail() helper persists true outcome, returns email_sent/email_status/email_error on `create`, new `resend_welcome` action. signup/index.html shows warning + Resend button when email_sent=false. Deployed + columns live. | Validated by: deno check clean; columns confirmed in DB; manual test with RESEND_API_KEY unset needed to observe failure path (Jason's integration test). |
| D | Owner mobile at signup (5th field) | not started | signup persists owner mobile distinct from `phone_number_e164` | — |
| E | Ticket-destination question + persistence (no API build) | not started | answer incl. free text persisted; `email_ticket_recipient` owner-editable via admin chat | — |
| F | Menu curation by confidence | not started | real crawl splits confident vs needs-input; owner surface renders each differently | — |
| G | Expo Screen (promoted, always-active delivery path) | not started | paid test order queues, advances on human action, holds state across network drop | — |
| H | Ticket delivery truth (Resend webhooks vs `resend_message_id`) | not started | bad recipient → visible bounce on that order | — |
| I | Escalation rule — 7-min unacked → SMS owner (reuse issue-detector) | not started | synthetic unacked order triggers exactly one escalation | — |
| J | PROVE carrier approval chain deployed+scheduled | not started | function deployed+scheduled; `submitted` shop advances to `approved` on its own | — |
| K | PROVE website read reliability | not started | run 20 real restaurant sites; report success rate + failure copy | — |
| L | PROVE demo kit (3 codes) | not started | walk all three on a phone in order; report breakage | — |
| M | Delete/mark `signup-page/wizard.js` dead | not started | confirm nothing serves it, then remove/mark | — |
| N | Resolve uncommitted `chat-sms` change | in verification | committed alone 292a838 (reduce-qty → modify_item); **deploy NOT yet confirmed** | must verify chat-sms edge deploy |

## Log
- 2026-09-03 22:33 EDT — board created. Rehearsal stood down (leg 1 cancelled, leg 2 not
  started, `p2-rehearsal-diner` left in place). Starting item A.
- 2026-09-04 05:28 EDT — Item A → **built**. Two promo-path bugs fixed (69f9018),
  verify_jwt pinned (a51d6df), redeployed v4, stale coupon confirmed gone. All 7
  deterministic checks pass. Only live test-card walk remains (Jason's integration test).
  Starting item C.
- 2026-09-04 05:38 EDT — Item C → **built**. Commit 9885751. Migration 084 applied
  (3 columns live). onboarding-save v48 deployed. Signup surfaces email failure + resend.
