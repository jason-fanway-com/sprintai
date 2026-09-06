# SPEC — Menu source priority ladder + aggregator provenance

**From:** Jason → OrderFare · 2026-09-05
**Status:** SPEC ONLY — not built, awaiting Jason's approval.
**Related:** item K (website reader), migration 090 (`confidence_score`), `MenuTab.tsx`
"We have questions" curation surface.

---

## The decision

When we build a shop's menu, try sources in this order and **stop at the first that
yields a usable menu**:

| # | Source | Status today |
|---|---|---|
| 1 | The restaurant's own website | Built — `scrape-shop` → `extract-menu-items` |
| 2 | A printed menu the owner provides (photo or PDF) | Built — `parse-menu-pdf` already accepts PDF **and** image MIMEs (jpeg/png/heic/webp) |
| 3 | The menu on their Google listing | **Not built, and weak — see "Rung 3 problem"** |
| 4 | LAST RESORT: the aggregator (Slice / Toast / ChowNow) | Not built; measured 2026-09-05 |

### Why this order

Aggregator prices are typically marked up, and that markup is how the aggregator makes
money. Importing it into a direct-order channel silently undercuts the entire pitch —
that ordering direct is better for the restaurant. **The owner's own prices are the
product argument.** A menu that quietly carries Slice's markup makes us look identical
to the thing we're replacing.

---

## What the 2026-09-05 measurement actually found

Stated up front because it changes how rung 4 should be built:

- **Slice** — scraper returns a usable menu (151 items, all priced, 16 categories) but
  **zero options, toppings, or sizes**. Pizzas arrive as single-price rows.
- **Toast** — scraper returns **nothing** (0 items). The storefront is a JS app our
  static scrape cannot read. The menu is there (~99 items when rendered in a browser).
- **ChowNow** — returns **nothing**. The link we find is a location-picker; the menu is
  behind a click.
- **Markup:** where an independent comparison was possible (Independent Pizzeria's own
  printed PDF vs its Toast storefront) prices were **identical**, one item cheaper on
  Toast. Slice/Toast/ChowNow are direct-order/POS providers where the restaurant sets
  the price — **not** marketplaces.

**Consequence for this spec:** the markup risk is real but belongs to the *marketplaces*
— DoorDash, UberEats, GrubHub — not to the three platforms named in rung 4. Rung 4 as
written targets the platforms least likely to mark up. Two options, Jason's call:

- **(A) Keep rung 4 as specified.** Treat all aggregator sources as suspect regardless.
  Costs nothing, stays conservative, and the provenance/warning machinery below is the
  same either way.
- **(B) Split rung 4 into 4a (direct-order platforms: Slice/Toast/ChowNow) and 4b
  (marketplaces: DoorDash/UberEats/GrubHub, never auto-imported).** More honest to what
  we measured. **Recommended** — but it is a change to your stated ladder, so I am not
  assuming it.

Everything below works unchanged under either option.

---

## A. Provenance — how it is stored

Two levels, because Jason asked for both menu and item. Item level is not redundant:
after a bulk price correction, per-item provenance is the only thing that tells us which
prices are still aggregator-derived and which the owner has fixed.

### A1. Menu level — extend `menus`

`menus.source` already exists and carries `'pdf' | 'csv' | 'manual'`. Extend the
vocabulary to name the rung:

```
'website' | 'owner_upload' | 'google' | 'aggregator' | 'csv' | 'manual'
```

Add one column:

```sql
ALTER TABLE menus ADD COLUMN source_detail jsonb;
-- { "rung": 4,
--   "platform": "slice",
--   "url": "https://slicelife.com/restaurants/ny/...",
--   "fetched_at": "2026-09-05T13:00:00Z",
--   "rungs_tried": [
--     {"rung":1,"source":"website","result":"no_priced_items"},
--     {"rung":2,"source":"owner_upload","result":"not_provided"},
--     {"rung":3,"source":"google","result":"no_menu_available"},
--     {"rung":4,"source":"aggregator","result":"ok","items":151}
--   ] }
```

`rungs_tried` is the part that matters for honesty later. It records *why* we fell
through to the aggregator, so when an owner asks "why are these prices wrong" we can
answer "we couldn't read your website, and you hadn't sent us a menu" — not guess.

### A2. Item level — extend `menu_items`

```sql
ALTER TABLE menu_items ADD COLUMN source     text;  -- same vocabulary as menus.source
ALTER TABLE menu_items ADD COLUMN source_ref text;  -- the exact URL/file the row came from
```

Backfill existing rows from their menu's source; default new rows to the menu's source.

**Reuse, do not duplicate:** `menu_items.owner_edited` (boolean) already exists and
already means "the owner changed this". That is the correct marker for a corrected
price — no new column. An item with `source='aggregator'` and `owner_edited=true` is a
price the owner has fixed; `owner_edited=false` is a price we are still quoting on the
aggregator's authority.

### A3. Why not `menu_items.meta` jsonb

`meta` exists and would hold this without a migration, but provenance needs to be
*queryable* — "show me every shop still quoting aggregator prices" is a question we will
ask repeatedly, and it should be an indexed column, not a JSON scan.

---

## B. Telling the owner plainly

When `menus.source = 'aggregator'`, the Menu tab shows a banner **above** the existing
curation section. Plain language, no jargon, no file paths:

