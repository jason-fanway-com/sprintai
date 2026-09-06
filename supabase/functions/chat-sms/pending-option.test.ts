// DEFECT 1 (2026-09-06 P0): unit coverage for the deterministic
// pending-option resolver. The live acceptance run (15/15 doneness answers,
// one cart line each) is the real proof; this file locks the pure logic
// down so it can't silently regress.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  findPendingOptionQuestion,
  resolvePendingOptionAnswer,
  type PendingOptionChoice,
} from "./pending-option.ts";

const TEMP_CHOICES: PendingOptionChoice[] = [
  { name: "Rare", price_cents: 0 },
  { name: "Medium Rare", price_cents: 0 },
  { name: "Medium", price_cents: 0 },
  { name: "Medium Well", price_cents: 0 },
  { name: "Well Done", price_cents: 0 },
];

Deno.test("resolvePendingOptionAnswer: 'medium' resolves to Medium, not Medium Rare/Medium Well", () => {
  const hit = resolvePendingOptionAnswer("medium", TEMP_CHOICES);
  assertEquals(hit?.name, "Medium");
});

Deno.test("resolvePendingOptionAnswer: 'well done' resolves to Well Done, not Medium Well", () => {
  const hit = resolvePendingOptionAnswer("well done", TEMP_CHOICES);
  assertEquals(hit?.name, "Well Done");
});

Deno.test("resolvePendingOptionAnswer: 'rare' resolves to Rare, not Medium Rare", () => {
  const hit = resolvePendingOptionAnswer("rare", TEMP_CHOICES);
  assertEquals(hit?.name, "Rare");
});

Deno.test("resolvePendingOptionAnswer: 'medium rare please' resolves to Medium Rare", () => {
  const hit = resolvePendingOptionAnswer("medium rare please", TEMP_CHOICES);
  assertEquals(hit?.name, "Medium Rare");
});

Deno.test("resolvePendingOptionAnswer: 'medium well' resolves to Medium Well", () => {
  const hit = resolvePendingOptionAnswer("medium well", TEMP_CHOICES);
  assertEquals(hit?.name, "Medium Well");
});

Deno.test("resolvePendingOptionAnswer: unrelated message resolves to nothing", () => {
  const hit = resolvePendingOptionAnswer("can I also get a coke", TEMP_CHOICES);
  assertEquals(hit, null);
});

Deno.test("resolvePendingOptionAnswer: empty message resolves to nothing", () => {
  assertEquals(resolvePendingOptionAnswer("", TEMP_CHOICES), null);
});

Deno.test("findPendingOptionQuestion: finds the open group on the cart line that has one", () => {
  const menuById = new Map([
    ["burger-1", { name: "Cheese Burger", option_groups: [{ name: "Temp", choices: TEMP_CHOICES }] }],
  ]);
  const cart = [
    { menu_item_id: "burger-1", pending_options: ["Temp"] },
  ];
  const q = findPendingOptionQuestion(cart, menuById);
  assertEquals(q?.menu_item_id, "burger-1");
  assertEquals(q?.group_name, "Temp");
  assertEquals(q?.choices.length, 5);
});

Deno.test("findPendingOptionQuestion: no pending groups anywhere returns null", () => {
  const menuById = new Map([
    ["burger-1", { name: "Cheese Burger", option_groups: [{ name: "Temp", choices: TEMP_CHOICES }] }],
  ]);
  const cart = [
    { menu_item_id: "burger-1", pending_options: undefined },
  ];
  assertEquals(findPendingOptionQuestion(cart, menuById), null);
});

Deno.test("findPendingOptionQuestion: ignores lines with no menu_item_id (bundles)", () => {
  const menuById = new Map<string, { name: string; option_groups?: { name: string; choices: PendingOptionChoice[] }[] }>();
  const cart = [{ pending_options: ["Temp"] }];
  assertEquals(findPendingOptionQuestion(cart, menuById), null);
});
