// PO dispatch (2026-09-15), follow-on to 5639013c: that fix used the
// clause's captured `label` as slot_key instead of hardcoding "choice",
// which separates the 11 collision survivors that have ONE labeled clause
// (e.g. "meat") and one unlabeled one. It does NOT separate the remaining
// shape where NEITHER clause has a label but they differ in `anchor`
// ("choice_of" vs "served_with") — real NJB platter text: "...Served with
// home fries or hash brown and choice of bagel or toast." Both clauses are
// bare enumerations (no parenthetical sub-attribute), so `label` is
// undefined on both and they still collide on the literal "choice"
// fallback. `anchor` (normalize.ts:68) is captured on every description
// slot regardless of label and is already load-bearing at
// pickDescriptionSlot/pickSideDescriptionSlot (normalize.ts:112,:122) — this
// dispatch adds it as a second-tier slot_key fallback, after label, before
// the "choice" literal.
//
// index.ts calls Deno.serve() at module scope, so it can't be imported
// directly by tests (same constraint as njb-slot-key-label-20260915.test.ts)
// — this file mirrors just the one-line slot_key formula from
// derivedGroups, with a source-text regression check at the bottom so the
// mirror can't silently drift from the real code.
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeMenuItems, type RawMenuItemRow } from "../_shared/normalize.ts";
import { buildAskPlan, type CompileGroup, type CompileItem } from "../_shared/compile-menu.ts";
import { renderStepQuestion } from "./ask-plan-engine.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("../compile-menu/index.ts", import.meta.url));

// Mirror of compile-menu/index.ts's derivedGroups slot_key formula (FIXED:
// label, then anchor, then the "choice" literal).
function derivedGroupSlotKey(slot: { label?: string; anchor?: "choice_of" | "served_with" }): string {
  return slot.label ?? slot.anchor ?? "choice";
}

function platterRow(overrides: Partial<RawMenuItemRow> = {}): RawMenuItemRow {
  return {
    id: "a1b2c3d4-e5f6-4789-a012-3456789abcde",
    name: "Two Egg Platter",
    // Real NJB platter text shape (normalize.ts:56-59 doc comment), verbatim.
    description: "Two eggs any style served with home fries or hash brown and choice of bagel or toast.",
    category: "Breakfast Platters",
    price_cents: 895,
    size_label: null,
    ...overrides,
  };
}

function buildDerivedCompileItem(row: RawMenuItemRow): CompileItem {
  const [normalized] = normalizeMenuItems([row]);
  const derivedGroups: CompileGroup[] = normalized.slots.map((slot, slotIdx) => ({
    id: `derived:${row.id}:${slotIdx}`,
    name: "Choice",
    kind: "slot",
    slot_key: derivedGroupSlotKey(slot),
    min_select: 1,
    max_select: 1,
    kitchen_critical: false,
    price_critical: false,
    default_choice_id: null,
    ask_mode: null,
    provenance: "stated",
    display_order: 1000 + slotIdx,
    choices: slot.choices.map((c, choiceIdx) => ({
      id: `derived:${row.id}:${slotIdx}:${choiceIdx}`,
      name: c.display_name,
      display_name: c.display_name,
      price_cents: 0,
      is_default: false,
      provenance: "stated",
    })),
  }));
  return {
    id: row.id,
    name: row.name,
    display_name: normalized.display_name,
    category: row.category,
    price_cents: row.price_cents,
    active: true,
    price_provenance: "stated",
    product_key: normalized.product_key,
    missing_from_source_since: null,
    groups: derivedGroups,
  };
}

Deno.test("compiler: the platter's 'served with' side clause and 'choice of' bread clause are both unlabeled but carry different anchors", () => {
  const [normalized] = normalizeMenuItems([platterRow()]);
  const descriptionSlots = normalized.slots.filter(s => s.source === "description");
  assertEquals(descriptionSlots.length, 2, "expected exactly the side clause and the bread clause");
  assertEquals(descriptionSlots[0].label, undefined, "side clause is a bare enumeration, no label");
  assertEquals(descriptionSlots[0].anchor, "served_with");
  assertEquals(descriptionSlots[1].label, undefined, "bread clause is a bare enumeration, no label");
  assertEquals(descriptionSlots[1].anchor, "choice_of");
});

Deno.test("compiler: the side slot's compiled slot_key is 'served_with' and the bread slot's is 'choice_of' — no collision on the generic 'choice' literal", () => {
  const item = buildDerivedCompileItem(platterRow());
  const askPlan = buildAskPlan(item, "2026-09-15T00:00:00.000Z");
  const sideStep = askPlan.steps.find(s => s.group_id === `derived:${item.id}:0`);
  const breadStep = askPlan.steps.find(s => s.group_id === `derived:${item.id}:1`);
  assert(sideStep, "side step must exist");
  assert(breadStep, "bread step must exist");
  assertNotEquals(sideStep!.slot_key, breadStep!.slot_key);
  assertEquals(sideStep!.slot_key, "served_with");
  assertEquals(breadStep!.slot_key, "choice_of");
});

Deno.test("compiler + render: the side-choice and bread-choice slot questions are DISTINCT — a customer can tell these are two different questions", () => {
  const item = buildDerivedCompileItem(platterRow());
  const askPlan = buildAskPlan(item, "2026-09-15T00:00:00.000Z");
  const sideStep = askPlan.steps.find(s => s.group_id === `derived:${item.id}:0`)!;
  const breadStep = askPlan.steps.find(s => s.group_id === `derived:${item.id}:1`)!;
  const sideQuestion = renderStepQuestion(sideStep, askPlan.display_name);
  const breadQuestion = renderStepQuestion(breadStep, askPlan.display_name);
  assertNotEquals(
    sideQuestion,
    breadQuestion,
    `side-choice and bread-choice slot questions rendered identically — a customer cannot tell these are two different questions: both are ${JSON.stringify(sideQuestion)}`,
  );
  assertEquals(sideQuestion, "Which side with the Two Egg Platter?");
  assertEquals(breadQuestion, "Which would you like with the Two Egg Platter?");
});

Deno.test("regression: compile-menu/index.ts's derivedGroups falls back to the clause's captured anchor before the hardcoded 'choice' literal", () => {
  assert(
    INDEX_SOURCE.includes('slot_key: slot.label ?? slot.anchor ?? "choice"'),
    "derivedGroups must read slot.anchor as the second-tier fallback before the 'choice' literal",
  );
});
