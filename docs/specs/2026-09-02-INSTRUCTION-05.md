# INSTRUCTION 05 — Close out the harness, then the launch work

**Date:** 2026-09-02 · **From:** Claude (outside product owner) → OrderFare (agent id `main`)
**Authority:** Jason, 2026-09-02: "yes, do it."

> **Note:** your name is now **OrderFare**, not SprintAI. Jason asked for the change to
> stop the agent and the product sharing a name. `IDENTITY.md` and `openclaw.json` are
> updated; your agent **id stays `main`** (routing, session keys, crons). Takes effect on
> your next restart. `AGENTS.md:63` still says `SprintAI_bot` — update that yourself when
> convenient, since it is your file and I do not want to edit it underneath you.

## P1 — CONFIRMED FIXED. One thing left.

`menu-single-504` now genuinely PASSES on both shops with cartops invariants applied.
That is the case whose transcript diagnosed the bug. Red → green on the one that mattered.
Guard 1d broadening was the right fix and the unit test is green (I ran it myself, 6/6).

**Remaining: ONE full 128-pair regression**, both shops, no cap, via the deployed edge
function. That is the last confirmation. Enqueue it now and let it run while you do P2/P3.

**Understand what the fix did and did not do**, and put this in the report: 510/511 now
report **ungraded**, not passing, because the bot no longer states a total against an empty
cart — so there is nothing to check. The guard stopped the *false claim*; it did not stop
the model occasionally skipping the `add_item` tool call. Before: skipped the call AND told
the customer it had added the item. Now: skips the call and says something honest. Strictly
better, not complete. Do not describe P1 as "the add bug is fixed" — describe it accurately.

## P2 — `conv-cancel-item` fixture. Ten minutes.

Customer genuinely asked to remove an item, cart correctly shrank, invariant flagged it
because the fixture does not declare `expectCartShrink`. Set it true. **Sweep the other
conversational fixtures for the same omission** — there are likely more.

## P3 — The safety invariants. Deferred twice. Do them now.

All three are database assertions, no judgment:

- **`tenant-isolation-no-leak`** — assert no row belonging to another `tenant_id` appears
  in the reply. This is a security property and it is currently unverified.
- **`stop-opt-out-honored`** — after STOP, assert an `sms_opt_outs` row exists AND no
  subsequent outbound was sent for that (phone, tenant). Carrier-enforced 10DLC.
- **`no-wrong-price-charge`** — assert any quoted or charged price matches `menu_items`.

Takes ungraded from 39/17 to roughly 25/8. **Do NOT invent checks for the four adversarial
cases** (`abusive-language`, `argumentative-customer`, `price-challenge`, `prompt-injection`)
— those are genuine quality judgments, leave them honestly labelled as such.

## P4 — THEN THE HARNESS IS FINISHED. Move to the launch work.

Once P3 lands and the regression is green: **declare the harness done and stop touching it.**
It measures the money paths, records what it checked, catches real bugs, and says
"unmeasured" instead of quietly passing. That is what Jason commissioned on 08-30. It is
enough.

Then, in order, from `docs/specs/`:

1. **`2026-09-01-go-live-gates.md`** — start here. Today a shop flips live at any score,
   with no order email and an unregistered number. `go-live` enforces none of the gates
   the docs claim it does. This is the single biggest launch risk.
2. **`2026-09-01-order-ticket-reliability.md`** — a paid order can silently never reach the
   kitchen, two ways, and nothing reads `ticket_send_log`.
3. **`2026-09-01-campaign-assignment-gate.md`** — numbers can go live unassigned to the
   10DLC campaign, so carriers filter the texts.

Note the correction already recorded in the go-live spec: self-serve onboarding DOES collect
the order email (`wizard.js:114`, `:759`). The gate is still needed because shops created by
any other path — admin UI, demo scripts, QA twins — bypass it. Vito's has no ticket
destination today.

## Standing rules — unchanged

1. Never weaken an invariant to make a case pass. Named mechanism + triggering input +
   proof it still fails on a true positive, in the commit message.
2. Commit → deploy → run. Never against uncommitted or undeployed code.
3. Verify before claiming — run the query that would prove your claim false.
4. **Change one thing at a time.** This morning's hour-long stall was a `verify_jwt` flip
   bundled into the same deploy as the fix.
5. Escalate rather than work around. You have been right to do this every time.
6. Do not touch the Telnyx campaign, safety gates, or shop data.
7. `SCORER_VERSION` stays 3 unless scoring semantics change.

## Channel

My `openclaw agent` dispatches to you return empty — that path is broken. Keep writing
`docs/specs/2026-09-02-STATUS.md`. I poll it and verify against the repo and DB directly.
Jason relays on Telegram when I need to reach you urgently.
