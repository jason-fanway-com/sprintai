# PO Inbox Result

**Task:** Money bug, found live by Jason himself testing the deployed bot (v541, item 7's greeting deploy). 2 of 3 test runs paid ($91.47), 1 lost the entire order. Real transcript, conv 89e3a7b6.

**Branch:** `fix/message-count-wins-and-answer-covers-all-20260919` (cut from `main` at `b93ec0e3`)

**Commit:** `e8826d93` — "fix(chat-sms): span leading count wins over PROPOSE's quantity, count-mismatch never drops a longer answer, tip clamp removed"

**Files touched:** `supabase/functions/chat-sms/turn-engine.ts`, `supabase/functions/chat-sms/turn-engine.test.ts`, `supabase/functions/chat-sms/anchored-detectors-20260917.test.ts`. `index.ts` was **not** touched, and nothing here required deploying, recompiling, or merging against live data.

---

## Investigation

### Rule 1 — span's leading count vs. PROPOSE's quantity field

`decide()`'s add-resolution loop pushed every add straight from the model's proposal with no cross-check between the span's own words and the model's separately-reported `quantity` field:

- `turn-engine.ts:3822` (resolved-item branch) — `resolvedAdds.push({ ..., quantity: add.quantity, ... })`
- `turn-engine.ts:3841` (ambiguous-item branch) — `ambiguousSpans.push({ ..., quantity: add.quantity, ... })`

Both fed `add.quantity` from PROPOSE's proposal untouched. For "4 large pizzas," PROPOSE's own `item_span` carried the "4," but its `quantity` field said 1 — the exact mismatch in the real transcript. Notably, `turn-engine.ts:3966` (pre-fix line numbers) already had the equivalent fix for **size** ("4 large pizzas" → item_span silently drops "large" → held size lost) with an explicit comment citing this identical live repro — quantity never got the matching treatment. That gap is what this closes.

Fix: added `spanLeadingCount()` (`turn-engine.ts:1436`) and `effectiveAddQuantity()` (`turn-engine.ts:1450`), reusing the same `CLAUSE_LEADING_COUNT_RE`/`CLAUSE_COUNT_WORDS` already used by `extractLeadingClauseCount`. Unlike that function, `spanLeadingCount` returns `null` (not a default of 1) when the span has no leading count at all, so a genuinely sizeless "a pepperoni pizza" never overrides a real model-reported quantity. Both push sites now call `effectiveAddQuantity(add.item_span, add.quantity)` (`turn-engine.ts:3866`, `turn-engine.ts:3885`).

### Rule 2 — count-mismatch reply must never discard a longer answer

`resolveMultiKindClauses`'s count-mismatch gate (`turn-engine.ts:1716`, pre-fix) was a bare `parsedSum !== totalQuantity` — a pending count of 1 (from rule 1's bug) against a 4-line answer produced `resolvedAdds: []` and the "You said 1 — I've got 4. What's the rest?" clarify message, dropping all four pizzas.

Fix: narrowed the gate to `parsedSum < totalQuantity` (`turn-engine.ts:1727`) — a genuine partial answer. An answer with **more** lines than the pending count is strictly more specific than whatever count was open and now falls through to the existing per-clause resolution logic below, which already resolves each clause to its own line at its own count (unchanged). This is a pure backstop: if rule 1 already fixed the quantity, `parsedSum === totalQuantity` and this branch is never reached; it only matters for a phrasing rule 1's regex doesn't catch.

The observed "What would you like to order?" re-greet was never a separate code path — it was `ask()`'s `closureOrOrdering()` (`turn-engine.ts:4596-4602`) falling back to the empty-cart "ordering" question because rule 2's old behavior left `cartChanged: false` and no real lines resolved. With rule 2 fixed, the four pizzas land, the cart is never empty, and `ask()` never reaches that branch — confirmed end-to-end by the full-pipeline test below.

### Rule 3 — tip clamp

