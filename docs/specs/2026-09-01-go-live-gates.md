# Spec: go-live must enforce the gates the docs already promise

**Date:** 2026-09-01
**Owner:** Lead → John Walsh (build) → Melvin (verify)
**Priority:** 3 of 5. Depends on specs 1 and 2 — a Proof gate is only worth enforcing once Proof grades correctly.

## Why this exists

Three hard gates are stated as binding in the repo's own documents. None of them is code.

- Proof spec, 2026-08-30, opening paragraph: **"100% or the shop does not go live."**
- `RUNBOOK.md` and `HANDOFF.md`: **"First delivery test is a hard go-live gate."** The 8-step real-handset script (`sprintai-telnyx-provisioning-test.md`) is described as the ground-truth check, because the Telnyx API's 806 `failureReasons` flag may be stale rather than live.
- The kitchen ticket is the only channel by which a restaurant learns an order exists (see spec 4). A shop with no ticket destination cannot fulfil an order it has been paid for.

`supabase/functions/go-live/index.ts:159` enforces: `connect`, `delivery_geo`, `menu`, `menu_approved`, `menu_clean`, `number`, `hours`, `subscription`, `ein`.

There is no Proof gate. There is no delivery-test gate. There is no ticket-destination gate. A shop at 82% with an SMS path never tested on a real handset and no order email configured flips live cleanly today.

This is the gap that matters most for Erin's first shops, because it is the one no one will notice until a real customer is on the other end.

## Fix

Add three gates to the `gates` object. Same shape, same `blocked_by` behaviour, same refusal message pattern.

### Gate 1 — `proof`

Passes only when the shop has a **current, passing** Proof run.

- Source: the latest `test_runs` row with `scorer_version = 2` and `proof_score = 100%`.
- **Currency:** the run must be against the shop's current menu and current deployed code. Compare the run's menu revision and commit SHA against live. A Proof run from before the last menu edit or the last `chat-sms` deploy does not count. Stale green is worse than no green — it is the failure mode that burned 2026-08-31 (#3807: agents declared victory off the wrong shop's stale log, and #3813 became a standing rule because of it).
- **Twin resolution:** Proof cannot run against a shop that has a live phone number — the safety gate refuses it by design, which is why `create-qa-twin.py` exists. So the gate resolves the shop's QA twin and reads the twin's run. It must additionally assert **menu parity** between shop and twin (item count and content hash). A twin whose menu has drifted from its parent proves nothing about the parent. If no twin exists or parity fails, the gate blocks with a message saying which.

### Gate 2 — `delivery_test`

Passes only when the first-delivery test has been recorded as passed for this shop's number.

- Add a `first_delivery_test_passed_at` column (new migration) plus who recorded it.
- This is a human attestation of the 8-step handset script, not an API check — that is the entire point of it. Record it from the admin dashboard, one control, with the operator's identity.
- Non-test shops only. `is_test` shops skip, same pattern as the existing `ein` gate.

### Gate 3 — `ticket_destination`

Passes only when `email_ticket_recipient` is non-null and syntactically valid.

> **CORRECTION 2026-09-01 (spec author).** My original rationale here was wrong and is
> replaced. I wrote that self-serve onboarding "does not collect" this field. It does —
> `signup-page/wizard.js:114` collects it at the account step (saved at :140) and
> `wizard.js:759` collects it again as an explicit "Order ticket email" (saved at :821).
> I had grepped `signup-page/*.html`, found nothing, and reported the null result as
> proof. The wizard is JavaScript, not inline HTML. My error; the gate survives it, for
> a better reason below.

**The real reason, from production data (`qa_ro.shops_config`, 2026-09-01):**

Of 39 shops, **6 have no ticket destination** — and two of them are
**`Vito's Pizza`** and **`Vito's Pizza (QA)`**, the demo shop and its QA twin. Vito's
was created by `scripts/create-vitos-pizza-demo.py`, not through the wizard.

So the wizard collects it correctly, and shops created by any other path — admin UI,
demo scripts, QA-twin cloning — bypass that collection entirely. Nothing downstream
notices. The gate is what makes the collection path irrelevant: however a shop was
created, it cannot go live without somewhere to send orders.

Blast radius on Vito's is currently limited — `charges_enabled = false`, so
`isShopLive()` fails and no checkout can complete, meaning no order can be paid for and
lost. But that is a coincidence of the demo being unfunded, not a safeguard. If anyone
enables Stripe on Vito's to make the demo take a real payment, orders will vanish
silently. Worth setting the recipient on both Vito's rows today regardless of this spec.

## Refusal messages

Follow the existing pattern at `go-live/index.ts:175–182` — each refusal says what to do, not just what failed:

- `proof` → "Go-live refused: this shop has not passed Proof against its current menu. Run Proof and clear all failures before launch." Include the score and the run id.
- `proof` blocked on staleness or parity → say which, name the twin, and name what changed since the run.
- `delivery_test` → "Go-live refused: the first-delivery test has not been completed on this number. Run the 8-step handset script and record the result."
- `ticket_destination` → "Go-live refused: no order email is configured. The kitchen has no way to receive orders."

## Acceptance (Melvin verifies)

1. A shop below 100% `proof_score` is refused, with the score and run id in the message.
2. A shop at 100% whose menu changed after the run is refused as stale.
3. A shop whose twin menu no longer matches the parent is refused on parity.
4. A shop with no `first_delivery_test_passed_at` is refused; an `is_test` shop is not.
5. A shop with null `email_ticket_recipient` is refused.
6. Self-serve onboarding cannot be completed without an order email.
7. A shop passing all three plus the existing six flips live, unchanged from today's behaviour.
8. **No existing gate weakened.** Diff the `gates` object; the nine current keys behave identically.

## Operational consequence — say this to Jason before it bites

Once this lands, **the first shops cannot be launched on the day they are signed.** Sequence per shop becomes: onboard → menu → twin → Proof to 100% → number → campaign assignment (spec 5) → handset delivery test → go-live. Proof alone is roughly an hour of cron time, and clearing failures on a messy menu has taken days on Vito's.

That is the honest cost of the gate. It is also exactly what Jason asked Proof to be at #3651 — the thing that lets an owner feel confident. A gate that never blocks is not a gate, and a shop that goes live broken costs more than a shop that goes live late. But Erin's expectations and the demo-kit sales copy need to reflect a real onboarding window, not same-day.

## Out of scope

- Building the owner-facing Proof report artifact (Phase 2). The gate reads the score; presenting it beautifully to a restaurant owner is still unbuilt.
- Automating campaign assignment — spec 5.

## Definition of done

Three gates added and enforced, migration for the two new columns applied, self-serve onboarding collects the order email, refusal messages actionable. Melvin verifies all 8 criteria including the no-weakening diff. RUNBOOK's gate list updated to match the code.
