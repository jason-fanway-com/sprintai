# Item K — Website Read Reliability (measurement only)

**Date:** 2026-09-05
**Scope:** PROVE the website-read path against 20 real small-restaurant sites. Measurement only — no product code changed, nothing deployed, nothing "fixed."
**Verdict:** **0/20 sites produced a usable menu. The read path extracts ZERO menu items and ZERO hours for 100% of real restaurants, while reporting success.** Honest red.

---

## 1. What was driven, and how

- **Path under test:** the deployed Supabase edge function `scrape-shop` (project `rvdqfxtrskxekfkqnegx`), driven over the network. Not reimplemented, not stubbed.
- **Real contract (read from `supabase/functions/scrape-shop/index.ts`):** the function takes `{ shop_id }` — **not a URL**. It reads `shops.website_url` from the DB, then:
  1. Firecrawl `/map` to discover pages → `prioritizePages()` keeps up to 8, **skipping `.pdf`, images, css/js, sitemaps**.
  2. Firecrawl `/scrape` each page → markdown (+ rawHtml on homepage for JSON-LD/footer).
  3. Three LLM calls via **OpenRouter** (`anthropic/claude-sonnet-4-6`): (a) context/about summary, (b) `extractOpenHours()`, (c) `extractMenuItems()` → inserts into `menu_items` if the shop's menu is empty.
  - It does **not** call `extract-menu-items` or `parse-menu-pdf`; extraction is inline. It never extracts options/modifiers.
- **Endpoint:** `POST https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/scrape-shop`
- **Payload:** `{ "shop_id": "<uuid>" }`
- **Auth:** `Authorization: Bearer <service-role JWT>` + `apikey` (function is not in `config.toml`, so default `verify_jwt=true`; a valid project JWT is required).
- **Harness:** `scripts/tmp-item-K-runner.cjs`. Because the function keys off a DB row, the harness created one throwaway tenant + 20 shops (each with `website_url`) + 20 empty menus, invoked `scrape-shop` per shop, then read back `shops.crawl_status/crawl_error/open_hours` and the `menu_items` rows. Credentials sourced from `~/.openclaw/.secrets` (`SPRINTAI_CHAT_SUPABASE_*`); no secret printed. One pass per site, no retries, no fan-out.

**Prod rows created (see §7 cleanup):** tenant `826c8f24-cc13-41d9-9285-84f7b1a94493` + 20 shops + 20 menus, all under that tenant. Full id map in `scripts/tmp-item-K-ids.json`.

---

## 2. The sample (locked before any run)

20 real independent pizza/bagel/deli/sub shops — the ICP, no chains. List fixed before running so it could not be tuned. Menu **format was pre-classified with a lightweight web fetch (selection only — not the measured path)**; the *actual* format/outcome from the run is authoritative and shown in §4.

| # | URL | Intended bucket |
|---|-----|-----------------|
| 1 | independent-pizzeria.com | PDF-only |
| 2 | newcitypizzeria.com | PDF-only |
| 3 | spinnatoshoagies.com | PDF-only |
| 4 | ourfamilypizzeria.com | PDF-only |
| 5 | subonehoagie.com | image-only |
| 6 | biaggiopizza.com | JS-heavy |
| 7 | myfamilypizzas.com | JS-heavy |
| 8 | familypizzeriamenu.com | JS-heavy |
| 9 | familypizzeriarestaurantmenu.com | JS-heavy |
| 10 | theindiepizzeria.com | JS-heavy |
| 11 | bagelcafenj.com | multi-menu |
| 12 | bagelfresh.com | multi-menu |
| 13 | delionabagelcafe.com | multi-menu |
| 14 | bagelguysdeli.com | old plain HTML |
| 15 | bagelbarndeli.com | old plain HTML |
| 16 | nybagelewingnj.com | old plain HTML |
| 17 | hoagiesandhops.com | free choice (plain HTML menu) |
| 18 | jerseybagel.com | free choice (HTML menu) |
| 19 | bkpizzeria.com | JS-heavy |
| 20 | orderfamilypizzeriamenu.com | JS-heavy |

