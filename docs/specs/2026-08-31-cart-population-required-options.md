# Spec: Cart-population fix — never drop items with required options

**Date:** 2026-08-31
**Owner:** Lead → John Walsh (build) → Melvin (verify)
**Origin:** Proof run b354c271 on Vito's Pizza (QA), 85.2%. Diagnosis = Bug A (cart-population).

## Problem

When a customer names multiple items in one message and an item has a REQUIRED option
(Gyro → beef/chicken, Shrimp Scampi → pasta), the bot clarifies one item and **silently
drops the others**. Cart ends up missing items; stated total is correct for the wrong cart.

Root cause: system prompt rule at `supabase/functions/chat-sms/index.ts:565` tells the bot
to withhold an item until it has collected the required option. On multi-item messages the
withheld item is never submitted to `add_item` at all — so it never enters cart_json.

Evidence (run b354c271):
- menu-two-7: "Shrimp Scampi and a Pierogie" → cart = Pierogie only ($12.95). Scampi absent.
- menu-three-8: cart = Cheese + Cali Fries; Shrimp Fra Diavolo absent.
- menu-checkout-13/14: bot loops on clarification; item never lands; checkout impossible.

## Why prompt-only is not enough

A prompt rule that says "don't drop items" still relies on the LLM obeying probabilistically
— the exact class of failure Proof exists to eliminate. Fix must be structural, not just
instructional.

## The fix — two layers

**Layer 1 — prompt (`chat-sms/index.ts:565` area):** On any message, the bot must call
`add_item` for EVERY item it recognizes, immediately, even when a required option is not yet
known. Then ask about the missing option(s) in the same reply. Never withhold submission
pending an option.

**Layer 2 — `add_item` handler:** Accept an item whose required option is unset. Store it in
cart with the option marked pending (e.g. `pending_options: ["meat"]` or a `needs_option`
flag). Do not reject. Price uses the base; option surcharge applies once chosen. The item is
in cart_json from the moment it is submitted, independent of what the LLM says next.

**Checkout (menu-checkout-13/14):** With pending-option items in cart, a "checkout" request
must NOT loop. Deterministically enumerate outstanding required options, ask once for each,
and once resolved proceed to checkout. Never infinite-clarify.

## Acceptance criteria (Melvin verifies)

1. Two-item message, one/both needing required options → cart_json contains ALL ordered items.
2. Bot asks for each missing option; the affected item stays in cart while pending.
3. Stated total reflects all items once options are chosen; matches deterministic footer.
4. Checkout with a pending option resolves the option without looping, then completes.
5. Re-run Proof cases menu-two-*, menu-three-*, menu-checkout-13/14 → PASS.
6. No regression: single-item orders and previously-passing cases still pass.
7. Shared code only — no per-shop / per-menu special casing.

## Definition of done

- Layers 1+2 implemented; checkout loop fixed.
- Melvin confirms all 7 criteria.
- Full Proof re-run on Vito's QA shows the four named cases green and overall ≥ prior 85.2%
  with the required-option class cleared (target: near-100%, no new regressions).
