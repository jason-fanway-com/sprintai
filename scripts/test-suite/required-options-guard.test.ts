/**
 * required-options-covered — Red-Green Evidence (2026-09-06)
 *
 * verifyRequiredOptionsCovered fails a case whose final-turn cart_json has a
 * line for an item with a required option group but no non-empty selection
 * for that group (the bot reached "checkout" without ever answering a
 * required customization). It passes once the selection is present.
 *
 * These are fixture-based unit tests of the pure grading function, the same
 * pattern already used by stated-total-guard.test.ts / persist-guard.test.ts
 * for the other cart-ops invariants — no live bot call, since this function
 * only reads the RunResult transcript it's given.
 *
 * Run: deno test --allow-net --allow-env --allow-read scripts/test-suite/required-options-guard.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyRequiredOptionsCovered } from "./cart-ops.ts";
import type { RunResult } from "./runner.ts";

const BACON_CHEESEBURGER_ID = "94557b9c-25a8-45cc-aa02-7f175dae4389";

function runWithFinalCart(cart: unknown): RunResult {
  return { transcript: [{ reply: "Anything else?", cart }] } as unknown as RunResult;
}

// ── RED: required group present on the item, missing from the cart line ──

Deno.test("doctored transcript: required 'Temp' group never answered FAILS", () => {
  const requiredGroups = new Map([[BACON_CHEESEBURGER_ID, ["Temp"]]]);
  const cart = [
    { menu_item_id: BACON_CHEESEBURGER_ID, name: "Bacon Cheeseburger", quantity: 1, price_cents: 1099, options: {} },
  ];
  const r = verifyRequiredOptionsCovered(runWithFinalCart(cart), requiredGroups);
  assertEquals(r.applied, true);
  assertEquals(r.passed, false);
});

Deno.test("doctored transcript: required group present but selection is an empty array FAILS", () => {
  const requiredGroups = new Map([[BACON_CHEESEBURGER_ID, ["Temp"]]]);
  const cart = [
    {
      menu_item_id: BACON_CHEESEBURGER_ID,
      name: "Bacon Cheeseburger",
      quantity: 1,
      price_cents: 1099,
      options: { Temp: [] },
    },
  ];
  const r = verifyRequiredOptionsCovered(runWithFinalCart(cart), requiredGroups);
  assertEquals(r.applied, true);
  assertEquals(r.passed, false);
});

// ── GREEN: fixed transcript, the same required group answered ────────────

Deno.test("fixed transcript: required 'Temp' group answered 'Medium' PASSES", () => {
  const requiredGroups = new Map([[BACON_CHEESEBURGER_ID, ["Temp"]]]);
  const cart = [
    {
      menu_item_id: BACON_CHEESEBURGER_ID,
      name: "Bacon Cheeseburger",
      quantity: 1,
      price_cents: 1099,
      options: { Temp: ["Medium"] },
    },
  ];
  const r = verifyRequiredOptionsCovered(runWithFinalCart(cart), requiredGroups);
  assertEquals(r.applied, true);
  assertEquals(r.passed, true);
});

// ── Must not false-positive on items/groups outside the required map ─────

Deno.test("item with no required groups on the shop's map is never checked (trivial pass)", () => {
  const requiredGroups = new Map<string, string[]>(); // no shop items require anything
  const cart = [{ menu_item_id: BACON_CHEESEBURGER_ID, name: "Bacon Cheeseburger", quantity: 1, price_cents: 1099, options: {} }];
  const r = verifyRequiredOptionsCovered(runWithFinalCart(cart), requiredGroups);
  assertEquals(r.applied, false);
  assertEquals(r.passed, true);
});

Deno.test("multi-group item: one of two required groups missing still FAILS", () => {
  const PIZZA_ID = "42189675-84e8-4213-bb5c-ea9b6643d0ff"; // Buffalo Chicken - Medium
  const requiredGroups = new Map([[PIZZA_ID, ["Sauce", "Bleu cheese or ranch"]]]);
  const cart = [
    {
      menu_item_id: PIZZA_ID,
      name: "Buffalo Chicken - Medium (14\")",
      quantity: 1,
      price_cents: 1999,
      options: { Sauce: ["Mild"] }, // "Bleu cheese or ranch" never answered
    },
  ];
  const r = verifyRequiredOptionsCovered(runWithFinalCart(cart), requiredGroups);
  assertEquals(r.applied, true);
  assertEquals(r.passed, false);
});
