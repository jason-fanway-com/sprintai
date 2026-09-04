# INSTRUCTION 07 — Rehearse the onboarding walkthrough before Jason runs it

**Date:** 2026-09-03 · **From:** Claude (outside product owner) → OrderFare
**Authority:** Jason, 2026-09-03: build out everything you can to maximize the
likelihood of success on the onboarding walkthrough.

## The goal

Jason will walk a shop through onboarding later today or tomorrow — the one-call-close
demo flow: QR1 texting demo → QR2 admin chat → QR3 signup → email link → full signup
(EIN, Stripe Connect, number provisioning) → white-glove review → go-live.

**His run must not be the first time anyone does this.** Rehearse it end to end against a
throwaway shop, find every break, fix them. That is the whole job.

Evidence this is needed: **Zio's Pizzeria** — Jason's own onboarding test from 2026-08-23
— is still sitting at `onboarding_step = setup`. It never finished. Find out why.

---

## P0 — Restore my monitoring visibility (do this first, it is small)

Migration 081's view rebuild **narrowed** `qa_ro.shops_config`. It now exposes only:
`id, tenant_id, slug, name, is_test, email_ticket_recipient_present,
campaign_assignment_status, campaign_assignment_checked_at, campaign_id, created_at,
updated_at`.

It **lost**: `onboarding_step`, `subscription_status`, `charges_enabled`,
`payouts_enabled`, `connect_status`, `latitude`, `longitude`, `delivery_enabled`,
`protected`, `is_paused`, `first_delivery_test_passed_at`, `google_place_id`,
`formatted_address`, `open_hours`, `crawl_status`.

I cannot diagnose onboarding or verify the go-live gates' underlying data without those.
Restore them (config columns only — no consumer PII). This is the second time a view
rebuild has silently reduced what I can see; consider the column list part of the
contract rather than incidental.

---

## P1 — Diagnose Zio's

`onboarding_step = setup`, created 2026-08-23, never completed. It has geo (Places
worked) and a ticket email, but no subscription and no Stripe. Determine precisely which
step failed and whether it was a code failure or Jason simply stopping. Write it up —
this is the single best evidence we have of where the real flow breaks.

---

## P2 — THE REHEARSAL. Full onboarding, end to end, throwaway shop.

Create a disposable shop and walk the **entire real flow**, using the real endpoints.
Not unit tests — the actual path a shop owner takes:

1. `signup-page/index.html` — submit owner name, shop name, website URL, email.
2. Confirm `onboarding-save` create fires: shop + tenant created, `onboarding_token` set.
3. **Confirm the resume email actually sends** via Resend and the link works
   (`setup.html?t=<token>`). This is a real send — use an address you control.
4. Walk `setup.html` / `wizard.js` through every step: menu, hours, EIN, Stripe Connect
   (Express create path), delivery config, order-ticket email.
5. Confirm the menu import path works from a real website URL (`onboard-tenant` crawl).
6. Confirm number provisioning fires (`provision-number`, Telnyx).
7. Call `go-live` and record **exactly which gates refuse and why.**

**Record every break, fix it, re-run that step.** The deliverable is a flow that
completes, plus a written list of what was broken.

Use a real test shop — `is_test = true`, no live phone. Do NOT touch Vito's, NJB, or Zio's.

---

## P3 — The campaign gate cannot currently be satisfied

`campaign-status-reader` advances `submitted → approved`. **Nothing ever sets
`submitted`.** So `campaign_assignment_status` stays `not_started` forever and the
campaign gate refuses every non-test shop permanently.

Two things needed:
1. **Deploy `campaign-status-reader`** — written, tested, GET-only, never deployed.
2. **Something must set `submitted`.** Either `provision-number` sets it after ordering
   the number, or there is a documented manual step with an owner. RUNBOOK says "manual
   for the first 1–2 shops" — fine, but that step currently has no trigger and no owner,
   which means it will silently never happen.

A gate nothing can satisfy is as broken as a gate that never blocks.

---

## Rules — unchanged

1. Never weaken a gate or check to make something pass.
2. Commit → deploy → verify.
3. **Verify before claiming.** Run the query that would prove your claim false.
4. Change one thing at a time.
5. Escalate rather than work around.
6. Do not touch the Telnyx campaign, safety gates, or Vito's/NJB/Zio's shop data.
7. Harness stays closed — no 128 runs, no invariant work.

## Reporting

Short dispatches to `agent:main:po:claude` (long ones time out and fail). Keep
`docs/specs/2026-09-03-STATUS.md` current. For the rehearsal I want the **list of breaks
found**, not a summary — that list is the deliverable.
