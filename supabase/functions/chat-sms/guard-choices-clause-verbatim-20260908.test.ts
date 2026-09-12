// ITEM 1 (2026-09-08, PO live verification — real transcript: "Turkey Sub
// added! What size - medium 12" or large 16" (+$8)? ... Choices for Size:
// Medium 12'', Large 16''"): GUARD 8 (and its sibling GUARD 7c) appended a
// redundant "Choices for X:" clause even though the compiled path had
// already rendered the group's real choices, because the old suppression
// test was "is the group's display name generic" (displayGroupName(...) ===
// "option") rather than "did we already say this." That check happened to
// mask the duplicate for Slice's generic "Choose an option" import labels
// but never covered a real-named group like "Size" — exactly what the PO's
// repro hit.
//
// D2 fix (2026-09-09, Vito's "House" salad — real leaked-clause repro): the
// "already said" check itself used to run against a copy of the text with
// every raw occurrence of the item's own name string-stripped out first
// (meant to stop "Chicken Caesar added!" from counting as stating the
// "Caesar" dressing choice). That blind strip also erased a REAL choice
// mention whenever the item's own name happened to be a prefix of one of
// its own choices — Vito's item "House" has a real dressing choice "House
// Balsamic"; the reply genuinely listed it, but stripping every "house"
// from the text first erased that legitimate mention too, so the clause
// leaked anyway. `groupChoicesAlreadySaidMirror` below now takes `itemName`
// directly and exempts a choice from the "prove it's in the text" check
// only when the choice's ENTIRE content is already contained in the item's
// own name (never touching the raw text at all) — see sequencer.ts's real
// groupChoicesAlreadySaid for the authoritative version this mirrors.
//
// This file mirrors `groupChoicesAlreadySaid` (sequencer.ts) verbatim for
// standalone testing plus structural assertions against index.ts's actual
// call sites (Deno.serve() is at module scope in index.ts, making it
// non-importable — same constraint as every other *.test.ts in this
// directory). `significantStems` IS imported directly since it lives in the
// importable pending-disambiguation.ts, not re-implemented.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { significantStems } from "./pending-disambiguation.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

// Mirror of sequencer.ts's groupChoicesAlreadySaid.
function groupChoicesAlreadySaidMirror(
  menuItemId: string, groupName: string, choiceNames: string[], text: string,
  compiledRenderedGroups: Map<string, Set<string>>, itemName: string,
): boolean {
  if (compiledRenderedGroups.get(menuItemId)?.has(groupName)) return true;
  const textStems = significantStems(text);
  const itemNameStems = significantStems(itemName);
  return choiceNames.every(name => {
    const nameStems = significantStems(name);
    if (nameStems.size === 0) return true;
    if ([...nameStems].every(s => itemNameStems.has(s))) return false;
    return [...nameStems].every(s => textStems.has(s));
  });
}

const TURKEY_CHOICES = ["Medium 12''", "Large 16''"];

Deno.test("groupChoicesAlreadySaid: structural signal — compiledRenderedGroups says yes regardless of the text passed", () => {
  const rendered = new Map([["item-1", new Set(["Size"])]]);
  const result = groupChoicesAlreadySaidMirror("item-1", "Size", TURKEY_CHOICES, "totally unrelated text", rendered, "Turkey Sub");
  assertEquals(result, true);
});

Deno.test("groupChoicesAlreadySaid: the exact PO repro — quote-style paraphrase now matches via stems, not raw substring", () => {
  const replyLower = `turkey sub added! what size - medium 12" or large 16" (+$8)?`;
  const result = groupChoicesAlreadySaidMirror("item-1", "Size", TURKEY_CHOICES, replyLower, new Map(), "Turkey Sub");
  assert(result, "stem-based match must survive the straight-quote vs stored two-apostrophe mismatch");
});

Deno.test("groupChoicesAlreadySaid: real choices genuinely never mentioned — false, clause is still needed", () => {
  const replyLower = `turkey sub added! what size would you like?`;
  const result = groupChoicesAlreadySaidMirror("item-1", "Size", TURKEY_CHOICES, replyLower, new Map(), "Turkey Sub");
  assertEquals(result, false);
});

Deno.test("groupChoicesAlreadySaid: only ONE of two choices mentioned — still false (must say ALL choices, not just one)", () => {
  const replyLower = `turkey sub added! we've got a medium 12'' if you'd like that.`;
  const result = groupChoicesAlreadySaidMirror("item-1", "Size", TURKEY_CHOICES, replyLower, new Map(), "Turkey Sub");
  assertEquals(result, false);
});

Deno.test("Vito's / legacy scoping: compiledRenderedGroups is never populated for a non-compiled item, so only the textual check applies — same behavior as before this fix for any real-named group", () => {
  // Vito's never runs the compiled add_item branch (compiled_ordering_engine_
  // enabled stays false), so compiledRenderedGroups.get(id) is always
  // undefined there — the structural fast-path can never fire, and this
  // falls straight through to the textual check exactly as GUARD 8 always
  // did. Real-named groups (Vito's has zero generic-labeled groups) behaved
  // identically before and after this fix: suppressed only if genuinely
  // already said.
  const replyLower = `cheeseburger added! how would you like that cooked?`;
  const result = groupChoicesAlreadySaidMirror("vito-item", "Temp", ["Rare", "Medium", "Well Done"], replyLower, new Map(), "Cheeseburger");
  assertEquals(result, false); // not said -> clause still renders, same as pre-fix behavior
});