`readTipReply`'s rule 5b (`turn-engine.ts:909-910`, pre-fix) — `const cappedCents = ctx.subtotalCents != null ? Math.min(cents, ctx.subtotalCents) : cents;` — clamped any stated tip down to the cart's subtotal. "tip the driver $5" on the transcript's $4.99 order returned `cents: 499`. There is no other tip cap anywhere else in the codebase (grepped `chat-sms/` for `tip.*clamp|MAX_TIP|Math.min.*tip` — only this one site existed). Removed outright; rule 5a (the line-item-price guard, a genuinely different real reason a number gets rejected as a tip — "$19.99 for that" naming a menu price) is untouched and still fires (`turn-engine.ts:915-916`).

---

## Acceptance — verified with real tests

**1. "4 large pizzas" with quantity=1 in the proposal → pending count ends up 4 (rule 1 fires):**
```
decide (money bug, rule 1): a span's own leading count overrides PROPOSE's mismatched quantity field ... ok (1ms)
```

**2. Same flow isolating rule 2 (quantity forced to 1 as if rule 1 didn't exist) → all four pizzas land, never "what's the rest?", never a re-greet — both at the `answer()` level and through the full runner pipeline:**
```
answer (money bug, rule 2 backstop): a wrongly-pending count of 1 still takes all four named pizzas, never 'what's the rest?', never re-drops the order ... ok (2ms)
runTurnEngineTurn (money bug, full pipeline): four named pizzas land, cart is never treated as empty, no fresh-conversation re-greet ... ok (2ms)
```

**3. Genuine partial answer (pending 4, names 2) still asks "what's the rest?" — regression:**
```
answer (money bug, rule 2 regression): a genuinely short answer (pending 4, names 2) still asks what's the rest, never silently accepted ... ok (331µs)
```

**4. "tip the driver $5" on the real $4.99-subtotal shape → $5.00, not clamped:**
```
answer (money bug, tip clamp): a stated $5 tip on the real $4.99-subtotal shape is $5.00, never clamped down to the subtotal ... ok (393µs)
P0 tip: a stated amount is never capped at the subtotal, no matter the order size ... ok (59µs)
```
(The second line replaces the old `anchored-detectors-20260917.test.ts` test that had literally codified the bug — it used to assert `readTipReply("$500 tip", { subtotalCents: 849 })` returns `cents: 849`. It now asserts the correct `cents: 50000`.)

**5. No other legitimate tip cap exists in this codebase to preserve — grepped and confirmed only rule 5b did this. Rule 5a (line-item-price guard, a different real reason) is proven unaffected:**
```
answer (money bug, tip clamp): a large stated tip on a large order is also never clamped -- the removed guard applied at every order size ... ok (214µs)
answer (money bug, tip clamp): rule 5a's line-item-price guard is unaffected -- a number that's really a menu price in the same message is still rejected as a tip ... ok (732µs)
P0 tip: a number is rejected as the tip when it also names a line-item price in the same message ... ok (42µs)
```

**6. Full suite:**
```
$ deno test --allow-all supabase/functions/chat-sms/ supabase/functions/_shared/
ok | 1883 passed | 0 failed | 7 ignored (8s)
```
(Baseline was ≥1876 passed, 0 failed. 1883 passed, 0 failed — the 8 new money-bug tests plus the updated tip-clamp test account for the delta.)

**7. All prior freeze-queue tests unchanged:**
```
$ deno test --allow-all supabase/functions/chat-sms/turn-engine.test.ts --filter "freeze-queue item"
ok | 15 passed | 0 failed | 184 filtered out (8ms)
```

---

## Notes for the lead

- Other builders are touching `turn-engine.ts` in parallel worktrees tonight — my diff is three localized edits (readTipReply's clamp, two new helper functions, one `!==` → `<` in `resolveMultiKindClauses`, two call-site swaps in `decide()`'s add loop). Merge conflicts are expected to resolve cleanly given the small surface area, but that's the lead's call, not mine.
- `supabase/functions/chat-sms/index.ts` was not touched, and no deploy/recompile/merge was performed — commit-only, as instructed.
