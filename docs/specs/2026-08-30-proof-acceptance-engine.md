# Proof — Per-Shop Deterministic Acceptance Engine

**Owner:** SprintAI lead (Opus). **Builder:** John Walsh. **QA:** Melvin.
**Date:** 2026-08-30. **Status:** Phase 1 spec — build now.

## What Proof is (product-within-the-product)

Proof is the pre-launch guarantee. It runs a battery of real order conversations
against a shop's OWN menu, grades them **deterministically** (server cart_json =
source of truth; code checks every total, every checkout, every menu item — NO LLM
grading an LLM), and emits a pass/fail report. **100% or the shop does not go live.**

An owner "gets Proofed" before launch and can show the report to feel confident
putting the bot in front of their customers.

## Why (the problem this kills)

Today the go-live signal is an LLM-judged 122-case run: the bot is probabilistic AND
the judge is probabilistic, so the score moves on its own and can never be a real
gate. Meanwhile real money-path bugs (wrong total, checkout won't finalize, cart
resets, hallucinated menu item) are the only things that actually matter to an owner.
Proof makes the money paths deterministic and grades them deterministically.

## Architecture principle (non-negotiable)

Push determinism OUT of the LLM. The model handles conversation only. These are
CODE, never LLM judgment:
- Cart state: `cart_json` is the single source of truth.
- Totals: server code renders subtotal + $0.99 fee + delivery + tip. Never the model.
- Checkout finalize: server recomputes total at checkout; must match quoted.
- Menu: bot may only reference items in the shop's menu (fixed list); no invented items.
- Tenant isolation: a case for shop A never sees shop B data.

## Phase 1 — Deterministic gate engine (build now)

Build on existing pieces: `scripts/test-suite/cart-ops.ts`
(`verifyCartOpsInvariants`, `verifyStatedTotal`, `buildCartOpsCases`),
`generator.ts` (`generateCases`), `run.ts`, `quick.ts`.

### 1. Harden the harness (root cause of the 52-min hang)
- Every edge-fn call and every network call in `runner.ts` / `run.ts` wraps in a
  timeout (default 30s/turn, configurable) + 2 retries with backoff.
- On timeout after retries: mark that case FAILED with reason `harness-timeout`,
  log it, and CONTINUE — never hang the whole run.
- Print a heartbeat line every N cases so a stall is visible immediately.

### 2. Deterministic acceptance battery (the Proof gate)
- New entrypoint `scripts/test-suite/proof.ts <shop_id>`.
- Generates cases from the shop's real menu covering: single item, multi-item,
  add/remove/reduce, modifiers, cancel+reorder, no-mutate turns, checkout finalize,
  closed-hours, off-menu request (must decline, no invented item).
- Grades EVERY case with deterministic invariants only (extend `cart-ops.ts`):
  - quoted_total == server-computed subtotal + $0.99 + delivery + tip (0c tolerance).
  - Checkout finalize: an `orders` row is written and its total == last quoted total.
  - Every item the bot names in its summary exists in `cart_json` at same qty.
  - No menu item referenced that isn't in the shop menu (hallucination guard).
  - No cross-tenant data.
- NO LLM judge in the Proof gate path. Exit 0 iff 100% pass.

### 3. Close the 3 open classes as deterministic guards (code, not prompt)
For each, add the server-side guard AND a Proof case that locks it:
- **Checkout won't finalize:** ensure the finalize path always writes the order and
  returns the confirmed total; add case that asserts the `orders` row.
- **Cart resets mid-conversation:** ensure `cart_json` persists across turns; add case
  that orders, does a no-mutate turn (name/question), then verifies cart intact.
- **Menu hallucination:** constrain bot output to the menu list; add case that requests
  an off-menu item and asserts the bot declines with no invented line.

## Acceptance criteria (Melvin verifies)
1. `proof.ts <shop_id>` runs end-to-end against live TEST edge fn, never hangs, prints
   a per-case result and a final `PROOF: N/N pass` line, exit 0 on all-pass.
2. Induce a timeout (bad URL) → run still completes, that case marked
   `harness-timeout`, others unaffected.
3. All 3 open classes have a passing deterministic case AND a code guard; removing the
   guard makes the case fail (guard actually does the work).
4. No LLM judge call in the Proof gate path (grep clean).
5. Runs green against NJB test clone `38ae034c-cb9d-4f32-b4f1-d9b40393574b`.

## Out of scope (Phase 2, separate spec)
Owner-facing Proof report surface (the readable/showable artifact), onboarding
integration, per-shop scheduling. Phase 1 is the engine + gate + guards only.
