// P0 (2026-09-07, Jason, relayed via PO session): BUG 4 part (b). Part (a) —
// the compiled-engine reactive modifier match — was fixed in b72d5ac (ask-plan-
// engine.ts now resolves modifiers reactively when named in the same sentence
// as the item and size, and the item was compiled with the stepEligible fix so
// on_request groups are matchable). Part (b) is the independent safety net:
// the confirmation text must never claim "with <modifier>" unless that modifier
// is ACTUALLY in the cart line's ask_plan_selections.
//
// Without part (b), a modifier the engine couldn't resolve (e.g. ambiguous
// match between two compiled choices, or a modifier name the engine silently
// misses) could still appear in the model's reply as confirmed, while the cart
// shows modifiers:[] and no price delta. GUARD 12 covers this for legacy-path
// items (via option_groups), but compiled items have no option_groups in the
// effective menu, so GUARD 12 silently skips them.
//
// GUARD 16 fills that gap: for any compiled item touched this turn, it checks
// every modifier choice in the item's ask_plan. If the reply names a choice
// that is NOT in ask_plan_selections, it's a false claim — append a correction
// and track it in unverified_requests (same append-only convention as GUARD 12
// and 15: surgically detecting "which sentence is the false claim" in free text
// is fragile regex surgery, appending an honest correction is strictly safer).
//
// This file mirrors GUARD 16's matching logic verbatim for standalone testing
// (Deno.serve() is at module scope in index.ts, making it non-importable —
// same constraint as every other *.test.ts in this directory).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

interface CartLineLike {
  menu_item_id: string;
  ask_plan_selections?: Record<string, string>;
  unverified_requests?: string[];
}
interface StepLike { kind: string; group_id: string; choices: { id: string; display: string }[] }
interface MenuItemLike { id: string; ask_plan: { display_name: string; steps: StepLike[] } | null }

