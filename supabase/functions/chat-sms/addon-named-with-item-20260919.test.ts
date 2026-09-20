// Freeze-queue item W2 (2026-09-19 PO dispatch, live conv 01609954 #20,
// v549, money bug): customer said "a Chicken quesadilla with Black Diamond
// Steak and Chicken added" -- bot replied "Chicken added" $12.49, the plain
// quesadilla with no add-ons. Both of the customer's own explicitly-named
// add-ons were silently dropped: no question, no refusal, no trace, no
// price change. Real Vito's query (menu_id 54a42842-32be-43b5-9e0c-
// 00fae0ce48fc, shop e0000000-0000-0000-0000-000000000001, item id
// ca76b6d2-351e-437a-a33b-b9a6ab6b23b2): the "Chicken" quesadilla carries
// one OPTIONAL "Add-ons" modifier group (min_select 0, max_select 4) with
// real choices Chicken ($4.00), Shrimp ($6.00), Blackened Salmon ($8.00),
// Black Diamond Steak ($8.00) -- both named add-ons are real, priced,
// listed choices of this exact group.
//
// ROOT CAUSE (same mechanism as item 6 part C, 9d8195d1, reaching a new
// limit -- not a parallel defect): the fresh-add modifier floor (00-BF,
// turn-engine.ts's decide()) already calls the PLURAL recovery function,
// recoverAssertedChoicesFromText, specifically so two distinctly-named
// modifiers in one clause don't get dropped (pepperoni wart c, "half
// pepperoni half sausage"). But that plural function's own PLAIN-choice
// branch (no half/whole placement language, which "Add-ons" choices never
// have) was hard-coded to `plainHits.length === 1 ? plainHits : []` --
// preserving the pre-existing singular contract that TWO plain choices tied
// resolve to NOTHING, on purpose, for the genuinely-ambiguous case ("with
// sausage and onions" -- is "onions" a modifier or a different item?). The
// live #20 message is a different, unambiguous shape: the customer's own
// trailing word "added" ("...and Chicken added") states outright that both
// named things are being added to the item just named, the same class of
// single-word disambiguator as Part B's "extra". This fix adds that signal
// (EXPLICIT_MULTI_ADDON_RE, turn-engine.ts) so BOTH real, matched plain
// choices land when it's present, while leaving the "sausage and onions"
// contract (no such word) exactly as it was tonight -- see pepperoni-warts-
// 20260919.test.ts's own still-passing test for that.
//
// Item 6 part C's own name-collision fix (isSubsetOfItemName / scoped-
// ModifierText) is ALSO exercised here unchanged: one of the two named
// add-ons ("Chicken") is identical to this item's own name. That fix
// already lets an exact-name-match choice recover on a fresh-add turn (see
// quesadilla-grilled-chicken-20260919.test.ts) -- this file proves it still
// works when a SECOND, unrelated add-on ("Black Diamond Steak") is named
// alongside it in the same clause, which part C's own test never covered
// (it only ever named one add-on at a time).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decide,
  recoverAssertedChoicesFromText,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type Proposal,
} from "./turn-engine.ts";

// Real Vito's Quesadillas "Chicken" item (id ca76b6d2-351e-437a-a33b-
// b9a6ab6b23b2) and its real "Add-ons" modifier choices (group id ad490187-
// 82c9-4913-b859-b419d10d876f), pulled live 2026-09-19.
const QUESADILLA_RAW_NAME = "Chicken";
const REAL_ADDONS = [
  { id: "c-chicken", display: "Chicken" },
  { id: "c-salmon", display: "Blackened Salmon" },
  { id: "c-shrimp", display: "Shrimp" },
  { id: "c-steak", display: "Black Diamond Steak" },
];

// ── Unit level: the plural modifier floor itself ───────────────────────────

Deno.test("recoverAssertedChoicesFromText (W2): real #20 text recovers BOTH named add-ons, neither dropped", () => {
  const hits = recoverAssertedChoicesFromText(
    "quesadilla with Black Diamond Steak and Chicken added",
    REAL_ADDONS,
    QUESADILLA_RAW_NAME,
  );
  assertEquals([...hits].sort(), ["c-chicken", "c-steak"].sort());
});

Deno.test("recoverAssertedChoicesFromText (W2): without the 'added' signal, two plain add-ons still resolve to nothing -- the pre-existing 'sausage and onions' contract is unchanged", () => {
  const hits = recoverAssertedChoicesFromText(
    "quesadilla with Black Diamond Steak and Chicken",
    REAL_ADDONS,
    QUESADILLA_RAW_NAME,
  );
  assertEquals(hits, []);
});

Deno.test("recoverAssertedChoicesFromText (W2): a single named add-on with 'added' still recovers just that one, not a phantom second", () => {
  const hits = recoverAssertedChoicesFromText("quesadilla with Black Diamond Steak added", REAL_ADDONS, QUESADILLA_RAW_NAME);
  assertEquals(hits, ["c-steak"]);
});

Deno.test("recoverAssertedChoicesFromText (W2): negation still blocks everything, even with 'added' present", () => {
  const hits = recoverAssertedChoicesFromText("quesadilla with no Black Diamond Steak and no Chicken added", REAL_ADDONS, QUESADILLA_RAW_NAME);
  assertEquals(hits, []);
});

Deno.test("recoverAssertedChoicesFromText (W2, unaffected): an add-on genuinely not named is never guessed, 'added' or not", () => {
  const hits = recoverAssertedChoicesFromText("quesadilla with Shrimp and Chicken added", REAL_ADDONS, QUESADILLA_RAW_NAME);
  assertEquals([...hits].sort(), ["c-chicken", "c-shrimp"].sort());
});

