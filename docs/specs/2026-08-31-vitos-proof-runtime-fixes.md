# Spec: Vito's Proof runtime fixes — checkout truthfulness, cart-drop, same-name matcher

**Date:** 2026-08-31 (deadline — one consolidated pass)
**Owner:** Lead → John Walsh (build) → Melvin (FULL Proof verify)
**Evidence:** Proof run test_runs.id dc98e3dd on Vito's QA shop (22ed2761-a3f2-5bde-9012-916a93c521cd) = 82.03% (105/128). Bug list pulled from the run's own critical_failures, NOT disk logs (disk proof-*.log are stale/other-shop — do NOT trust them).

All code changes in `supabase/functions/chat-sms/index.ts` unless noted.

## Fix 1 — Bot must never claim an order/checkout that didn't happen (HIGHEST PRIORITY)

**Symptom:** cases proof-checkout-writes-order, proof-cart-persists-across-multiple — bot tells the customer "payment link sent / order placed" when has_real_checkout_session=false. No real Stripe/checkout session exists. It lies about taking the order.

**Fix (deterministic gate):** The bot may state "order placed / payment link sent / here's your link" ONLY when the checkout/submit_order tool actually returned a real session (real session id + payment URL). If no real session was created, a post-response guard must block/replace any success/link claim. Success text is gated on the tool result, never on LLM narration. The payment link itself should be emitted deterministically by code from the real session URL, not typed by the model.

**Acceptance:** In any case where no checkout session was created, the bot's reply contains no claim that the order was placed or a link was sent. When a session IS created, the real link is present.

## Fix 2 — Multi-item never drops an item; checkout completes on request

**Symptom:** menu-two-7 — "Shrimp Scampi and a Pierogie" → only Pierogie in cart, bot quotes $13.94 (half the order). Also a Gyro checkout: after the customer says "checkout", bot asks "what else can I add?" and never finishes. b86a86d (pending_options) shipped but did not fully hold live.

**Fix:**
- Ensure `add_item` is invoked for EVERY item the customer names in a message, even when a required option is still unknown (reinforce the ~line 566 rule AND confirm the item-name→menu-row matcher resolves each named item — a drop can be the matcher failing to resolve item #2, not just the prompt).
- When the customer signals completion ("checkout", "that's it", "done"), proceed deterministically toward submit_order. If items have unresolved required options, ask once for each remaining option then continue — do NOT re-loop into open-ended "what else can I add?".

**Acceptance:** menu-two-7 → both items in cart_json, correct total. A "checkout" request with a pending option resolves the option and completes; never loops.

## Fix 3 — Same-name items disambiguated in code (fold in; generalizes)

**Symptom:** menu-single-509 — Vito's menu has two "Tuna" rows (Salads $11.95 id 1125dcac; Wraps $9.99 id 98ce60f5). `buildMenuItemNames()` (~line 1671) blindly overwrites duplicate canonical name keys; the system-prompt menu block (~line 471) omits category, so "I'd like a Tuna" is a coin flip.

**Fix:** When a base item name is duplicated across rows, make it category-qualified in BOTH the name map (~1671) and the prompt menu lines (~471) so the model/matcher can distinguish (e.g. "Tuna (Salad)" vs "Tuna (Wrap)"). When a customer's phrase maps to multiple rows, the bot asks which rather than guessing. Do NOT edit menu data — this is shared code, fixes every shop. NOTE: the two "Gyro (Beef or Chicken)" rows ($14.99 Salad vs $10.99 Hot Sandwich) are legitimately different items and this same fix disambiguates them.

**Acceptance:** "Tuna" order resolves to the correct row or the bot asks which; no invented "Tuna Salad".

## Out of scope / test fixes (do not change product code)
- menu-single-520 ("Ranch" offered as a pizza): Ranch is a free modifier, not an orderable item. This is a BAD TEST case — fix or remove it in the test generator/library, not chat-sms.
- menu-single-508 (Mussels $22.99): transient LLM miss; unique-name item exists. Leave; re-run should clear.
- proof-hallucination-mid-order: scorer false-positive (judge text says the total is correct). Note for scorer triage.

## Definition of done
- Fixes 1–3 implemented in chat-sms; test 520 corrected in the suite.
- Melvin runs the FULL Proof suite (all cases, not target cases) and reports the number + any new regression.
- Deploy chat-sms; autonomous Proof re-run on Vito's QA confirms the number. Target: fake-checkout and cart-drop classes cleared; overall materially above 82% with no new critical regressions.
