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

// Mirror of GUARD 16's inner loop logic. `userMessage` defaults to the
// empty string in legacy call sites below that predate the 2026-09-08 fix
// requiring the customer to have actually named the attribute; those sites
// pass it explicitly once updated.
function guard16FlaggedMirror(
  ci: CartLineLike,
  menuItem: MenuItemLike,
  reply: string,
  userMessage: string,
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
  let userMessageLower = userMessage.toLowerCase();
  userMessageLower = userMessageLower.replace(new RegExp(`\\b${dn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  const flagged: string[] = [];
  for (const displayName of allModifierDisplays) {
    if (confirmedDisplays.has(displayName.toLowerCase())) continue;
    const nameRe = new RegExp(`\\b${displayName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (!nameRe.test(userMessageLower)) continue;
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
  const userMessage = "large buffalo chicken pizza with pepperoni";
  const flagged = guard16FlaggedMirror(PEPPERONI_NOT_IN_SELECTIONS, PIZZA_MENU_ITEM, reply, userMessage);
  assertEquals(flagged, ["Pepperoni"]);
});

// When pepperoni IS in selections, no false flag
Deno.test("GUARD 16: confirmed modifier is never flagged", () => {
  const reply = "Got it — Large Buffalo Chicken Pizza with pepperoni added!";
  const userMessage = "large buffalo chicken pizza with pepperoni";
  const flagged = guard16FlaggedMirror(PEPPERONI_IN_SELECTIONS, PIZZA_MENU_ITEM, reply, userMessage);
  assertEquals(flagged, []);
});

// No confirmation keyword → guard skips entirely
Deno.test("GUARD 16: no confirmation keyword means no check", () => {
  const reply = "Pepperoni is available as a topping on that pizza.";
  const userMessage = "pepperoni";
  const flagged = guard16FlaggedMirror(PEPPERONI_NOT_IN_SELECTIONS, PIZZA_MENU_ITEM, reply, userMessage);
  assertEquals(flagged, []);
});

// Item name words stripped: "Buffalo Chicken Pizza" → "chicken" stripped from
// the reply before checking, so "Grilled Chicken" (a topping) can still be
// detected as unconfirmed without tripping on the item's own word "chicken".
Deno.test("GUARD 16: item name stripping prevents item words from blocking modifier detection", () => {
  const reply = "Got it — Buffalo Chicken Pizza added with grilled chicken!";
  const userMessage = "buffalo chicken pizza with grilled chicken";
  const flagged = guard16FlaggedMirror(PEPPERONI_NOT_IN_SELECTIONS, PIZZA_MENU_ITEM, reply, userMessage);
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
  const userMessage = "large buffalo chicken pizza";
  const flagged = guard16FlaggedMirror(lineNoSize, PIZZA_MENU_ITEM, reply, userMessage);
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
  assertEquals(guard16FlaggedMirror(ci, slotOnlyItem, reply, "option a"), []);
});

// No ask_plan_selections → guard skips (not a compiled line)
Deno.test("GUARD 16: item with no ask_plan_selections is skipped (legacy-path line)", () => {
  const legacyLine: CartLineLike = { menu_item_id: "8655ccdd-e43b-4a8f-a22d-f2d1ef71615f" };
  const reply = "Got it — with pepperoni added!";
  assertEquals(guard16FlaggedMirror(legacyLine, PIZZA_MENU_ITEM, reply, "pepperoni"), []);
});

// ROOT-CAUSE REGRESSION (2026-09-08, real Zio's transcript): the bot's own
// stock description of an item ("comes with mushrooms") must never be
// mistaken for a customer request. The customer only asked for the pizza —
// "mushrooms" and "pepperoni" appear ONLY in the bot's own reply text.
Deno.test("GUARD 16 fix: bot's own item description is not a customer request — no false flag", () => {
  const reply = "Got it — Large Buffalo Chicken Pizza added. That comes with mushrooms and pepperoni.";
  const userMessage = "large buffalo chicken pizza";
  const flagged = guard16FlaggedMirror(PEPPERONI_NOT_IN_SELECTIONS, PIZZA_MENU_ITEM, reply, userMessage);
  assertEquals(flagged, []);
});

// Same fix, but confirms the guard still catches a REAL customer-named ask
// that the bot falsely confirms — the fix must not make the guard blind to
// genuine false claims, only to bot-authored description text.
Deno.test("GUARD 16 fix: customer-named modifier is still caught when falsely confirmed", () => {
  const reply = "Got it — Large Buffalo Chicken Pizza added with mushrooms.";
  const userMessage = "large buffalo chicken pizza with mushrooms please";
  const flagged = guard16FlaggedMirror(PEPPERONI_NOT_IN_SELECTIONS, PIZZA_MENU_ITEM, reply, userMessage);
  assertEquals(flagged, ["Mushrooms"]);
});

// REAL-DATA residual gap found while verifying the fix against Zio's and
// NJB's live menus (2 of 133 items): an item whose own NAME contains a word
// that is ALSO a separately orderable modifier (e.g. real menu item "Bacon
// Burger Pizza" — "Bacon" is both baked into the name and an on-request
// topping). Naming the item alone must not read as asking for that
// modifier — the item's own display name is stripped from the customer's
// message first, same phrase-stripping already applied to the reply.
Deno.test("GUARD 16 fix: a modifier word embedded in the item's own name is not mistaken for a customer request", () => {
  const baconPizza: MenuItemLike = {
    id: "bacon-pizza-id",
    ask_plan: {
      display_name: "Bacon Burger Pizza",
      steps: [{ kind: "modifier", group_id: "top-group", choices: [
        { id: "c-bacon", display: "Bacon" },
        { id: "c-mush", display: "Mushrooms" },
      ]}],
    },
  };
  const line: CartLineLike = { menu_item_id: "bacon-pizza-id", ask_plan_selections: {} };
  const reply = "Got it — Bacon Burger Pizza added. That comes with beef, bacon, and cheese.";
  const userMessage = "bacon burger pizza";
  const flagged = guard16FlaggedMirror(line, baconPizza, reply, userMessage);
  assertEquals(flagged, []);
});

// Same item, but the customer DOES separately ask for extra bacon beyond
// what's in the name — still must be caught if falsely confirmed.
Deno.test("GUARD 16 fix: extra bacon explicitly requested beyond the item name is still caught", () => {
  const baconPizza: MenuItemLike = {
    id: "bacon-pizza-id",
    ask_plan: {
      display_name: "Bacon Burger Pizza",
      steps: [{ kind: "modifier", group_id: "top-group", choices: [
        { id: "c-bacon", display: "Bacon" },
        { id: "c-mush", display: "Mushrooms" },
      ]}],
    },
  };
  const line: CartLineLike = { menu_item_id: "bacon-pizza-id", ask_plan_selections: {} };
  const reply = "Got it — Bacon Burger Pizza added with extra bacon.";
  const userMessage = "bacon burger pizza with extra bacon";
  const flagged = guard16FlaggedMirror(line, baconPizza, reply, userMessage);
  assertEquals(flagged, ["Bacon"]);
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
