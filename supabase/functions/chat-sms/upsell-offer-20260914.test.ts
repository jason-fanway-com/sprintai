import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  alreadyOfferedUpsellThisConversation,
  computeUpsellOffer,
  extractOfferedItemName,
  firstParseableUpsellName,
  renderUpsellOfferSentence,
} from "./upsell-offer-20260914.ts";
import { applyCompiledAddItem, type CompiledCartLine, type CompiledMenuItem } from "./ask-plan-engine.ts";
import type { AskPlan } from "../_shared/compile-menu.ts";

const cokeLookup = (name: string) =>
  name.toLowerCase() === "coke" ? { name: "Coke", price_cents: 299 } : null;
const noLookup = (_: string) => null;

Deno.test("firstParseableUpsellName: picks the FIRST semicolon entry, not cheapest/priciest/all", () => {
  assertEquals(firstParseableUpsellName("Shrimp +6.00; Black Diamond Steak +8.00"), "Shrimp");
  assertEquals(firstParseableUpsellName("French Fries +4.99"), "French Fries");
  assertEquals(firstParseableUpsellName("Coke +$2.99"), "Coke");
});

Deno.test("firstParseableUpsellName: skips unparseable free-text entries to find a real Name+Price one", () => {
  assertEquals(firstParseableUpsellName("add extra dressing; add shrimp +$6; suggest a drink"), "add shrimp");
});

Deno.test("firstParseableUpsellName: pure prose with no Name+Price shape anywhere returns null", () => {
  assertEquals(firstParseableUpsellName("Substitute side for an upcharge"), null);
  assertEquals(firstParseableUpsellName("suggest wings or a drink"), null);
});

Deno.test("renderUpsellOfferSentence / extractOfferedItemName round-trip", () => {
  const sentence = renderUpsellOfferSentence({ name: "Coke", priceCents: 299 });
  assertEquals(sentence, "Want to add Coke for $2.99?");
  assertEquals(extractOfferedItemName(sentence), "Coke");
});

Deno.test("extractOfferedItemName: unrelated prior message is not an offer", () => {
  assertEquals(extractOfferedItemName("Where should we bring it?"), null);
  assertEquals(extractOfferedItemName(null), null);
  assertEquals(extractOfferedItemName(undefined), null);
});

Deno.test("alreadyOfferedUpsellThisConversation: true once the exact offer phrase has appeared in history", () => {
  const history = [
    { role: "user", content: "I'll have french fries" },
    { role: "assistant", content: "French Fries added. Want to add Coke for $2.99?" },
  ];
  assertEquals(alreadyOfferedUpsellThisConversation(history), true);
});

Deno.test("alreadyOfferedUpsellThisConversation: false when no assistant message ever made this offer", () => {
  const history = [
    { role: "user", content: "I'll have french fries" },
    { role: "assistant", content: "French Fries added. Anything else?" },
  ];
  assertEquals(alreadyOfferedUpsellThisConversation(history), false);
});

Deno.test("computeUpsellOffer: happy path resolves the real menu item and its real price", () => {
  const offer = computeUpsellOffer("Coke +2.99", true, false, [], cokeLookup);
  assertEquals(offer, { name: "Coke", priceCents: 299 });
});

Deno.test("computeUpsellOffer: never trusts the raw upsell string's price — uses the live menu's price instead", () => {
  // Upsell field says +6.00 (stale/drifted), but the real menu item is 2.99.
  const offer = computeUpsellOffer("Coke +6.00", true, false, [], cokeLookup);
  assertEquals(offer?.priceCents, 299);
});

Deno.test("computeUpsellOffer: upsell disabled for the shop -> no offer", () => {
  assertEquals(computeUpsellOffer("Coke +2.99", false, false, [], cokeLookup), null);
});

Deno.test("computeUpsellOffer: no upsell field on the added item -> no offer", () => {
  assertEquals(computeUpsellOffer(null, true, false, [], cokeLookup), null);
  assertEquals(computeUpsellOffer("", true, false, [], cokeLookup), null);
});

Deno.test("computeUpsellOffer: a pending required question this turn always wins over the offer", () => {
  assertEquals(computeUpsellOffer("Coke +2.99", true, true, [], cokeLookup), null);
});

