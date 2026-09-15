// PO dispatch (2026-09-15), part 2 of the 784cc701 revert follow-up: the
// real cause of NJB's "Meat Only Breakfast Sandwich" two identical slot
// questions is a compile-time slot_key collision, not a rendering default.
// normalize.ts's extractDescriptionClauses already captures a `label` for a
// parenthetical description clause like "choice of meat (Bacon, Ham,
// Sausage, or Pork Roll)" -> label "meat" (see normalize.test.ts's "root
// cause of the toast/bread mis-bind" test) — but compile-menu/index.ts's
// derivedGroups builder hardcoded every description-derived slot group's
// slot_key to the literal "choice", discarding that label. Two such slots on
// one item (meat + bread, NJB's real shape) both end up with slot_key
// "choice", which is not in ask-plan-engine.ts's TEMPLATE_QUESTIONS, so both
// fall to the SAME generic fallback question text.
//
// index.ts calls Deno.serve() at module scope, so it can't be imported
// directly by tests (same constraint documented in compile-menu/
// fetch-batching-20260907.test.ts) — this file mirrors just the one-line
// slot_key formula from derivedGroups, with a source-text regression check
// at the bottom so the mirror can't silently drift from the real code.
// Everything else (normalizeMenuItems, buildAskPlan/promptTemplateFor,
// renderStepQuestion) is the REAL production code, not a mirror.
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeMenuItems, type RawMenuItemRow } from "../_shared/normalize.ts";
import { buildAskPlan, type CompileGroup, type CompileItem } from "../_shared/compile-menu.ts";
import { renderStepQuestion } from "./ask-plan-engine.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("../compile-menu/index.ts", import.meta.url));

// Mirror of compile-menu/index.ts's derivedGroups slot_key formula (updated
// 2026-09-15 for the anchor-fallback follow-on — label still wins first;
// see njb-slot-key-anchor-20260915.test.ts for that dispatch's own coverage).
function derivedGroupSlotKey(slot: { label?: string; anchor?: "choice_of" | "served_with" }): string {
  return slot.label ?? slot.anchor ?? "choice";
}

function njbRow(overrides: Partial<RawMenuItemRow> = {}): RawMenuItemRow {
  return {
    id: "f2268e5e-a829-4b20-8963-02f49b1ce773",
    name: "Meat Only Breakfast Sandwich",
    // Real NJB description text, verbatim (2026-09-15 DB read).
    description: "Choice of meat (Bacon, Ham, Sausage, or Pork Roll) on choice of bagel, bread, or roll.",
    category: "Breakfast Sandwiches",
    price_cents: 500,
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

Deno.test("compiler: NJB's real 'Meat Only Breakfast Sandwich' description produces a captured label for the meat clause", () => {
  const [normalized] = normalizeMenuItems([njbRow()]);
  const descriptionSlots = normalized.slots.filter(s => s.source === "description");
  assertEquals(descriptionSlots.length, 2, "expected exactly the meat clause and the bread clause");
  assertEquals(descriptionSlots[0].label, "meat");
  assertEquals(descriptionSlots[1].label, undefined);
});

Deno.test("compiler: the meat slot's compiled slot_key is 'meat' (its captured label), not the generic 'choice' literal — and the bread slot falls to its captured anchor 'choice_of' (no label was captured for it)", () => {
  const item = buildDerivedCompileItem(njbRow());
  const askPlan = buildAskPlan(item, "2026-09-15T00:00:00.000Z");
  const meatStep = askPlan.steps.find(s => s.group_id === `derived:${item.id}:0`);
  const breadStep = askPlan.steps.find(s => s.group_id === `derived:${item.id}:1`);
  assert(meatStep, "meat step must exist");
  assert(breadStep, "bread step must exist");
  assertEquals(meatStep!.slot_key, "meat");
  assertEquals(breadStep!.slot_key, "choice_of");
});

Deno.test("compiler + render: the meat-choice and bread-choice slot questions are DISTINCT — a customer can tell these are two different questions", () => {
  const item = buildDerivedCompileItem(njbRow());
  const askPlan = buildAskPlan(item, "2026-09-15T00:00:00.000Z");
  const meatStep = askPlan.steps.find(s => s.group_id === `derived:${item.id}:0`)!;
  const breadStep = askPlan.steps.find(s => s.group_id === `derived:${item.id}:1`)!;
  const meatQuestion = renderStepQuestion(meatStep, askPlan.display_name);
  const breadQuestion = renderStepQuestion(breadStep, askPlan.display_name);
  assertNotEquals(
    meatQuestion,
    breadQuestion,
    `meat-choice and bread-choice slot questions rendered identically — a customer cannot tell these are two different questions: both are ${JSON.stringify(meatQuestion)}`,
  );
  assertEquals(meatQuestion, "What meat would you like for the Meat Only Breakfast Sandwich?");
  assertEquals(breadQuestion, "Which would you like with the Meat Only Breakfast Sandwich?");
});

Deno.test("regression: compile-menu/index.ts's derivedGroups uses the clause's captured label as slot_key, falling back to anchor before the hardcoded 'choice' literal", () => {
  assert(
    INDEX_SOURCE.includes('slot_key: slot.label ?? slot.anchor ?? "choice"'),
    "derivedGroups must read slot.label (then slot.anchor) instead of hardcoding the 'choice' literal",
  );
});
