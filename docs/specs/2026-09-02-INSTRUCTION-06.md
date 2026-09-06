# INSTRUCTION 06 — Harness CLOSED. All hands to launch blockers.

**Date:** 2026-09-02 · **From:** Claude (outside product owner) → OrderFare
**Authority:** Jason, 2026-09-02, explicit: stop testing, move to launch work.

## The harness is finished. Stop.

Across roughly a thousand test conversations since Aug 30, the product has produced
**one** genuine defect — the phantom "added it for ya" claim, now fixed and guarded.
Every other failure, every single time, has been the test being wrong.

The scores moved a lot: 128/128 → 85% → 82% → 50% → 60% → 100% → 96% → 92% → 98% → 76%.
**The product never moved.** What moved was measurement accuracy. We have been watching a
thermometer get calibrated and reading it as the patient's temperature changing.

The suite has answered its question: **the money paths hold.** Totals match carts,
checkouts write orders, the bot does not invent menu items. That answer has been stable
for two days. Another run will not change it.

### Therefore, effective immediately

- **NO more full 128 runs.** Not for validation, not for a baseline, not "one more clean one."
- **NO more invariant work.** The ~4 remaining false-positive classes are documented and
  ACCEPTED. Do not fix them.
- Land the P3 Bug1/Bug2 fix on **unit tests only** (12/12 already green, twins identical,
  committed `d47d012`). Optionally one `case_filter` run of ≤10 affected cases if you want
  confidence — 3 minutes, not 70. Then stop.
- Kill any queued or running rows. Preserve as dead; do not delete evidence.

If someone later wants a Proof report as a sales artifact for a shop owner, it is a
10-minute job once concurrency ships. It is not needed now.

---

## All hands to the launch blockers

Four days untouched. These are what break in front of a real customer at a real
restaurant, and **none of them is a QA problem** — no amount of Proof runs touches them.

### 1. `docs/specs/2026-09-01-go-live-gates.md` — START HERE

Today a shop flips live at any score, with no order email configured, on a number never
assigned to the 10DLC campaign. `go-live/index.ts:159` enforces `connect, delivery_geo,
menu, menu_approved, menu_clean, number, hours, subscription, ein` — and nothing else.

Add three gates: `proof` (current passing run, menu + commit current, twin parity),
`delivery_test` (first-delivery handset test recorded), `ticket_destination`
(`email_ticket_recipient` non-null).

Note the correction already in that spec: self-serve onboarding DOES collect the order
email (`wizard.js:114`, `:759`). The gate is still needed because shops created by any
other path — admin UI, demo scripts, QA twins — bypass it. **Vito's has no ticket
destination today.**

### 2. `docs/specs/2026-09-01-order-ticket-reliability.md`

A paid order can silently never reach the kitchen, two ways: the idempotency slot is
claimed *before* the send so a failure is never retried, and `email_ticket_recipient` may
be null with no error. `ticket_send_log` records every attempt and **nothing reads it.**

### 3. `docs/specs/2026-09-01-campaign-assignment-gate.md`

`provision-number` sets `pending_campaign_assignment: true`; nothing reads it and
`provision-campaign` does not exist. Numbers can go live unassigned, so carriers filter
the texts. `chat-sms` classifies Telnyx 10036 as *transient*, so it fails silently.

---

## Rules — unchanged, all still binding

1. Never weaken a check to make something pass.
2. Commit → deploy → verify. Never against uncommitted or undeployed code.
3. **Verify before claiming.** Run the query that would prove your claim false. Seven
   false completions so far; this is the one habit that matters most.
4. Change one thing at a time.
5. Escalate rather than work around.
6. Do not touch the Telnyx campaign, safety gates, or shop data.

## Reporting

Report on `agent:main:po:claude` at each meaningful step, and keep
`docs/specs/2026-09-02-STATUS.md` current. For go-live work I want the **gate list diff**
and evidence each new gate actually blocks — a gate that does not block is worse than no
gate, which is the lesson of Guard 1d and we should not learn it twice.
