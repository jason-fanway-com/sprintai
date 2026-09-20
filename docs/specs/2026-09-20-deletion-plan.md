# Old-engine deletion plan (Phase 4)

2026-09-20 · derived from an import-graph audit of `supabase/functions/chat-sms/` at commit 69fc542b.

## Result
After every shop runs `clean_engine_enabled`, **37 files and about 7,400 lines of index.ts** have no
surviving production importer. The new engine (`engine/*`) imports nothing from the legacy tree.

## Keep
- `engine/*` (15 files), `index.ts` (trimmed to ~3,000 lines of transport), `checkout-session.ts`
- `itemizer.ts`, `money-footer-20260909.ts`, `cart.ts`, `cart-summary-intent-20260909.ts` **only while**
  the pre-branch `cart.phase === "checkout"` block (index.ts ~5936–6093) exists. Gate or port that
  block and these four go too.
- `slash-shorthand-normalize-20260916.ts`, `delivery-memory-offer.ts` (pre-branch plumbing)
- `pricing.ts` has no live consumer after deletion; keep as a utility or drop.

## Delete (leaf-first order)
1. `propose.ts`, `turn-engine-runner.ts`
2. index.ts legacy region + move `CompiledCartLine` type into `checkout-session.ts`
3. `confirm-readback-20260918.ts`, `action-confirmation.ts`, `turn-engine.ts`
4. `ask-plan-engine.ts`, `turn-reconciler.ts`, `resolve-item.ts`, `phrase-split.ts`
5. the rest: `pending-disambiguation.ts`, `pending-option.ts`, `dialogue-signals.ts`, `intent-router.ts`,
   `checkout-intent-gate-20260913.ts`, `upsell-offer-20260914.ts`, `reactive-modifier-match.ts`,
   `sequencer.ts`, `candidate-list.ts`, `option-removal-20260909.ts`, `pizza-topping-compose.ts`,
   `pending-question-followthrough.ts`, `unresolved-item-segment-guard.ts`,
   `enumeration-shortfall-retry.ts`, `stated-attribute-carryforward.ts`, `zero-option-attribute-hint.ts`,
   `invented-action-guard.ts`, `regular-offer-modifier-20260912.ts`, all `guard*.ts`,
   `answer-interpreter.ts` (already dead), `chat-sms-mtest/` (stale fork)

## index.ts ranges that die
ORDERING_TOOLS 538–681 · buildSystemPrompt V1/V2 893–1701 · executeTool 1716–3085 · saveCart 3087–3143 ·
runOrderingLoop 3145–3591 · reply post-processing 3593–4124 (except `stripEmDashes`, used by sendSms) ·
appendEngineCheckoutLinkIfReady 156–242 · turn_engine_enabled branch 6384–6440 · legacy body and guard
gauntlet 6441–10349 · FIX C / GUARD 22 10394–10450 · ~40 imports.

## Must survive
STOP/HELP/START handling, `handleSystemEvent` (payment_confirmed → ticket email), sendSms stack and
segmentation, conversation lookup and turn lock (+ its `finally`), cart find-or-create, expiry reset,
hours/closed gates, delivery pause, history load, compliance disclosure helper, `stripEmDashes`.

## Cross-dependencies to fix first
- `checkout-session.ts` imports `TurnEngineCartLine` from `turn-engine.ts` → inline the type.
- `_shared/menu-readiness.ts` imports four legacy modules and has no production consumer → delete with its test.
- `_shared/compile-menu.test.ts` imports `resolve-item.ts` → drop those assertions.

## Live conflict found (fix before deletion, independent of it)
The `cart.phase === "checkout"` block runs **before** the clean-engine branch. `createCheckoutSession`
writes `phase: "checkout"`, so on a clean-engine shop the customer's next message after a payment
link enters that block, and its `wantsChange` path calls `executeTool("add_item")` and writes
`cart_json` directly, bypassing `engine_form`. Gate it on `!shop.clean_engine_enabled`.

## Tests
About 135 of 158 root test files import deleted modules or scan deleted index.ts text; they go with
them. Keep the ~20 that test transport (SMS splitting, hours, expiry, delivery offer, itemizer, cart,
pricing, slash shorthand). Re-point `enforce-single-cart-writer.test.ts` at `engine/project.ts`.