**Distribution honesty note.** Required minimum was 4 image-only. I could confirm only **1** genuine image-only ICP site in advance (subonehoagie) despite targeted searching — and that scarcity is itself a finding: today's small restaurants have largely moved their menus onto **third-party JS ordering platforms** (Slice, Toast, Owner.com, ChowNow, order.online) rather than PDFs or images. I did not manufacture image-only sites to hit the quota. The buckets still did their job: the sample is uniformly *hard* (PDFs, JS widgets, cert-broken old HTML, image homepages), so the result is not inflated by easy picks. As it turned out, the read path failed on every bucket identically, so bucket mix did not change the outcome.

---

## 3. Grading bar (applied uniformly)

The purpose of `scrape-shop` is to auto-read the site and hand the owner a starting **menu** (items + prices), **hours**, and an **about** blurb.

- **PASS** — crawl succeeded **and ≥1 menu item was extracted with a price** (feature delivered its core value).
- **PARTIAL** — crawl succeeded and the about/context summary was saved, but **zero menu items** were extracted (owner gets a blurb, must hand-enter the entire menu; hours also empty).
- **FAIL** — function error or no usable output at all.

A run that returns rows but drops prices or options would be PARTIAL — moot here, since no run returned any rows.

---

## 4. Per-site results (live, deployed function)

`ext` = `menu_items_extracted` from the function's own JSON response. `db` = rows found in `menu_items`. `hrs` = days with hours. All times wall-clock.

| # | URL | HTTP | fn ok | pages scraped | ext | db | priced | options | hrs | ms | Grade |
|---|-----|------|-------|---------------|-----|----|--------|---------|-----|----|-------|
| 1 | independent-pizzeria.com | 200 | ✓ | 9 | 0 | 0 | 0 | 0 | 0 | 53464 | PARTIAL |
| 2 | newcitypizzeria.com | 200 | ✓ | 8 | 0 | 0 | 0 | 0 | 0 | 70206 | PARTIAL |
| 3 | spinnatoshoagies.com | 200 | ✓ | 9 | 0 | 0 | 0 | 0 | 0 | 28336 | PARTIAL |
| 4 | ourfamilypizzeria.com | 200 | ✓ | 7 | 0 | 0 | 0 | 0 | 0 | 29452 | PARTIAL |
| 5 | subonehoagie.com | 422 | ✗ | — | 0 | 0 | 0 | 0 | 0 | 8157 | **FAIL** |
| 6 | biaggiopizza.com | 200 | ✓ | 9 | 0 | 0 | 0 | 0 | 0 | 139131 | PARTIAL |
| 7 | myfamilypizzas.com | 200 | ✓ | 9 | 0 | 0 | 0 | 0 | 0 | 109343 | PARTIAL |
| 8 | familypizzeriamenu.com | 200 | ✓ | 2 | 0 | 0 | 0 | 0 | 0 | 108084 | PARTIAL |
| 9 | familypizzeriarestaurantmenu.com | 200 | ✓ | 2 | 0 | 0 | 0 | 0 | 0 | 115518 | PARTIAL |
| 10 | theindiepizzeria.com | 200 | ✓ | 2 | 0 | 0 | 0 | 0 | 0 | 10855 | PARTIAL |
| 11 | bagelcafenj.com | 200 | ✓ | 9 | 0 | 0 | 0 | 0 | 0 | 32384 | PARTIAL |
| 12 | bagelfresh.com | 200 | ✓ | 2 | 0 | 0 | 0 | 0 | 0 | 19682 | PARTIAL |
| 13 | delionabagelcafe.com | 200 | ✓ | 9 | 0 | 0 | 0 | 0 | 0 | 110333 | PARTIAL |
| 14 | bagelguysdeli.com | 200 | ✓ | 1 | 0 | 0 | 0 | 0 | 0 | 21353 | PARTIAL |
| 15 | bagelbarndeli.com | 200 | ✓ | 4 | 0 | 0 | 0 | 0 | 0 | 26902 | PARTIAL |
| 16 | nybagelewingnj.com | 200 | ✓ | 6 | 0 | 0 | 0 | 0 | 0 | 21487 | PARTIAL |
| 17 | hoagiesandhops.com | 200 | ✓ | 9 | 0 | 0 | 0 | 0 | 0 | 114020 | PARTIAL |
| 18 | jerseybagel.com | 200 | ✓ | 8 | 0 | 0 | 0 | 0 | 0 | 62639 | PARTIAL |
| 19 | bkpizzeria.com | 200 | ✓ | 9 | 0 | 0 | 0 | 0 | 0 | 56175 | PARTIAL |
| 20 | orderfamilypizzeriamenu.com | 200 | ✓ | 2 | 0 | 0 | 0 | 0 | 0 | 114084 | PARTIAL |

