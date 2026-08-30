# Spec: Finish it — checkout completion driver + conversational cart-state + suite cleanup

**Date:** 2026-08-29
**Owner:** John Walsh (build) → Melvin (verify) → 3× full-suite stability run
**Origin:** Aug 28 run on frozen scorer v1 = 104/122 (85.2%). Deterministic cart math is holding (cart-ops 76%→~100%, the $27→$44 class is dead). Remaining 9 real failures are conversational, in 3 classes. Jason: "finish it, then test it three times."

## The 3 remaining real classes (from triaged Aug 28 run)
1. **Checkout won't finalize** — bot takes the order, then loops "what else?" or keeps re-asking pickup/delivery even after the customer says "checkout" and gives a name. The C1 gate BLOCKS a bad submit but nothing DRIVES completion. This is the whole job — an order that never closes.
2. **Cart resets mid-conversation** — in free-form multi-turn the cart still wipes to one item. The deterministic guard fixed structured mutation cases, not the conversational path.
3. **Menu hallucination/miss** — invented "Shrimp Francese," missed real "Pierogies." Model/retrieval quality.

## North-star + scale check
An order that doesn't close is a lost customer and a support ticket — the opposite of self-serve. Fixes must be GENERAL (any shop, any menu), no per-shop code.

## Pre-mortem (why this fails → mitigation)
1. **Deploy drift** — prod chat-sms newer than git. → Diff live vs git before editing; validate against live schema; re-test the real SMS/browser path after deploy. (memory: edge-function-deploy-drift.)
2. **A completion driver that submits too eagerly** — auto-submits before the cart/mode/name are truly ready, charging a wrong or partial order. → Completion only fires when ALL of: cart non-empty, mode ∈ {pickup,delivery}, name present, AND an explicit customer checkout intent. Server recompute + C1 guard still gate the actual submit.
3. **Conversational cart guard over-suppresses** — blocks a legitimate clear/restart. → Only suppress clear_cart when an add_item/keep-intent exists in the same turn; explicit "start over"/"cancel everything" still clears.
4. **Class 3 is model-quality, may not fully close deterministically** — → Harden retrieval (ground strictly to this shop's menu; refuse/deny items not in menu instead of inventing) but do NOT claim 100%; report residual honestly.
5. **Nondeterminism hides regressions** — one run looks clean by luck. → That's why we run 3×; report all three + variance, not a single number.

## Workstreams
### D — Checkout completion driver (product: chat-sms)
- **D1.** When cart non-empty + mode set + name set + customer signals checkout ("checkout"/"yes"/"that's it"/"done"/"pay"), deterministically transition to submit_order and create the REAL Stripe session. No "what else?" loop after a checkout signal.
- **D2.** Kill the pickup/delivery re-ask loop: once mode is captured, never re-ask it. If mode is the only missing slot, ask once, accept the answer, advance.
- **D3.** Keep C1 (no phantom "payment link sent" without a real session) — completion must produce a real session, not a claim.

### E — Conversational cart-state persistence (product: chat-sms)
- **E1.** Extend the B2/B3 add-vs-clear guard to the free-form conversational path, not just structured mutation turns. Adding an item mid-conversation must never wipe existing items; corrections mutate qty without zeroing.

### F — Menu retrieval hardening (product: chat-sms) — best-effort, not gated to 100%
- **F1.** Ground item lookup strictly to this shop's menu. If an item isn't on the menu, decline honestly ("we don't have X") — never invent a plausible-sounding item (no "Shrimp Francese"). Improve recall on real items (e.g. "Pierogies") via better matching. Report residual miss rate honestly.

### G — Suite cleanup (harness / repo hygiene)
- **G1.** Fix bad fixtures: cases that order bagels/turkey club against an Italian pizzeria — the bot correctly declines, test marks fail. Make these fixtures shop-appropriate or assert the correct decline behavior as PASS.
- **G2.** Kill residual scorer noise: self-negating math flags ("total wrong… which is correct") and the clean-cart miscount. Invariant stays authoritative over the LLM judge on arithmetic (extends A1).
- **G3.** Commit the pending `judge-rubric.ts` change (hours-window array normalization — defensive, low-risk) after Melvin confirms it's safe. Don't let it drift.
- **G4.** Clear the deterministic-checkout-guards spec from spec-inbox (code shipped) — note it done.

## Definition of Done
1. D, E, G implemented; F attempted. Deployed to prod chat-sms (drift-checked first). judge-rubric.ts committed.
2. Melvin verifies against acceptance + no regression on the 104 currently-passing.
3. **Run the full 122 THREE times** on Zio's against the final build. Auto-triage each. Report all 3 scores, the variance, which classes closed, and honest residual (expect class-3 retrieval to be the main remainder).
4. Success = checkout-completion and conversational-cart cases flip green and STAY green across all 3 runs (deterministic, not lucky).
