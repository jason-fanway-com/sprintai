# Invariant 4 fix — the 4 items with no unique lexicon term

Builds directly on `2026-09-07-item9-zios-stated-provenance-gate.md`'s own invariant 4
section, which root-caused these same 3 Zio's items (plus flagged a 4th, NJB one) but was
explicitly told to report only, not fix. This report documents the actual fix, applied to
`supabase/functions/_shared/compile-menu.ts` (the real compiler, not just the report
script), plus independent re-verification.

## The 4 items, exactly

| # | Shop | Item | Category | Price |
|---|------|------|----------|-------|
| 1 | Not Just Bagels | **One Egg (Side)** (`ac861733-541f-4215-9ea5-1ee334385c03`) | Sides | $1.00 |
| 2 | Zio's Pizzeria | **Zio's** (`3b8bb511-06d3-4c24-8858-632ecb412ca9`) | Chicken or Veal | $18.99 |
| 3 | Zio's Pizzeria | **Shrimp Parmigiana** (`6206f66f-a57c-4784-8e56-51e7e9e6aae4`) | Seafood | $20.99 |
| 4 | Zio's Pizzeria | **Eggplant Parmigiana** (`6c441560-c56c-4024-8875-04c2815c3cc2`) | Baked Dishes | $16.99 |

All 4 were `bot_state: orderable` — this was never a blocking-logic bug, purely a lexicon
resolution gap: a real customer saying "I want the Zio's" or "the shrimp parmigiana" would
have hit an ambiguous term with no way to tell which of 2-3 items they meant.

## Exact mechanism, reproduced and confirmed for all 4 (not guessed)

One root cause, one line of code: `compile-menu.ts`'s lexicon **rule 2** (§6.2 step 2)
strips a trailing category-noun suffix off a qualified item's `display_name` to also index
the unqualified form — e.g. "Chicken Caesar Salad" [Salads] also indexes "Chicken Caesar",
so a customer who skips the category word still resolves. This is correct when the
unqualified form isn't already someone else's real name. It becomes a bug when it is:

- **Zio's** (`3b8bb511…`) — its only lexicon term is `"zios"`. Two *different* items
  independently strip down to the identical term: **Zio's Salad** [Salads] strips trailing
  " Salad" → `"zios"`; **Zio's Panini** [Paninis] strips trailing " Panini" → `"zios"`. All
  three items now share `"zios"`, so none of them resolves uniquely to it — but Salad and
  Panini each *also* keep their own full name (`"zios salad"`, `"zios panini"`) as a
  fallback. The bare entrée has no fallback: it's just `"Zio's"`, full stop.
- **Shrimp Parmigiana** (`6206f66f…`) [Seafood] — only term `"shrimp parmigiana"`.
  **Shrimp Parmigiana Sub** [Hot Subs] strips trailing " Sub" → the identical term. Sub
  keeps `"shrimp parmigiana sub"` as its own fallback; the entrée has none.
- **Eggplant Parmigiana** (`6c441560…`) [Baked Dishes] — identical pattern: **Eggplant
  Parmigiana Sub** [Hot Subs] strips to the same term, same fallback asymmetry.
- **One Egg (Side)** (`ac861733…`) [Sides] — mechanism confirmed by direct trace, not
  guessed (the earlier report flagged this as "likely" the same class without tracing it):
  item 2's normalizer (`normalize.ts`'s trailing-parenthetical-qualifier rule) strips
  `"(Side)"` off this item's own `display_name` *before compile-menu.ts ever sees it*,
  producing the primary term `"one egg"` directly — not `"one egg side"`. Independently,
  compile-menu.ts's rule 2 strips **One Egg Sandwich** [Breakfast Sandwiches]'s trailing
  " Sandwich" → also `"one egg"`. Two *different* pipeline stages (the normalizer's own
  qualifier-stripping and the compiler's rule 2) converge on the same string with neither
  aware of the other's output — a slightly different flavor of the same underlying gap:
  rule 2 (and, transitively, any other alias-producing stage) needs to check against the
  *final*, fully-normalized set of primary names, not just its own category-suffix logic.

## The fix

`supabase/functions/_shared/compile-menu.ts`: `compileMenu` now precomputes
`primaryTermOwners` — a menu-wide map of every item's own Rule-1 term (its final,
normalized `display_name`) to its id — before compiling any item. `itemLexiconTerms`
(called via `compileItem`) takes this map as an optional parameter; when generating a
Rule-2 stripped alias, it now skips emitting that alias if the stripped term is already a
*different* item's real Rule-1 term. An item's own Rule-1 term is never touched — only the
optional convenience alias is suppressed, and only when it would shadow someone else's
genuine identity term. `compile-menu/index.ts` (the edge function) needed no changes: it
only calls `compileMenu`, so the fix applies automatically to the real compiled output, not
just this report script.

The parameter is optional and defaults to no suppression, so `compileItem`'s existing
standalone unit tests (which construct single items with no menu context) are unaffected —
confirmed by running the full suite.

## Verification

- `deno check` clean on `compile-menu.ts`, `compile-menu/index.ts`,
  `scripts/item-9-readonly-compile-report.ts`.
- 3 new unit tests added to `compile-menu.test.ts` (39/39 pass, up from 36): a direct
  collision-guard test reproducing the real Zio's/Salad case, a no-false-positive test
  (alias still generated when nothing collides), and a `compileMenu` end-to-end test
  reproducing all 3 Zio's-shaped items in one menu and asserting invariant 4 passes.
- Re-ran the real, read-only compile against live NJB + Zio's data (same script, same
  read-only guarantee — zero writes) and confirmed directly, by recomputing the exact
  term-ownership map compile-menu.ts itself uses: all 4 items now resolve to `owners=1`
  (previously 2 or 3). Full report run: **invariant 4 now PASSES on both shops.**
- Zio's orderable count is 218/220 in this run (up from the pre-existing 217/220 after the
  separately-landed stated-provenance-gate fix) — this fix does not touch blocking logic at
  all, so that number is unaffected by it; it is included here only as evidence nothing else
  regressed. NJB stayed at 100/170, unchanged, confirming the fix doesn't alter bot_state
  anywhere, only lexicon term generation.
- Confirmed no *new* collisions were introduced: reran the full report and manually diffed
  the invariant-4 violation list (now empty on both shops) against the pre-fix list (this
  exact 4-item set) — nothing new appeared.

## What's deliberately not touched

Rule 2's own full-name fallback design is otherwise unchanged — an item that legitimately
needs its unqualified form (no collision) still gets it, per the existing "Chicken Caesar
Salad" test. This fix only removes the alias in the narrow case where it would silently
shadow a different, real item — it does not change qualification behavior for the
non-colliding majority case.