**Totals:** menu items extracted across all 20 = **0**. Sites that scraped ≥1 page = **19/20**. Sites reporting `ok:true` = **19/20**. Median wall time ≈ 55s; slowest 139s (biaggiopizza).

### Rates
- **PASS (success): 0/20 = 0%**
- **PARTIAL: 19/20 = 95%**
- **FAIL: 1/20 = 5%**
- Menus with prices: **0%**. Menus with options/modifiers: **0%**. Hours captured: **0%**. About/context blurb saved: **95%** (the only thing that works).

---

## 5. Root cause (confirmed, not inferred)

Every site scraped text fine (19/20 got pages), the **about summary saved on 19/20**, yet **menu and hours came back empty on all 20**. The difference between the call that works and the two that fail is a single line.

- The **summary** call uses the raw text of `message.content` — it never parses JSON, so it works.
- `extractOpenHours()` and `extractMenuItems()` both send OpenRouter `response_format: { type: "json_object" }` and then do:
  ```js
  const raw = (data?.choices?.[0]?.message?.content ?? "").trim();
  const parsed = JSON.parse(raw);   // throws
  ```

I replicated the exact `extractMenuItems` request against OpenRouter (`anthropic/claude-sonnet-4-6`, `response_format:json_object`) with a 4-item menu. **HTTP 200**, valid data — but the content came back **wrapped in a markdown code fence**:

```
```json
{ "items": [ { "name": "Margherita Pizza", "price_cents": 1499, ... } ] }
```
```

`JSON.parse("```json\n{...}\n```")` throws a `SyntaxError`. Both functions catch it and `return null` → **0 items, 0 hours, on every input**. `response_format:json_object` is **not honored** by the Anthropic-on-AWS provider behind OpenRouter; it returns fenced markdown, and the function does not strip the fence.

This is deterministic and total: it is not a per-site or per-format problem. **The menu/hours extraction has a 0% success rate for structural reasons, independent of the website.**

---

## 6. Failure modes, ranked by frequency