> **These prices came from Slice, not from you.**
> We couldn't read a menu on your website, so we used your Slice page to get you
> started. Ordering sites often list higher prices than the shop charges directly —
> please check these against what you actually charge. Fixing them here takes a
> minute, and your customers will see your prices, not Slice's.

The platform name and the reason are read from `source_detail`, so the sentence is true
for the specific shop rather than generic.

---

## C. Bulk correction — ONE review surface, not two

**Route into the existing surface.** `MenuTab.tsx` already has a "We have questions"
section driven by `flag_review` + `flag_reason`, rendering a single list. Aggregator
items are simply low-confidence items:

```
confidence_score = 0.5          (below the 0.75 flag threshold)
flag_review      = true
flag_reason      = "This price came from Slice and may be higher than yours. What do you charge?"
```

No new page, no new route, no second review UI.

### What changes in that section

It is already a single list — it is missing only the editable field. Three additions:

1. **An inline price input on each row.** Today the row shows `$14.99` as static text
   next to a "Looks right" button. It becomes an editable number field, pre-filled with
   the imported price, with the item name and category beside it. Sixty items = sixty
   fields on **one scrollable list**. No per-item screen, no modal, no pagination.
2. **One "Save all prices" button**, sticky at the bottom of the section, enabled only
   when something is dirty, showing the count ("Save 12 changed prices"). One batched
   `UPDATE`, not sixty round-trips.
3. **A "These are all correct" bulk action**, for the owner whose aggregator prices
   happen to match. Clears the flags without requiring sixty individual clicks.

On save, per changed row: `price_cents` = new value, `owner_edited = true`,
`flag_review = false`, `confidence_score = 1.0`. Rows confirmed as-is get the same
except `price_cents` is untouched and `owner_edited` stays false — so we retain the fact
that the price is still the aggregator's number, merely confirmed.

### Sort order

Highest-price items first within the flagged list. If an owner corrects only the first
ten of sixty, those ten are where the money is.

---

## D. The go-live consequence — needs Jason's explicit yes

`go-live` already blocks launch when any `flag_review = true` row exists on the menu
(`supabase/functions/go-live/index.ts`). Since this spec flags every aggregator-sourced
item, **an aggregator-sourced shop cannot go live until the owner has been through the
price list.**

I believe that is exactly right — it is what enforces (b) and (c), and it prevents a shop
launching on prices nobody verified. But it is a real gate: an owner who ignores the
list stays blocked. Confirm you want it, and I'll leave it; say otherwise and I'll spec a
softer path.

---

## E. The rung 3 problem — stated honestly

**Rung 3 (Google listing menu) is the weakest rung and is not close to buildable today.**

- Our `google-places-lookup` function requests `rating`, address, and phone. It does not
  request menu data.
- The Places API (New) exposes **no structured menu**. There is no field that returns
  items and prices. At best it returns a `websiteUri` (which is rung 1, already tried
  and already failed by the time we reach rung 3) and sometimes a menu *link* pointing
  at — in practice — an aggregator, which is rung 4.

So rung 3 as written would, most of the time, either re-try rung 1 or short-circuit to
rung 4 wearing a different hat. Options:

- **(A) Drop rung 3**, making the ladder website → owner upload → aggregator.
- **(B) Keep rung 3 as a stub** that only fires when Places returns a non-aggregator
  menu URL we haven't already tried — rare, cheap, occasionally right. **Recommended.**
- **(C) Spike it first** — one day measuring what Places actually returns for our 20
  sample shops before committing.

I did not pick for you. It changes the ladder you specified.

---

## F. Build order (when approved)

1. Migration: `menus.source_detail`, `menu_items.source`, `menu_items.source_ref`;
   backfill existing rows; extend the `source` vocabulary.
2. Ladder orchestration in the onboarding/scrape path, writing `rungs_tried`.
3. Aggregator adapter for **Slice only** — it is the only one of the three our scraper
   can currently read. Toast and ChowNow return zero items and would need a rendering
   scrape; out of scope here, flagged as separate work.
4. `MenuTab` changes: banner, inline price fields, "Save all prices", "These are all
   correct".
5. Provenance surfaced in `qa_ro` so we can answer "which shops are on aggregator
   prices" without a production query.

---

## G. Acceptance

1. A shop whose website yields no priced items and who uploads no menu falls through to
   the aggregator, and `menus.source_detail.rungs_tried` records all four attempts.
2. Every aggregator-sourced item carries `source='aggregator'` and `source_ref` = the
   exact storefront URL.
3. The Menu tab shows the named-platform banner, and every aggregator item appears in
   the **existing** "We have questions" list — no second review surface exists anywhere
   in the app.
4. An owner corrects 60 prices in one scrolling list with one save. No per-item screen.
5. Corrected items show `owner_edited=true` and no longer flag; confirmed-as-is items
   clear the flag but retain `owner_edited=false`.
6. A shop on unreviewed aggregator prices cannot pass `go-live`.

---

## H. Open questions for Jason

1. **Rung 4 split** — keep as one rung (A), or split direct-order vs marketplace (B,
   recommended)?
2. **Rung 3** — drop (A), stub (B, recommended), or spike first (C)?
3. **Go-live gate** — confirm aggregator-sourced shops should be blocked until reviewed.
4. **Toast/ChowNow** — they return zero items today. Accept Slice-only for now, or is a
   rendering scraper in scope?
