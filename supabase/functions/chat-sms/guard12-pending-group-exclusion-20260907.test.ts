// P0 REGRESSION (2026-09-07, live on Vito's canary while Jason was actively
// testing it): GUARD 12 ("confirmation claims unresolved choice", added
// earlier the same day for BUG 4 hardening) fired on the FIRST-turn add of
// ANY item with a still-open required option group, menu-wide — not
// specific to any one item. Exact repro: "cheeseburger" -> bot correctly
// adds the item and asks "How would you like it cooked? Rare, medium rare,
// medium, medium well, or well done?" (all real, correct choices from the
// real Temp group) -> GUARD 12 then flagged ALL FIVE as "unresolved
// choices the reply confirmed" and moved them into unverified_requests,
// because (a) the reply contains "added" (a confirmation-claim trigger
// word, for the BASE ITEM) and (b) the reply ALSO names every real choice
// (because it is ASKING about them, per the required-option flow that has
// worked in this codebase for months) — GUARD 12 had no way to tell "the
// reply named this choice while asking" from "the reply named this choice
// while falsely confirming it applied."
//
// FIX: exclude any option group still listed in the cart line's own
// `pending_options` from GUARD 12's "unselected choice names" set — a
// group still pending is, by construction, being asked about this turn,
// not confirmed. This mirrors the guard's ACTUAL intent (Jason's real BUG 4
// repro: "Small Buffalo Chicken Pizza with pepperoni - got it" naming a
// choice that was NEVER pending — i.e. the model just invented having
// applied something) without the false-positive on the ordinary ask flow.
//
// GUARD 12 lives inline in index.ts (Deno.serve() at module scope, not
// importable — same constraint as every *.test.ts file in this directory).
// This mirrors the exact filter logic verbatim, with a source-text
// regression check at the bottom.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

interface Group { name: string; choices: Array<{ name: string }> }
interface Line { options?: Record<string, string[]>; pending_options?: string[] }

function unselectedChoiceNamesMirror(menuItemGroups: Group[], ci: Line): string[] {
  const pendingGroupNames = new Set((ci.pending_options ?? []).map(g => g.toLowerCase()));
  const selectedNames = new Set(Object.values(ci.options ?? {}).flat().map(v => v.toLowerCase()));
  return menuItemGroups
    .filter(g => !pendingGroupNames.has(g.name.toLowerCase()))
    .flatMap(g => g.choices.map(c => c.name))
    .filter(name => !selectedNames.has(name.toLowerCase()));
}

const TEMP_GROUP: Group = {
  name: "Temp",
  choices: [{ name: "Rare" }, { name: "Medium Rare" }, { name: "Medium" }, { name: "Medium Well" }, { name: "Well Done" }],
};

Deno.test("GUARD 12 fix: a still-pending group contributes ZERO unselected choice names (the exact cheeseburger repro)", () => {
  const line: Line = { options: undefined, pending_options: ["Temp"] };
  const names = unselectedChoiceNamesMirror([TEMP_GROUP], line);
  assertEquals(names, []);
});

Deno.test("GUARD 12 fix: a NON-pending group's unselected choices are still caught (real BUG 4 shape preserved)", () => {
  const toppingsGroup: Group = { name: "Toppings", choices: [{ name: "Pepperoni" }, { name: "Mushroom" }] };
  const line: Line = { options: undefined, pending_options: [] }; // NOT pending — the real bug-4 shape
  const names = unselectedChoiceNamesMirror([toppingsGroup], line);
  assertEquals(names.sort(), ["Mushroom", "Pepperoni"]);
});

Deno.test("GUARD 12 fix: a resolved group's OWN selected choice is excluded even if not pending", () => {
  const line: Line = { options: { Temp: ["Medium Rare"] }, pending_options: [] };
  const names = unselectedChoiceNamesMirror([TEMP_GROUP], line);
  assertEquals(names.sort(), ["Medium", "Medium Well", "Rare", "Well Done"]);
});

Deno.test("GUARD 12 fix: two groups, one pending one not — only the non-pending one's unselected choices are flagged", () => {
  const dressingGroup: Group = { name: "Dressing", choices: [{ name: "Ranch" }, { name: "Caesar" }] };
  const line: Line = { options: undefined, pending_options: ["Temp"] }; // Dressing NOT pending (already resolved or n/a), Temp IS
  const names = unselectedChoiceNamesMirror([TEMP_GROUP, dressingGroup], line);
  assertEquals(names.sort(), ["Caesar", "Ranch"]);
});

Deno.test("regression: index.ts's GUARD 12 filters pending_options groups before flatMap'ing choices", () => {
  assert(INDEX_SOURCE.includes("pendingGroupNames"), "GUARD 12 must build a pendingGroupNames set");
  assert(
    /filter\(g => !pendingGroupNames\.has\(g\.name\.toLowerCase\(\)\)\)/.test(INDEX_SOURCE),
    "GUARD 12's unselectedChoiceNames must filter out groups still in pending_options before considering their choices — this is the exact 2026-09-07 regression fix",
  );
});
