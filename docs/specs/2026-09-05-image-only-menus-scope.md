# Image-only menus — scope only, not built (2026-09-05)

Many ICP shops publish their menu as a photo of a printed board or a scanned trifold —
not HTML, not extractable-text PDF. Today that path produces nothing. This scopes what
it would take. **No code written.**

**Recommendation up front:** do it with Claude vision (Sonnet 5) in one call per shop,
OCR-and-structure together, gated by a mandatory human side-by-side confirmation before
anything goes live. Reason: at every option the API cost is a few cents per shop — a
rounding error next to the labor cost of the human check every image-sourced price needs
anyway, so optimizing the API layer instead of the review step is optimizing the wrong
thing.

---

## Pipeline stages

1. **Detect image-only.** In the existing scrape-shop / parse-menu-pdf path, when no
   machine-readable menu HTML is found and a linked PDF extracts to ~0 characters of
   text (a scanned/image PDF), or the site links directly to a menu JPG/PNG, flag the
   shop as an image-menu candidate instead of falling through to "no menu found."
2. **Collect images.** For an image-PDF, render each page to an image (standard PDF
   rasterization, not new territory). For a bare photo, use it as-is.
3. **Vision extraction call.** One Claude Messages API call per shop with all of that
   shop's menu images attached, forced through a structured-output schema (item name,
   price, category, size/modifier options) — a single OCR+structuring pass, not a
   separate OCR step feeding a separate LLM step.
4. **Fail closed, per item and per shop.** If an image is too blurry/glared/cropped to
   read a specific price, that item must be dropped or the whole menu marked
   needs-manual — never a guessed or interpolated price. This is the same zero-tolerance
   rule that already governs cart accuracy elsewhere in this repo; it does not get
   relaxed because the source was a photo instead of text.
5. **Human confirmation gate — non-negotiable.** Before an image-sourced menu goes live
   for ordering, a human (owner or ops) reviews the extracted items+prices next to the
   source image, item by item, and explicitly approves. This plugs into the same
   owner-confirmation checkpoint the text/PDF menu-parse path already needs — same gate,
   just fed by vision output instead of text-extraction output. Showing the raw text
   list without the source image next to it is not enough: a misread price is invisible
   to the model itself (it doesn't know it misread), so the check only works if it's a
   photo-to-value comparison, not a plausibility read.

---

## Cost per shop — the arithmetic

Claude image tokens ≈ `(width_px × height_px) / 750` (confirmed via the claude-api skill
and consistent with independent sources). Current Claude API pricing (per the claude-api
skill, cached 2026-06-24):

| Model | Input $/MTok | Output $/MTok |
|---|---|---|
| Opus 5 | $5.00 | $25.00 |
| Sonnet 5 | $3.00 | $15.00 |
| Haiku 4.5 | $1.00 | $5.00 |

Assumptions (stated, not hidden): a typical ICP shop's full menu = **3 photos** (main
board, specials/sides, drinks), each resized to ~1568px on the long edge at a 4:3
portrait ratio (~1176×1568px) — the standard Claude image-input target.

- Tokens per image ≈ (1176 × 1568) / 750 ≈ **2,458** → 3 images ≈ **7,375** input tokens
- Plus one extraction-instruction prompt ≈ 500 tokens → **~7,850 input tokens/shop**
- Output: structured JSON for ~60 items (name+price+category) + options ≈ **~1,300 output
  tokens/shop**

| Model | Input cost | Output cost | **Total / shop** |
|---|---|---|---|
| Opus 5 | 7,850 × $5/1M = $0.0393 | 1,300 × $25/1M = $0.0325 | **≈ $0.072** |
| Sonnet 5 | 7,850 × $3/1M = $0.0236 | 1,300 × $15/1M = $0.0195 | **≈ $0.043** |
| Haiku 4.5 | 7,850 × $1/1M = $0.0079 | 1,300 × $5/1M = $0.0065 | **≈ $0.014** |

**Google Cloud Vision** (`DOCUMENT_TEXT_DETECTION`, $1.50/1,000 units, 1 unit = 1 image):
3 images = 3 units ≈ **$0.0045/shop** for raw OCR text only — no name/price pairing, no
structure. You'd still need an LLM pass afterward to turn raw text into items+prices,
adding a second pipeline stage and a second point of failure, for roughly the same total
cost as just doing it in one Claude vision call.

**AWS Textract** (`DetectDocumentText`, $1.50/1,000 pages): same shape and same cost as
GCV, ≈ **$0.0045/shop** for plain text only. Textract's Forms/Tables APIs ($15/1,000,
10x) buy nothing here — a menu board isn't a structured form.

**Open-source OCR** (Tesseract/PaddleOCR, self-hosted): ~$0 marginal API cost, but no
built-in structuring, materially worse accuracy on angled/glared/handwritten photos than
commercial vision APIs or Claude, and it's infrastructure we'd own and operate. Worse
accuracy for a workload where accuracy is the entire risk is a bad trade even at $0.

**Verdict:** every option is a few cents per shop or less. The dollar difference between
them (a few pennies) does not matter at ICP volumes. What matters is which option gets
you a structured, checkable result in the fewest pipeline stages — that's Claude vision
doing OCR+structuring together, because GCV/Textract/open-source all require a second
LLM pass to get the same structured output Claude gives you in the first call.

---

## Accuracy risk

A misread price (glare turns `$8.99` into `$3.99`, a smudged `1` reads as `7`, a `$` sign
merges with an adjacent digit) is **silently plausible** — it looks like a valid price,
so nothing in the pipeline flags it on its own. This is a cart-accuracy defect, which is
zero-tolerance per the compliance guardrails governing this repo. The only reliable catch
is a human looking at the source image next to the extracted value, per item, before it
ships — self-consistency checks (asking the model to re-read or cross-check its own
output) cannot catch a consistent misread, since the model isn't aware it misread.

## Recommendation

Claude vision (Sonnet 5), one call per shop, OCR+structure combined, mandatory
photo-side-by-side human confirmation before go-live. One-line reason: the cost spread
between every realistic option is pennies, so the deciding factor is pipeline simplicity
and how well the output supports the human check the data requires either way.
