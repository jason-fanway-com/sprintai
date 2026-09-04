# INSTRUCTION 10 — Build every missing piece. Do not run the integration test.

**Date:** 2026-09-03 · **From:** Claude (outside product owner) → OrderFare
**Authority:** Jason, 2026-09-03. **This supersedes the sequencing in INSTRUCTION-07, -08
and -09.** Their contents stand; the order and the stopping condition change.

---

## The change

> *"We got to build all the pieces, put them together, make them available to the
> integration test. When we're ready, we will run the integration test according to a plan
> run by me, the main human in charge."*

**Stand down the rehearsal.** Stop walking the onboarding flow end to end. Leg 1 is
cancelled as a gating activity — do not resume it, do not start leg 2. The rehearsal shop
`p2-rehearsal-diner` stays where it is; do not delete it.

**Build the missing components instead.** Every functional gap below gets built and
validated on its own, without an end-to-end walk.

**You do not run the integration test.** Jason runs it, to his plan, when the pieces are
assembled. He observes, the PO observes, and the PO tells you what to fix. Do not attempt
a full-flow test to "check your work" — component proof is the standard here.

**We expect it to break when he runs it.** That is the point of him running it. Do not
over-engineer against imagined failures; build each piece correctly and stop.

---

## What to build

Ordered by criticality. Most are independent — parallelise where Melvin's verification
capacity allows. Report the readiness of each separately.

### A. Subscription code path — *nothing exists*
Full spec: `2026-09-03-INSTRUCTION-08.md`.
**Correction to that spec:** it targets `signup-page/wizard.js`. **That file is dead code**
— nothing loads it but test fixtures. The live onboarding surface is
`signup-page/setup.html`, which has **no subscription step at all**. Build the step there.
**Validated when:** a test shop reaches `subscription_status = 'active'` only after a
Stripe test-card checkout, with subscription and customer ids persisted, and a promo-code
redemption yields a $0 first invoice *with a payment method still attached*.

### B. Onboarding/go-live split + completion screen — *does not exist*
Full spec: `2026-09-03-INSTRUCTION-09.md` §1.
**Validated when:** a shop with the nine owner gates passing reaches `onboarding_complete`
and renders the completion screen while the four QA gates are still unsatisfied; `go-live`
still evaluates thirteen and still refuses.

### C. Resume email failure must be visible — *fails silently by design*
`onboarding-save` logs a failed or unconfigured send and continues as success. That email
is the only bridge from signup to onboarding.
**Build:** persist send outcome per shop; return the true result to the signup page so it
can be seen in the room; provide a resend path.
**Validated when:** with the mail key deliberately unset, signup reports failure rather
than success, and the failure is recorded and resendable.

### D. Owner mobile number at signup — *not collected anywhere*
INSTRUCTION-09 §4. Five fields now. Stored separately from any shop-facing number.
**Validated when:** a signup persists an owner mobile distinct from `phone_number_e164`.

### E. Ticket destination question + persistence — *silently defaults today*
INSTRUCTION-09 §5 (revised). Ask the question, offer Expo Screen (default) / dedicated
mailbox / their own system via API / free text. Persist the answer including free text.
**Do not build the API integration** — capture the named system only.
**Validated when:** the answer, including free text, is persisted for a test shop, and
`email_ticket_recipient` is editable by the owner via admin chat.

### F. Menu curation by confidence — *does not exist*
Extraction works; nothing sorts by confidence. Going live requires the owner to personally
attest the menu with zero flagged rows, so an unsorted pile turns the first impression into
an audit.
**Build:** a confidence score per extracted item; a confident set presented as the taste;
low-confidence items presented as specific questions for the owner to answer.
**Validated when:** a crawl of a real restaurant website yields items split into confident
and needs-input, and the owner surface renders both differently.

### G. Expo Screen — *does not exist, now promoted*
Full spec: the Expo Screen proposal (four states, seven-minute escalation, owner tab plus
standalone install, wake lock, start-shift audio unlock, device pairing).
**It is no longer post-launch.** Per INSTRUCTION-09 §5 it is the default and always-active
order destination for every shop, which makes it the only delivery path guaranteed correct.
**Validated when:** a paid test order appears in the queue, advances only on human action,
and the screen holds state across a network drop.

### H. Ticket delivery truth — *does not exist*
Resend delivery webhooks (`delivered` / `bounced` / `complained`) written back against
`resend_message_id`, surfaced per order on the Expo Screen.
**Validated when:** a deliberately bad recipient produces a visible bounce on that order.

### I. Escalation rule — *does not exist*
INSTRUCTION-09 and the Expo Screen spec: paid, ticket delivered, still unacknowledged after
**7 minutes** → escalate to the owner by SMS. Reuse `issue-detector`.
**Validated when:** a synthetic unacknowledged order triggers exactly one escalation.

---

## What to prove rather than build

### J. Carrier approval chain
`provision-number` now sets `submitted`; `campaign-status-reader` is written. Deployment
and scheduling are **unconfirmed** — the read-only role cannot see the scheduler.
**Prove:** the function is deployed and scheduled, and a `submitted` shop advances to
`approved` on its own.

### K. Website read reliability
Only ever attempted a handful of times, all against fabricated test shops. Real-world rate
is unknown, and it carries the whole first impression.
**Prove:** run it against **twenty real restaurant websites** of the kind Erin will visit.
Report the success rate and what the page should say on failure.

### L. Demo kit
Three codes: demo restaurant text-to-order with a Stripe test transaction; owner chat
(86'ing an item with end-of-day auto-expiry, delivery toggle); signup page. All exist as
code; none has been walked as a customer would.
**Prove:** walk all three on a phone, in order, and report what breaks.

---

## Cleanup — do these, they are cheap and they cost us today

### M. Delete or clearly mark `signup-page/wizard.js` as dead
A complete nine-step onboarding flow that runs nowhere. It already caused one wrong
diagnosis by the PO today. Confirm nothing serves it, then remove or mark it.

### N. Resolve the uncommitted `chat-sms` change
The one-line quantity-reduction prompt addition has sat uncommitted for days. Justify and
ship it alone, or revert. It must not ride along with any of the above.

---

## Reporting — a readiness board, not prose

Maintain `docs/specs/2026-09-03-READINESS.md`. One row per item A–N:
**item · status (not started / building / in verification / built) · validated how · blockers.**

Update it whenever a status changes. This is the artifact Jason reads to decide when the
integration test happens. Keep `docs/specs/2026-09-03-STATUS.md` current too — it still
does not exist.

Short dispatches to `agent:main:po:claude`. Report each item's readiness as it lands rather
than batching.

## Rules — unchanged

1. Never weaken a gate to make something pass. Gate count stays 13, fail-closed.
2. Commit → Melvin verifies → deploy → verify.
3. Verify before claiming. Run the query that would prove your claim false.
4. Change one thing at a time.
5. Escalate rather than work around.
6. Do not touch the Telnyx campaign or Vito's / NJB / Zio's.
7. No LLM grades an LLM.
8. Acceptance suite: permitted for launch qualification only; still banned for validating
   scorer changes.
9. Do not pull backlog items while any of A–N is open.
