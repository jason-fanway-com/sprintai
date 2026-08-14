# Menu Intake Accuracy Fix — Build Spec

**Owner:** Lead (SprintAI_bot) → Builder (John Walsh) → QA (Melvin)
**Date:** 2026-08-09
**Priority:** P0 — blocks scalable self-serve onboarding. Demo week of 2026-08-11.

## Why

Baseline test of the live pipeline on Jack's Slice (commit `e08c048`) scored **terrible**:

- 64% item recall (57 of 219 items missed)
- **0 of 17 modifier blocks** extracted (toppings, wing flavors, dressings, add-ons — all dropped)
- 174 hallucinated entries
- 11 wrong prices, up to $3.96 off

Root cause: `supabase/functions/parse-menu-pdf/index.ts` makes **one** `claude-sonnet-4-6` call over the whole PDF and emits the legacy 5-field shape (`name/description/price_cents/category/modifiers_json`). It consolidates categories, ignores modifier tables, guesses prices from pixels, and does not implement the Menu Intake Standard's validator (§A), double-extract-diff (§B), or the 7-column canonical output.

**Framing:** No customer ever hits a wrong price — the owner sign-off gate (Standard §C) blocks go-live. This is a **setup-quality** problem: inaccurate intake means either heavy manual cleanup (doesn't scale) or owners abandon onboarding. Jason's call: menu intake is a **one-time per-store** process worth the most capable model and multiple passes. Accuracy here is the difference between onboarding that feels magical and onboarding that feels like homework.

## Reference

Implements `docs/specs/menu-intake-standard.md` — that is the canonical schema, QA checklist, validator (§A), double-extract-diff (§B), and sign-off gate (§C). This spec pins the concrete build.

## Requirements

**R1 — Best model.** Use the most capable Opus available to the account (`claude-opus-5` if the `ANTHROPIC_API_KEY` account can call it; else `claude-opus-4-8`). Builder verifies availability + the correct PDF/document API header against the live key **before** pinning; do not hardcode a model that 404s.

**R2 — Multi-pass, not single-shot.** Process the menu in sections/pages, never one call over the whole doc. At minimum: (a) an **items** pass per section/page, and (b) a **dedicated modifier-blocks pass** that specifically hunts topping/sauce/dressing/protein-add-on/side-sub tables. The 0/17 modifier miss is the single biggest failure — this pass exists to kill it.

**R3 — Ground prices in text, don't guess.** When the PDF has a text layer, extract it and pass it alongside the rendered document so prices/names are read, not inferred from pixels. Image-only PDFs fall back to high-res per-page vision. Never invent a price — blank + flag per Standard Rule 2.

**R4 — Canonical output.** Emit the Standard's 7-column model (`category, name, size, price, description, prompt_for, upsell`) plus separate modifier blocks — not the legacy 5-field shape. Persist so the ordering flow and owner-correction UI can consume it. **DB changes additive only** — confirm/extend `menu_items` columns; no drops (tenant data is sacred).

**R5 — Validator + fidelity check.** Implement Standard §A (deterministic QA validator) and §B (double-extract-and-diff). Run the extraction independently ≥2x; row-diff with fuzzy name match; **any price/size/presence disagreement → Open Questions**, never silently shipped. Validator runs after the diff and gates.

**R6 — Owner correction + sign-off.** Do **not** build a new correction UI. The owner corrects via the existing **"Talk to Your Menu"** conversational admin feature — `admin-dashboard/src/components/shop/ConversationalAdminChat.tsx` (+ `ChatAdminTab.tsx`), backed by the `admin-chat` edge function. Confirm that path already applies price/name/add/remove edits to the canonical menu, then **surface the intake's Open Questions / low-confidence flagged rows into that flow** so the owner is prompted to resolve them conversationally. Wire to the §C sign-off gate (content hash + immutable attestation + request-time go-live block); the gate re-arms on the resulting content-hash change. Builder checks what of §C already exists before building. Reuse over rebuild.

**R7 — Real end-to-end harness.** The prior test ran **locally as a proxy** — it could not hit the deployed function (no seeded test shop). Build a repeatable harness that seeds a test shop, POSTs the **actual deployed** `parse-menu-pdf`, and scores the DB result against `tests/fixtures/menu-intake/jacks_slice_flat.csv` (326 rows). Report: recall, modifier-block coverage, price mismatches, hallucination count, Open Questions produced.

## Acceptance criteria (Melvin gates — all must pass)

- **Item recall ≥ 95%** vs the 326-row golden.
- **Modifier coverage ≥ 90%** — ≥16 of 17 blocks present, every block non-empty.
- **Zero silent price errors** — every price either matches golden **or** appears in Open Questions. An unflagged wrong price is a hard fail.
- **Hallucination rate < 5%** (extra entries with no golden match).
- Validator (§A) passes; double-extract-diff (§B) runs and emits Open Questions; §C sign-off gate blocks go-live without valid attestation.
- Output conforms to the 7-column canonical schema + modifier blocks; determinism rules hold.
- Harness (R7) runs against the deployed function and prints the scorecard. Scored, not asserted-by-hand.

## Pre-mortem (rank-ordered) → mitigations

1. **Image-only PDFs** (no text layer) → prices still guessed. → Per-page high-res vision + double-extract-diff flags disagreements for owner; never rely solely on text layer.
2. **Opus model / document-beta not available on the account** → runtime 500. → Verify model + headers against the live key first; fall back to `claude-opus-4-8`.
3. **Schema migration risk** — `menu_items` lacks `size/prompt_for/upsell` → data loss / broken ordering. → Additive migration only; confirm or add columns; no drops.
4. **Cost/latency blowup** from multi-pass Opus. → It's one-time per store; acceptable. Log token cost + latency per run so we can watch it.
5. **Overfit to Jack's Slice** — passes the one fixture, fails real menus. → Add a 2nd golden (NJB bagel menu) as a guard. **Flag:** only Jack's golden exists today; we need a second. Standard is menu-agnostic — do not tune to one file.
6. **Golden may contain errors** → false diffs. → Treat golden as reference; hand-spot-check disagreements before scoring them as misses.

**R8 — Wire the real intake into the wizard; accept PDF *and* photo.** The onboarding wizard's menu step (`signup-page/wizard.js` ~271-485) today accepts **`.csv` only** (`accept=".csv"` → `import-menu-csv`). No owner has a canonical CSV — that's our internal artifact. Real owners upload a **PDF or a phone photo** (often several photos for a multi-page menu). Required:
- Wizard menu step accepts PDF + images (`.pdf,.jpg,.jpeg,.png,.heic`), **multiple files** allowed (multi-page menu = multiple photos).
- Extend the parse pipeline to accept images (Claude `image` content blocks, not just the PDF `document` block); HEIC/rotated/glare-tolerant as far as the model allows.
- Wizard calls the **fixed parse pipeline** (not `import-menu-csv`) → produces the canonical menu → surfaces Open Questions for conversational review via "Talk to Your Menu" (R6) → owner confirms → §C sign-off.
- Keep CSV as an optional advanced input; the **default owner path is PDF/photo**.

## Out of scope

Delivery-radius geocoding, financial reporting, non-menu wizard steps. Focus: PDF **or photo** → accurate canonical menu, wired into onboarding, reviewed conversationally, measured end-to-end.