Deno.test("computeUpsellOffer: already offered this conversation -> never twice", () => {
  const history = [
    { role: "assistant", content: "French Fries added. Want to add Coke for $2.99?" },
  ];
  assertEquals(computeUpsellOffer("Coke +2.99", true, false, history, cokeLookup), null);
});

Deno.test("computeUpsellOffer: candidate name doesn't resolve to a real active menu item -> no offer (menu drift)", () => {
  assertEquals(computeUpsellOffer("Discontinued Sundae +3.99", true, false, [], noLookup), null);
});

Deno.test("computeUpsellOffer: free-text-only upsell field (no parseable item) -> no offer, left to the model's own voice", () => {
  assertEquals(computeUpsellOffer("Substitute side for an upcharge", true, false, [], cokeLookup), null);
});

// Item C root-cause regression test (2026-09-14): the live bug was never a
// flaw in computeUpsellOffer's own logic above — it's correct and was
// already covered. The gap was that index.ts's separate-turn pending-answer
// resolver (the compiled item's required option, e.g. Cheese Burger's Temp,
// answered on the turn AFTER the add) never called computeUpsellOffer at
// all. That's a wiring omission a pure unit test of either module in
// isolation cannot see — but the CONTRACT between them can be pinned down
// here: applyCompiledAddItem's real result for a two-call add-then-answer
// sequence (the exact shape index.ts's resolver uses — see
// ask-plan-engine.test.ts's "TWO SEPARATE calls" test) is a `next_question`
// that goes from a real string to `null`. Any caller that resolves a
// pending required option — this one included — must feed EXACTLY that
// `next_question === null` transition into computeUpsellOffer's
// `hasPendingRequiredQuestion` gate as `false`, or the offer stays
// permanently unreachable for every required-option item answered on a
// later turn, regardless of how correct the two modules are individually.
Deno.test("wiring contract: a compiled item's required option resolved via a SEPARATE follow-up call (index.ts's pending-answer resolver shape) becomes upsell-eligible — the exact regression this fix closes", () => {
  const TEMP_STEP = {
    group_id: "grp-temp", slot_key: "temp", kind: "slot" as const, ask_mode: "ask" as const,
    prompt_template: "temp.ask",
    choices: [
      { id: "c-welldone", display: "Well Done", price_delta_cents: 0 },
      { id: "c-medium", display: "Medium", price_delta_cents: 0 },
    ],
  };
  const askPlan: AskPlan = {
    compiled_at: "2026-09-11T00:00:00Z", compiler_version: 1,
    display_name: "Cheese Burger", base_price_cents: 849, steps: [TEMP_STEP],
    recap_template: "{qty} {display_name}", ticket_template: "{name}",
  };
  const menuItem: CompiledMenuItem = { ask_plan: askPlan, bot_state: "orderable", option_groups: [{ id: "grp-temp", name: "Temp" }] };
  const cheeseBurgerUpsellField = "French Fries +4.99; Coke +2.99";
  const ffLookup = (name: string) => name.toLowerCase() === "french fries" ? { name: "French Fries", price_cents: 499 } : null;

  const cart: CompiledCartLine[] = [];
  applyCompiledAddItem(cart, menuItem, "cheeseburger-id", 1, "cheeseburger", null); // turn 1: adds, Temp still open
  const stillOpen = computeUpsellOffer(cheeseBurgerUpsellField, true, cart[0].pending_options !== undefined, [], ffLookup);
  assertEquals(stillOpen, null, "while Temp is still open, no offer yet — the required question always wins");

  // Turn 2, a SEPARATE applyCompiledAddItem call — the customer's answer.
  const answerResult = applyCompiledAddItem(cart, menuItem, "cheeseburger-id", 1, "medium", null);
  const answerR = answerResult.result as { next_question: string | null };
  const offer = computeUpsellOffer(cheeseBurgerUpsellField, true, answerR.next_question !== null, [], ffLookup);
  assertEquals(offer, { name: "French Fries", priceCents: 499 }, "resolving the last required option on a later turn must make the item upsell-eligible immediately");
  assertEquals(renderUpsellOfferSentence(offer!), "Want to add French Fries for $4.99?");
});
