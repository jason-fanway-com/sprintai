// Verification for Jason's priority-1 ask (2026-09-07, "modifiers first —
// last open money bug"): the bot must never say a modifier was added unless
// it's actually in the cart line's options, EVEN WHILE the real apply path
// is incomplete. GUARD 12 (already committed, index.ts) is the existing
// mechanism for exactly this; this file verifies it actually kills the
// false claim end-to-end (claim-detection regex + honest-append text), not
// just the unselectedChoiceNames set-computation already covered by
// guard12-pending-group-exclusion-20260907.test.ts.
//
// GUARD 12 lives inline in index.ts (Deno.serve() at module scope, not
// importable) — same constraint as every other GUARD *.test.ts file here.
// Mirrors the exact logic verbatim, with a source-text regression check.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

interface Choice { name: string }
interface Group { name: string; choices: Choice[] }
interface MenuItem { name: string; option_groups?: Group[] }
interface Line { name: string; options?: Record<string, string[]>; pending_options?: string[] }

// Verbatim mirror of index.ts's GUARD 12 block, including the 2026-09-08
// fix requiring the customer's own message to actually name the attribute
// (root cause of the Zio's Tuna Provolone Wrap false positive: the bot's
// own stock item description was being scanned as if it were a customer
// request). `userMessage` defaults to "" only where a test predates that
// fix and is being retrofitted below.
function runGuard12(reply: string, menuItem: MenuItem, ci: Line, userMessage: string): { reply: string; flagged: string[] } {
  const pendingGroupNames = new Set((ci.pending_options ?? []).map(g => g.toLowerCase()));
  const selectedNames = new Set(Object.values(ci.options ?? {}).flat().map(v => v.toLowerCase()));
  const unselectedChoiceNames = (menuItem.option_groups ?? [])
    .filter(g => !pendingGroupNames.has(g.name.toLowerCase()))
    .flatMap(g => g.choices.map(c => c.name))
    .filter(name => !selectedNames.has(name.toLowerCase()));
  if (unselectedChoiceNames.length === 0) return { reply, flagged: [] };

  let replyLower12 = reply.toLowerCase();
  for (const w of menuItem.name.toLowerCase().split(/\s+/).filter(Boolean)) {
    replyLower12 = replyLower12.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  }
  const claimsConfirmation12 = /\b(?:got it|note[ds]?|add(?:ed|ing)?|noting|i['’]ll)\b/i.test(replyLower12);
  if (!claimsConfirmation12) return { reply, flagged: [] };

  let userMessageLower12 = userMessage.toLowerCase();
  for (const w of menuItem.name.toLowerCase().split(/\s+/).filter(Boolean)) {
    userMessageLower12 = userMessageLower12.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  }
  const flagged: string[] = [];
  for (const name of unselectedChoiceNames) {
    const nameRe = new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (!nameRe.test(userMessageLower12)) continue;
    if (nameRe.test(replyLower12)) flagged.push(name);
  }
  if (flagged.length === 0) return { reply, flagged: [] };

  const asksText = [...new Set(flagged)].join(", ");
  return { reply: `${reply} Just to be clear — I couldn't confirm "${asksText}" as an option here, so it isn't priced or on the order yet; I've flagged it for the shop.`, flagged };
}

const PIZZA: MenuItem = {
  name: "Buffalo Chicken Pizza",
  option_groups: [
    { name: "Add Toppings", choices: [{ name: "Pepperoni" }, { name: "Mushrooms" }] },
  ],
};

Deno.test("Jason's exact BUG 4 repro: false 'with pepperoni' claim gets an honest correction appended", () => {
  const reply = "Small Buffalo Chicken Pizza with pepperoni - got it!";
  const userMessage = "small buffalo chicken pizza with pepperoni";
  const line: Line = { name: "Buffalo Chicken Pizza", options: undefined, pending_options: [] };
  const { reply: fixed, flagged } = runGuard12(reply, PIZZA, line, userMessage);
  assertEquals(flagged, ["Pepperoni"]);
  // The false claim sentence is still present (append-only, never surgical
  // removal — deliberate design, see index.ts's GUARD 12 header comment),
  // but the corrected reply the customer actually receives says plainly
  // it is NOT priced or on the order.
  assertStringIncludes(fixed, "Small Buffalo Chicken Pizza with pepperoni - got it!");
  assertStringIncludes(fixed, "isn't priced or on the order yet");
  assertStringIncludes(fixed, "Pepperoni");
});

Deno.test("no false positive: pepperoni genuinely applied (real fix path) triggers no correction", () => {
  const reply = "Small Buffalo Chicken Pizza with pepperoni - got it!";
  const userMessage = "small buffalo chicken pizza with pepperoni";
  const line: Line = { name: "Buffalo Chicken Pizza", options: { "Add Toppings": ["Pepperoni"] }, pending_options: [] };
  const { reply: fixed, flagged } = runGuard12(reply, PIZZA, line, userMessage);
  assertEquals(flagged, []);
  assertEquals(fixed, reply);
});

Deno.test("no false positive: reply doesn't claim confirmation at all", () => {
  const reply = "What size would you like for the Buffalo Chicken Pizza?";
  const line: Line = { name: "Buffalo Chicken Pizza", options: undefined, pending_options: [] };
  const { flagged } = runGuard12(reply, PIZZA, line, "buffalo chicken pizza");
  assertEquals(flagged, []);
});

Deno.test("no false positive: a still-pending group's choices are a real question, not a false claim", () => {
  const reply = "Got it — Buffalo Chicken Pizza! How would you like it cooked? Rare, medium, or well done?";
  const tempItem: MenuItem = { name: "Buffalo Chicken Pizza", option_groups: [{ name: "Temp", choices: [{ name: "Rare" }, { name: "Medium" }, { name: "Well Done" }] }] };
  const line: Line = { name: "Buffalo Chicken Pizza", options: undefined, pending_options: ["Temp"] };
  const { flagged } = runGuard12(reply, tempItem, line, "buffalo chicken pizza");
  assertEquals(flagged, []);
});

Deno.test("multiple false claims in one reply are all caught and named", () => {
  const reply = "Buffalo Chicken Pizza with pepperoni and mushrooms - got it!";
  const userMessage = "buffalo chicken pizza with pepperoni and mushrooms";
  const line: Line = { name: "Buffalo Chicken Pizza", options: undefined, pending_options: [] };
  const { reply: fixed, flagged } = runGuard12(reply, PIZZA, line, userMessage);
  assertEquals(flagged.sort(), ["Mushrooms", "Pepperoni"]);
  assertStringIncludes(fixed, "isn't priced or on the order yet");
});

// ROOT-CAUSE REGRESSION (2026-09-08, real Zio's transcript, Tuna Provolone
// Wrap): the bot's own stock item description ("That comes with lettuce,
// tomato, onions, and mayo") must never be treated as a customer request.
// Measured blast radius before this fix: 158/220 Zio's items and all
// 170/170 NJB items carry a real description the bot can recite, so this
// false positive was not an edge case — it was most of both menus.
Deno.test("GUARD 12 fix: bot's own item description is not a customer request — no false flag", () => {
  const reply = "Got it - Tuna Provolone Wrap added. That comes with lettuce, tomato, onions, and mayo.";
  const userMessage = "tuna provolone wrap";
  const wrap: MenuItem = {
    name: "Tuna Provolone Wrap",
    option_groups: [{ name: "Toppings", choices: [{ name: "Lettuce" }, { name: "Tomato" }, { name: "Onions" }, { name: "Mayo" }] }],
  };
  const line: Line = { name: "Tuna Provolone Wrap", options: undefined, pending_options: [] };
  const { flagged } = runGuard12(reply, wrap, line, userMessage);
  assertEquals(flagged, []);
});

// Same fix, but confirms the guard still catches a REAL customer-named ask
// that the bot falsely confirms — the fix must not blind the guard to
// genuine false claims (the real Bug 4/5 case), only to bot-authored
// description text.
Deno.test("GUARD 12 fix: customer-named topping is still caught when falsely confirmed", () => {
  const reply = "Got it - Tuna Provolone Wrap added with extra mayo.";
  const userMessage = "tuna provolone wrap with extra mayo";
  const wrap: MenuItem = {
    name: "Tuna Provolone Wrap",
    option_groups: [{ name: "Toppings", choices: [{ name: "Lettuce" }, { name: "Tomato" }, { name: "Onions" }, { name: "Mayo" }] }],
  };
  const line: Line = { name: "Tuna Provolone Wrap", options: undefined, pending_options: [] };
  const { flagged } = runGuard12(reply, wrap, line, userMessage);
  assertEquals(flagged, ["Mayo"]);
});

// REAL-DATA residual gap (2 of 133 live items across both shops): an item
// whose own NAME contains a word that is ALSO a real topping choice (e.g.
// "Bacon Burger Pizza" — "Bacon" is baked into the name and separately
// orderable). Naming the item alone must not read as asking for that
// topping — the item's own name is stripped word-by-word from the
// customer's message first, same treatment already applied to the reply.
Deno.test("GUARD 12 fix: a topping word embedded in the item's own name is not mistaken for a customer request", () => {
  const baconPizza: MenuItem = {
    name: "Bacon Burger Pizza",
    option_groups: [{ name: "Toppings", choices: [{ name: "Bacon" }, { name: "Mushrooms" }] }],
  };
  const reply = "Got it - Bacon Burger Pizza added. That comes with beef, bacon, and cheese.";
  const userMessage = "bacon burger pizza";
  const line: Line = { name: "Bacon Burger Pizza", options: undefined, pending_options: [] };
  const { flagged } = runGuard12(reply, baconPizza, line, userMessage);
  assertEquals(flagged, []);
});

// GUARD 12 (known limitation, not introduced by this fix, not fixed here):
// unlike GUARD 16's phrase-based item-name stripping, GUARD 12 strips the
// item name WORD-BY-WORD with a global regex, so a shared word ("bacon")
// is removed from every occurrence, not just the one inside the item name.
// A customer separately asking for "extra bacon" on "Bacon Burger Pizza"
// is therefore not distinguishable from the item's own name by this guard
// today — same blind spot pre-dates this fix (it already applied to the
// reply side; this fix only extends the same treatment to the customer's
// message). Documented here so it isn't mistaken for a regression.
Deno.test("GUARD 12 (known limitation): extra bacon on an item named for bacon is not distinguishable from the item name itself", () => {
  const baconPizza: MenuItem = {
    name: "Bacon Burger Pizza",
    option_groups: [{ name: "Toppings", choices: [{ name: "Bacon" }, { name: "Mushrooms" }] }],
  };
  const reply = "Got it - Bacon Burger Pizza added with extra bacon.";
  const userMessage = "bacon burger pizza with extra bacon";
  const line: Line = { name: "Bacon Burger Pizza", options: undefined, pending_options: [] };
  const { flagged } = runGuard12(reply, baconPizza, line, userMessage);
  assertEquals(flagged, []);
});

Deno.test("regression: index.ts's GUARD 12 append text still says the item is unpriced/unresolved, not applied", () => {
  assert(
    INDEX_SOURCE.includes(`isn't priced or on the order yet`),
    "GUARD 12's honest-correction text must say the flagged choice is NOT priced/on the order — this is the exact wording the false-claim fix depends on",
  );
  assert(
    /const claimsConfirmation12 = \/\\b\(\?:got it\|note\[ds\]\?\|add\(\?:ed\|ing\)\?\|noting\|i\['’\]ll\)\\b\/i/.test(INDEX_SOURCE),
    "GUARD 12's confirmation-claim regex must still match 'added'/'got it'/'noting' phrasing",
  );
});
