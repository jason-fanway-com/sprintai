# Menu Intake Standard — Sprint

**Job:** Convert any restaurant's menu (PDF, photo, image, or text) into Sprint's canonical menu schema, consistently and exhaustively, so it can be uploaded to the platform with no human rebuild.

This standard exists so that the **output is identical run to run and restaurant to restaurant.** Two agents running this on the same menu must produce the same file. Determinism is the feature — it's what lets Sprint onboard thousands of restaurants without bespoke work.

The reference implementation is the **Jack's Slice** export. When in doubt about shape, match it exactly.

---

## The output schema

A single flat table. **Seven columns, this exact order, these exact lowercase names:**

| column | meaning |
|---|---|
| `category` | The menu section for items; a defined block label for modifiers (see below). |
| `name` | The item name, or the modifier option name. |
| `size` | Size / variant. **Blank** if the item has no size. |
| `price` | Absolute price for an item; price **delta** for a modifier option. Plain number, **two decimals, no currency symbol**. Blank **only** when genuinely unknown — and then it must be flagged. |
| `description` | Ingredients and included sides. Lead with included sides as `Served with ...` when the menu states them. |
| `prompt_for` | The **required** choices the ordering AI must ask to complete this line. Semicolon-separated. Blank if none. |
| `upsell` | **Optional** add-ons this item supports (with price hints) plus one cross-sell nudge. Semicolon-separated. Blank if none. |

The file has two regions, in this order:

1. **Items** — every sellable line, grouped by category in the menu's own section order.
2. **Modifier blocks** — the answer sets (toppings, sauces, dressings, add-ons, side subs) at the bottom, each under a labeled `category`.

---

## Golden rules (non-negotiable)

1. **Be exhaustive.** Account for every ordering option: every size, topping, sauce, add-on, dressing, side substitution, and protein choice. Missing an option is a defect.
2. **Never invent a price or an option.** If a price is illegible, missing, or says "market price," leave `price` blank and flag it. Do not guess, average, or infer a number.
3. **Flag, don't smooth over.** Anything ambiguous, suspicious, or incomplete goes into the **Open Questions** output (below) with a specific question — never silently resolved.
4. **Deterministic ordering.** Items follow the menu's section order; within a multi-size item, rows go in canonical size order (below); modifier blocks follow the fixed block order (below). Same input → same file.
5. **One row per sellable variant.** Each size of a pizza, each cup/bowl of a soup, each stromboli size = its own row.
6. **The flat file carries data, not logic.** Per-item applicability rules and "don't upsell what's already in the cart" live in the ordering agent's prompt, not here. This file lists what's available and what to ask/suggest; it does not enforce conditional rules.

---

## Reading the menu

- Source may be a PDF, a photo, or scanned image. Read carefully; OCR errors on prices and toppings are common.
- When a character or price is unclear, **do not guess** — flag it (Rule 2).
- Capture the menu's **own section names** as categories (Pizza, Appetizers, Salads, Wraps, etc.), in the order they appear.

---

## Building item rows

- **Sizes → separate rows**, same `description` repeated. Canonical size order: small → medium → large; cup → bowl; personal → mid → large (e.g., Personal → 14" → 16"). Use the menu's size labels, including any measurement: `Small (10")`, `Medium (14")`, `Large (16")`. Single-size items get a blank `size` (or a stated label like `One size`).
- **`price`**: two decimals, no symbol — `12.95`, not `$12.95` or `12.9`.
- **`description`**: if the menu says what the item is served with, lead with `Served with <sides>` then the ingredients. Example: `Served with choice of pasta, garlic knots, side salad. Marsala wine sauce, mushrooms, ...`
- **Names**: clean, title-cased, straight quotes/characters only. Keep them as the customer would recognize them.

---

## Building `prompt_for` (required choices)

`prompt_for` = the free, required selections the AI must collect before the line is complete. Detect them from menu language:

- **"choice of" / "your choice of"** → e.g. pasta, dressing.
- **"X or Y"** baked into the item → `beef or chicken`, `steak or chicken`, `red or white`, `spicy or mild`.
- **A sauce/flavor list** attached to the item → `which sauce (hot, mild, or BBQ)`, `which wing flavor(s)`.
- **A required dressing** on a salad → `which dressing`.

**Format:** a short phrase naming what to ask, with the valid options inline so the AI can offer them, e.g. `which pasta (spaghetti, penne, angel hair, or linguine)`. Multiple required asks are semicolon-separated: `which sauce (hot, mild, or BBQ); bleu cheese or ranch`. These are **free** choices — they do not change price.

