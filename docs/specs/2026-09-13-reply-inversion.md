# Phase 2 — Reply inversion: code renders cart facts, the model adds voice

**Status:** NEXT. Not queued behind anything.
**Requested by:** Jason, 2026-09-11, first message of the engagement. Spec'd
2026-09-13 after the PO deferred it three times while it produced
customer-visible defects.

## Why now

2026-09-13 19:07, Vito's, live, +16102565023:

> **YOU:** Add a large plain pizza
> **BOT:** Got it, adding a large plain cheese pizza. I've got your items: large
> cheese pepperoni pizza, french fries, and a large plain cheese pizza. Confirm?
> Subtotal: $25.99 Service fee: $0.99 Total: $26.98

The cart held **two** lines. The model authored a sentence listing three items
and the system shipped it. The arithmetic was consistent with the cart, so no
guard caught it: the customer pays for two and believes he ordered three.

This is not a new class. It is the same one the write-side inversion closed for
cart state, still open for cart *claims*.

## The rule

> **Any sentence that asserts cart contents, quantities, prices or totals is
> rendered by code from `cart_json`. The model may add warmth around it. It may
> not author it.**

Not "the model is checked". Not "a guard greps it". The model is never the
source of a cart fact.

## Current shape (measured 2026-09-13)

- `index.ts` has **48** `reply = ` assignments
- **32** distinct guards, most of which exist to audit model prose
- **14** call sites already do the right thing via `renderItemizedRecap(...)`

So the pattern is already established and proven in 14 places. This is
extending it, not inventing it.

## The work

1. **Classify every `reply = ` site** into:
   - **FACT** — asserts items/quantities/prices/totals → must render from cart
   - **VOICE** — greeting, apology, clarifying question, warmth → model may author
   - **MIXED** — split it; the fact half renders, the voice half doesn't
   Produce the table before changing code.

2. **One renderer owns cart facts.** Extend `renderItemizedRecap` /
   `renderLedgerFooter` into the single path for any item enumeration. A reply
   that needs to say what is in the cart calls it. There is no second way.

3. **The model loses the vocabulary.** Today's prompt tells it *not* to state
   totals (`MONEY/SCOPE RULE`, index.ts:936/1307) and it complies on money —
   that rule works. Extend the same treatment to item enumeration: the model is
   told to say "I've got your items" and never to list them. Code appends the
   list.

4. **Retire what becomes unreachable.** GUARD 1c (cart-content hallucination),
   1d (phantom add), 1f (narrated correction), 1g (menu-item hallucination) all
   exist to catch the model lying about cart contents. When the model cannot
   author a cart claim, they have nothing to catch. Delete them — do not leave
   them as belt-and-braces. Every guard retired is a measurable outcome:
   **32 guards and 48 `reply =` sites are the baseline; both must fall.**

5. **Enforcement.** A test that fails if a reply-producing branch interpolates a
   cart item name or a price without going through the renderer. Same shape as
   `enforce-single-cart-writer.test.ts`, which works.

## Non-negotiables

- **The money footer stays.** It is code-rendered already and it is the only
  thing telling the customer what they owe.
- **Do not weaken `enforceVerbatimStepQuestion`.** Its determinism is correct;
  it is the model of what this spec wants everywhere.
- **One question per reply** survives this change.
- The canary is unchanged throughout: `$8.49 + $0.99 = $9.48`, one line,
  Temp: Medium.

## Acceptance

- The 19:07 transcript cannot recur: a reply enumerating three items when the
  cart holds two is unrepresentable, not merely detected.
- Guard count **below 32** and `reply = ` count **below 48**, with the retired
  guards named in the commit.
- Five consecutive clean runs of the 8-phrase money matrix.
- Canary green.

## What this does not cover

The SMS-path silent drop (00-A-no-error-history) is separate and comes first —
it needs the error log before it can be diagnosed at all.
