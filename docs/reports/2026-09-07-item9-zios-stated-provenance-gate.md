# Item 9 (re-run) — stated-provenance gate: Zio's, NJB, Vito's + invariant 4/8 findings

Generated 2026-09-07T20:10:13.950Z. Report-only: zero writes made to any table. Follow-up to
`2026-09-07-item9-zios-rerun-post-slice-load.md` (163/220, 6 owner_questions) per the PO's
follow-up request.

## The fix

Real architecture fix in `archetypes.ts` (`inferCategory`'s slot-resolution ladder), not a
Zio's-specific patch. **The rule:** if a menu item already has ≥1 real `option_groups` row
with `provenance='stated'` (i.e. a platform feed — Slice today, any future adapter — actually
published option data for this exact item), archetype inference becomes advisory-only for
that item: it may still guess what a slot's choices *would* look like (kept as a new
`SlotOutcomeKind` — `"advisory"` — for future reference/reporting), but it must not generate
a blocking `owner_questions` row for a slot the platform data didn't already cover. The
platform data is the restaurant's own live ordering channel; guessing on top of it isn't
caution, it's overriding the restaurant. Items with **no** stated-provenance groups at all
(no platform source — all of Not Just Bagels, and any Zio's item Slice never covered) are
completely unaffected — archetype inference stays fully active for them, exactly as before.

**Implementation** (`supabase/functions/_shared/archetypes.ts`):
- `ExtractedGroup` gained an optional `provenance?: string` field (the option_groups row's
  own provenance column, passed through by the two real callers below).
- New `hasStatedProvenanceGroup(item)` helper: `item.extractedGroups.some(g => g.provenance
  === "stated")`. Checks the item's own real per-item groups only — never
  `categoryCandidateGroups` (a sibling category turned into a candidate shared list was never
  a row on this item, so it says nothing about whether the platform spoke for this item).
- In `resolveSlotForItem`, this check sits right after `default_from_name` and right before
  the `universal_choices` / `kitchen_critical||price_critical` branches — the only two branches
  that ever produce a blocking `needs_question`/`proposed` outcome. If the gate fires, the
  slot resolves to `"advisory"` instead, which `inferCategory`'s `needsQuestion` filter
  (`kind === "needs_question" || kind === "proposed"`) does not match, so no owner_questions
  row is ever produced for it. `"advisory"` outcomes are also now counted in each question's
  `exclusions` list, same as `stated`/`default`/`not_applicable`.
- Gate is on `provenance === "stated"` specifically, **not** `owner_confirmed` — Vito's 223
  hand-built option_groups are 100% `owner_confirmed` (confirmed live against the DB before
  writing this fix), so Vito's slot resolution is completely unaffected either way; its groups
  already bind directly by name (`"Temp"`, `"Bread"`, ...) regardless of this gate.
- Two real callers updated to actually populate the new field:
  `supabase/functions/compile-menu/index.ts` (the production edge function) and
  `scripts/item-9-readonly-compile-report.ts` (this report). Both already SELECTed
  `provenance` from `option_groups` for other purposes — this only wires it into the one
  spot that was missing it.
- `supabase/functions/_shared/archetypes.test.ts`'s live-data loader also updated to select
  and pass `provenance` through, so the "live: shopname" report tests reflect the real
  post-fix behavior too (not required for correctness — those tests only log, they don't
  assert — but doing otherwise would make the live-data section quietly stale).
- Added 3 new unit tests: the gate suppressing burger `temp` on an item with unrelated
  stated groups; the gate correctly NOT firing for an `owner_confirmed` group (stated-only,
  not a blanket "any provenance" gate); and a mixed-category case where one item has stated
  data and its category-mate doesn't, proving the question still fires for the item that
  genuinely has no source data while the one with stated data is excluded. Full suite:
  73/73 passed (was 70/70 before this fix — 34 archetypes.test.ts baseline + 3 new = 37,
  plus compile-menu.test.ts's 36 — see command log), typechecked clean
  (`deno check` on all 4 touched files).

## Real numbers (live DB, this run — not adjusted to hit a target)

- **Zio's: 163/220 → 217/220 orderable (98.6%)**. Owner_questions: 6 → 2. Invariant 8
  (90% gate) now **PASSES** on its own (98.6% ≥ 90%) — threshold untouched.
- **Not Just Bagels: unchanged, 100/170 (58.8%), 8 owner_questions**, verified bit-for-bit
  identical to the pre-fix run (no platform-sourced groups exist for NJB at all, so the new
  gate never fires for it — this is the expected no-op, not a coincidence).
- **Vito's: unchanged** — not in this report script's scope (Vito's isn't one of its two
  target shops), but independently confirmed live: all 223 of its option_groups are
  `owner_confirmed`, never `stated`, so the stated-only gate cannot touch it regardless.

Zio's did **not** land at 220/220 — 3 items remain genuinely blocked, and per the standing
instruction nothing was touched to force the number up. Root cause, checked directly against
the live DB: these 3 items (**Cheese Burger**, **Double Burger** — Burgers/temp; **Tuna
Provolone Wrap** — Wraps/bread) have **zero `option_groups` rows at all** — Slice never
published any option data for them, unlike their siblings. This is the same class of gap
BLOCKED.txt already documented for 2 Zio's pizza items ("missing beats wrong" — staying
blocked here is correct, not a bug the gate should paper over). These 3 still need either a
real Slice-side fix (if the data exists upstream and wasn't captured) or an owner answer.

## Invariant 4 — the 3 items with no unique lexicon term (root-caused, same class as "remove the pizza")

All 3 are on **Zio's**, and all 3 pass invariant 1 (not blocked) — this is a pure lexicon
resolution gap in `compile-menu.ts`'s `itemLexiconTerms`, unrelated to the stated-provenance
fix (confirmed: these exact 3 IDs already failed invariant 4 in the pre-fix
`2026-09-07-item9-zios-rerun-post-slice-load.md` report, byte-identical). Root cause is
**rule 2** (the "stripped category-qualified name" lexicon rule): it strips a trailing
category-noun suffix off one item's `display_name` to also index the unqualified form (so
"Chicken Caesar Salad" also resolves to "Chicken Caesar") — but when a DIFFERENT, unrelated
item's full name happens to equal that stripped form exactly, the two collide and neither
term is unique anymore. Each violator below has a plain entrée-style name that becomes
*someone else's* stripped term, and has no second (its own qualified) term to fall back on:

- **`3b8bb511…` "Zio's"** [Chicken or Veal, price $18.99] — its only lexicon term is `"zios"`.
  Two OTHER items strip down to that exact same term: **"Zio's Salad"** [Salads] strips its
  trailing " Salad" → `"zios"`, and **"Zio's Panini"** [Paninis] strips its trailing
  " Panini" → `"zios"`. All 3 items share the term `"zios"`, so none of them is unique for
  it — but the other two each ALSO carry their own full-name term (`"zios salad"`,
  `"zios panini"`) which IS unique, so only the bare `"Zio's"` item is left with zero unique
  terms.
- **`6206f66f…` "Shrimp Parmigiana"** [Seafood, $20.99] — only term `"shrimp parmigiana"`.
  **"Shrimp Parmigiana Sub"** [Hot Subs] strips its trailing " Sub" → the same term. The Sub
  keeps its own full-name term as a unique fallback; the bare entrée does not.
- **`6c441560…` "Eggplant Parmigiana"** [Baked Dishes, $16.99] — same pattern exactly:
  **"Eggplant Parmigiana Sub"** [Hot Subs] strips to the identical term, same fallback
  asymmetry.

So it's one mechanism, 3 instances: whenever an entrée/plate item's plain name is identical
to another item's name with its own category word removed, the plain item loses. (Not Just
Bagels has 1 similar violation, `ac861733…` "One Egg (Side)" [Sides] — out of scope for the
"3 items" ask but flagged here since it's the same class: likely collides with a "One Egg"
or similarly-named item in another category once a suffix strips off.) Not fixed here per
the PO's instruction to report, not touch, invariant 4/8 — this is scoping information for
whoever picks up rule 2's collision handling next (e.g. rule 2 should probably check the
stripped form against the whole menu's rule-1 terms before emitting it, and drop it on
collision rather than let both items silently share it).

