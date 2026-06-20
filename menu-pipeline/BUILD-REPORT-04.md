# BUILD REPORT — Spec 04: Menu Intake Pipeline

**Builder:** John Walsh · **Branch:** `menu-intake-04` · **Status:** Stage A + Stage B
COMPLETE and self-verified. **One pending deliverable** (Jack's Slice reference
export) is BLOCKED on a missing source file — see *Blocked / needs input*.

Implements `MENU-INTAKE-STANDARD.md` (Stage A) and the CSV→DB mapping in
`projects/sprintai/specs/build/04-MENU-INTAKE-PIPELINE.md` (Stage B).

---

## What was built

### Stage A — menu source → canonical 7-column CSV + Open Questions
Source-agnostic by design: every front-end produces a `MenuModel`; one
deterministic serializer turns a `MenuModel` into a byte-identical CSV.

- `menu-pipeline/core/types.ts` — `MenuModel`, `CanonicalRow`, Stage A output + validation types.
- `menu-pipeline/core/ordering.ts` — the determinism rules in one place: fixed
  modifier-block order, canonical size order (keyword tiers + inches + **count/pound/dozen**),
  category cross-sell defaults. *(carried from prior run; extended with `extractCount`.)*
- `menu-pipeline/core/serialize.ts` — `MenuModel` → byte-deterministic 7-col CSV
  (RFC-4180 quoting, 2-decimal prices, items in menu order, deduped modifier
  blocks in fixed order, cross-sell nudge appended) + **Open Questions always produced** (`"None — ..."` when empty). *(carried from prior run.)*
- `menu-pipeline/core/parse.ts` — `MenuSource` union (`pdf|image|html|text|model`),
  the single `MenuFrontEnd` interface, `runStageA()` orchestration, and the pure
  `stageAFromModel()` tail.
- `menu-pipeline/frontends/claude.ts` — PDF / image / HTML / text → `MenuModel`
  via Claude (temperature 0, pinned model, injected `fetch`), with a MenuModel-shaped
  prompt enforcing the golden rules.

### Validator — fails LOUDLY on referential-integrity breaks
- `menu-pipeline/core/validate.ts` — enforces the standard's QA checklist:
  - **Referential integrity:** every `prompt_for` option and every `+$` add-on
    in `upsell` must resolve to an option in a modifier block.
  - Price format (2-decimal or blank), no duplicate rows, modifier-block detection.
  - `assertValid()` throws for fail-fast call sites (the importer, `--strict` CLI).

### Stage B — confirmed CSV → DB (idempotent / diff-based)
- `supabase/migrations/010_menu_import.sql` — adds `menus.source 'csv'` +
  `import_hash`; `menu_items.is_available / size_label / import_key / owner_edited`;
  `option_groups.import_key`, `option_choices.import_key` + unique upsert indexes.
- `menu-pipeline/core/csv.ts` — RFC-4180 CSV parser (inverse of the serializer); validates the 7-column header.
- `menu-pipeline/core/import-plan.ts` — pure diff-based plan builder: rows →
  `menu_items`; `prompt_for` → required `option_groups`+`option_choices` (free=0);
  `upsell +$` → optional groups/choices (positive deltas); **fails loudly on
  unresolved references**; FNV-1a `import_hash` for no-op detection. `diffItems()`
  emits inserts / updates / **deactivations (never hard-deletes)** keyed by `import_key`.
- `supabase/functions/import-menu-csv/index.ts` — Stage B applier edge function.
  Resolves the shop's single `csv`-source menu, **skips entirely when `import_hash`
  is unchanged**, upserts by `import_key`, **preserves `owner_edited` rows**, and
  **deactivates** items no longer present. Does **NOT** replicate
  `parse-menu-pdf`'s delete-all-on-upload.

### Fixtures + harness + CLI
- `menu-pipeline/fixtures/*.model.json` — 5 **synthetic** test menus (pizza, taco,
  coffee, deli, bbq), varied shapes. `fixtures/README.md` states plainly these are
  synthetic and that the Jack's Slice reference is pending a real source.
- `menu-pipeline/scripts/run-fixtures.mjs` — determinism + validation + plan harness.
- `menu-pipeline/scripts/stage-a.mjs` — Stage A CLI for real menu files.
- `menu-pipeline/scripts/test-validate.mjs` — negative tests (loud failures).
- `menu-pipeline/scripts/test-import-diff.mjs` — Stage B idempotency/diff tests.
- `menu-pipeline/out/*` — committed CSV + Open Questions for all 5 fixtures (artifacts).

---

## How to run

