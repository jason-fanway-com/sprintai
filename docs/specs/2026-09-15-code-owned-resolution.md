# Code-owned item resolution — amendment to the turn-engine spec

**Status:** approved by Jason, 2026-09-15. Supersedes `2026-09-14-turn-engine-oversight.md`
§3c (proposal contract) and Phase 2`s gate. Everything else in that document stands,
including the Phase 0 freeze on `index.ts`.

## 1. Why

Phase 2 as designed has the model choose `menu_item_id`. Measured on Vito`s, on the
deployed prompt shape, after the lexicon surface-form fix landed and Vito`s was recompiled:

| phrasing | resolved, n runs | |
|---|---|---|
| `cheeseburger` | 4/4 Cheese Burger $8.49 | ok |
| `2 cheeseburgers, medium` | 4/4 Bacon Cheeseburger **$10.99** | wrong |
| `two cheese burgers and a large fries` | 3/3 Cheese Burger $8.49 | ok |
| `can i get a cheeseburger med and a coke` | 3/3 Bacon Cheeseburger **$10.99** | wrong |
| `cheeseburger, fries, coke` | 3/3 Cheese Burger $8.49 | ok |
| `lemme do a burger well done plus fries` | 3/3 Bacon Cheeseburger **$10.99** | guess |

10 of 20 calls overcharge by $2.50/unit. A follow-up A/B (30 calls) injected the one
genuinely missing term, `cheeseburgers` -> Cheese Burger, and it changed nothing: the
plural phrasings stayed 4/5 and 5/5 wrong. In the failing sentence case the correct term
was **already** in the lexicon and the model picked the dearer item anyway.

The conclusion is not "the data is incomplete". It is that item identity cannot be a model
output. Evidence: `~/po-scratch/finding-lexicon-fix-insufficient-20260915.md`,
`po-lexgap-ab-20260915.log`, `propose-mx-v3-lexiconfix-20260915.log`.

A deterministic longest-match over the SAME live lexicon was simulated offline
(`po-resolver-sim-20260915.py`) and gets every one of these right: `cheeseburger` ->
$8.49, `bacon cheeseburger` -> $10.99, `burger` -> ambiguous (7 items) -> ask.

## 2. The trade, stated up front

The resolver turns silent guesses into clarifying questions. `fries` matches 10 Vito`s
items and `burger` matches 7, so both become **one question**, where today the model picks
one and says nothing. That is the intended behaviour, not a regression — a silent guess on
`burger` is the same defect class as the $2.50 overcharge and only looks harmless when it
happens to land on a cheap row. Do not add a tiebreak, a popularity score, a "most likely"
heuristic or a cheapest-wins rule to suppress these questions. Ambiguous means ask.

## 3. Work item 1 — the data, first (`compile-menu.ts`)

The uncommitted space-collapsed + plural pass is correct and additive. **Commit it**, and
add two more mechanically derived surface forms in the same pass, under the same single
gate — a candidate is kept only when it resolves to exactly one item across the whole
shop lexicon, and is dropped for every claimant otherwise. No tiebreaks.

1. **Plural of the collapsed form.** Today the pass pluralizes only stated terms, so
   `cheese burger` yields `cheese burgers` and `cheeseburger` but never `cheeseburgers` —
   the single most likely thing a customer types. Measured new terms, zero new collisions
   in all three shops: Zio`s 466, Not Just Bagels 182, Vito`s 0. Five of Zio`s 466 are
   currently swallowed by another item`s term (`cheesesteaks`, `chickencheesesteaks`,
   `eggplantparmigianas`, `grilledchickens`, `shrimpparmigianas`) — the exact shape of the
   cheeseburger bug.
2. **Trailing word-runs (head nouns).** For each item term, every proper trailing run:
   `10 pieces wings boneless` -> `wings boneless`, `boneless`. Measured kept / dropped as
   ambiguous: Vito`s 158/193, Zio`s 350/199, Not Just Bagels 177/63. `fries` (10 items)
   and `burger` (7) drop, correctly.