## Melvin verification (independent, adversarial pass)

A fresh agent with no visibility into this report's reasoning was asked to independently
re-derive every claim above from the diff and the live DB, not trust any comment or number as
given. All 6 checks: **PASS**.

1. **Diff correctness** — independently confirmed `hasStatedProvenanceGroup` gates on
   `provenance === "stated"` only, reads only `item.extractedGroups` (never
   `categoryCandidateGroups`), and sits at exactly the claimed position in
   `resolveSlotForItem`'s ladder (after `default_from_name`, before `universal_choices` /
   `kitchen_critical`||`price_critical`).
2. **Test suite** — ran it fresh: `37 tests from archetypes.test.ts` + `36 tests from
   compile-menu.test.ts` → `ok | 73 passed | 0 failed`.
3. **Vito's untouched** — independently queried the live DB: 224 items, 223 option_groups,
   provenance counts `{ owner_confirmed: 223 }` — zero `stated` rows.
4. **Report script is genuinely read-only, numbers match** — read the script first to confirm
   zero writes, then ran it live: NJB 100/170 (58.8%, 8 questions), Zio's 217/220 (98.6%, 2
   questions) — identical to the numbers above.
5. **Spot-checked all 57 Zio's items** across the 6 previously-affected categories (not just
   5) — found 54 with a real `stated` group (e.g. Zio's Cheesesteak Sub, Steak Sub, Turkey
   Wrap, Gyro, BBQ Cheese Burger, Zio's Panini), confirmed none of the 54 appear in the
   post-fix blocked list.
6. **The 3 remaining blocked items are genuine data gaps** — independently queried
   `option_groups` for Cheese Burger, Double Burger, and Tuna Provolone Wrap: all three
   return zero rows, confirming `hasStatedProvenanceGroup` correctly returns false and the
   ladder correctly still asks for them.

**Melvin's overall verdict:** "The fix does exactly what it claims, safely... No discrepancies
found from the numbers reported to me."

---
## Not Just Bagels

**Items in:** 170 total (170 active, 0 inactive/hidden)

**Items orderable:** 100 / 170 (58.8%)

Other states: blocked 70, display_only 0, stale 0

### Items blocked, and on what

- **slot bread pending owner question: Do customers pick a bread on Breakfast Sandwiches?** — 20 item(s)
  - Meat Lovers Breakfast Sandwich [Breakfast Sandwiches]
  - OBO Sandwich [Breakfast Sandwiches]
  - Turkey Bacon & Egg Sandwich [Breakfast Sandwiches]
  - TBOBO Sandwich (Turkey Bacon) [Breakfast Sandwiches]
  - Lox, Egg, Onions & Cheese [Breakfast Sandwiches]
  - Lean Wrap [Breakfast Sandwiches]
  - HOBO Sandwich (Ham) [Breakfast Sandwiches]
  - Avocado Crush [Breakfast Sandwiches]
  - Turkey Bacon, Egg & Cheese [Breakfast Sandwiches]
  - Egg & Cheese Sandwich [Breakfast Sandwiches]
  - Western Breakfast Sandwich [Breakfast Sandwiches]
  - PROBO Sandwich (Pork Roll) [Breakfast Sandwiches]
  - BOBO Sandwich (Bacon) [Breakfast Sandwiches]
  - One Egg Sandwich [Breakfast Sandwiches]
  - Pastrami, Egg & Cheese [Breakfast Sandwiches]
  - SOBO Sandwich (Sausage) [Breakfast Sandwiches]
  - Salami, Egg & Cheese [Breakfast Sandwiches]
  - Two Eggs Sandwich [Breakfast Sandwiches]
  - Steak, Egg & Cheese [Breakfast Sandwiches]
  - Meat Only Breakfast Sandwich [Breakfast Sandwiches]
- **slot bread pending owner question: Do customers pick a bread on Cold Sandwiches?** — 15 item(s)
  - Sloppy Joe - Roast Beef [Cold Sandwiches]
  - Pastrami & Cheese Sandwich [Cold Sandwiches]
  - Whitefish Salad Sandwich [Cold Sandwiches]
  - Tuna Salad Sandwich [Cold Sandwiches]
  - Ham & Cheese Sandwich [Cold Sandwiches]
  - Roast Beef & Cheese Sandwich [Cold Sandwiches]
  - Sloppy Joe - Turkey [Cold Sandwiches]
  - Salami & Cheese Sandwich [Cold Sandwiches]
  - BLT [Cold Sandwiches]
  - Egg Salad Sandwich [Cold Sandwiches]
  - Turkey & Cheese Sandwich [Cold Sandwiches]
  - Turkey Club [Cold Sandwiches]
  - The Universal [Cold Sandwiches]
  - Cheese Sandwich [Cold Sandwiches]
  - Chicken Salad Sandwich [Cold Sandwiches]
- **slot bread pending owner question: Do customers pick a bread on Hot Sandwiches?** — 12 item(s)
  - Chicken Cutlet Sandwich [Hot Sandwiches]
  - Grilled Cheese [Hot Sandwiches]
  - Cheddar Cheeseball Cheesesteak [Hot Sandwiches]
  - Beef Gyro [Hot Sandwiches]
  - Reuben [Hot Sandwiches]
  - Grilled Chicken Gyro [Hot Sandwiches]
  - Rachel [Hot Sandwiches]
  - Pizza Bagel [Hot Sandwiches]
  - Tuna Melt [Hot Sandwiches]
  - Cheesesteak [Hot Sandwiches]
  - Big John's [Hot Sandwiches]
  - Turkey Melt [Hot Sandwiches]
- **slot bread pending owner question: Do customers pick a bread on Wraps?** — 10 item(s)
  - Veggie Wrap [Wraps]
  - Grilled Chicken Cheesesteak Wrap [Wraps]
  - Habanero Wrap [Wraps]
  - Cheesesteak Wrap [Wraps]
  - Co's Wrap [Wraps]
  - Mo's Wrap [Wraps]
  - Chicken Tender Parm Wrap [Wraps]
  - Ranch Chicken Wrap [Wraps]
  - Grilled Chicken Caesar Wrap [Wraps]
  - Bo's Wrap [Wraps]
- **slot egg_side pending owner question: Do customers pick a side on Omelette & Egg Platters?** — 7 item(s)
  - Lean Omelette Platter [Omelette & Egg Platters]
  - Spinach & Feta Cheese Omelette Platter [Omelette & Egg Platters]
  - Meat Lovers' Omelette Platter [Omelette & Egg Platters]
  - Penny's Spicy Omelette Platter [Omelette & Egg Platters]
  - Lox & Onions Omelette Platter [Omelette & Egg Platters]
  - Bacon, Sausage, Ham Or Pork Roll Omelette Platter [Omelette & Egg Platters]
  - Western Omelette Platter [Omelette & Egg Platters]
- **slot toast pending owner question: Do customers pick a toast/bread on Omelette & Egg Platters?** — 3 item(s)
  - Veggie Omelette Platter [Omelette & Egg Platters]
  - Cheese Omelette Platter [Omelette & Egg Platters]
  - Build Your Own Omelette Platter [Omelette & Egg Platters]
- **slot dressing pending owner question: Do customers pick a dressing on Salads?** — 2 item(s)
  - Garden Salad [Salads]
  - Chef's Salad [Salads]
- **slot egg_style pending owner question: How would customers like their eggs cooked on Omelette & Egg Platters?** — 1 item(s)
  - Two Eggs Any Style Platter [Omelette & Egg Platters]

### Full owner_questions list (8 rows — none exist in the DB yet, these are what item 3's infer would write)

- **[Breakfast Sandwiches] bread** (archetype: sandwich, blocking: true, priority: 80, items affected: 20)
  - Q: Do customers pick a bread on Breakfast Sandwiches?
  - Proposed choices: (none — owner must supply)
- **[Cold Sandwiches] bread** (archetype: sandwich, blocking: true, priority: 60, items affected: 15)
  - Q: Do customers pick a bread on Cold Sandwiches?
  - Proposed choices: (none — owner must supply)
- **[Hot Sandwiches] bread** (archetype: sandwich, blocking: true, priority: 48, items affected: 12)
  - Q: Do customers pick a bread on Hot Sandwiches?
  - Proposed choices: (none — owner must supply)
- **[Omelette & Egg Platters] egg_side** (archetype: eggs, blocking: true, priority: 44, items affected: 11)
  - Q: Do customers pick a side on Omelette & Egg Platters?
  - Proposed choices: (none — owner must supply)
- **[Wraps] bread** (archetype: sandwich, blocking: true, priority: 40, items affected: 10)
  - Q: Do customers pick a bread on Wraps?
  - Proposed choices: (none — owner must supply)
- **[Omelette & Egg Platters] toast** (archetype: eggs, blocking: true, priority: 12, items affected: 3)
  - Q: Do customers pick a toast/bread on Omelette & Egg Platters?
  - Proposed choices: (none — owner must supply)
  - Excluded (already resolved without a question): Lean Omelette Platter, Spinach & Feta Cheese Omelette Platter, Meat Lovers' Omelette Platter, Penny's Spicy Omelette Platter, Lox & Onions Omelette Platter, Bacon, Sausage, Ham or Pork Roll Omelette Platter, Western Omelette Platter, Two Eggs Any Style Platter
- **[Salads] dressing** (archetype: salad, blocking: true, priority: 8, items affected: 2)
  - Q: Do customers pick a dressing on Salads?
  - Proposed choices: (none — owner must supply)
  - Excluded (already resolved without a question): Caesar Salad, Greek Salad
- **[Omelette & Egg Platters] egg_style** (archetype: eggs, blocking: true, priority: 4, items affected: 1)
  - Q: How would customers like their eggs cooked on Omelette & Egg Platters?
  - Proposed choices: Scrambled, Over easy, Over medium, Over hard, Sunny side up, Poached
  - Excluded (already resolved without a question): Veggie Omelette Platter, Lean Omelette Platter, Spinach & Feta Cheese Omelette Platter, Cheese Omelette Platter, Meat Lovers' Omelette Platter, Penny's Spicy Omelette Platter, Lox & Onions Omelette Platter, Bacon, Sausage, Ham or Pork Roll Omelette Platter, Western Omelette Platter, Build Your Own Omelette Platter

### §8.2 invariants

FAIL — inv 1: No item in an active category is blocked (70 violation(s): 00f24ac1-712d-4de7-a5e1-25dc4e2f6420 (Meat Lovers Breakfast Sandwich); 017bff65-eb66-4352-8cb4-f7b4a2d117b5 (Veggie Omelette Platter); 03bb3475-2b92-400c-b224-fc5d67e5fee0 (OBO Sandwich); 04c8a9cf-345b-4a37-a374-d807c1cfc27a (Veggie Wrap); 05a4f460-b676-4602-bc9a-6e6151051479 (Sloppy Joe - Roast Beef), ...)
PASS — inv 2: Every orderable item has display_name, ask_plan, price_cents>0, confirmed price_provenance
PASS — inv 3: No two orderable items share the same display_name
FAIL — inv 4: Every orderable item has ≥1 active lexicon term resolving uniquely to it (1 violation(s): ac861733-541f-4215-9ea5-1ee334385c03)
PASS — inv 5: Every group on an orderable item satisfies slot/min/max/choice/provenance rules
PASS — inv 6: Every default_choice_id references an active choice in its own group
PASS — inv 7: No active choice has provenance 'inferred'
FAIL — inv 8: orderable/active ratio ≥ 0.9 or owner-acknowledged (actual: 58.8%, acknowledged: false) (1 violation(s): ratio 58.8% < 90%, not acknowledged)

### Ten real ask_plans

**Flavored Cream Cheese Spread (per Pound)** [Homemade Cream Cheese Spreads] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.089Z",
  "compiler_version": 1,
  "display_name": "Flavored Cream Cheese Spread (per Pound)",
  "base_price_cents": 1195,
  "steps": [
    {
      "group_id": "derived:3bbc0c46-f41e-477e-a1a2-d84236bafcaf:0",
      "slot_key": "choice",
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choice.ask",
      "choices": [
        {
          "id": "derived:3bbc0c46-f41e-477e-a1a2-d84236bafcaf:0:0",
          "display": "Walnut Raisin",
          "price_delta_cents": 0
        },
        {
          "id": "derived:3bbc0c46-f41e-477e-a1a2-d84236bafcaf:0:1",
          "display": "Scallion",
          "price_delta_cents": 0
        },
        {
          "id": "derived:3bbc0c46-f41e-477e-a1a2-d84236bafcaf:0:2",
          "display": "Strawberry",
          "price_delta_cents": 0
        },
        {
          "id": "derived:3bbc0c46-f41e-477e-a1a2-d84236bafcaf:0:3",
          "display": "Blueberry",
          "price_delta_cents": 0
        },
        {
          "id": "derived:3bbc0c46-f41e-477e-a1a2-d84236bafcaf:0:4",
          "display": "Olive",
          "price_delta_cents": 0
        },
        {
          "id": "derived:3bbc0c46-f41e-477e-a1a2-d84236bafcaf:0:5",
          "display": "Sun-Dried Tomato",
          "price_delta_cents": 0
        },
        {
          "id": "derived:3bbc0c46-f41e-477e-a1a2-d84236bafcaf:0:6",
          "display": "Garlic Herb",
          "price_delta_cents": 0
        },
        {
          "id": "derived:3bbc0c46-f41e-477e-a1a2-d84236bafcaf:0:7",
          "display": "Garden Vegetable",
          "price_delta_cents": 0
        },
        {
          "id": "derived:3bbc0c46-f41e-477e-a1a2-d84236bafcaf:0:8",
          "display": "Jalapeño Cheddar",
          "price_delta_cents": 0
        },
        {
          "id": "derived:3bbc0c46-f41e-477e-a1a2-d84236bafcaf:0:9",
          "display": "Chocolate Chip",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Bagel With Flavored Cream Cheese** [Bagel With] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.089Z",
  "compiler_version": 1,
  "display_name": "Bagel With Flavored Cream Cheese",
  "base_price_cents": 450,
  "steps": [
    {
      "group_id": "derived:c56512e1-51f4-43ba-bb31-7a1069157ae8:0",
      "slot_key": "choice",
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choice.ask",
      "choices": [
        {
          "id": "derived:c56512e1-51f4-43ba-bb31-7a1069157ae8:0:0",
          "display": "Walnut Raisin",
          "price_delta_cents": 0
        },
        {
          "id": "derived:c56512e1-51f4-43ba-bb31-7a1069157ae8:0:1",
          "display": "Scallion",
          "price_delta_cents": 0
        },
        {
          "id": "derived:c56512e1-51f4-43ba-bb31-7a1069157ae8:0:2",
          "display": "Strawberry",
          "price_delta_cents": 0
        },
        {
          "id": "derived:c56512e1-51f4-43ba-bb31-7a1069157ae8:0:3",
          "display": "Blueberry",
          "price_delta_cents": 0
        },
        {
          "id": "derived:c56512e1-51f4-43ba-bb31-7a1069157ae8:0:4",
          "display": "Olive",
          "price_delta_cents": 0
        },
        {
          "id": "derived:c56512e1-51f4-43ba-bb31-7a1069157ae8:0:5",
          "display": "Sun-Dried Tomato",
          "price_delta_cents": 0
        },
        {
          "id": "derived:c56512e1-51f4-43ba-bb31-7a1069157ae8:0:6",
          "display": "Garlic Herb",
          "price_delta_cents": 0
        },
        {
          "id": "derived:c56512e1-51f4-43ba-bb31-7a1069157ae8:0:7",
          "display": "Garden Vegetable",
          "price_delta_cents": 0
        },
        {
          "id": "derived:c56512e1-51f4-43ba-bb31-7a1069157ae8:0:8",
          "display": "Jalapeño Cheddar",
          "price_delta_cents": 0
        },
        {
          "id": "derived:c56512e1-51f4-43ba-bb31-7a1069157ae8:0:9",
          "display": "Chocolate Chip",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Meat Side** [Sides] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.089Z",
  "compiler_version": 1,
  "display_name": "Meat Side",
  "base_price_cents": 225,
  "steps": [
    {
      "group_id": "derived:c9b0a70c-44ff-42cc-b7c6-517f434a3d62:0",
      "slot_key": "choice",
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choice.ask",
      "choices": [
        {
          "id": "derived:c9b0a70c-44ff-42cc-b7c6-517f434a3d62:0:0",
          "display": "Bacon",
          "price_delta_cents": 0
        },
        {
          "id": "derived:c9b0a70c-44ff-42cc-b7c6-517f434a3d62:0:1",
          "display": "Ham",
          "price_delta_cents": 0
        },
        {
          "id": "derived:c9b0a70c-44ff-42cc-b7c6-517f434a3d62:0:2",
          "display": "Sausage",
          "price_delta_cents": 0
        },
        {
          "id": "derived:c9b0a70c-44ff-42cc-b7c6-517f434a3d62:0:3",
          "display": "Pork Roll",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Extras & Add-Ins - Meat** [Extras & Add-Ins] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.089Z",
  "compiler_version": 1,
  "display_name": "Extras & Add-Ins - Meat",
  "base_price_cents": 175,
  "steps": [
    {
      "group_id": "derived:d6d2173d-a440-4032-b4b8-2a848f2d2099:0",
      "slot_key": "choice",
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choice.ask",
      "choices": [
        {
          "id": "derived:d6d2173d-a440-4032-b4b8-2a848f2d2099:0:0",
          "display": "Bacon",
          "price_delta_cents": 0
        },
        {
          "id": "derived:d6d2173d-a440-4032-b4b8-2a848f2d2099:0:1",
          "display": "Ham",
          "price_delta_cents": 0
        },
        {
          "id": "derived:d6d2173d-a440-4032-b4b8-2a848f2d2099:0:2",
          "display": "Sausage",
          "price_delta_cents": 0
        },
        {
          "id": "derived:d6d2173d-a440-4032-b4b8-2a848f2d2099:0:3",
          "display": "Pork Roll",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Meat Lovers Breakfast Sandwich** [Breakfast Sandwiches] — bot_state: blocked (slot bread pending owner question: Do customers pick a bread on Breakfast Sandwiches?)
```json
{
  "compiled_at": "2026-09-07T20:10:13.089Z",
  "compiler_version": 1,
  "display_name": "Meat Lovers Breakfast Sandwich",
  "base_price_cents": 1395,
  "steps": [
    {
      "group_id": "derived:00f24ac1-712d-4de7-a5e1-25dc4e2f6420:0",
      "slot_key": "choice",
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choice.ask",
      "choices": [
        {
          "id": "derived:00f24ac1-712d-4de7-a5e1-25dc4e2f6420:0:0",
          "display": "Bagel",
          "price_delta_cents": 0
        },
        {
          "id": "derived:00f24ac1-712d-4de7-a5e1-25dc4e2f6420:0:1",
          "display": "Bread",
          "price_delta_cents": 0
        },
        {
          "id": "derived:00f24ac1-712d-4de7-a5e1-25dc4e2f6420:0:2",
          "display": "Roll",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Pastrami & Cheese Sandwich** [Cold Sandwiches] — bot_state: blocked (slot bread pending owner question: Do customers pick a bread on Cold Sandwiches?)
```json
{
  "compiled_at": "2026-09-07T20:10:13.089Z",
  "compiler_version": 1,
  "display_name": "Pastrami & Cheese Sandwich",
  "base_price_cents": 995,
  "steps": [
    {
      "group_id": "derived:09689cb8-afd9-41dd-87a0-afe0cd17702d:0",
      "slot_key": "choice",
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choice.ask",
      "choices": [
        {
          "id": "derived:09689cb8-afd9-41dd-87a0-afe0cd17702d:0:0",
          "display": "Bagel",
          "price_delta_cents": 0
        },
        {
          "id": "derived:09689cb8-afd9-41dd-87a0-afe0cd17702d:0:1",
          "display": "Bread",
          "price_delta_cents": 0
        },
        {
          "id": "derived:09689cb8-afd9-41dd-87a0-afe0cd17702d:0:2",
          "display": "Roll",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Lean Omelette Platter** [Omelette & Egg Platters] — bot_state: blocked (slot egg_side pending owner question: Do customers pick a side on Omelette & Egg Platters?)
```json
{
  "compiled_at": "2026-09-07T20:10:13.089Z",
  "compiler_version": 1,
  "display_name": "Lean Omelette Platter",
  "base_price_cents": 1395,
  "steps": [
    {
      "group_id": "derived:0e9a8ec9-e481-4d19-ae7b-eb001e350ffc:0",
      "slot_key": "choice",
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choice.ask",
      "choices": [
        {
          "id": "derived:0e9a8ec9-e481-4d19-ae7b-eb001e350ffc:0:0",
          "display": "Bagel",
          "price_delta_cents": 0
        },
        {
          "id": "derived:0e9a8ec9-e481-4d19-ae7b-eb001e350ffc:0:1",
          "display": "Toast",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Grilled Cheese** [Hot Sandwiches] — bot_state: blocked (slot bread pending owner question: Do customers pick a bread on Hot Sandwiches?)
```json
{
  "compiled_at": "2026-09-07T20:10:13.089Z",
  "compiler_version": 1,
  "display_name": "Grilled Cheese",
  "base_price_cents": 495,
  "steps": [
    {
      "group_id": "derived:11d8d528-ad05-4fed-b91e-46d1dc2cc046:0",
      "slot_key": "choice",
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choice.ask",
      "choices": [
        {
          "id": "derived:11d8d528-ad05-4fed-b91e-46d1dc2cc046:0:0",
          "display": "Bagel",
          "price_delta_cents": 0
        },
        {
          "id": "derived:11d8d528-ad05-4fed-b91e-46d1dc2cc046:0:1",
          "display": "Bread",
          "price_delta_cents": 0
        },
        {
          "id": "derived:11d8d528-ad05-4fed-b91e-46d1dc2cc046:0:2",
          "display": "Roll",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Sun Dried Tomato Bagel** [Bagels] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.089Z",
  "compiler_version": 1,
  "display_name": "Sun Dried Tomato Bagel",
  "base_price_cents": 150,
  "steps": [],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Macaroni & Cheese Triangles** [From The Fryer] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.089Z",
  "compiler_version": 1,
  "display_name": "Macaroni & Cheese Triangles",
  "base_price_cents": 695,
  "steps": [],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

---

## Zio's Pizzeria

**Items in:** 220 total (220 active, 0 inactive/hidden)

**Items orderable:** 217 / 220 (98.6%)

Other states: blocked 3, display_only 0, stale 0

### Items blocked, and on what

- **slot temp pending owner question: Do customers pick a temperature on Burgers?** — 2 item(s)
  - Cheese Burger [Burgers]
  - Double Burger [Burgers]
- **slot bread pending owner question: Do customers pick a bread on Wraps?** — 1 item(s)
  - Tuna Provolone Wrap [Wraps]

### Full owner_questions list (2 rows — none exist in the DB yet, these are what item 3's infer would write)

- **[Burgers] temp** (archetype: burger, blocking: true, priority: 8, items affected: 2)
  - Q: Do customers pick a temperature on Burgers?
  - Proposed choices: Rare, Medium rare, Medium, Medium well, Well done
  - Excluded (already resolved without a question): Burger, BBQ Cheese Burger, Zio's Deluxe Burger, Mamma Mia Burger
- **[Wraps] bread** (archetype: sandwich, blocking: true, priority: 4, items affected: 1)
  - Q: Do customers pick a bread on Wraps?
  - Proposed choices: (none — owner must supply)
  - Excluded (already resolved without a question): New York Wrap, Turkey Wrap, Cheese Steak Wrap, Chicken Cheese Steak Wrap, Chicken Caesar Wrap, Veggie Wrap, Buffalo Chicken Wrap, Prosciutto Wrap, Roast Beef Wrap, Grilled Chicken Wrap

### §8.2 invariants

FAIL — inv 1: No item in an active category is blocked (3 violation(s): 0376e784-5ebd-4f82-aaff-2afe5cf3b36d (Tuna Provolone Wrap); a16b6a66-e8c9-4164-90ee-2c218b46f145 (Cheese Burger); be5b49d5-2062-4119-a264-4f5f89b6ddf3 (Double Burger))
PASS — inv 2: Every orderable item has display_name, ask_plan, price_cents>0, confirmed price_provenance
PASS — inv 3: No two orderable items share the same display_name
FAIL — inv 4: Every orderable item has ≥1 active lexicon term resolving uniquely to it (3 violation(s): 3b8bb511-06d3-4c24-8858-632ecb412ca9; 6206f66f-a57c-4784-8e56-51e7e9e6aae4; 6c441560-c56c-4024-8875-04c2815c3cc2)
PASS — inv 5: Every group on an orderable item satisfies slot/min/max/choice/provenance rules
PASS — inv 6: Every default_choice_id references an active choice in its own group
PASS — inv 7: No active choice has provenance 'inferred'
PASS — inv 8: orderable/active ratio ≥ 0.9 or owner-acknowledged (actual: 98.6%, acknowledged: false)

### Ten real ask_plans

**Plain Pan Pizza** [Pizza] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.942Z",
  "compiler_version": 1,
  "display_name": "Plain Pan Pizza",
  "base_price_cents": 1999,
  "steps": [
    {
      "group_id": "7ed6493a-ae58-4a0a-ba8a-a719737ce0d7",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "650e83c8-efa5-4d81-9207-60fbab491ed2",
          "display": "18''",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Chocolate Caramel Cake** [Desserts] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.942Z",
  "compiler_version": 1,
  "display_name": "Chocolate Caramel Cake",
  "base_price_cents": 575,
  "steps": [
    {
      "group_id": "b14ecad2-fb13-439d-80a3-f008a6c63118",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "dbae1df8-9f31-4a3a-b452-73f09994d126",
          "display": "Dessert",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Cheese Fries** [Side Orders] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.942Z",
  "compiler_version": 1,
  "display_name": "Cheese Fries",
  "base_price_cents": 799,
  "steps": [
    {
      "group_id": "2d36a0e4-b4bb-4930-aeab-c08987399bff",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "3a85fe84-fe41-4a8d-bc9c-665b0e0111e1",
          "display": "Side Orders",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Veggie Panini** [Paninis] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.942Z",
  "compiler_version": 1,
  "display_name": "Veggie Panini",
  "base_price_cents": 1199,
  "steps": [
    {
      "group_id": "955a3ddd-ccd9-4041-827c-86cc445558eb",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "78c94e45-7184-4707-a02a-50c27bc27fd9",
          "display": "Panini",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Garden Salad** [Salads] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.942Z",
  "compiler_version": 1,
  "display_name": "Garden Salad",
  "base_price_cents": 799,
  "steps": [
    {
      "group_id": "9b41cb70-a5d5-4976-bbd9-7bc621cec3e1",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "a3aa6f97-5df6-4ea6-91b0-92465b30f286",
          "display": "Salad",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Bruschetta** [Appetizers] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.942Z",
  "compiler_version": 1,
  "display_name": "Bruschetta",
  "base_price_cents": 799,
  "steps": [
    {
      "group_id": "afa06961-c504-4c37-bcad-c6838fb3cb00",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "81af17ee-fdd8-4245-ac8e-8d3729c8f9de",
          "display": "Appetizer",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Italian Hot Dog Sub** [Hot Subs] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.942Z",
  "compiler_version": 1,
  "display_name": "Italian Hot Dog Sub",
  "base_price_cents": 1099,
  "steps": [
    {
      "group_id": "fd231040-3518-4f99-8571-d90bee7ecefd",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choose_an_option.ask",
      "choices": [
        {
          "id": "1faa3dbd-3cef-42a3-a449-b356e8ce193d",
          "display": "Medium 12''",
          "price_delta_cents": 0
        },
        {
          "id": "37f45feb-b51b-4046-95e7-4908dbbbc81f",
          "display": "Large 16''",
          "price_delta_cents": 800
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Baked Ziti** [Baked Dishes] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.942Z",
  "compiler_version": 1,
  "display_name": "Baked Ziti",
  "base_price_cents": 1699,
  "steps": [
    {
      "group_id": "da653597-1dbc-4fa1-9007-42e76d5d6485",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "17416fd3-d762-4084-beda-cf4529750780",
          "display": "Pasta",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Pasta Pomodoro** [Pasta] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.942Z",
  "compiler_version": 1,
  "display_name": "Pasta Pomodoro",
  "base_price_cents": 1499,
  "steps": [
    {
      "group_id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0",
      "slot_key": "choice",
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choice.ask",
      "choices": [
        {
          "id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0:0",
          "display": "Pasta: Spaghetti",
          "price_delta_cents": 0
        },
        {
          "id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0:1",
          "display": "Linguine",
          "price_delta_cents": 0
        },
        {
          "id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0:2",
          "display": "Penne",
          "price_delta_cents": 0
        },
        {
          "id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0:3",
          "display": "Rigatoni",
          "price_delta_cents": 0
        },
        {
          "id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0:4",
          "display": "Angel Hair",
          "price_delta_cents": 0
        },
        {
          "id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0:5",
          "display": "Fettuccine",
          "price_delta_cents": 0
        }
      ]
    },
    {
      "group_id": "3cd95a91-11c5-4ec6-afdc-2ffde199bfe6",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choose_pasta.ask",
      "choices": [
        {
          "id": "0c0c355c-9c08-40a8-962f-784ec2da81a4",
          "display": "Angel Hair",
          "price_delta_cents": 0
        },
        {
          "id": "17d040bc-28a5-4200-baf6-6b5f5f18030d",
          "display": "Rigatoni",
          "price_delta_cents": 0
        },
        {
          "id": "367380fa-2191-4491-bf38-c36f3246d6dd",
          "display": "Penne",
          "price_delta_cents": 0
        },
        {
          "id": "4210f478-58f1-4435-bdcd-fdc535e4409f",
          "display": "Spaghetti",
          "price_delta_cents": 0
        },
        {
          "id": "8f0299ad-ea50-459a-a568-2b4433377044",
          "display": "Linguine",
          "price_delta_cents": 0
        },
        {
          "id": "e02b1013-d7d5-45b7-9506-291d19ccaea6",
          "display": "Fettuccine",
          "price_delta_cents": 0
        }
      ]
    },
    {
      "group_id": "b7224c4a-8c50-4fc5-bef9-d9cdfd929105",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "5fcb9022-f9cb-4946-930c-af26735ef0e8",
          "display": "Pasta",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Ricotta & Mozzarella Calzone** [Calzones & Strombolis] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T20:10:13.942Z",
  "compiler_version": 1,
  "display_name": "Ricotta & Mozzarella Calzone",
  "base_price_cents": 1699,
  "steps": [
    {
      "group_id": "61cb1ecf-6749-416c-9fff-37377d6e1d3f",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choose_an_option.ask",
      "choices": [
        {
          "id": "a8a06e69-92c7-4633-b58d-184486e8449c",
          "display": "Small",
          "price_delta_cents": 0
        },
        {
          "id": "b31940fa-a5df-43fa-b376-8102ee34ab5e",
          "display": "Family",
          "price_delta_cents": 600
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

