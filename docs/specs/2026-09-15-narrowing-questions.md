# Narrowing questions — Jason's direction, 2026-09-15

**Status:** product direction from Jason, 2026-09-15 evening. Amends
`2026-09-15-code-owned-resolution.md` §2 ("ambiguous means ask"): it settles *how* to ask.
For the PO thread to spec into a crew dispatch. Nothing here reopens the resolver.

## The rule, in Jason's words

> "Pizza" should get "what kind", like a human interaction. Then it should hone in on the
> answer from there. "What kind", "what size". Only if you're asked, "what are the options",
> should the conversation engine list all the toppings or specialties.

## What that means for the engine

1. **Ambiguous never enumerates by default.** When `resolveItem` returns `ambiguous` with
   candidates, the ASK step renders a **narrowing question**, not a numbered list. "Which
   one would you like — 1) … 2) … 76)" is gone as a default.
2. **The question names the facet that splits the candidates.** Code picks the facet from
   compiled data, in a fixed order: **kind** (the base item / specialty) first, then
   **size**, then any remaining required slot. "What kind of pizza?" then "What size?"
3. **The answer narrows, not restarts.** The customer's reply is resolved against the
   *current candidate set* only (longest match within candidates). Each answer shrinks the
   set until one item remains, then the normal ask_plan continues. State carries the
   candidate set and the facet being asked; this is `open: { kind: "disambiguation" }`
   extended with `facet` and `candidates`.
4. **Enumeration only on request.** If the customer asks what the options are ("what are
   the options", "what kinds do you have", "what do you have") code renders the list for
   the *current facet* only, from data. That is the existing enumerated fallback, now
   triggered by the customer, never by the engine.
5. **Ambiguous within a facet still asks.** If "cheese" narrows pizza to three sizes, the
   next question is "What size?" — never a guess, never cheapest-wins.

## Where it lives (durability ranking level 1: data)

- **Compiler:** each item carries its facets — `kind` (base name without size or count) and
  `size` where the menu has one. The derived-row work already splits base + size for
  pizzas; expose it as data so ASK never parses names at runtime.
- **Engine:** `ask()` gains one branch: `disambiguation` with more than one candidate
  renders `What {facet} for the {head noun}?` from the facet whose values split the set.
  `answer()` resolves against candidates only. Pure functions, unit-testable, no model.
- **Nothing in a prompt.** The model is not involved in narrowing.

## Acceptance shape (for the PO to set exact numbers)

- Zio's: `pizza` → "What kind of pizza?" → `cheese` → "What size?" → `large` → one line at
  the Large Neapolitan Cheese price. Five runs, DB asserted per turn.
- Vito's: `fries` → one narrowing question → one line. `burger` → "What kind of burger?"
- `what are the options` at either question lists that facet's values, from data, and
  nothing else.
- A reply that lists candidates when the customer did not ask is a failure.
