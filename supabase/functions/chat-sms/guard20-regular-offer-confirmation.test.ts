import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeGuard20,
  mentionsRegularInvocation,
  priorTurnOfferedRegular,
  regularItemAuthorizedThisTurn,
} from "./guard20-regular-offer-confirmation.ts";

const notNamed = (_: string) => false;

Deno.test("AC6: confirming a JUST-OFFERED regular adds it (guard does not trip)", () => {
  const before: Array<{ menu_item_id: string; name: string; quantity: number }> = [];
  const after = [{ menu_item_id: "pep-large", name: "Large Pepperoni Pizza", quantity: 1 }];
  const regularItem = { name: "Large Pepperoni Pizza" };
  const priorAssistantMessage = "Hey Jason, welcome back! Want your regular, the Large Pepperoni Pizza, or something else today?";

  assertEquals(regularItemAuthorizedThisTurn("yes please", priorAssistantMessage, regularItem.name), true);

  const isNamedThisTurn = (itemName: string) =>
    regularItemAuthorizedThisTurn("yes please", priorAssistantMessage, regularItem.name) &&
    itemName.toLowerCase() === regularItem.name.toLowerCase();

  const result = computeGuard20(before, after, regularItem, isNamedThisTurn);
  assertEquals(result.tripped, false);
});

Deno.test("AC6 hard constraint: 'I want the regular' with NO prior offer is NOT sufficient — must still be offered first", () => {
  const before: Array<{ menu_item_id: string; name: string; quantity: number }> = [];
  const after = [{ menu_item_id: "pep-large", name: "Large Pepperoni Pizza", quantity: 1 }];
  const regularItem = { name: "Large Pepperoni Pizza" };

  // No prior assistant message offered anything — the bot's system prompt
  // told it to OFFER first, but this models the model skipping that step.
  const result = computeGuard20(before, after, regularItem, notNamed);
  assertEquals(result.tripped, true);
  assertEquals(result.reverted.length, 1);
  assertEquals(result.reverted[0].name, "Large Pepperoni Pizza");
});

Deno.test("stale-offer protection: an unrelated later 'yes' does not reactivate an offer from many turns ago", () => {
  const before: Array<{ menu_item_id: string; name: string; quantity: number }> = [];
  const after = [{ menu_item_id: "pep-large", name: "Large Pepperoni Pizza", quantity: 1 }];
  const regularItem = { name: "Large Pepperoni Pizza" };
  // The bot's IMMEDIATELY PRECEDING message is about something unrelated
  // (delivery address), not the regular offer from several turns back.
  const priorAssistantMessage = "Where should we bring it?";

  assertEquals(priorTurnOfferedRegular(priorAssistantMessage, regularItem.name), false);
  const result = computeGuard20(before, after, regularItem, notNamed);
  assertEquals(result.tripped, true);
});

Deno.test("ordinary genuinely-named order for the same item is untouched (not this guard's business)", () => {
  const before: Array<{ menu_item_id: string; name: string; quantity: number }> = [];
  const after = [{ menu_item_id: "pep-large", name: "Large Pepperoni Pizza", quantity: 1 }];
  const regularItem = { name: "Large Pepperoni Pizza" };
  const isNamedThisTurn = (itemName: string) => itemName === "Large Pepperoni Pizza"; // customer literally said it
  const result = computeGuard20(before, after, regularItem, isNamedThisTurn);
  assertEquals(result.tripped, false);
});

Deno.test("item already legitimately in the cart before this turn is never touched", () => {
  const before = [{ menu_item_id: "pep-large", name: "Large Pepperoni Pizza", quantity: 1 }];
  const after = [{ menu_item_id: "pep-large", name: "Large Pepperoni Pizza", quantity: 1 }];
  const regularItem = { name: "Large Pepperoni Pizza" };
  const result = computeGuard20(before, after, regularItem, notNamed);
  assertEquals(result.tripped, false);
});

Deno.test("no eligible regular item (null) is always a no-op", () => {
  const before: Array<{ menu_item_id: string; name: string; quantity: number }> = [];
  const after = [{ menu_item_id: "x", name: "Anything", quantity: 1 }];
  const result = computeGuard20(before, after, null, notNamed);
  assertEquals(result.tripped, false);
});

Deno.test("mentionsRegularInvocation recognizes the customer's own phrasing", () => {
  assertEquals(mentionsRegularInvocation("I want the regular"), true);
  assertEquals(mentionsRegularInvocation("give me my usual"), true);
  assertEquals(mentionsRegularInvocation("same as last time"), true);
  assertEquals(mentionsRegularInvocation("large cheese pizza please"), false);
});
