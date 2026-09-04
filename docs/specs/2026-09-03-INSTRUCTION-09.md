# INSTRUCTION 09 — Split onboarding from go-live; reopen the suite for launch qualification

**Date:** 2026-09-03 · **From:** Claude (outside product owner) → OrderFare
**Authority:** Jason, 2026-09-03.

**Sequencing:** after INSTRUCTION-08 (subscription code path). Do not start this until the
subscription work is committed, verified and deployed. Do not pull backlog items while
either is in progress.

---

## Why

Today there is one cliff: thirteen gates, all-or-nothing, and a restaurant is either
nothing or live. That means an owner can sit looking at a blocked screen because a phone
carrier has not answered yet — which is neither their fault nor their business.

Jason: *"There should be a difference between onboarding completed and go-live, which I
guess is the QA phase."* And when the owner's part is done: *"Congratulations, sit and
wait. Let us do our work. When it's near perfect and when the phone number clears, we
will let you know we're ready for launch."*

---

## 1. Split the thirteen gates into two phases

**Do not remove, weaken, or renumber any gate.** All thirteen still must pass before a
shop goes live. This changes *when each is evaluated and who is waiting on it*.

**Phase A — ONBOARDING COMPLETE (the owner's job, nine gates)**

`ein` · `connect` · `subscription` · `menu` · `menu_approved` · `menu_clean` · `hours` ·
`ticket_destination` · `delivery_geo`

When all nine pass, set a new persisted state — `onboarding_complete` — and show the
owner a completion screen. Copy, close to Jason's words:

> **You're done. Congratulations.**
> Sit tight and let us do our work. We're putting your assistant through its paces and
> waiting on your phone number to clear the carriers. We'll message you the moment we're
> ready to launch.

This screen is terminal for the owner. It must not show blocked gates, error states, or
anything that reads as their fault. Nothing on it should ask them for more.

**Phase B — QA (our job, four gates)**

`number` · `campaign_assignment` · `proof` · `delivery_test`

Evaluated after Phase A completes. The owner is not present and must not be blocked
waiting on a screen. When all four pass, notify the owner that launch is ready — **by
SMS to the owner cell** (see §4), with email as a secondary.

`go-live` continues to require all thirteen and continues to fail closed. Its gate count
stays 13.

## 2. The acceptance suite is reopened — for launch qualification ONLY

The closure of 2026-08-30 was aimed at one specific waste: **using multi-hour product
runs to validate changes to the scoring engine itself.** That prohibition stands. Harness
and scorer changes are still validated with unit tests, never with product runs.

**Qualifying a new restaurant for launch is a different activity and is now permitted.**
A Proof run whose purpose is to satisfy the `proof` gate for a specific shop is not a
violation and must not be reported as one.

Nothing else about Proof changes: `SCORER_VERSION` stays 3, grading stays deterministic,
100% is still required, and the twin-menu parity check is unchanged.

## 3. The QA phase is agent-operated, not agent-judged

This is the important distinction and it is not negotiable.

**Agents operate.** Create the QA twin, start the run, chase failures, re-run, file the
result, escalate what they cannot resolve. Treat this as an employee running a routine.

**Code judges.** `proof_pass_pct` remains deterministic. **No agent, model, or LLM may
decide whether a shop passed.** Proof's founding principle — no LLM grading an LLM —
applies exactly as before. An agent reporting a pass is not a pass; the score is.

**Every run produces a record**, appended to `docs/specs/qa-phase-log.md`:
shop, date, wall-clock duration, what failed, what was flaky versus genuinely broken,
what needed a judgment call and who made it, and **whether any human or agent had to
intervene at all**.

That record is the specification for automating this later. The trigger for automation is
**not a count of runs** — it is the intervention rate approaching zero. Report that rate.

## 4. Signup collects the owner's mobile number

Add one field to the light signup: **owner mobile number**, for texting.

Signup now collects: owner name · restaurant name · website · email · **mobile**.
Still nothing else. No card, no tax ID, no Stripe on that page — unchanged.

Store it separately from any shop-facing number. This becomes the durable channel for
reaching the owner after Erin leaves: the nudge to begin onboarding, the congratulations,
and the ready-to-launch message.

## 5. Order ticket destination — ask the question, record the answer, build only what we know

Today the address typed at signup silently becomes the kitchen ticket destination. That is
almost always the wrong place — it is the owner's personal or business inbox.

Do not leave this as a silent default, and do not try to solve it. **Surface it as an
explicit question during onboarding** and capture what they say. Jason's framing:

> The email you entered is where all your orders are going to land. You probably don't
> want that — it's your personal inbox. Let's figure out where these should go.

Present the options we know about:

- **The Expo Screen** — the default, and always active regardless of what else is chosen
- **A dedicated mailbox** — an address that exists only for orders
- **Their own ticketing system** — an API integration with whatever the kitchen already runs
- **Something else** — free text

**Build now:** the question, the Expo Screen default, the dedicated-mailbox option, and
persistence of the answer — *including the free text* — for every shop.

**Do not build:** the API integration. Capture the intent and the system named, nothing
more. We will not know what that integration looks like until a real customer describes
their setup.

The answers across the first ten shops are the research. Report the distribution.

**Consequence — the Expo Screen is now the guaranteed delivery path.** Orders land there
by default for every shop, whatever else is configured. It is no longer a
nice-to-have that follows launch; it is the one destination that is always correct and
always available. Treat it accordingly when it is scheduled.

Also: `email_ticket_recipient` is currently frozen after onboarding — no owner-facing
surface can change it. **Make it editable by the owner** (admin chat is the natural home,
alongside 86'ing and the delivery toggle), so we can act on what a customer tells us
without a database edit.

---

## Acceptance criteria

Run the query or command that would prove each false:

1. A shop with all nine Phase A gates passing reaches `onboarding_complete` and is shown
   the completion screen — with the four QA gates still unsatisfied.
2. That screen shows no blocked gate, no error, and no further ask.
3. `go-live` still evaluates thirteen gates and still refuses when any fails.
4. A Proof run executed to qualify a shop completes without being flagged a violation.
5. `docs/specs/qa-phase-log.md` exists and has a record for every qualification run.
6. Signup persists an owner mobile number distinct from the shop phone number.
7. An owner can change the order ticket destination without a database edit.
8. Onboarding asks the ticket-destination question explicitly and persists the answer —
   including free text — for every shop. Orders reach the Expo Screen regardless of the
   answer given.

## Rules — unchanged

1. Never weaken a gate to make something pass. Gate count stays 13.
2. Commit → Melvin verifies → deploy → verify.
3. Verify before claiming. Run the query that would prove your claim false.
4. Change one thing at a time.
5. Escalate rather than work around.
6. Do not touch the Telnyx campaign or Vito's / NJB / Zio's.
7. No LLM grades an LLM. Ever.
8. Do not bundle the uncommitted `chat-sms` change with this work.

## Reporting

Short dispatches to `agent:main:po:claude`. Keep `docs/specs/2026-09-03-STATUS.md`
current — it still does not exist.
