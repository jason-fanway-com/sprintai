# Spec: Deterministic cart + checkout state machine + scorer freeze

**Date:** 2026-08-28
**Owner:** John Walsh (build) → Melvin (verify)
**Origin:** Aug 27 Zio's run = 108/122 (88.5%). Triage of 14 failures = 4 scorer-noise, 10 real, clustered into 5 recurring classes. Root problem: we keep fixing the scorer mid-flight, so the number never stabilizes. Fix the product deterministically AND freeze the scorer in one pass.

## North-star check
Cart accuracy and checkout completion are existential (the $27.24→$44.49 incident). Every fix here must be GENERAL — works for restaurant #1 and #10,000, no per-shop code. Making totals deterministic removes a whole class of support tickets = advances minimal-manual-intervention.

## Pre-mortem (why this fails, mitigations)
1. **Edge-function deploy drift** — prod chat-sms may be newer than git; deploying stale silently regresses. → Diff live deployed version vs git BEFORE editing; validate columns vs live schema; re-test browser path after deploy. See memory `edge-function-deploy-drift`.
2. **Fixing scorer changes the baseline again** — → After this pass, TAG the scorer version and do not touch harness scoring logic again without an explicit note. Freeze = locked.
3. **Deterministic total diverges from what the bot SAYS** — bot prose quotes one number, server computes another. → Bot must NEVER emit a computed total in prose; it renders the server-computed `quoted_total_cents` verbatim. Single source of truth.
4. **State machine over-rigid, breaks natural conversation** — → Slot-fill only gates the checkout transition, not ordering. Customer can still add/modify freely; the machine only blocks submit_order until mode+name known.
5. **Regression in passing cases** — 108 currently pass. → Melvin re-runs the full 122 after; net pass count must be ≥ 108 with the 10 real bugs' cases now passing. No previously-green case may go red.

## Workstream A — Scorer freeze (harness, `scripts/test-suite/`)
Fix the 4 false-failure sources, then lock.
- **A1.** Investigate WHY cartops-add-single / reduce-qty / empty-cart-no-total flagged `wrong_total` when the totals were arithmetically correct ($7.99+$0.99=$8.98). Invariant #1 already adds 99 — so the false positive is coming from the LLM judge's `wrong_total` flag OR the quoted-amount extraction, NOT invariant #1. Find the real source. Make the programmatic invariant authoritative for totals; the LLM judge must NOT be able to fail a case on arithmetic the invariant already passed.
- **A2.** `conv-off-menu-declined` expects the bot to suggest bagels/sandwiches at an Italian pizzeria — a bad test expectation copied from a bagel-shop fixture. Fix the generated case's success criteria so declining an off-menu item correctly and offering on-menu alternatives PASSES.
- **A3.** After A1–A2, add a `SCORER_VERSION` constant (bump it) and a one-line note in RUNBOOK: scorer is frozen at this version; do not change scoring logic without recording why.

**A acceptance:** the 4 noise cases (add-single, reduce-qty, empty-cart-no-total, off-menu-declined) pass on correct bot behavior; no scoring-logic change silently flips other cases.

## Workstream B — Deterministic cart + total (product, `supabase/functions/chat-sms`)
cart_json is the single source of truth. Server computes the total. Bot renders it, never calculates it.
- **B1.** Total shown to customer = server-computed from cart_json (`cartSubtotal + 99 service fee + delivery_fee + driver_tip`). Bot's prose must interpolate this server value, not do its own math. Kills class 5 (math error: used $8.99 for a $7.99 item → $24.96 vs correct $23.96).
- **B2.** "also add X" / "add another X" = ADD, never REPLACE. Adding item B when cart has item A must yield {A, B}, not {B}. Fixes `cartops-add-then-add` (lost Mac & Cheese Bites) and `conv-group-order` (cart reset on correction).
- **B3.** A correction ("make it 1") mutates quantity in cart_json; it must not zero the cart. Fixes `conv-group-order` reset.

**B acceptance:** cartops-add-then-add, conv-group-order, menu-combo pass; server total always equals invariant-computed total; no bot-authored arithmetic in outbound prose.

## Workstream C — Checkout state machine (product, `supabase/functions/chat-sms`)
- **C1.** Deterministic slot-fill before `submit_order`: require `fulfillment_mode` (pickup|delivery) and `customer_name`. Accept "yes"/"checkout"/"pickup"/"delivery" as valid mode answers; never dead-end re-asking the same question. Fixes `menu-checkout-12` and `conv-pickup-only-clarification`.
- **C2.** Only emit "Payment link sent!" (or any link-sent claim) when a real Stripe checkout session was actually created (`has_real_checkout_session = true`). No phantom confirmations. Fixes `cartops-full-order-corrections`.

**C acceptance:** menu-checkout-12, conv-pickup-only-clarification, cartops-full-order-corrections pass; bot never claims a payment link without a real session; confirmed cart + name + mode always reaches submit_order.

## Out of scope this pass
- Class 4 (menu retrieval / hallucinated items: conv-upsell-accepted, menu-single-515, conv-why-expensive, menu-cat-appetizers stall). These are model/retrieval quality, not deterministic logic. Note them; do not force this round.

## Definition of Done
1. A, B, C implemented; deployed to prod edge functions (validate no deploy drift first).
2. Melvin re-runs the full 122 on Zio's. Net pass ≥ 108 AND the named cases in A/B/C acceptance now pass. No previously-green case regresses.
3. Scorer tagged/frozen; RUNBOOK note added.
4. Report: before/after pass count, which acceptance cases flipped green, any residual real failures (expected: the ~4 class-4 retrieval cases).