// Mirror of GUARD 16's inner loop logic
function guard16FlaggedMirror(
  ci: CartLineLike,
  menuItem: MenuItemLike,
  reply: string,
): string[] {
  if (!menuItem.ask_plan || !ci.ask_plan_selections) return [];
  const confirmedDisplays = new Set<string>();
  const allModifierDisplays: string[] = [];
  for (const step of menuItem.ask_plan.steps) {
    if (step.kind !== "modifier") continue;
    for (const c of step.choices) allModifierDisplays.push(c.display);
    const choiceId = ci.ask_plan_selections[step.group_id];
    if (!choiceId) continue;
    const choice = step.choices.find(c => c.id === choiceId);
    if (choice) confirmedDisplays.add(choice.display.toLowerCase());
  }
  if (allModifierDisplays.length === 0) return [];
  let replyLower = reply.toLowerCase();
  const dn = menuItem.ask_plan.display_name.toLowerCase();
  replyLower = replyLower.replace(new RegExp(`\\b${dn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  if (!/\b(?:got it|note[ds]?|add(?:ed|ing)?|noting|i['']ll|with)\b/i.test(replyLower)) return [];
  const flagged: string[] = [];
  for (const displayName of allModifierDisplays) {
    if (confirmedDisplays.has(displayName.toLowerCase())) continue;
    const nameRe = new RegExp(`\\b${displayName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (nameRe.test(replyLower)) flagged.push(displayName);
  }
  return flagged;
}

const PIZZA_MENU_ITEM: MenuItemLike = {
  id: "8655ccdd-e43b-4a8f-a22d-f2d1ef71615f",
  ask_plan: {
    display_name: "Buffalo Chicken Pizza",
    steps: [
      { kind: "slot", group_id: "size-group", choices: [
        { id: "c-large", display: "Large 18''" },
        { id: "c-medium", display: "Medium 16''" },
      ]},
      { kind: "modifier", group_id: "top-group", choices: [
        { id: "c-pep", display: "Pepperoni" },
        { id: "c-mush", display: "Mushrooms" },
        { id: "c-grill-chix", display: "Grilled Chicken" },
      ]},
    ],
  },
};

const PEPPERONI_NOT_IN_SELECTIONS: CartLineLike = {
  menu_item_id: "8655ccdd-e43b-4a8f-a22d-f2d1ef71615f",
  ask_plan_selections: { "size-group": "c-large" }, // size resolved, no topping
};
const PEPPERONI_IN_SELECTIONS: CartLineLike = {
  menu_item_id: "8655ccdd-e43b-4a8f-a22d-f2d1ef71615f",
  ask_plan_selections: { "size-group": "c-large", "top-group": "c-pep" },
};

// The exact repro: model says "with pepperoni" but pepperoni is NOT in selections
Deno.test("GUARD 16: the exact repro — reply claims pepperoni but it's not in ask_plan_selections", () => {
  const reply = "Got it — Large Buffalo Chicken Pizza with pepperoni added!";
  const flagged = guard16FlaggedMirror(PEPPERONI_NOT_IN_SELECTIONS, PIZZA_MENU_ITEM, reply);
  assertEquals(flagged, ["Pepperoni"]);
});

// When pepperoni IS in selections, no false flag
Deno.test("GUARD 16: confirmed modifier is never flagged", () => {
  const reply = "Got it — Large Buffalo Chicken Pizza with pepperoni added!";
  const flagged = guard16FlaggedMirror(PEPPERONI_IN_SELECTIONS, PIZZA_MENU_ITEM, reply);
  assertEquals(flagged, []);
});

// No confirmation keyword → guard skips entirely
Deno.test("GUARD 16: no confirmation keyword means no check", () => {
  const reply = "Pepperoni is available as a topping on that pizza.";
  const flagged = guard16FlaggedMirror(PEPPERONI_NOT_IN_SELECTIONS, PIZZA_MENU_ITEM, reply);
  assertEquals(flagged, []);
});

// Item name words stripped: "Buffalo Chicken Pizza" → "chicken" stripped from
// the reply before checking, so "Grilled Chicken" (a topping) can still be
// detected as unconfirmed without tripping on the item's own word "chicken".
Deno.test("GUARD 16: item name stripping prevents item words from blocking modifier detection", () => {
  const reply = "Got it — Buffalo Chicken Pizza added with grilled chicken!";
  const flagged = guard16FlaggedMirror(PEPPERONI_NOT_IN_SELECTIONS, PIZZA_MENU_ITEM, reply);
  assert(flagged.includes("Grilled Chicken"), "should flag unconfirmed Grilled Chicken");
  assert(!flagged.includes("Pepperoni"), "pepperoni not in reply → not flagged");
});

// Slot choices (size) are never flagged — GUARD 16 only scans modifier steps
Deno.test("GUARD 16: slot choices (size) are never flagged even if the size name appears in reply unconfirmed", () => {
  const lineNoSize: CartLineLike = {
    menu_item_id: "8655ccdd-e43b-4a8f-a22d-f2d1ef71615f",
    ask_plan_selections: {}, // nothing resolved yet
  };
  const reply = "Got it — adding a Large Buffalo Chicken Pizza!";
  const flagged = guard16FlaggedMirror(lineNoSize, PIZZA_MENU_ITEM, reply);
  assert(!flagged.some(f => f.toLowerCase().includes("large")), "size choices must never be flagged by GUARD 16");
});

// Item has no modifier steps → nothing to flag
Deno.test("GUARD 16: item with no modifier steps produces no flags", () => {
  const slotOnlyItem: MenuItemLike = {
    id: "some-id",
    ask_plan: {
      display_name: "Plain Item",
      steps: [{ kind: "slot", group_id: "g1", choices: [{ id: "c1", display: "Option A" }] }],
    },
  };
  const ci: CartLineLike = { menu_item_id: "some-id", ask_plan_selections: { "g1": "c1" } };
  const reply = "Got it — Option A added!";
  assertEquals(guard16FlaggedMirror(ci, slotOnlyItem, reply), []);
});

// No ask_plan_selections → guard skips (not a compiled line)
Deno.test("GUARD 16: item with no ask_plan_selections is skipped (legacy-path line)", () => {
  const legacyLine: CartLineLike = { menu_item_id: "8655ccdd-e43b-4a8f-a22d-f2d1ef71615f" };
  const reply = "Got it — with pepperoni added!";
  assertEquals(guard16FlaggedMirror(legacyLine, PIZZA_MENU_ITEM, reply), []);
});

// Regression: GUARD 16 exists in index.ts
Deno.test("regression: GUARD 16 is present in index.ts and has the key structural invariants", () => {
  assert(INDEX_SOURCE.includes("GUARD 16 (compiled modifier falsely confirmed)"),
    "GUARD 16 must log a trip with that exact label");
  assert(INDEX_SOURCE.includes("ask_plan_selections"),
    "GUARD 16 must consult ask_plan_selections as the source of truth for confirmed modifiers");
  assert(INDEX_SOURCE.includes("confirmedDisplays16"),
    "GUARD 16 must build a set of confirmed modifier displays from ask_plan_selections");
  assert(
    /step\.kind !== "modifier"/.test(INDEX_SOURCE),
    "GUARD 16 must skip slot steps — only modifier steps carry topping choices",
  );
  assert(
    /dn16 = menuItem\.ask_plan\.display_name\.toLowerCase\(\)/.test(INDEX_SOURCE),
    "GUARD 16 must strip the item's display_name as a full phrase (not word-by-word) to avoid clobbering modifier names that share a word with the item name",
  );
  assert(
    /reply = `\$\{reply\}.*Just to be clear/.test(INDEX_SOURCE),
    "GUARD 16 must append a correction, never replace the model's reply",
  );
});