---

## Building `upsell` (optional add-ons + cross-sell)

Two parts, semicolon-separated:

1. **The item's own optional add-ons**, with the price hint inline using `+$`:
   `add a protein (chicken +$4, shrimp +$6, salmon +$8, steak +$8)`, `add extra toppings`, `upgrade the side (...)`, `add extra dip`.
2. **One category-level cross-sell nudge** appended last (see Defaults table): `suggest wings, garlic knots, or drinks`.

`upsell` is raw suggestion *material*. Suppression logic ("only if not already in cart," "cap at one," "lead with highest margin") is the ordering agent's job, not this file's.

---

## Building the modifier blocks

At the bottom, list every answer set as its own labeled block. `size`, `prompt_for`, and `upsell` stay blank on these rows; `price` holds the **delta**.

- **Dedupe sets in the flat file.** One `Buffalo Sauce Options` block, one `Salad Protein Add-ons` block, etc. — even if different items technically offer different subsets. (The subset rules live in the ordering prompt.)
- **Half/whole pricing → separate option rows**, portion in the name: `Pepperoni (Whole pizza)` `4.50`, `Pepperoni (Half pizza)` `3.50`.
- **Free required-choice answers** (dressings, sauces, pasta, beef/chicken) → `price` = `0.00`.
- **Paid add-ons** (toppings, proteins) → positive delta.
- **"For an upcharge" with no amount** → `price` blank + flag, with a note like `Upcharge TBD`.

**Fixed block order** (include only those that apply): Pizza Toppings - Regular, Pizza Toppings - Gourmet, Slice Toppings - Regular, Slice Toppings - Gourmet, Wing Flavors, Wing Extras, Salad Dressings, Extra Dressing, Salad Protein Add-ons, Quesadilla/Other Protein Add-ons, Pasta Choices, Buffalo Sauce Options, [other required-choice sets], Side Substitutions, Side Substitutions - Kids.

---

## Ambiguity & the Open Questions output

Alongside the menu file, always produce an **Open Questions** list. Every flag is one line: the item/area, the issue, and the specific question to resolve. Flag at minimum:

- Any **missing/illegible/market price** (price left blank).
- **"Upcharge" with no amount** (side subs, etc.).
- **Suspicious uniformity** (e.g., every specialty pizza's small is the same price — confirm it's real, not a layout artifact).
- **Single-size items** where the menu layout is ambiguous about which size the price refers to.
- **Add-ons positioned ambiguously** (e.g., protein add-ons printed under one item but possibly applying to a whole section).
- Anything you had to interpret rather than read directly.

If there are zero flags, say so explicitly — don't omit the section.

---

## Validation before "done" (QA checklist)

The job is not done until all pass:

- [ ] **Referential integrity:** every option named in a `prompt_for` has a matching answer in a modifier block; every `+$` add-on in `upsell` has a matching paid-add-on block.
- [ ] **No orphan/empty blocks:** every modifier block has options; no block is referenced but absent.
- [ ] **Prices:** every `price` is a 2-decimal number **or** blank-and-flagged. No stray symbols, no single-decimal values.
- [ ] **Completeness:** every menu section is represented; multi-size items have all sizes; spot-check 3 items against the source.
- [ ] **No duplicate rows.**
- [ ] **Open Questions produced** (even if empty).
- [ ] **Determinism:** ordering follows the rules above.

This checklist is what QA verifies. Work that fails any line goes back, with the specific failure named.

---

## Output files

- **Primary:** flat CSV with the seven columns, UTF-8.
- **Optional mirror:** single-sheet XLSX with the same data — blank/TBD prices shaded yellow, `prompt_for` shaded blue, `upsell` shaded green, for fast human review.
- **Companion:** the Open Questions list (its own file or a clearly separated section).

---

## Worked example (match this shape)

```csv
category,name,size,price,description,prompt_for,upsell
Pizza,Buffalo Chicken,"Large (16"")",22.99,"Chopped chicken; choose sauce; topped with bleu cheese or ranch","which sauce (hot, mild, or BBQ); bleu cheese or ranch","add extra toppings; suggest wings, garlic knots, or drinks"
Entrees,Chicken Marsala,,19.95,"Served with choice of pasta, garlic knots, side salad. Marsala wine sauce, mushrooms, sauteed garlic, onions","which pasta (spaghetti, penne, angel hair, or linguine)","suggest an appetizer and drinks"
Salads,Greek,,10.99,"Tomatoes, red onions, cucumbers, kalamata olives, feta cheese","which dressing","add a protein (chicken +$4, shrimp +$6, salmon +$8, steak +$8); suggest a drink"
Pizza Toppings - Regular,Pepperoni (Whole pizza),,4.50,,,
Salad Dressings,Ranch,,0.00,,,
Side Substitutions,Sweet Potato Fries,,,Upcharge TBD,,
```