// ── End to end through decide() ────────────────────────────────────────────
//
// Real IDs, real ask_plan shape (steps/choices), a minimal 2-term lexicon
// scoped to just this item -- same isolation discipline as item 6 part C's
// own end-to-end test, so this proves the ADD-ON recovery fix specifically,
// independent of the real shop's full lexicon (a separate, pre-existing
// item-resolution collision was found investigating this ticket -- a bare
// single-word span like "chicken" or "chicken quesadilla" against the full
// live Vito's lexicon currently ties into an 11-candidate cross-category
// disambiguation via resolveItem's widenIntoSizedFamily, because several
// OTHER items each carry a derived "chicken <category noun>" synonym term
// that also core-reduces to bare "chicken" once its own category noun is
// stripped. That is documented in po-inbox-result.md as a separate, real
// defect -- out of scope for this ticket, not touched here, and not what
// caused the live #20 symptom, since production resolved to the correct
// $12.49 item and only dropped the add-ons).

const QUESADILLA_ID = "ca76b6d2-351e-437a-a33b-b9a6ab6b23b2";
const ADDON_GROUP = "ad490187-82c9-4913-b859-b419d10d876f";

const QUESADILLA_MENU: TurnEngineMenuItem[] = [{
  id: QUESADILLA_ID, name: QUESADILLA_RAW_NAME, category: "Quesadillas", price_cents: 1249, bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Chicken",
    base_price_cents: 1249, recap_template: "", ticket_template: "",
    steps: [{
      group_id: ADDON_GROUP, slot_key: "addons", kind: "modifier" as const, ask_mode: "on_request" as const,
      prompt_template: "addons.ask",
      choices: [
        { id: "c-chicken", display: "Chicken", price_delta_cents: 400 },
        { id: "c-salmon", display: "Blackened Salmon", price_delta_cents: 800 },
        { id: "c-shrimp", display: "Shrimp", price_delta_cents: 600 },
        { id: "c-steak", display: "Black Diamond Steak", price_delta_cents: 800 },
      ],
    }],
  },
  option_groups: [{ id: ADDON_GROUP, name: "Add-ons" }],
}];

const QUESADILLA_LEXICON = [
  { term: "chicken", target_id: QUESADILLA_ID },
  { term: "chicken quesadilla", target_id: QUESADILLA_ID },
];

Deno.test("decide() (W2 END TO END, real #20 message): 'a Chicken quesadilla with Black Diamond Steak and Chicken added' adds ONE quesadilla with BOTH add-ons applied and priced", () => {
  const message = "a Chicken quesadilla with Black Diamond Steak and Chicken added";
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [{ item_span: "chicken quesadilla", quantity: 1, choices: [] }],
  };
  const before: TurnEngineCartLine[] = [];
  const out = decide(proposal, before, QUESADILLA_MENU, QUESADILLA_LEXICON, () => "line-1", message);

  const lines = out.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(lines.length, 1, `expected exactly one cart line -- BEFORE cart ${JSON.stringify(before)}, AFTER cart ${JSON.stringify(out.cart)}`);
  const line = lines[0] as unknown as { price_cents: number; options?: Record<string, string[]> };

  // Real before/after reply and cart state (per acceptance criterion 1):
  //   BEFORE: cart empty, no reply yet this turn.
  //   AFTER:  1x Chicken (Quesadillas) $12.49 base + $4.00 Chicken add-on +
  //           $8.00 Black Diamond Steak add-on = $24.49, both add-ons named
  //           in the recap -- never a silent $12.49 plain add.
  assertEquals(line.price_cents, 1249 + 400 + 800, `both add-on price deltas must be applied -- got ${JSON.stringify(line)}`);
  const addonTexts = line.options?.["Add-ons"] ?? [];
  assertEquals([...addonTexts].sort(), ["Black Diamond Steak", "Chicken"].sort(),
    `both named add-ons must appear in the recap, neither silently dropped -- got ${JSON.stringify(line.options)}`);
  assertEquals(out.declines, [], `no decline should fire -- both named add-ons are real, valid choices -- got ${JSON.stringify(out.declines)}`);
  assertEquals(out.disambiguationCandidateIds, null,
    `naming two of this item's own add-ons together must never open a disambiguation question -- got ${JSON.stringify(out.disambiguationCandidateIds)}`);
});

Deno.test("decide() (W2 regression): a fresh add naming the item with NO add-ons at all still adds cleanly, unaffected by the new multi-addon signal", () => {
  const message = "a Chicken quesadilla please";
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [{ item_span: "chicken quesadilla", quantity: 1, choices: [] }],
  };
  const out = decide(proposal, [], QUESADILLA_MENU, QUESADILLA_LEXICON, () => "line-1", message);
  const lines = out.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(lines.length, 1, `expected exactly one cart line -- got ${JSON.stringify(out.cart)}`);
  const line = lines[0] as unknown as { price_cents: number; options?: Record<string, string[]> };
  assertEquals(line.price_cents, 1249, `plain quesadilla, no add-on charges -- got ${JSON.stringify(line)}`);
  assertEquals(line.options?.["Add-ons"] ?? [], [], `no add-ons named, none should appear -- got ${JSON.stringify(line.options)}`);
  assertEquals(out.declines, []);
  assertEquals(out.disambiguationCandidateIds, null);
});
