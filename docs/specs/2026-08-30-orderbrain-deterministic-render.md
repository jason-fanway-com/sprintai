# Spec: OrderBrain deterministic render — retire the guard zoo

**Date:** 2026-08-30
**Author:** SprintAI_bot (lead)
**Status:** Approved by Jason ("do it the right way"), ready to build after commit of proof_p1_falsepos_fix
**Owns:** `supabase/functions/chat-sms/index.ts`, `scripts/test-suite/cart-ops.ts`

## Problem

Reliability of the money/menu surface is currently enforced by ~6 overlapping
regex guards over free-form LLM prose, plus a separate regex grader in the test
suite. Regex over prose fails both ways:

- **False positives** (breaking good replies / failing good runs). The Proof
  grader `verifyHallucinationGuard` (cart-ops.ts L288) matches
  `([A-Z][A-Za-z\s'&-]{3,40})(?:\s+\$?\d+...)` — ANY capitalized phrase before a
  price — then requires an EXACT menu-name match (`===`). So "Your total is
  $8.99", "I've got 2 items in your cart", "Today's hours are ..." all read as
  invented menu items. This is the 18-case failure on the 2026-08-30 Proof run.
- **Coverage gaps** in the same regexes (missed phrasings).

Production side, the same fragility lives in F1 `claimsOffMenuItem`,
`claimsItemInCart` (1c), `offersUngroundedUpgrade` (1e),
`claimsAddedWithoutMutation` (3b), the empty-cart `claimsTotal`, and the new
Proof P3 scrubber — each a regex second-guessing the model's prose.

This is exactly the string-matching the OrderBrain design (Host proposes, Ledger
decides) exists to eliminate. Narrowing one regex is a patch. The right fix is
to make the money and status lines **code-rendered from Ledger truth** so there
is nothing for a scrubber to get wrong, and to ground menu claims at the
**action layer**, not in prose.

## Principle

- **Host (LLM)** = understand + converse. Proposes structured actions. Speaks
  conversational glue only.
- **Ledger (code)** = single source of truth. Owns cart contents, subtotal,
  fee, total, item count, checkout/payment status, hours, location. Renders
  those lines itself. Validates every proposed action against the menu.
- The customer never sees a number or an item name the Ledger did not produce.

## Phase A — deterministic render + collapse the grader (fixes the 18)

### A1. Code-render the money/status lines
When a reply needs to state any of: cart total, subtotal, service fee, line
price, item count, "payment link sent"/checkout status, hours, or location —
that text is composed by code from Ledger state and appended, not emitted
free-form by the LLM. The model may still say "Anything else?" etc.
- Acceptance: for a cart of known contents, the total/subtotal/fee/count strings
  in the reply are byte-for-byte what a pure Ledger render function produces.

### A2. Rewrite `verifyHallucinationGuard` to check reply vs Ledger truth
Stop flagging capitalized-word-before-price. New logic:
- Ignore boilerplate line shapes: total / subtotal / fee / tip / item count /
  hours / location / payment-status / greeting.
- Any dollar figure in the reply must equal a Ledger-derived figure
  (total, subtotal, fee, or a line price for a cart/menu item). A figure the
  Ledger didn't produce → fail.
- Flag an item token only when it is positioned as an item ("added X",
  "your X", "we have X", "one X") AND fails a menu **lookup** (normalized
  substring/fuzzy match against menu + cart names), never `===`.
- Acceptance: all 18 boilerplate cases from the 2026-08-30 run pass; a genuinely
  invented item ("pterodactyl wing") in a reply still fails.

### A3. Green gate
- Acceptance: Proof against NJB — 0 hallucination-guard failures on the
  deterministic (non-conversational) set. Remaining reds, if any, are the 500
  (owned by proof_p1_falsepos_fix) or newly-surfaced real bugs, reported, not
  hidden.

## Phase B — action-layer menu grounding + retire redundant guards

### B1. Ground menu claims at the action layer
The LLM proposes `add_item`/`modify_item` with an item id/name. The Ledger
validates against the effective menu and rejects unknowns; a rejected add never
enters the cart, and the confirmation is code-rendered from what was actually
accepted. "Invented item" cannot reach the customer as a real add.
- Acceptance: an add for an off-menu item is rejected at the action layer, cart
  unchanged, reply does not claim it was added — with NO prose regex involved.

### B2. Retire the guard zoo
Once A1+B1 hold, remove or reduce to a single thin defense-in-depth assertion:
F1 `claimsOffMenuItem`, Proof P3 scrubber, `claimsItemInCart`,
`offersUngroundedUpgrade`, `claimsAddedWithoutMutation`, empty-cart `claimsTotal`.
Each removal must be justified by a deterministic mechanism that now covers it.
- Acceptance: guard count drops materially; Proof stays green; no reply-mangling
  scrubber remains on the money/status path.

## Pre-mortem

1. **Rendering changes tone / breaks friendliness.** Mitigation: code renders
   only the factual lines; the LLM keeps the warm framing around them. QA a
   sample of replies for voice, not just correctness.
2. **A1 regresses existing passing cases.** Mitigation: Melvin QA + full Proof
   re-run before deploy; diff reply text on the previously-green cases.
3. **B2 removes a guard that was catching something real.** Mitigation: remove
   one at a time, each behind a Proof case proving the deterministic path covers
   it. Do not bulk-delete.
4. **Scope creep into a rewrite.** Mitigation: Phase A is the gate to green and
   ships first; Phase B follows as its own commit.

## Sequencing

Phase A and the in-flight `proof_p1_falsepos_fix` (500 + sim key) both touch
chat-sms — do NOT run in parallel. Order: let proof_p1_falsepos_fix commit →
build Phase A → Melvin → deploy → Proof re-run → then Phase B.
