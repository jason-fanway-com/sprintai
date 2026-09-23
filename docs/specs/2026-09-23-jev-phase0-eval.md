# Jev (TypeSafe) Phase 0 — offline eval against the engine ledger

2026-09-23. Question: where does a calibrated classifier (Jev 1.13, via OpenRouter's decisions
endpoint, $0.042 per million input tokens, output free) earn a place in the clean-sheet engine?
Method: `scripts/engine/jev-eval.ts` rebuilds labeled cases from the engine ledger since the clean
engine went live (3,116 carts, 14,450 ledger rows, 3 shops), asks Jev the judgment the engine would
have asked at that moment, and scores by confidence threshold. No product code was touched.

## Verified facts about the service
- Endpoint `POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`, same
  OpenRouter key as the interpreter. Request = `state` object + map of typed questions
  (choice / noul / score); response = typed answer, probabilities, confidence, `usage.cost`.
- Cost measured: ~$0.00003 per turn-sized call (500–800 input tokens, three questions).
- Latency measured: 233 ms median on one run, 1,164 ms median on another (beta service). It
  must run in parallel with the interpreter call and carry a timeout; on timeout the engine
  behaves exactly as today.

## A. Item ambiguity — should Jev pick the item from the customer's original message?
42 unique cases where today's resolver still asks (21 raw cases the current resolver already solves
were excluded). Label = the item the customer ended up with.

| threshold | picked (coverage) | right | wrong | asked |
|---|---|---|---|---|
| ≥0.8 | 10 (24%) | 7 | 3 | 32 |
| ≥0.95 | 8 (19%) | 5 | 3 | 34 |

The three "wrong" picks, read one by one:
- "bowl of lobster bisque" → Jev: Bowl (1.00). Label "Cup" came from a scripted harness customer
  answering the size question with "cup". Jev was right; the engine was wrong to ask. **Resolver
  gap, fixed today:** size words in the item span (cup, bowl) now narrow.
- "Chicken Bacon Ranch pizza, medium size" → Jev: Medium (1.00). Label "Small" is again the scripted
  answer. Jev was right. **Resolver gap, fixed today:** filler words ("size") no longer block an
  option from narrowing.
- "Chicken parm sandwich, **large fries**, large plain pizza and onion rings" → Jev: French Fries
  (0.98). This is Jason's real phone order; he wanted Crab Fries. **Jev was wrong, with high
  confidence, on a real customer.** Nothing in the message named the kind; Jev supplied a prior.

Verdict: **do not let Jev pick item identity.** One confident wrong item in ten picks is a wrong
ticket and wrong money, the two things that must never be wrong. Its correct picks were cases the
deterministic resolver should own, and now does. Jev may later be used to ORDER a kind list (most
likely first) but never to skip the question.

## B. Omission adjudication — did the customer actually ask for the item the lexicon saw?
33 unique cases where the engine asked "Did you also want X?". The harness labels (a scripted
customer says yes to anything) were unusable; every case was re-read by hand against the
question "is the customer asking to ADD this item in this message?" (4 yes, 29 no).

| threshold p(yes) | predicted yes | real yes caught | false yes | missed yes | questions saved |
|---|---|---|---|---|---|
| ≥0.5 | 5 | 4/4 | 1 | 0 | 28 of 33 |
| ≥0.7 | 5 | 4/4 | 1 | 0 | 28 of 33 |
| ≥0.9 | 1 | 1/4 | 0 | 3 | 32 of 33 |

The one false yes at 0.5: "2 chicken parm sandwiches …" with the word "sandwiches" pointing at
cheesesteak sandwiches (p=0.75). Correct no's include "remove the pizza" (0.01), "an order of
garlic knots" vs the item "Broccoli Order" (0.04), "show full order" (0.06), and "can I get that on
a flagel?" (0.46, a modification, not an add).

Verdict: **wire it, gated at p ≥ 0.5, and only ever in the suppressing direction.** Below the
gate the omission question is dropped (28 of 33 pointless questions gone); at or above it the
engine does exactly what it does today — asks. Jev never adds a line. A wrong Jev answer costs
one extra question, never a wrong ticket.

## Not measurable from the ledger yet
Option word → choice group ("buffalo" vs Hot/Mild) and reply routing have no labels in the
ledger. Labels will come from the phone tests and the messy pass; the eval script is the harness.

## Decisions
1. Phase 1 wires ONE judgment: omission adjudication, through a new `judge.ts` adapter (the
   second and last file allowed to call a model), parallel with the interpreter, 1.5 s timeout,
   threshold in one table in the core, every answer in the ledger with its probability.
2. Item-identity picking is rejected on evidence; the two resolver gaps it exposed are fixed with
   fixture tests instead.
3. Re-run this eval after each week of live traffic; the case sets grow from the ledger for free.

## Outcome (2026-09-23, afternoon)
Phase 1 shipped as chat-sms v615 (commit 00fbdb40): acceptance Vito's 35/35, NJB 10/10, Zio's 10/10,
sweep 40/42, 0 invented, 0 money mismatches; live probes confirmed the "order of garlic knots" false
question gone. Vito's p95 rose from ~4 s to 7.6 s on that run. Jason's call on reading the results:
the gain is small and not worth another dependency. **The judge is switched off** (`JUDGE.enabled =
false`, commit e2e05c46, v616). The adapter, the seam tests and this eval stay in the repo so it can be
re-enabled on evidence, one judgment at a time, without rebuilding anything.
