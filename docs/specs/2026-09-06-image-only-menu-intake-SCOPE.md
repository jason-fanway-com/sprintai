# SCOPE — Image-only menu intake (no OCR-able PDF, no website menu)

**From:** subagent scoping pass → OrderFare · 2026-09-06
**Status:** SCOPE ONLY — not built, no code or DB touched. Read-only research against `docs/specs/menu-intake-standard.md`, `docs/specs/2026-09-05-menu-source-priority.md`, `supabase/functions/parse-menu-pdf`, `supabase/functions/scrape-shop`, `supabase/functions/import-menu-csv`.

---

## The gap, stated precisely

`parse-menu-pdf` already **declares** it accepts image MIME types:

```ts
const IMAGE_MIMES = new Set(["image/jpeg","image/jpg","image/png","image/heic","image/heif","image/webp"]);
```

But look at what the multipart branch actually does with a file (`index.ts:88-97`):

```ts
for (const f of (file ? [file, ...files] : files)) {
  if (f.size > MAX_FILE_BYTES) return jsonError(...);
  if (!isImage(f.type)) {
    menuText = menuText || (await extractPdfText(...));   // PDFs get processed
  }
  // images: fall through, nothing happens
}
```

An image never gets read. The function then hits `if (!menuText || menuText.length < 50) return jsonError(...)` and the upload fails with "Menu text is required." **The image path is a declared MIME allowlist with no implementation behind it** — this isn't a small gap, it's a dead branch. That's the actual starting point, not "extend an existing image feature."

---

## 1. What it would take

### The pipeline

```
Owner uploads 2-6 photos
        ↓
[NEW] Preprocessing: EXIF rotation fix, basic blur/glare reject,
       photo ordering (if owner doesn't order them, best-effort by filename/EXIF timestamp)
        ↓
[NEW] Vision extraction: triple-extract, same architecture as the PDF path,
       but content blocks are images, not menuText
        ↓
[REUSE] §A validator, §B consensus/price-agreement logic, content_hash,
        Open Questions, menu_items insert — all already generic over rows,
        not over "how the rows were produced"
        ↓
[REUSE, unchanged] import-menu-csv contract — the 7-column canonical
        CSV is the interface; nothing downstream cares whether the
        rows came from a PDF's text layer or a JPEG
```

### Extraction approach: **vision-direct, not OCR-then-LLM** — with OCR kept as a narrow auxiliary

Two options existed:

- **OCR-then-LLM**: run Tesseract/cloud OCR to get raw text, feed that text into the *existing* `parse-menu-pdf` prompt path unchanged.
- **Vision-direct**: send the images themselves to a multimodal LLM (Claude Opus 5, same model family already in use) and let it read the menu the way a person would.

**Pick vision-direct.** Reasons:

1. **The source material is why this rung exists at all** — laminated boards, handwritten specials, phone snapshots with glare and skew. Traditional OCR is materially worse than a vision-capable LLM on exactly this kind of degraded, non-tabular input; that's the whole reason this rung is hard. Piping bad OCR text into a prompt built for clean PDF text would produce worse results than either approach alone.
2. **The pipeline is already LLM-native.** `parse-menu-pdf`'s triple-extract, consensus gate, and validator all operate on structured JSON from an LLM call — swapping the LLM's *input modality* (image content blocks instead of a text string) reuses that entire downstream machinery untouched. OCR-then-LLM would still need all of that, plus a separate OCR step to build and maintain.
3. **The standard already anticipated this.** `menu-intake-standard.md` line 45: "Source may be a PDF, a photo, or scanned image." The reference standard was written photo-aware; the implementation just never followed through on the image half.

**Where OCR still earns a place — not as the extraction path, but as a narrow, independent price oracle.** The PDF path has a "silent-price gate" (`extractDollarAmounts` + `isPriceInText`): a price all 3 vision passes agree on is only confirmed if that exact number also appears literally in the source text. That's a real defense against a hallucinated-but-consensus price. Images have no text layer, so that gate has nothing to check against today. A cheap, independent OCR pass (Tesseract, self-hosted, near-zero marginal cost — or a cloud OCR API at ~$0.0015/image if self-hosting isn't wanted) run purely to harvest "dollar amounts visible somewhere in this image" gives the same cross-check for free. It doesn't need to be accurate at reading item names or structure — it only needs to catch numbers.

### What's reused vs. genuinely new

