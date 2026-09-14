import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  alreadyOfferedUpsellThisConversation,
  computeUpsellOffer,
  extractOfferedItemName,
  firstParseableUpsellName,
  renderUpsellOfferSentence,
} from "./upsell-offer-20260914.ts";

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
