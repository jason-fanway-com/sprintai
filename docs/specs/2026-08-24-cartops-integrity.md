# Spec: CartOps integrity — cart is the single source of truth

**Owner:** SprintAI_bot → John Walsh → Melvin
**Date:** 2026-08-24
**Approved direction (Jason):** restore correct cart behavior, no more prompt patches, add the checkout backstop, add an adversarial CartOps test battery. This spec is the precise version after orientation.

## Findings (ground truth from code)
- Checkout (submit_order, chat-sms/index.ts ~L728–821) already builds the Stripe amount from `cart_json` line items + fee + delivery + tip. **The charge already equals the real cart.** The backstop largely exists — confirm + comment it, don't rebuild.
- `set_driver_tip` (L1086–1088) only writes `driver_tip_cents` — it does NOT touch items. So the tip→quantity duplication comes from the LLM spuriously calling `add_item` (and dedup then merging to qty 2) on the tip-reply turn.
- The corrected early-gate (capture item + ask pickup/delivery in same turn) is ALREADY in the working tree (L547). Keep it.
- Verified-good delivery zone check + coords gate are committed (36cc5e9, a7c70fd). Keep them.

## The defects to fix (all global, in supabase/functions/chat-sms/index.ts)

1. **Tip turn must never mutate items.** Root-cause the tool calls on a bare-amount tip reply. Deterministic guard: when the previous assistant turn offered a driver tip AND the user's message is essentially a bare tip amount ($1/$2/$3/$5 or "no tip"), route to `set_driver_tip` (or none) and SUPPRESS/ignore any `add_item` in that same turn. More generally: `add_item` for a menu_item already present must only increase quantity when the user's message explicitly asks for more ("another", "two of them", "make it 2"); it must never silently increment as a side effect of an unrelated turn.

2. **Corrections must write back to cart_json.** "just want one" / "make it one" / "remove one" / "just X" must call a real quantity/remove tool that updates `cart_json` AND persists (order_carts.update) BEFORE any summary is shown. Verify the existing "just one" detector actually mutates and persists — Melvin saw it NOT change cart_json.

3. **Displayed numbers must mirror cart_json.** Every quoted total and item summary must be computed from `cart_json` (subtotal + $0.99 service fee + delivery fee + tip). Fix the hallucinated-total guard math (Melvin saw quoted $29.24 vs DB $26.25 — a components error). The bot may never state a total or line set that differs from the real cart.

4. **Confirm + harden the checkout backstop.** submit_order must compute the Stripe amount solely from `cart_json` (+fee/delivery/tip) — it does today; add an explicit comment marking it the invariant, and ensure no path lets an LLM-provided number reach Stripe.

## Invariants (must hold — become the test gate)
- quoted_total == charged_total == sum(cart_json line totals) + service_fee + delivery_fee + driver_tip
- every line the bot displays exists in cart_json with the same qty
- no item quantity changes on a turn whose user message is a tip/name/question (non-item intent)
- a correction that reduces/removes must be reflected in cart_json before the next reply
- no duplicate lines for the same menu_item_id + modifiers (merge to one line/qty)

## Test battery (scripts/test-suite/)
Add an adversarial **CartOps** battery: LLM-designed mutation sequences — add, add-another, remove, change qty, add tip, "just one", re-add, swap item, cancel mid-order, interrupt-with-question-then-order — each asserting the invariants above by reading cart_json + the computed checkout amount. Criticality = critical; **CartOps gate requires 100%**. Wire into run.ts/library.ts so it runs per shop.

## Acceptance (Melvin, live on Zio's — delivery)
Replay Jason's exact flow: pizza → nea → "$2" tip (cart stays 1x, tip=200) → wings → "just want one" (cart_json ACTUALLY = 1 pizza) → name → submit. ASSERT: pay-link/checkout amount == last quoted total == cart_json total. Plus a clean correction test (order 2, "just want one", cart_json→1). Plus re-run full Zio readiness (was 82%) and the new CartOps battery at 100%.

## Out of scope
- Full LLM-intent/code-state refactor beyond the above (the architecture audit covers the longer-term shape). Keep this change surgical + global.