Order within the pass stays deterministic so the same input yields byte-identical output.

**Gate — a pure data assertion, no model calls.** Unit tests, then recompile Vito`s only
and query `lexicon`: `cheeseburger` and `cheeseburgers` both -> `442f650d`
(Cheese Burger); `bacon cheeseburger` and `bacon cheeseburgers` both -> `94557b9c`;
`fries` and `burger` absent. Then assert **no existing term changed target or disappeared**
— diff the term->target map before and after; additions only. Stop if anything moved.
Zio`s and Not Just Bagels only after I have read the Vito`s result. No menu is re-imported,
least of all Not Just Bagels` hand-corrected one.

## 4. Work item 2 — the resolver (`resolve-item.ts`, new pure module)

Only after item 1 is accepted.

### Contract change

In `adds`, `menu_item_id: string` is replaced by `item_span: string` — the verbatim run of
the customer`s own message naming the item, nothing normalised, nothing invented.
Everything else in §3c is unchanged: `quantity` stays an integer field, `choices` stay
`group_id`/`choice_id` pairs, `removes`/`modifies` stay `line_key`, `answer_text` stays
question-only.

This does **not** reopen `source_phrase`. That field fed the text-grounding reconciler,
which re-derived after the fact what had already happened, from prose. `item_span` is an
input to a deterministic, total function that runs before anything reaches the cart. If a
span cannot be resolved to exactly one item, no line is added and the turn becomes an ASK.
Nothing downstream ever reads the span again. Do not reintroduce a reconciler.

### The function

Pure, no I/O, no LLM, same discipline as `turn-engine.ts`. Given a span and the compiled
lexicon, normalise (lowercase, collapse whitespace, strip punctuation), find the longest
lexicon term occurring in the span as a whole-word run, and return one of exactly three:

- `resolved` — exactly one target at the longest matched length
- `ambiguous` — two or more targets tie at that length; carries the candidate items so ASK
  can name them
- `unresolved` — nothing matched

Longest-match is what makes `bacon cheeseburger` beat `cheeseburger` when and only when the
customer actually said `bacon`. DECIDE calls it; `ambiguous` and `unresolved` both route to
ASK. Never guess, never fall back to the model, never partial-credit a span.

### Gate

1. Unit tests. Fixtures must be able to fail: include at least one item with two or more
   option groups (Cheese Burger has one and hid a defect once already), the
   `cheeseburger` / `bacon cheeseburger` pair, an ambiguous span, an unresolved span, and a
   span whose longest match is a multi-word term.
2. A live matrix, **five runs per phrasing**, asserting the **resolved item id and its
   price** — not schema validity, not "an id that exists". A real id for the wrong item is
   schema-valid; that is how the last gate passed while billing $2.50 too much.

   | phrasing | expected |
   |---|---|
   | `cheeseburger` | Cheese Burger 849 x1 |
   | `2 cheeseburgers, medium` | Cheese Burger 849 x2 |
   | `two cheeseburgers and a large fries` | Cheese Burger 849 x2 + ASK which fries |
   | `can i get a cheeseburger med and a coke` | Cheese Burger 849 x1 + Coke 299 x1 |
   | `cheeseburger, fries, coke` | Cheese Burger 849 x1 + Coke 299 x1 + ASK which fries |
   | `bacon cheeseburger` | Bacon Cheeseburger 1099 x1 |
   | `lemme do a burger well done plus an order of fries` | ASK which burger |

   Zero calls may bill Bacon Cheeseburger for a span that does not contain `bacon`.

3. Long runs detached with `nohup`, output to `~/po-scratch/`, path reported. A run that
   dies with its shell has produced nothing.

## 5. Out of scope

`index.ts` stays frozen — this is all new files plus DECIDE. Phase 3 wiring is unchanged
and still needs its own dispatch and my personal review of the one routing branch.