| Component | Status |
|---|---|
| Owner upload surface (multipart form, `file`/`files` fields) | **Reuse** — already accepts image MIME types, just needs the dead branch implemented |
| Triple-extract / 3-way consensus / silent-price gate architecture | **Reuse** the pattern; **new** prompt variants that take image content blocks |
| §A deterministic QA validator | **Reuse**, unchanged — operates on rows, not on provenance |
| Content-hash + owner sign-off go-live gate | **Reuse**, unchanged |
| `import-menu-csv` / canonical 7-column contract | **Reuse**, unchanged — this is the whole point of the flat-file contract |
| `menus.source` / `source_detail` provenance (per 2026-09-05 spec) | **Reuse** the column, **new** vocabulary value (`owner_upload_image` or similar) |
| EXIF rotation fix, blur/glare basic quality check | **New** |
| Multi-photo ordering / "these 4 photos are one menu" consolidation prompt | **New** — the existing prompt was written for one continuous text blob; multi-image needs explicit instruction not to duplicate items that appear across overlapping photos |
| OCR auxiliary price-oracle pass | **New**, small — the OCR call/lib, wiring its output into a photo-specific version of `isPriceInText` |
| Forced full-review flag for image-sourced menus (see §3) | **New**, small — a source-conditional override on `flag_review`/`confidence_score` at insert time |

---

## 2. What it would cost per shop

### Pricing basis

`parse-menu-pdf`'s `MODEL` constant is `anthropic/claude-opus-5-fast` via OpenRouter — this maps to Anthropic's Fast Mode on Claude Opus 5, priced at **$10 / $50 per 1M tokens** (in/out). That's the number the arithmetic below uses, matching the model the existing pipeline already pays for. (OpenRouter pass-through pricing should be confirmed against the live OpenRouter rate card before build — this is Anthropic's list price, the basis I have confidence in.)

