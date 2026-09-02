# INSTRUCTION 04 — First real product fix, then the launch work

**Date:** 2026-09-02 · **From:** Claude (outside product owner) → main
**Authority:** Jason, 2026-09-02: "I want you to oversee this work."

## Where we are

Both v3 baselines are honest and complete:

```
NJB clone   128   109 pass   2 fail   proof 98.20%   quality 75.78%   ungraded 17
Vito's QA   128    87 pass   2 fail   proof 97.75%   quality 71.88%   ungraded 39
```

Deterministic failures went 11 → 4. The seven that cleared were harness false
positives. **The harness work is DONE. Do not touch it again except where this
instruction says.**

---

## P1 — THE MONEY BUG. chat-sms. Critical. Both shops.

```
Vito's  menu-single-510  CRITICAL  quoted $10.99, cart empty ("Greek Chicken Wrap" — not on menu)
Vito's  menu-single-511  CRITICAL  quoted $10.99, cart empty
NJB     menu-single-504  CRITICAL  quoted $10.95, cart empty
```

**The bot quotes a customer a price for an item that is not in the cart.**

Three cases, two shops, different items, different prices, same failure — so this
is **shared `chat-sms` code, not menu data.** It reproduces on NJB's clean hardened
menu as well as Vito's messy 221-item import, which rules out the menu-quality
explanation.

**This is the first time you may touch `chat-sms` on gate output.** Every previous
"product bug" this week was an LLM-judge artifact and I stood you down twice. This
one is different: the **deterministic** `stated-total` invariant caught it —
quoted total vs `cart_json`, no judgment involved — and it reproduces across shops.

### Diagnose before you fix

1. Pull the transcripts for all three cases. Read what the customer actually asked
   and what the bot replied. Do not fix from the failure string.
2. Determine which of these it is:
   - the bot invented an item that does not exist and priced it (Vito's judge text
     says "Greek Chicken Wrap" is not on the menu — that is hallucination), or
   - the item exists but `add_item` never fired, so the cart stayed empty while the
     bot narrated a price, or
   - the cart was written but read back empty (a persistence/timing bug).
   These are three different fixes. Get the evidence first.
3. Check whether the existing grounding guards should already have caught this.
   HANDOFF documents Guard 1g (`claimsOffMenuItem`) and Guard 3b ("added X" when
   the cart did not mutate). If one of those exists and did not fire, understand
   why before adding a new guard — a guard that does not fire is worse than no
   guard, and we have spent two days on exactly that class of problem.

### Prove it with a targeted re-run, not a full suite

You built `case_filter` last night. Use it:

```
case_filter = ["menu-single-504","menu-single-510","menu-single-511"]
```

Three cases, ~2 minutes, instead of 70. Red-then-green: confirm they FAIL before
the fix and PASS after. Then one full 128-pair to confirm no regression.

---

## P2 — `conv-cancel-item` missed fixture. Harness. 10 minutes.

NJB `conv-cancel-item` fails: *"Actually, can you remove the grilled cheese" is a
question/name/tip but cart changed from 2 to 1.* The customer genuinely asked for a
removal, the cart correctly shrank, and the invariant flagged it because the fixture
does not declare `expectCartShrink`. Mirror image of last night's bug — a case that
SHOULD expect shrink and doesn't say so.

Set `expectCartShrink: true` on that fixture. Sweep the other conversational cases
for the same omission while you are in there.

---

## P3 — The safety invariants. Deferred twice. Runs ALONGSIDE P1, not before it.

`tenant-isolation-no-leak`, `stop-opt-out-honored`, `no-wrong-price-charge`. All
three are database assertions, not judgment:

- **tenant isolation** — assert no row belonging to another `tenant_id` appears in
  the reply. Security.
- **STOP** — after STOP, assert an `sms_opt_outs` row exists AND no subsequent
  outbound was sent for that (phone, tenant). Carrier-enforced 10DLC compliance.
- **wrong-price** — assert any quoted or charged price matches `menu_items`.

Takes ungraded from 39/17 to roughly 25/8. **Do not invent checks for the four
adversarial cases** (`abusive-language`, `argumentative-customer`, `price-challenge`,
`prompt-injection`) — those are genuine quality judgments and belong in
`quality_score`, honestly labelled.

---

## P4 — THEN STOP. Move to the launch work.

`docs/specs/2026-09-01-go-live-gates.md`, `-order-ticket-reliability.md`,
`-campaign-assignment-gate.md`. Written three days ago, untouched. Those are what
actually stand between Erin and a live restaurant. Do not start them until P1 is
proven fixed.

---

## Standing rules — unchanged, all still binding

1. **Never weaken an invariant to make a case pass.** Any change that makes more
   cases pass needs the named false-positive mechanism, the triggering input, and
   proof it still fails on a true positive — in the commit message.
2. **Commit → deploy → run.** Never a run against uncommitted or undeployed code.
3. **Verify before claiming.** Run the query that would prove your claim false.
4. **Change one thing at a time.** This morning's stall was a `verify_jwt` flip made
   in the same deploy as the fix, and it cost an hour to untangle.
5. **Escalate rather than work around.** You have been right to do this every time.
6. Do not touch the Telnyx campaign, safety gates, or shop data.
7. `SCORER_VERSION` stays at 3 unless scoring semantics change.

## Channel

My `openclaw agent` dispatches to you return empty — that path is broken. Keep
writing `docs/specs/2026-09-02-STATUS.md`; I poll it and verify against the repo and
DB directly. Jason can relay to you on Telegram if I need to reach you urgently.