**1. Empty menu + empty hours from unstripped ```json fence (20/20, 100%).**
Root cause above. `JSON.parse` on fenced output throws → `null` → nothing extracted.
- *Owner sees today:* nothing about a failure. On the completion card the About blurb renders, hours show **"Hours: Not available"**, and the menu tab is silently empty. (`signup-page/setup.html:1094` renders `Hours: Not available`; the onboarding step "Upload your menu" simply stays unchecked, `OnboardingWizard.tsx:38`.)
- *Suggested replacement (suggestion only):* fix the parse (strip a leading ```json / trailing ``` fence, or use a JSON-mode-honoring model) — but until then the owner-facing copy should not imply the menu was read. e.g. *"We saved a summary of your site. We couldn't pull your menu automatically — add or paste it below and we'll format it for you."*

**2. False success — `ok:true` with zero menu/hours (19/20, 95%).**
The function returns `{ ok:true, menu_items_extracted:0 }` and sets `crawl_status:"done"`, so every layer above treats a total extraction failure as a win.
- *Owner sees today:* the green "done" state (About text + "Hours: Not available"), no error.
- *Suggested replacement:* treat `menu_items_extracted === 0` as a soft-fail state, not `done`. Copy: *"We read your website but couldn't find a menu we could import. Upload a photo or PDF, or add items below."* (Also: don't report `ok:true` when both structured extractions returned null.)

**3. Options/modifiers never captured (20/20, 100%).**
The extraction schema is `{name, price_cents, category, description}` only; `menu_items.modifiers_json` is never written. Even a fixed extractor would import flat items with no sizes/toppings/choices.
- *Owner sees today:* n/a (no items at all today); once #1 is fixed, items would appear with no options.
- *Suggested replacement:* add modifiers/options to the extraction schema and the prompt; surface uncaptured options as a flagged question in the menu tab.

**4. Menu lives off the shop's own domain / in a format the crawler drops (large subset).**
Real ICP menus increasingly sit in third-party ordering widgets (Slice, Toast, Owner.com, ChowNow, order.online) on other domains, or as PDFs/images. `prioritizePages()` skips `.pdf` and images, and Firecrawl `/map` only sees the shop's own domain — so the menu text often isn't in what gets scraped. Evidence: the Slice/Toast SPA sites (#8, 9, 10, 20) discovered only **1 page**; PDF-menu sites (#1–4) had their menu file filtered out. This is a ceiling even after #1 is fixed.
- *Suggested replacement:* follow the ordering-platform link, and stop skipping PDFs — route PDFs to `parse-menu-pdf` (which exists) instead of discarding them.

**5. Image-only / text-less homepage → hard 422 (1/20).**
subonehoagie.com (Wix, menu as photos) returned **"No readable text found on website"** — Firecrawl got no text.
- *Owner sees today:* `signup-page/setup.html:469` — **"⚠️ Couldn't scan your website. You can still continue — just add details below."** (with `" No readable text found on website"` appended).
- *Suggested replacement:* this copy is actually fine; keep it, and add an obvious "Upload a menu photo instead" action right beside it (the ICP that fails here is exactly the one that keeps its menu as an image).

---

## 7. Cleanup

All prod rows were created under a single throwaway tenant so cleanup is one cascade delete.
- **Tenant:** `826c8f24-cc13-41d9-9285-84f7b1a94493` ("ITEMK Measurement (delete me)")
- 20 shops + 20 menus under it (ids in `scripts/tmp-item-K-ids.json`).
- Deleted via `node scripts/tmp-item-K-runner.cjs cleanup` (tenant delete → cascades to shops → menus → menu_items). Deletion status recorded at run time; see §8.
- No shop rows left behind in any real tenant. The three `scripts/tmp-item-K-*` files are measurement artifacts, not committed as product code.

## 8. Bottom line

The website-read path, a core first-impression feature, **imports no menu at all** for real restaurants — 0/20, driven live against the deployed function — because Claude-via-OpenRouter returns fenced JSON and the extractor `JSON.parse`s it without stripping the fence. It fails silently (`ok:true`, "done"), so an owner finishes onboarding believing their site was read while their menu is empty. This is a deterministic, single-cause break, not a long-tail reliability issue. Not fixed here (measurement only); the one-line-ish fix and the copy changes above are recommendations.

---

# After the fix (commit 838b2f9) — re-measurement, 2026-09-05

**Verdict: fixed. The single-cause 0% break is gone.** Re-driven live against the deployed `scrape-shop` (project `rvdqfxtrskxekfkqnegx`, fix confirmed deployed) over the **exact same 20 locked sites**, fresh throwaway tenant, one shop per site, `{shop_id, force:true}`.

## Rates (before → after)
| Metric | Baseline | After fix |
|---|---|---|
| **PASS** (≥1 priced menu item) | **0/20 (0%)** | **6/20 (30%)** |
| **PARTIAL** (site read, 0 items) | 19/20 (95%) | 14/20 (70%) |
| **FAIL** (error / no output) | 1/20 (5%) | **0/20 (0%)** |
| **Honesty** (crawl_status matches DB) | 5% (19 false "done") | **100% (0 false "done")** |
| Hours captured | 0/20 | 14/20 |

The parse fix works. Six sites imported real, priced menus where baseline got zero: newcitypizzeria (25), subonehoagie (36), myfamilypizzas (73), bagelfresh (149), delionabagelcafe (59), hoagiesandhops (88) — **all items priced**. `subonehoagie` was a hard 422 in baseline; now 36 items. `extractOpenHours` also fixed: hours on 14/20 (was 0).

**Honesty check: perfect.** All 6 "done" have items; all 14 "partial" have 0 items; no site claimed "done" over an empty menu. The false-success bug that told owners their menu was read is closed.

**Hallucination spot-check (3 PASS shops, item names + prices vs live sites):** hoagiesandhops ("Brotherly Love" $9.25, "Hog Island" — found live), myfamilypizzas ("Alfredo Pizza", "Supreme", $12.99 — found), subonehoagie ("Philly Steak" $9.39, "Supreme Steak" — found). **Real menus, not hallucinated.**

## Measurement note — first run was contaminated (Firecrawl rate limit), discarded
The first (unpaced) re-run ran 20 crawls in ~44s and collapsed: sites 1-2 scraped fine, then cascaded to "No readable text" and "Firecrawl /map failed" at ~350ms (429s). Firecrawl account is healthy (direct `/map` = 200, 575/1000 credits). `scrape-shop` has **no retry/backoff on a Firecrawl 429** (`discoverPages` throws straight through). Baseline never hit this because each crawl took 30-139s, spacing calls out. Re-ran with 45s between sites → clean, 0 Firecrawl failures. Numbers above are the paced run.

## Ranked remaining failure modes (the 14 PARTIALs — all honest, none are regressions)
1. **PDF menus, dropped by design (largest bucket).** Sites read 8-9 pages, 0 items (1,3,4,6,11,15,16,18,19). `prioritizePages` skips `.pdf` and `wp-content/uploads`; confirmed independent-pizzeria's menu is `IP-PrintMenu-March.pdf`. `parse-menu-pdf` exists but `scrape-shop` never routes to it. **Biggest single lever for lifting 30% → higher.**
2. **Menu behind JS / off-domain ordering widget.** `/map` discovers only 1-2 pages (8,9,10,14,20 — Slice/Toast/Owner.com SPAs). Menu text isn't on the shop's own domain.
3. **No Firecrawl 429 retry/backoff.** Not a per-site failure, but destroyed the unpaced batch run 18/20. Production onboards one shop at a time so it won't trip there; any batch/backfill will collapse. Add exponential backoff.
4. **Options/modifiers still not captured.** Extraction schema is flat (`name, price_cents, category, description`); `modifiers_json` never written. PASS items are correct but size/topping choices are lost. (Not graded a FAIL — pre-existing.)

## Cleanup
Throwaway tenant `e8b92edd-428c-4251-ab21-1b140d287a30` (paced run) cascade-deleted; verified 0 shops remain. The earlier contaminated tenant was also deleted (0 shops). Artifacts: `scripts/tmp-item-K-after-runner.cjs`, `-after-ids.json`, `-after-results.json`, `-after-run.log` — measurement only, not product code.

## Bottom line (after)
The deterministic 0% parse break is fixed: **6/20 now import real, correctly-priced menus, 0 hallucinations, 0 false-success, 0 hard failures.** The remaining 70% are honest PARTIALs — the crawler can't reach menus that live in PDFs or off-domain ordering widgets, which the fix never claimed to solve. Routing PDFs to `parse-menu-pdf` is the highest-value next step; add Firecrawl 429 backoff before any batch re-crawl.

---

# Third measurement — against the source-priority ladder, 2026-09-05

**Verdict: 6/20 → 12/20 (60%) PASS. The PDF routing paid off; two of the biggest menus now die to an edge-function wall-clock timeout, which is the new top failure mode.** Re-driven live against the deployed `scrape-shop` (project `rvdqfxtrskxekfkqnegx`), **exact same 20 locked sites, same order**, fresh throwaway tenant, one shop per site, `{shop_id, force:true}`, paced 45s between sites. Deployed function confirmed current: response carried `menu_source` + `rungs_tried` (the ladder).

## Rates (baseline → after-fix → now)
| Metric | Baseline | After fix | **Now (ladder)** |
|---|---|---|---|
| **PASS** (≥1 priced item) | 0/20 (0%) | 6/20 (30%) | **12/20 (60%)** |
| **PARTIAL** (site read, 0 items) | 19/20 (95%) | 14/20 (70%) | **6/20 (30%)** |
| **FAIL** (error / no output) | 1/20 (5%) | 0/20 (0%) | **2/20 (10%)** |
| **Honesty** (no false "done") | 5% | 100% | **100% (0 false "done")** |
| Hours captured | 0/20 | 14/20 | 13/20 |

974 priced items across the 12 PASS sites; item names/prices spot-checked against live sites (Spinnato "Original Italian" $10.49, hoagiesandhops "Brotherly Love (Regular)" $14.00, subonehoagie "Philly Steak" $9.39) — real, not hallucinated. Median wall time 80s; **max 150s (the timeout ceiling)**. Options/modifiers: **0/20** (flat schema, unchanged). Firecrawl credits **258 → 121 (137 used)**.

## Per-rung win counts (12 PASS)
- **Rung 1 — own site, HTML: 8** (2,5,6,7,8,12,13,17)
- **Rung 1 — own site, PDF (routed to `parse-menu-pdf`): 4** (1,3,4,18)
- Rung 3 (Google listing): **0**
- Rung 4 (aggregator): **0**

**Did rung 3 (Google listing) ever fire? No.** It was *reached* on all 6 PARTIAL sites but short-circuited at `no_place_id` every time — freshly created shops (like a shop pre-geocode in real onboarding) carry no `google_place_id`, so `tryGoogleListingRung` returns before any Places lookup or scrape. **Rung 3 remains completely unmeasured — no evidence it works, and this run provides none.**

**Rung 4 (aggregator) fired twice, won zero:** site 10 (Toast) and site 11 (ChowNow), both `no_priced_items` — their storefronts are JS apps a static scrape can't read, exactly as the code comments predict. No Slice rung-4 win appeared because the Slice sites here serve their menu on their *own* domain (caught as a white-label backend, read via rung-1 HTML instead).

## Did PDF routing rescue the PDF bucket? Mostly yes.
Last time's PDF-shaped PARTIALs were 1,3,4,6,11,15,16,18,19. Now: **1,3,4,18 PASS via the PDF rung; 6 PASS via HTML** (biaggiopizza's menu turned out to be HTML, 124 items). Still PARTIAL: 11 (ChowNow), 15, 16, 19 — no reachable priced menu on the own domain and no aggregator link to follow. So PDF routing converted the true own-domain PDF sites; the leftover PARTIALs were never really own-domain PDFs.

## White-label costume (`source=website` over an aggregator backend)
`on_domain_backend` was detected on **9 sites**: 1 toast, 2 slice, 6 owner, 7 owner, 8 slice, 9 slice, 10 toast, 11 chownow, 17 toast. On the 6 PASS sites among them (1,2,6,7,8,17) the menu was read directly off the shop's own domain and the prices are the restaurant's own, so `source=website` is defensible — **and provenance records `on_domain_backend` so independence is not overstated. Working as designed** — except on PDF-rung wins where the record is dropped (failure mode #2).

## Honesty
**0 false "done"** — all 12 "done" have priced items, all 6 "partial" have 0. The original defect stays closed. **But two rows are stuck `crawl_status="running"`** (sites 9, 20) — see failure mode #1. Not a false "done", but a broken terminal state: site 9 has a full 240-item priced menu orphaned under a shop that never reached "done".

## Ranked remaining failure modes
1. **Edge-function wall-clock timeout on the largest menus (2/20 — sites 9, 20).** Both 504 at ~150s. `MENU_LLM_TIMEOUT_MS=170s` is set *longer than the platform's ~150s function ceiling*, so the biggest menus are killed at the gateway before the function returns. Site 9's 240 priced items **did** land in the DB, but the shop is stuck `running` (never written to `done`); site 20 got nothing. This is the exact class the timeout bump meant to save, now failing one rung up. **Top lever — the menu LLM budget must fit inside the function's own wall clock.**
2. **Provenance not persisted on PDF-rung wins (4/20 PASS — sites 1,3,4,18).** `parse-menu-pdf` *replaces* the shop's menu row; `scrape-shop` then writes `source_detail` to the old (now-deleted) menu id, so `menus.source_detail` is **null** on exactly the PDF wins — rung, `rungs_tried`, and `on_domain_backend` are lost from the DB (they survive only in the response body). Site 1's `on_domain_backend=toast` is therefore not durable. Menu is correct; the provenance/white-label record is dropped.
3. **Menu behind Toast/ChowNow JS storefront, unreadable by static scrape (~4/20 — 10,11 + own-domain-empty 14,15,16,19).** Rung 4 reaches them and scrapes, but a static fetch returns no priced items. A rendering scraper is out of scope.
4. **Rung 3 (Google listing) still unmeasured.** Short-circuits at `no_place_id` on every shop that lacks a `google_place_id`. Until a shop with a place id and an off-domain listing URL is driven through it, we have zero evidence it extracts anything.
5. **Options/modifiers never captured (0/20).** Flat extraction schema (`name, price_cents, category, description`); `modifiers_json` never written. Pre-existing, unchanged.

## Harness note (measurement integrity)
`scrape-shop`'s PDF rung swaps the menu row out from under the pre-created menu id, so the first-pass per-site DB counts (keyed to the created `menu_id`) undercounted PDF wins. Ground truth was re-read by `shop_id` (current menu row) in a read-only post-pass — that is the source of the numbers above. Artifacts: `scripts/tmp-item-K-remeasure2-runner.cjs`, `-postpass.cjs`, `-ids.json`, `-results.json`, `-final.json`, `-run.log` — measurement only, not product code.

## Cleanup
Throwaway tenant `25107b45-256f-4800-8f8e-87781120764c` cascade-deleted; independent post-delete queries confirm 0 tenant / 0 shops / 0 menus / 0 menu_items remain.

## Bottom line (third measurement)
**Doubled from 6/20 to 12/20 (60%) with 0 false-success and real, correctly-priced menus.** PDF routing did its job (4 clean PDF wins). The new ceiling is a wall-clock timeout that kills the two largest menus (one orphaning a full 240-item menu in a stuck `running` state) — the menu LLM timeout is set longer than the function can live. Rung 3 is still unproven (never fires without a place id); rung 4 reaches Toast/ChowNow but a static scrape can't read them. Highest-value next fix: make the menu extraction budget fit inside the function's wall clock, and persist provenance on PDF-rung wins.

---

# Fourth measurement — the two timeout fixes, 2026-09-05 23:39 EDT

**Verdict: both failure modes named in the third measurement are fixed and verified live on deployed `scrape-shop` v73 — and the fix cost us a menu.** Targeted re-run of exactly the three sites the fixes were aimed at (9, 20 = the 504 pair; 3 = the PDF-rung provenance case), fresh throwaway tenant, `{shop_id, force:true}`, paced. 13 Firecrawl credits (121 → 108). Artifacts: `scripts/tmp-item-K-timeoutfix-runner.cjs`, `-ids.json`, `-results.json`, `-run.log`.

## Failure mode #1 — wall-clock 504 → FIXED, at a cost
| Site | Before (v72) | After (v73) |
|---|---|---|
| 9 familypizzeriarestaurantmenu.com | HTTP **504** @150s, `crawl_status` stuck **`running`** forever, **240 priced items orphaned** under it | HTTP **200** @135s, terminal **`partial`**, owner-facing message written, **0 items** |
| 20 orderfamilypizzeriamenu.com | HTTP **504** @150s, stuck **`running`**, 0 items | HTTP **200** @135s, terminal **`partial`**, **0 items** |

No more gateway 504. No more stuck `running`. Every run now reaches a terminal status and tells the owner the truth ("We read your website but couldn't find a menu with prices"). That closes ledger `16d6a67a` — the caller no longer sees a failure on a success, because there is no longer a half-finished run.

**But site 9 got worse in the way that matters to a restaurant.** Last run it 504'd *after* landing a real 240-item priced menu in the DB. This run it returns cleanly with nothing. Rung 1 reported `no_priced_items` after scraping only **2 pages** (site 3, unaffected by the budget, scraped 9). Rungs 3 and 4 were then skipped with the new `skipped_elapsed_budget` result. The deadline-aware budget appears to be cutting the crawl short before the page holding the menu is ever fetched — traded a real menu for an honest empty one. Not proven to be causal (the 504 run returned no body, so its `pages_scraped` is unknown), but it is the only changed variable and it is the obvious suspect.

**This is not a net win yet.** Honesty is non-negotiable and we now have it. Losing a readable 240-item menu to buy it is not the trade — the work has to fit inside the wall clock, not be truncated to fit. Tracked as its own ledger item.

## Failure mode #2 — PDF-rung provenance dropped → FIXED
Site 3 (`spinnatoshoagies.com`), the PDF-rung case: `menu_id_swapped=true` (parse-menu-pdf did replace the menu row, as before) and **`sd_persisted=true`, `sd_rung=1`, `db_menu_source=website`, 101 priced items**. Before the fix, `menus.source_detail` was **null** on exactly these PDF wins. The re-resolve-by-`shop_id` write lands. Provenance is now durable on PDF-rung wins.

Sites 9 and 20 also persisted `source_detail` including `on_domain_backend=slice` and the full `rungs_tried` ladder on a *partial* — so the white-label record survives a failed read too, which is what makes the "we read your own site" claim auditable.

## Cleanup
Throwaway tenant `b11108bf-84df-4491-b466-70afa0d3837b` deleted; independently re-queried after the fact — 0 tenants, 0 shops remain.

## Bottom line (fourth measurement)
Both fixes work. The 504-and-stuck-`running` class is gone and PDF provenance is durable. The unresolved cost: the tighter budget looks like it truncates the crawl on the biggest sites, and site 9's 240-item menu no longer imports at all. Item K's headline rate is unchanged at **12/20 (60%)** — sites 9 and 20 were never PASS — but the next fix is to make a big menu fit inside the function's wall clock rather than shrinking the crawl to meet it.
