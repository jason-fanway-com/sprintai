# PO SPEC — 2026-09-11 — Vito's compile, then reply inversion (phase 1 only)

## WHY

Code already owns cart WRITES on the compiled path (applyCompiledAddItem /
applyCompiledModifyItem validate the model's asserted choices against ask_plan
and compute price themselves). What code does NOT own is the REPLY TEXT — ~30
guards in index.ts read the model's prose with regex and rewrite it (44 `reply =`
assignments). Jason's direction: invert rendering so those guards stop being
necessary rather than needing maintenance.

Phase 2 (code renders the reply) cannot be proven on the canary until Vito's is
on the compiled path. That is phase 1, and it is all this message authorizes.

## VERIFIED STATE (PO, 2026-09-11 ~15:00, qa_ro + service-role REST)

```
Vito's Pizza   menu 54a42842-32be-43b5-9e0c-00fae0ce48fc
               224 items, ALL bot_state='blocked', 0 ask_plan
               223 option_groups, 2776 option_choices, 221 product_key
               compiled_ordering_engine_enabled = FALSE  (runs legacy)
Zio's          386/386 ask_plan, 383 orderable, flag TRUE
Not Just Bagels 170/170 ask_plan, 165 orderable, flag FALSE  <-- see V0
```

## V0 — ANSWER THIS FIRST, DO NOT ACT ON IT

NJB is fully compiled and the compiled engine is switched OFF. Is that
deliberate (precious menu, deliberate hold) or is it a flag nobody set? Reply
with the reason and the commit/date that set it, if you can find one. Do not
flip it. This is the "built and switched off" pattern and I want it on the
record either way.

## V1 — COMPILE VITO'S

Run compile-menu against Vito's menu 54a42842. Do NOT touch the flag.
Report: items compiled, bot_state histogram, and the blocked list GROUPED BY
bot_state_reason with counts. I expect a large blocked set on the first pass —
that is the output I want, not a failure.

## V2 — SPLIT THE BLOCKERS

For each blocked reason group, say which of these it is:
  (a) missing menu DATA -> needs an owner answer (list the questions, batched)
  (b) compiler gap -> the data is there and the compiler did not use it
  (c) genuinely not orderable (display_only, discontinued)
Fix (b). Do not guess at (a) — no invented shop policy.

## V3 — GATE BEFORE FLIP

Walk Vito's compiled data with the compiled engine enabled in a NON-LIVE
context. Single-item and multi-item. Report pass rate on the orderable
fraction.

## V4 — FLIP, THEN CANARY

Only after V3 passes, set compiled_ordering_engine_enabled = true for Vito's,
deploy, and re-run the canary BY HAND:
```
cheeseburger / medium / thats it
-> one line, Temp: Medium, $8.49 + $0.99 = $9.48
```
Read the total from the cart or a read-only receipt, not the checkout reply.

## HARD CONSTRAINT

Vito's is the demo shop and the canary. If the compiled path changes the canary
total, the line count, or the recap rendering in ANY way, STOP at V3 and report.
Do not flip. A canary regression outranks this whole spec.

## REPORTING

Reply to po-inbox after V1 with the blocked histogram before starting V2. I want
to see the shape of the blocked set before you start fixing it.

Phase 2 (the reply inversion spec, naming which guards die) will be written
against V1's output — which guards can retire depends on what the compiled path
actually covers on Vito's.