---

## Category cross-sell defaults

Defaults for the cross-sell half of `upsell`. **These are starting points** — they should be tuned per restaurant toward higher-margin items; the ordering prompt can also override them.

| category | default nudge |
|---|---|
| Pizza | suggest wings, garlic knots, or drinks |
| By the Slice | suggest making it a combo with a drink |
| Wings | suggest fries and a drink |
| Salads | suggest a drink |
| Wraps / Paninis / Sandwiches / Burgers / Quesadillas | suggest a drink |
| Entrees | suggest an appetizer and drinks |
| Stromboli / Baked Pasta | suggest a side salad or drink |
| Kids | suggest a kids drink |
| Beverages | (none) |

---

## Sprint implementation requirements

This section is the **build spec** for the automated menu intake pipeline. These are not yet implemented — they are the requirements the implementation must satisfy.

### A) Deterministic QA Validator

A code module (TypeScript, runnable in edge functions and in CI) that enforces this standard's QA checklist programmatically:

1. **Referential integrity:** Every option named in any item's `prompt_for` column must resolve to at least one matching modifier block. Every `+$` add-on mentioned in the `upsell` column must resolve to at least one modifier block entry with a matching positive price delta. Failures surface as specific errors naming the item and the dangling reference.

2. **Price format validation:** Every non-blank `price` must be a valid 2-decimal number (regex `^\d+\.\d{2}$`). Blank prices must be accompanied by an Open Questions entry explaining why. Single-decimal or currency-symbol prices are hard failures.

3. **No duplicate rows:** Any two rows where `(category, name, size)` are identical after normalization is a hard failure.

4. **Every section represented:** The validator must know which sections appeared in the source menu (from extraction metadata) and ensure every one appears in the output. Section-missing = hard failure.

5. **No empty modifier blocks:** Every modifier block `category` must contain at least one option row with a non-empty `name`. Empty blocks are hard failures.

6. **Open Questions produced:** The parser's output must include an Open Questions list. If none, the parser must explicitly state "No Open Questions" — the validator verifies the list exists (even if empty).

7. **Output format:** The validator produces a structured result: `{ passed: boolean, failures: Array<{rule: string, item_ref: string, message: string}>, warnings: Array<{rule: string, item_ref: string, message: string}> }`.

### B) Double-Extract-and-Diff Fidelity Check

A higher-level integrity check that catches silent errors (wrong prices, missing sizes) that consistency rules cannot detect:

1. **Run the parser twice independently** on the same input (different LLM calls, no shared state).

2. **Row-by-row diff** the two outputs with fuzzy name matching. Any item present in one output but not the other → Open Questions entry.

3. **Price disagreement:** Any matched item pair where prices differ by more than $0 → Open Questions entry.

4. **Size disagreement:** Any matched item pair where the size/column count differs → Open Questions entry.

5. **Output:** A structured `DoubleExtractReport` with matched count, disagreement count, and the list of specific disagreements. The diff runs before the QA validator; if disagreements exist, they become Open Questions that the QA validator then checks.

### C) Mandatory Owner Sign-Off Go-Live Gate

Every menu must be explicitly approved by the restaurant owner before it goes live:

1. **Content hash:** Upon extraction, compute a SHA-256 hash of the canonical flat CSV content. Store it with the menu record.

2. **Timestamped attestation:** Before a menu can be set as `active` / `effective`, the shop owner (authenticated `shop_owner` role user) must submit an explicit approval: `{ menu_id, content_hash, approved_at: timestamp, approved_by: user_id }`. This is stored immutably in the database.

3. **Go-live block:** The ordering endpoint MUST NOT serve any menu that lacks a valid owner approval covering the current `content_hash`. The check is performed at request time, not at approval time.

4. **Re-arm on edit:** Any edit to the canonical flat CSV (content hash changes) invalidates the current approval. The menu must be re-approved before it can go live again.

5. **Liability:** Sprint is not liable for price errors. The owner attestation is the legal record that the menu and prices are correct.
