# Test Kitchen — disambiguation loop + menu option gaps (Jason 2026-09-06 10:58 EDT)

Source: Jason's live test on getsprintai.com/test-kitchen.html against Vito's Pizza.
Three items reported; one hypothesis (import duplication) is **corrected below** — verify
the correction against the live DB before doing any deletion.

**Do not regress:** Guard 7 (ambiguous same-name match) must keep firing when a name is
genuinely ambiguous. "large pepperoni pizza", "prop pizza" (typo-correction ask), mid-conversation
topping adds, and the upsell double-question fix (Guard 4) must still all work — do not touch
that code except where this spec says to.

---

## CORRECTION to Jason's blocker 2 — there is no import-duplication bug

Live query against `qa_ro.menu_item_option_coverage` for Vito's (`e0000000-0000-0000-0000-000000000001`),
active items, right now:

```
Chicken Caesar | Salads | active | 3 groups | 18 choices   (id 4103910d-...)
Chicken Caesar | Wraps  | active | 0 groups | 0 choices    (id 7fea07fc-...)
```

Two rows, not four. Every "duplicate name" in the shop (BLT, Cheesesteak, Chicken Cheesesteak,
Italian, Sausage, Veggie, Tuna, etc.) has a **distinct `import_key`** of the form
`category|name|size` — e.g. `homemade paninis|blt|` vs `cold sandwiches|blt|`. These are real,
different menu items (a BLT panini and a BLT cold sandwich are not the same order) that happen
to share a display name across categories. This matches existing product policy already on
record: same-name items across categories are legit and must not be deduped.

**Do not delete or merge any rows.** There is no importer bug creating spurious copies to fix.

The actual defect is narrower: Guard 7's category-match check in `chat-sms/index.ts` (the
`categoryMatches` block, search for `GUARD 7`) does an exact substring match of the customer's
message against the item's `category` column, case-folded only. It does not tolerate:

- singular/plural (customer says "salad", category is `"Salads"`)
- the wrap/wraps mismatch (customer says "the wrap", category is `"Wraps"`)

Because of this, Jason's own message — `caesar salad` — should have resolved directly to the
Salads row without ever asking, since the customer named the category. Fix this matcher first;
it may make blocker 1's transcript case moot for this exact phrase (though the general
ask-and-answer path below is still required, since not every ambiguous order names a category).

---

## BLOCKER 1 (real, confirmed) — the disambiguation question cannot be answered

Guard 7 asks a clarifying question but **persists no state**. The next user message is handled
by the normal LLM tool-call path with no memory of which two candidates were offered, so it
either re-resolves to the same ambiguous name (asks the identical question again) or fails to
resolve at all (produces the generic "I got mixed up" error on an unambiguous answer like
"the 12.95 one").

**Required fix — persist pending disambiguation, resolve deterministically before the LLM:**

1. When Guard 7 fires, store the offered candidates on the cart row (new JSON column on
   `order_carts`, e.g. `pending_disambiguation jsonb` — migration in `supabase/migrations/`):
   `{ query_name: string, candidates: [{menu_item_id, name, category, price_cents}] }`.
