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
   rendering scraper in scope? — **Answered below, 2026-09-08.**

---

## I. Addendum — Toast/ChowNow re-measured, 2026-09-08

Closes open question H4. Vigil 8fb959a1/b00e76f6: close the Toast/ChowNow zero-item gap.

**Finding: the two platforms fail for different reasons, and only one is fixable
without adding real infrastructure.**

- **ChowNow — fixed.** Its storefront is a client-rendered SPA whose menu hydrates
  ~1-5s *after* the initial HTML response; a plain Firecrawl scrape (rung 4's
  behavior before this change) reads the page before that happens and gets an empty
  shell. Firecrawl's `/scrape` accepts a `waitFor` (ms) parameter that holds the page
  open before reading it — no headless-render infra of our own needed, no new
  dependency, no code path change beyond passing a number.
  Verified against a real, live ChowNow storefront (`order.chownow.com/order/8581/
  locations/11586`, "The Pizza Shop", 27 Water St) with the exact request the
  updated `scrapePage()` now sends: `waitFor: 5000` returns the full rendered menu
  (109 priced items — pizzas, salads, apps, beverages, all with real prices matching
  what the live page displays). Feeding that markdown through the *existing*
  `extractMenuItems()` LLM prompt (unchanged, same call rung 1/3 already use)
  correctly parsed every item and price. Cost: 1 Firecrawl credit per attempt, same
  as any other rung-4 scrape — `waitFor` does not add to the credit cost.
  Implementation: `getAggregatorWaitForMs(platform)` in `aggregator-render.ts`
  returns 5000 for `"chownow"` and 0 (Firecrawl's default, no extra wait/latency)
  for every other platform — the cost of the wait is scoped to the one platform
  that needs it.
- **Toast — not fixable this way, and re-scoped rather than half-fixed.** A direct
  fetch to a live Toast storefront (`order.toasttab.com/online/pizza-napoli-
  restaurant`) 403s at Cloudflare before the app even runs. Firecrawl's rendered
  scrape gets further (its headless browser executes the JS) but the response is a
  reCAPTCHA challenge page ("Recaptcha requires verification"), not the menu — and
  this held even with a 5s `waitFor` and Firecrawl's own automatic `enhanced`-proxy
  retry (`proxy: "auto"`, the default, already retries with enhanced proxies on
  failure). This is Toast actively detecting and gating automated access, not a
  rendering timing gap — no `waitFor` value or retry closes it. Solving it for real
  would mean CAPTCHA-solving, which is a different class of tool (adversarial to
  the target site, ToS/legal exposure) and was out of scope for this task. Toast
  gets no `waitFor` in `aggregator-render.ts` (stays at 0) since spending latency
  there buys nothing — it still returns the honest `no_priced_items` result rung 4
  already handled correctly (flag-for-review path untouched, no behavior change for
  Toast beyond the comment explaining *why*).

**Firecrawl credit note:** the account was at 41/1000 free-tier credits at the start
of this investigation (34/1000 after — 7 spent testing both platforms). This ladder
already treats Firecrawl calls as a scarce, budgeted resource (see `MAX_PDF_
CANDIDATES`, `LADDER_FALLBACK_ELAPSED_BUDGET_MS` in `index.ts`); the ChowNow fix
adds exactly one more `waitFor`-tagged call at the same 1-credit cost as before, no
new recurring spend. Whoever owns the Firecrawl account should top up before this
sees real traffic — 34 credits covers roughly 34 more rung-1-or-below scrapes total,
website onboarding included.
