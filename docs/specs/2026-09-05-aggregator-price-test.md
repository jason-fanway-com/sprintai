# Aggregator price test — Slice, Toast, ChowNow (2026-09-05)

**Verdict up front:** Toast and ChowNow are unusable as an automated menu source at all —
Toast hard-blocks scraping, ChowNow serves item names but zero prices/options without a
real browser. Slice is scrapeable, but even there you get one flat price per item with
no size/topping options. **No platform tested gives us a usable price+options source.**
The "aggregators mark up prices" question is moot for two of three platforms because we
never got far enough to see a price to compare.

Environment note: this session had no working `$FIRECRAWL_API_KEY` (unset in this repo's
shell), so all fetching below is WebFetch + raw `curl`, no headless browser. **Firecrawl
credits spent: 0.** That is itself relevant to the verdict — see Toast and ChowNow below.

---

## Restaurants tested

| Platform | Restaurant | Address | Aggregator URL | Own site |
|---|---|---|---|---|
| Slice | Family Pizza | 81 W Main St, Meriden, CT 06451 | slicelife.com/restaurants/ct/meriden/06451/family-pizza/menu | meridenfamilypizza.com (Square Online) |
| Toast | Ham's Sandwich Shop | 14200 Wayzata Blvd, Minnetonka, MN | order.toasttab.com/online/ham-s-sandwich-shop | hamssandwichshop.com |
| ChowNow | Ess-a-Bagel (East 51st) | 831 3rd Ave, New York, NY 10022 | order.chownow.com/order/8010/locations/10764 | ess-a-bagel.com / essabagel.com |

All three are real, small/independent, ICP-shaped shops (family pizzeria, sandwich shop,
bagel shop) that also run a separate ordering presence on their own domain.

---

## Slice — Family Pizza (Meriden, CT)

**1. Usable menu?** Yes. The aggregator page returns a full, clean, machine-readable
item+price list with zero JS barrier — over 100 items across 20+ categories scraped
directly from the rendered page.

**2. Options survive?** No. The menu-grid view shows exactly one price per item (its
default size). The item's own description even says "Classic pizza or **create your own
pizza**," implying size/topping selection exists — but it lives behind a per-item
click-through/modal that isn't in the static page. Confirmed independently on the
restaurant's own site (see below) that Classic Pies actually has 5 sizes (Small 10" /
Medium 14" / Large 16" / X-Large 18" / Party 40pc) plus a linked topping-modifier
template. None of that granularity is visible on Slice's list view. **Flat items only.**

**3. Price comparison.** First "own site" candidate, familypizzaofmeriden.com, turned out
to be a **Slice-branded white-label page** ("Powered by Slice" in the footer) — i.e. the
same backend, not an independent price source. Comparing against it would have been
circular. A second, genuinely independent site exists at meridenfamilypizza.com, built on
Square Online (confirmed via its `/fbksg3no/...` Square order-page path and embedded
Square menu JSON) — this is the real comparison.

Matched flat-price items (Slice's non-promotional list price vs. Square site):

| Item | Slice | Own site (Square) | Delta |
|---|---|---|---|
| Cheese Pizza (default size) | $9.99 | $8.99 | +11.1% |
| Signature Gourmet Pie (avg., 22 flavors) | $13.25 | $12.25 | +8.2% |
| French Fries | $3.60 | $4.99 | −27.9% |
| Potato Wedges | $4.73 | $4.99 | −5.2% |
| Parmesan Garlic Bread | $3.14 | $3.99 | −21.3% |
| Parmesan Garlic Bread w/ Cheese | $4.73 | $4.75 | −0.4% |
| Curly Fries | $4.50 | $4.99 | −9.8% |
| Onion Rings | $4.91 | $5.50 | −10.7% |
| Signature Loaded Fries | $6.30 | $6.50 | −3.1% |
| Loaded Potato Wedges | $6.30 | $6.50 | −3.1% |
| Loaded Curly Fries | $6.74 | $6.99 | −3.6% |
| Sweet Potato Fries | $4.28 | $4.25 | +0.7% |

**Average delta: −5.4%** (Slice slightly cheaper on average) — pizzas run ~8–11% *higher*
on Slice, sides run mostly *lower* on Slice. This is not a clean "aggregator marks up"
story; it's mixed, and n=1 restaurant, so it should not be generalized to the platform.
Caveat: the pizza row compares each site's *default* listed size — Slice's list view
doesn't expose which size that is, so this is an approximate, not size-verified, match.
Also not measured: checkout-time service/platform fees on either side, which could move
the real total independently of the item price shown here.

---

## Toast — Ham's Sandwich Shop (Minnetonka, MN)

**1. Usable menu?** No. `order.toasttab.com` returns HTTP 403 with a Cloudflare "Just a
moment..." bot-challenge page. Tested against 3 different restaurant slugs on the
platform (Ham's Sandwich Shop, Mae's Sandwich Shop, Northwest Soup and Sandwich Co.) —
all three hit the identical challenge. This is a platform-wide block, not a
restaurant-specific one; no restaurant swap fixes it.

**2. Options survive?** N/A — never got past the block.

**3. Price comparison.** N/A on the Toast side. The restaurant's own site
(hamssandwichshop.com) *is* independently scrapeable and has real prices (e.g. El Diablo
$9.99, The Train Wreck $10.59, The Ham Stacker $10.49 — 11 warm sandwiches, $9.99–$11.49),
confirming the own-site half of this comparison is possible in principle. There is simply
nothing on the Toast side to compare it to without solving a Cloudflare challenge, which
requires a real browser (none available in this environment — see note above).

---

## ChowNow — Ess-a-Bagel (East 51st, NYC)

**1. Usable menu?** Partially. The page returns HTTP 200 and includes server-rendered
schema.org JSON-LD (`Restaurant` → `hasMenu` → `MenuSection` → `MenuItem`) with 35
sections and 229 item names + descriptions — genuinely useful as a **name/structure**
source. Confirmed the same pattern (names only) on a second ChowNow restaurant (The Bagel
Factory), so this is a platform behavior, not a one-off.

**2. Options survive?** No — the JSON-LD has no offers/price field at all, and by
extension no size/spread/modifier data either. That data is fetched client-side by
ChowNow's React app (`direct.chownow.com/static/js/main.*.js` calling `api.chownow.com`)
after page load; a handful of guessed REST paths (`/v3/order/...`, `/api/order/.../menu`)
all 404'd. Getting it would need a real browser executing the app's JS and its actual
XHR/fetch calls, not a plausible-endpoint guess.

**3. Price comparison.** Not possible — zero prices available from the aggregator side.
(Ess-a-Bagel's own site does publish a menu, but as a PDF that didn't extract to
readable text in this pass, so no verified own-site price list was captured either.)

---

## Bottom line

- **Slice**: scrapeable, gives flat item + one price, no options. For the one shop
  tested, prices track the restaurant's own site within roughly ±10%, not a uniform
  markup — but the missing size/topping data makes it useless as a *complete* price
  source regardless of markup direction.
- **Toast**: fully blocked (Cloudflare challenge on every restaurant tried). Zero data.
- **ChowNow**: item names/structure only, via static JSON-LD. Zero prices, zero options.

None of the three platforms, as scraped here, is usable as a price source. Slice is the
only one worth revisiting as a **name/structure** source (with the restaurant's own price
list layered on top, never the aggregator's) — and even that needs a size-matching
solution, since Slice's list view collapses multi-size items to one number. Toast and
ChowNow would need real browser automation (Cloudflare-solving + JS execution) before
this question is even re-askable for them.