2. On the NEXT inbound message, if `pending_disambiguation` is set, attempt deterministic
   resolution BEFORE calling the LLM/tool loop:
   - Category word match, singular/plural tolerant (strip trailing "s", or use a small
     stemmer — "salad"/"salads", "wrap"/"wraps" both resolve).
   - Ordinal ("the first one", "the second", "first", "1st", "number one/two").
   - Price match (a dollar amount or bare number matching a candidate's `price_cents`, e.g.
     "the 12.95 one", "12.95", "$9.99").
   - A bare "1"/"2" positional reply, matching the order the options were listed in the
     question.
   - If resolution succeeds: add the resolved item to the cart directly (server-side, same
     as `add_item` would), clear `pending_disambiguation`, and let the LLM generate the normal
     confirmation reply (or synthesize one deterministically — your call, but it must not
     re-ask).
   - If resolution FAILS: do not repeat the identical sentence. Rephrase with an explicit
     numbered format ("1) Chicken Caesar salad — $12.95  2) Chicken Caesar wrap — $9.99 — reply
     1 or 2") and keep `pending_disambiguation` set. Repeating the exact same string twice in a
     row must be impossible by construction (assert this in a test).
3. Clear `pending_disambiguation` on RESET, on cart expiry, and once any resolution succeeds.

**Acceptance — drive the LIVE public path** (`public-tester` function, `start`→`send`, anon key
in `test-kitchen.html`, `Origin: https://getsprintai.com`), against Vito's:

Paste a live, verbatim transcript proving ALL FOUR of these answer forms resolve correctly in
independent sessions (fresh `start` each time, so one working answer doesn't leak state into
the next):
   a. `caesar salad` alone (should now resolve directly via the category-match fix — confirm
      whether it even asks)
   b. `caesar salad` → (if it asks) → `the salad one`
   c. `caesar salad` → (if it asks) → `the first one`
   d. `caesar salad` → (if it asks) → `the 12.95 one`

For (b)-(d), if (a) already resolves without asking, force the ambiguous path some other way
(e.g. an item name that still requires disambiguation after the category-match fix, or
temporarily via a second genuinely-ambiguous pair) and show the same four answer forms working
against that. The requirement is: no form of a reasonable human answer produces a repeated
identical question or the "I got mixed up" error.

Delete your own test rows from `public_tester_sessions`/`order_carts` scoped by session id only.

---

## BLOCKER 3 (real, confirmed, larger than the "needs_options" view shows) — missing option data

`qa_ro.menu_item_option_coverage.needs_options` is a **text-regex heuristic** over
`prompt_for`/`description`/`upsell` — it returns NULL (not false) when all three are NULL, so it
silently fails to flag items that need options but were imported with no descriptive text at
all. Do not trust `needs_options`/`gap` alone; check `group_count = 0` against the categories
below directly.

Live category breakdown, Vito's, active items, right now (`group_count = 0` = has zero option
groups):

```
Angus Burgers & Specialty : 14 items, 14 with zero groups
Appetizers                : 27 items, 26 with zero groups
Cold Sandwiches           :  6 items,  6 with zero groups
Flatbreads                :  6 items,  5 with zero groups
Homemade Paninis          :  8 items,  7 with zero groups
Hot Sandwiches            : 13 items, 11 with zero groups
Wraps                     : 10 items,  8 with zero groups
Stromboli                 : 15 items, 15 with zero groups
Stromboli Rolls           :  8 items,  7 with zero groups
Soups                     :  6 items,  6 with zero groups
Beverages                 :  6 items,  6 with zero groups
Kids' Menu                :  4 items,  4 with zero groups
Baked Pasta               :  3 items,  3 with zero groups
Pizza Finish (Buffalo Ck) :  2 items,  2 with zero groups
```
(Pizza, Salads, Wings, Quesadillas, Entrees, By the Slice already have full option coverage.)

Jason's report named burgers, cold sandwiches, paninis, and flatbreads specifically — those are
confirmed. Before loading data, use judgment (or ask) on categories that may legitimately have
NO options (a canned beverage, a bowl of soup) vs. categories that clearly need them (a burger
needs "how do you want it", a panini/sandwich needs bread/side choices per the existing pattern
already loaded for pizza toppings and salad dressings). At minimum, fix the categories Jason
named as broken: **Angus Burgers & Specialty, Cold Sandwiches, Homemade Paninis, Flatbreads,
Hot Sandwiches, Wraps** (91 items, 82 currently with zero groups). Use the same menu-intake
process already used for pizza/dressings (see `menu-intake` docs/spec history) — load real
option groups/choices from the shop's actual menu source, not placeholders.

**Acceptance:**
1. Run this exact query before and after, paste the output (not a description):
   ```sql
   select category, count(*) as items, sum((group_count=0)::int) as zero_group_items
   from qa_ro.menu_item_option_coverage
   where shop_id = 'e0000000-0000-0000-0000-000000000001' and active
   group by category order by category;
   ```
2. For the six categories listed above, `zero_group_items` must be 0 after the fix (or, for any
   item you determine genuinely has no choices, document why in the PR/commit — don't just
   leave it silently zero).
3. Live transcript: order a burger and a panini item through the public tester and show the bot
   asking a real question with real choices (not "I don't have the list for this one").

---

## COSMETIC (last) — browser tab title

`test-kitchen.html:9` and `public/test-kitchen.html:10`: `<title>Try SprintAI — Test Kitchen</title>`
still says SprintAI while the page body says OrderFare. Update both files' `<title>` to match
current branding. One-line fix, do this last.

---

## Deliverable format

Reply with:
- The live transcript(s) for blocker 1 (all four answer forms).
- The before/after category table for blocker 3 (six named categories at minimum).
- Confirmation the correction on blocker 2 was verified (no rows deleted, migration/data-load
  only).
- `deno check` on changed files — note any PRE-EXISTING errors so we know the count didn't grow.

Not a description of the fix — the transcript and the numbers, exactly as Jason asked.
