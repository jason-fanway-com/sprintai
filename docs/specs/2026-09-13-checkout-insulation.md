# Checkout insulation and the order of the close

**Status:** NEXT, ahead of reply inversion.
**Requested by:** Jason — 2026-09-13 morning (insulate ordering from checkout),
refined 2026-09-13 evening after order #14.

## The refinement that matters

> "One thing that's annoying is it always rushes to get your name, which is the
> trigger for checkout. That's unnatural. It should always try to upsell. It
> should ask the user if they are ready to check out and then ask for their
> name."

**The name-ask is currently the checkout trigger.** That is the whole problem.
Asking a customer's name is how the bot *starts* closing, so it closes the
moment an item lands — before an upsell, before the customer has said they are
done.

## The correct order of the close

1. **Item added** → confirm what was added (rendered from the cart, not authored
   by the model — see the reply-inversion spec) and make **at most one** soft
   upsell offer at that natural moment.
2. **"Anything else, or are you ready to check out?"**
3. Customer says they are ready → **only then ask for the name.**
4. Name captured → payment link.

A name is collected *because* we are closing. It must never be the thing that
causes us to close.

## What this changes in code

- **The name-ask stops being a trigger.** Entering checkout requires explicit
  customer intent (step 2's affirmative, or "that's it" / "ready to check out" /
  "send the link"). `NAME_ASK` moves to *after* that gate, not before it.
- **Track that the name question was asked**, so it is never re-asked. Order #14
  asked "Putting this in for Jason, right?" four times in one conversation.
- **The upsell gets its moment.** `upsell_enabled` is already true for Vito's,
  `menu_items.upsell` is already populated ("Shrimp +6.00; Black Diamond Steak
  +8.00"), and the prompt already carries an UPSELL RESTRAINT rule. It never
  fires because the flow closes before the natural moment arrives. Give step 1
  that moment.
- Keep the restraint: **at most one** offer, never repeated, only real menu
  items. Restraint is right — the bug is that it currently offers *zero*.

## Non-negotiables

- Never infer checkout intent from a "yes" that answers some other question.
  This is the C4 class that produced $42 and $341 — a confirmation means yes to
  what was just asked, nothing more.
- Returning to ordering from checkout must void the stale Stripe link.
- One question per reply. Step 2 is ONE question, not "anything else?" plus
  "what's your name?".
- Canary unchanged: $8.49 + $0.99 = $9.48.

## Acceptance

- Add an item → the reply confirms it AND makes one upsell offer.
- "yes" to that upsell adds the upsold item; "no" proceeds without sulking.
- The bot asks "anything else, or ready to check out?" before ever asking a name.
- A name is asked at most ONCE per conversation.
- "that's it" / "ready to check out" / "send me the link" all enter checkout.
- A bare "yes" answering anything else NEVER enters checkout.
- Full 8-phrase money matrix still clean, five consecutive runs.
