// P0 (2026-09-12, live money defect on Vito's, conv f60d3611): matrix test
// for resolveModifierMention, covering the PO's explicit acceptance phrasing
// set plus the real Vito's Toppings choice list (fetched live from the DB
// during triage) so the whole/half default logic is pinned against the real
// shape, not a hand-simplified mirror.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveModifierMention, type ModifierChoiceOption } from "./regular-offer-modifier-20260912.ts";

// Real Vito's "Cheese - Large (16\")" Toppings group (option_group_id
// 26205301-e8d1-4f90-90c3-738958a5cfb6), trimmed to the toppings the test
// matrix references.
const VITOS_TOPPINGS: ModifierChoiceOption[] = [
  { groupName: "Toppings", name: "Pepperoni (Whole pizza)" },
  { groupName: "Toppings", name: "Pepperoni (Half pizza)" },
  { groupName: "Toppings", name: "Onions (Whole pizza)" },
  { groupName: "Toppings", name: "Onions (Half pizza)" },
  { groupName: "Toppings", name: "Sausage (Whole pizza)" },
  { groupName: "Toppings", name: "Sausage (Half pizza)" },
];

// A shop whose modifier group has no whole/half variants at all — "Extra
// Cheese" the way most non-pizza-topping modifiers are recorded.
const SIMPLE_MODS: ModifierChoiceOption[] = [
  { groupName: "Extras", name: "Extra Cheese" },
  { groupName: "Extras", name: "Extra Sauce" },
];

Deno.test("matrix: 'Yes delivery again. But I want pepperoni on it today.' -> Pepperoni (Whole pizza), add", () => {
  const r = resolveModifierMention("Yes delivery again. But I want pepperoni on it today.", VITOS_TOPPINGS);
  assertEquals(r, { groupName: "Toppings", choiceName: "Pepperoni (Whole pizza)", action: "add" });
});

Deno.test("matrix: 'yes but with pepperoni' -> Pepperoni (Whole pizza), add", () => {
  const r = resolveModifierMention("yes but with pepperoni", VITOS_TOPPINGS);
  assertEquals(r, { groupName: "Toppings", choiceName: "Pepperoni (Whole pizza)", action: "add" });
});

Deno.test("matrix: 'sure, add pepperoni' -> Pepperoni (Whole pizza), add", () => {
  const r = resolveModifierMention("sure, add pepperoni", VITOS_TOPPINGS);
  assertEquals(r, { groupName: "Toppings", choiceName: "Pepperoni (Whole pizza)", action: "add" });
});

Deno.test("matrix: 'yes, extra cheese on it' -> Extra Cheese (no whole/half variant), add", () => {
  const r = resolveModifierMention("yes, extra cheese on it", SIMPLE_MODS);
  assertEquals(r, { groupName: "Extras", choiceName: "Extra Cheese", action: "add" });
});

Deno.test("matrix: 'yes but no onions' -> exclude, no code action needed", () => {
  const r = resolveModifierMention("yes but no onions", VITOS_TOPPINGS);
  assertEquals(r, { groupName: "Toppings", choiceName: "", action: "exclude" });
});

Deno.test("half-pizza qualifier: 'yes but pepperoni on half' resolves to the Half variant", () => {
  const r = resolveModifierMention("yes but pepperoni on half", VITOS_TOPPINGS);
  assertEquals(r, { groupName: "Toppings", choiceName: "Pepperoni (Half pizza)", action: "add" });
});

Deno.test("no modifier named at all -> null (caller just accepts the plain regular)", () => {
  const r = resolveModifierMention("yes please", VITOS_TOPPINGS);
  assertEquals(r, null);
});

Deno.test("two distinct toppings named -> null, never guess between them", () => {
  const r = resolveModifierMention("yes but pepperoni and onions", VITOS_TOPPINGS);
  assertEquals(r, null);
});

Deno.test("hold-the phrasing: 'yes, hold the onions' -> exclude", () => {
  const r = resolveModifierMention("yes, hold the onions", VITOS_TOPPINGS);
  assertEquals(r, { groupName: "Toppings", choiceName: "", action: "exclude" });
});

Deno.test("empty message or empty choice list never matches", () => {
  assertEquals(resolveModifierMention("", VITOS_TOPPINGS), null);
  assertEquals(resolveModifierMention("yes but pepperoni", []), null);
});