Deno.test("groupChoicesAlreadySaid: D2 fix — item name that is a PREFIX of a real choice name ('House' item, 'House Balsamic' choice) does not blank out that choice's real mention", () => {
  const reply = `House added. What dressing would you like? Options: French, Bleu Cheese, House Balsamic.`;
  const result = groupChoicesAlreadySaidMirror("vito-house", "Dressing", ["French", "Bleu Cheese", "House Balsamic"], reply, new Map(), "House");
  assert(result, "the reply already named all three choices, including 'House Balsamic' — must be recognized as already said");
});

Deno.test("groupChoicesAlreadySaid: D2 fix — a choice WHOLLY contained in the item's own name ('Caesar' on 'Chicken Caesar') is never trusted from text-presence alone", () => {
  const reply = `Chicken Caesar added! What dressing would you like?`;
  const result = groupChoicesAlreadySaidMirror("vito-caesar", "Dressing", ["Caesar", "Ranch"], reply, new Map(), "Chicken Caesar");
  assertEquals(result, false, "the item's own name mentioning 'Caesar' must not count as the reply having stated the Caesar dressing choice");
});

Deno.test("groupChoicesAlreadySaid: D2 fix — the item-name-subset exemption does not fire for a choice with real content beyond the item's own name", () => {
  const reply = `House added. What dressing would you like?`; // choices NOT actually listed
  const result = groupChoicesAlreadySaidMirror("vito-house-2", "Dressing", ["House Balsamic"], reply, new Map(), "House");
  assertEquals(result, false, "'House Balsamic' has real content ('Balsamic') beyond the item name — it must still be checked against the text, and here it was never actually said");
});

// ── Wiring: the real index.ts source actually uses the new test, at both
// named call sites, and the generic-label check survives as its OWN,
// separate anti-leak fallback (not folded into "already said"). ──────────
Deno.test("GUARD 8 wiring: suppression is decided by groupChoicesAlreadySaid (unmangled reply text, real itemName), checked before the generic-label fallback", () => {
  assert(INDEX_SOURCE.includes("if (groupChoicesAlreadySaid(added.menu_item_id, groupName, group.choices.map(c => c.name), reply, compiledRenderedGroups, menuItem.name)) continue;"),
    "GUARD 8 must suppress on the structural/stem-based 'already said' test against the real reply text, not a pre-stripped copy");
  assert(INDEX_SOURCE.includes('const label8 = displayGroupName(group.name);\n        if (label8.toLowerCase() === "option") continue;'),
    "the generic-label leak guard must still exist as its own fallback, after the already-said check");
});

Deno.test("GUARD 7c wiring: same already-said test applied ahead of the generic-label fallback", () => {
  assert(INDEX_SOURCE.includes("if (groupChoicesAlreadySaid(resolved7c.id, groupName, group.choices.map(c => c.name), askText7c, compiledRenderedGroups, resolved7c.name)) return \"\";"),
    "GUARD 7c must use the same already-said test as GUARD 8, passing the item's own name");
  assert(INDEX_SOURCE.includes('const label7c = displayGroupName(group.name);\n            if (label7c.toLowerCase() === "option") return "";'),
    "GUARD 7c's generic-label leak guard must still exist");
});

Deno.test("compiledRenderedGroups wiring: populated from enforceVerbatimStepQuestion's output, in scope before GUARD 7c runs", () => {
  assert(INDEX_SOURCE.includes("const compiledRenderedGroups = new Map<string, Set<string>>();"),
    "compiledRenderedGroups must be declared once at outer scope so both GUARD 7c and GUARD 8 see the same instance");
  // PO fix (2026-09-11, two-question-collision guard): enforceVerbatimStepQuestion
  // now only runs when the order-type question DIDN'T already go out this
  // turn; the collision branch calls stripDeferredStepQuestion instead
  // (never appends a canonical question the customer wasn't asked). Both
  // branches still feed the SAME compiledRenderedGroups instance either way.
  assert(INDEX_SOURCE.includes("enforceVerbatimStepQuestion(reply, sq.nextQuestion, sq.choiceDisplays, sq.displayName)"),
    "item 2's enforcement must still run (non-collision turns) and its enforced groups must feed compiledRenderedGroups");
  assert(INDEX_SOURCE.includes("stripDeferredStepQuestion(reply, sq.nextQuestion, sq.choiceDisplays, sq.displayName)"),
    "the two-question-collision turn must strip the deferred slot question rather than force it in alongside the order-type question");
  assert(INDEX_SOURCE.includes("groups.add(sq.groupName);"),
    "the enforced/deferred group name must be recorded either way so GUARD 8 can recognize it was already handled this turn");
});