```bash
cd /Users/joestrazza/sprintai-ordering

# Determinism + validation + Stage-B-plan over the fixture set:
node --experimental-strip-types menu-pipeline/scripts/run-fixtures.mjs

# Negative / loud-failure tests:
node --experimental-strip-types menu-pipeline/scripts/test-validate.mjs

# Stage B idempotency / diff tests:
node --experimental-strip-types menu-pipeline/scripts/test-import-diff.mjs

# Stage A on a real menu (needs ANTHROPIC_API_KEY):
node --experimental-strip-types menu-pipeline/scripts/stage-a.mjs \
  --in path/to/menu.pdf --kind pdf --name "Jacks Slice" --strict
```

Determinism proof (two independent runs, byte-identical):
```bash
rm -rf menu-pipeline/out && node --experimental-strip-types menu-pipeline/scripts/run-fixtures.mjs >/dev/null
find menu-pipeline/out -type f | sort | xargs shasum -a 256 > /tmp/run1.sha
rm -rf menu-pipeline/out && node --experimental-strip-types menu-pipeline/scripts/run-fixtures.mjs >/dev/null
find menu-pipeline/out -type f | sort | xargs shasum -a 256 > /tmp/run2.sha
diff /tmp/run1.sha /tmp/run2.sha   # empty diff = byte-identical
```

---

## Verification results (self-test — Melvin still verifies)

- **Determinism:** two independent runs over all 5 fixtures produced byte-identical
  CSV + Open Questions (sha256 diff empty). ✅
- **Validator loud-failure:** unresolved `prompt_for` options, unresolved `+$`
  add-ons, stray currency symbols, single-decimal prices, and duplicate rows are
  all rejected; `assertValid` and `buildImportPlan` throw. ✅ (test-validate.mjs)
- **Stage B idempotency:** stable `import_hash` on unchanged CSV (no-op skip);
  hash changes on edit; first import = inserts; re-import = updates; owner-edited
  rows preserved; removed items deactivated, never hard-deleted. ✅ (test-import-diff.mjs)
- **CSV round-trip:** serialize → parse is lossless incl. quotes/commas. ✅

---

## Acceptance criteria status (spec 04)

| Criterion | Status |
|---|---|
| Same menu twice → byte-identical CSV | ✅ proven (fixtures, sha256 diff) |
| PDF vs HTML/text → equivalent CSV | ⚙️ same `MenuModel` → identical CSV by construction; **needs a real dual-format menu to run end-to-end through Claude** |
| 100% prices 2-decimal or blank+flagged; no stray symbols | ✅ enforced + tested |
| Every `prompt_for` / `+$` resolves to a block; import fails loudly otherwise | ✅ enforced + tested |
| Zero invented items/prices across fixtures | ✅ (no fabrication; null prices flagged) |
| Open Questions always produced ("none" explicit) | ✅ |
| CSV→DB lands items + option_groups + option_choices; agent can quote end-to-end | ⚙️ importer + migration built and unit-proven; **live web-chat transcript pending** (needs migration applied + a deployed function + a real menu) |
| Re-import preserves owner-confirmed edits via diff | ✅ proven |
| Jack's Slice fully ingested + queryable | ❌ **BLOCKED — source menu not found** |

---

## Blocked / needs input

**Jack's Slice reference export (and the live web-chat DoD).** The source menu
(PDF/photo/text) for Jack's Slice is **not present** in the repo or the workspace.
Golden rule #2 forbids inventing prices/options, so I did **not** fabricate a
Jack's Slice CSV. To finish the spec-04 Definition of Done I need:

1. The **Jack's Slice source menu** file (PDF or image), to run through Stage A
   and produce the real `jacks-slice.csv` + Open Questions reference export.
2. A target **`shop_id`** for Jack's Slice and confirmation it's OK to apply
   migration `010_menu_import.sql` and deploy `import-menu-csv` to the (test) DB,
   so I can land the rows and capture the live web-chat transcript (the DoD artifact).

The optional XLSX color-shaded mirror was not built (it's marked "optional" in the
standard); I can add it if wanted.

---

## Commits on `menu-intake-04`
1. `menu-intake(04): commit Stage A core scaffold (types, ordering, serialize)`
2. `menu-intake(04): Stage A validator, front-end interface, Claude front-end`
3. `menu-intake(04): Stage B importer (CSV->DB, idempotent/diff-based) + migration`
4. `menu-intake(04): fixtures, harness, CLI, negative tests, count-size ordering`
5. `menu-intake(04): build report + import-diff tests + type-only import fixes`

No payment functions touched. No commits to `main`. The chat-sms working-tree diff
and other pre-existing untracked files were left alone.