Image tokenization (Anthropic's published rule): **tokens ≈ (width_px × height_px) / 750**, with images resized to ≤~1.15 megapixels before charging. A representative owner photo (post-resize, ~1150×1534) costs roughly:

```
(1150 × 1534) / 750 ≈ 2,352 tokens/image  →  round to ~2,000 tokens/image
```

### Per-shop arithmetic (midpoint: 4 images, ~250 items+modifiers combined)

**Triple-extract, same as the PDF path — 3 independent passes, temp=0:**

| | per pass | × 3 passes |
|---|---|---|
| Image input tokens (4 × 2,000) | 8,000 | 24,000 |
| Prompt/instruction text tokens | ~1,000 | 3,000 |
| **Total input tokens** | 9,000 | **27,000** |
| Output tokens (≈330 JSON rows × ~80 tok/row, incl. key overhead) | ~27,000 | **81,000** |

```
Input:  27,000 / 1,000,000 × $10 = $0.27
Output: 81,000 / 1,000,000 × $50 = $4.05
                                  -------
Base cost per shop:               $4.32
```

**Retries:** photo quality (blur, glare, partial menus) makes failed/re-run extractions more likely than the PDF path, where text is usually clean. Estimate 30% of shops need one extra full triple-extract pass:

```
$4.32 × 1.3 ≈ $5.62
```

**OCR price-oracle pass:** self-hosted (Tesseract) ≈ $0 marginal; cloud OCR API ≈ $0.0015/image × 4 images ≈ $0.006. Negligible either way.

**→ ≈ $5.63 per shop, call it $5–6.**

### The non-obvious finding

Image *tokens* are cheap — **only ~$0.27 of the $4.32 base cost is the image input itself.** The dominant cost (~94%) is output tokens for the triple-extracted JSON — and that's a cost the **existing PDF pipeline already pays per shop**, image or not. Switching a shop from "clean PDF text" to "photos" barely changes the token bill. What it changes is the **failure rate and the amount of human (owner) review time**, which is a real cost but not a metered one — see §3.

### At scale

Marginal cost is linear — no batching discount applies today (real-time onboarding needs a synchronous response). If overnight batch processing is acceptable for this rung specifically (owner isn't watching a spinner), the Batch API's 50% discount roughly halves it:

| | Real-time | Batched (if applicable) |
|---|---|---|
| 1,000 shops | ~$5,630 | ~$2,800 |
| 10,000 shops | ~$56,300 | ~$28,100 |

---

## 3. Accuracy and the go-live gate

**The core problem: the silent-price gate's strongest defense doesn't transfer to images.** On the PDF path, a price all 3 passes agree on is only confirmed if that exact dollar figure appears literally in the extracted text layer — an independent, non-LLM cross-check. Images have no text layer. The OCR auxiliary pass (§1) restores a version of this, but it's weaker: OCR on a blurry laminated board can misread the same digit the vision model misread, especially if the failure mode is systematic (a "$14" that's genuinely hard to read might get "$11" from *both* the vision model and the OCR pass, because the image itself is ambiguous — not because either system is broken). Triple-extract consensus doesn't catch this either, since three passes of the same model looking at the same bad photo can converge on the same wrong number for the same reason.

This is exactly the failure mode the standard calls unforgivable: **a confidently wrong price that clears every automated gate.**

**Where the existing machinery already helps:**
- The mandatory owner sign-off gate (`menu-intake-standard.md` §C) already requires an explicit, timestamped, content-hash-bound approval before any menu goes live — this doesn't care what rung produced the rows.
- `go-live` already blocks on any `flag_review = true` row (confirmed in the 2026-09-05 source-priority spec, §D) — the enforcement lever already exists in the codebase; it just needs to be pointed at image-sourced rows.

**What's missing, and the recommendation:** for the PDF/text path, only *disagreements* get flagged — an item all 3 passes agree on and that's verified against source text ships with `flag_review = false`, `confidence_score = 1.0`, no owner action required. **That default should not carry over to images.** Given the gate above is genuinely weaker for images, every row from an image-sourced menu should be forced into review regardless of consensus:

```
source = 'owner_upload_image'
  → every menu_item row gets flag_review = true, confidence_score capped at 0.75
  → go-live is blocked until the owner has been through every row, not just the disagreements
```

This is a policy override, not new infrastructure — it's a source-conditional branch at insert time, using the exact `flag_review`/`go-live` mechanism already built for the aggregator rung. **Answering the question directly: no, an image-sourced menu should not be allowed to go live on consensus alone.** Owner line-by-line confirmation should be mandatory for this rung specifically, not optional the way it is for a clean PDF.

---

## 4. Effort estimate and biggest risk

| Piece | Days |
|---|---|
| Image preprocessing (EXIF rotation, blur/glare reject, multi-photo ordering) | 2–3 |
| Vision extraction wiring (adapt triple-extract prompts to image content blocks, implement the dead image branch in `parse-menu-pdf`) | 3–4 |
| OCR auxiliary price-oracle pass + image-specific `isPriceInText` equivalent | 1–2 |
| Forced full-review flag for image-sourced menus + Menu tab copy | 1 |
| Testing against real owner-submitted photos (blur, glare, handwritten boards, multi-page) and tuning | 2–3 |
| **Total** | **~9–13 days (call it 10–12)** |

Most of the estimate's uncertainty is in the last row — the current PDF pipeline was tuned against real menus over multiple passes (see `docs/specs/2026-08-09-menu-intake-accuracy-fix.md`); expect the same iteration cycle here, and it can't be tightened without a real sample set of the specific bad photos this rung exists to handle.

**Biggest risk:** a systematic misread — all 3 vision passes and the OCR oracle agreeing on the same wrong price because the source image is genuinely ambiguous, not because any one system is broken. The mandatory full-owner-review gate in §3 is a real mitigation, but it's a *process* mitigation, not a technical one: it depends on an owner actually reading 200+ rows carefully rather than skimming and clicking "looks right." That residual risk doesn't go away with more engineering — it's inherent to the source material this rung exists to accept.

---

## RECOMMENDATION

**Build now — moderate priority — build it conservative from day one.**

Reasoning:
- **Cost is not a blocker.** ~$5–6/shop is immaterial against the value of a shop that otherwise cannot self-onboard at all.
- **Reuse is high.** The validator, consensus architecture, content-hash sign-off gate, and the CSV contract are all already generic over row provenance — this is genuinely an extension, not a rebuild. ~10-12 days is a moderate lift for the crew.
- **It closes a real North Star gap.** Today, a restaurant with only a photo of a laminated menu cannot self-onboard — a human has to do it by hand, which is the exact failure mode the North Star exists to eliminate.
- **The accuracy gap is real but bounded and already has an enforcement lever.** The silent-price gate is weaker for images than for PDFs, but the fix isn't "don't build it" — it's "don't trust it the same way." Forcing full owner review on every image-sourced row (§3) uses infrastructure that already exists (the `flag_review`/`go-live` block) and directly neutralizes the one failure mode that matters most: a wrong price reaching a live shop unconfirmed.

**Condition on shipping:** the forced-full-review behavior in §3 must ship on day one, not as a follow-up. Do not soft-launch a version where consensus alone lets an image-sourced price go live — that's the one shortcut this scope explicitly rules out.

---

## Open questions for Jason

1. Confirm the `owner_upload_image` (or equivalent) source vocabulary addition and the forced-full-review default in §3 — this is a real UX cost to the owner (every row, not just flagged ones) in exchange for closing the accuracy gap.
2. Real-time vs. batch: is a shop uploading photos expected to see the extracted menu immediately, or is an overnight batch turnaround acceptable for this rung? Changes the cost table in §2 by ~2x and may change the UX design.
3. Self-hosted OCR (Tesseract, near-zero cost, one more thing to run/maintain) vs. a cloud OCR API (a few dollars per thousand images, no ops burden) for the price-oracle pass — no strong preference from this scope, needs a call.
