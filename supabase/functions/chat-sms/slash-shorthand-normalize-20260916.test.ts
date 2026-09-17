import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeSlashShorthand } from "./slash-shorthand-normalize-20260916.ts";

Deno.test("normalizeSlashShorthand: whitespace-padded slash becomes a comma, matching the live incident", () => {
  assertEquals(
    normalizeSlashShorthand("cheeseburger / medium / thats it"),
    "cheeseburger, medium, thats it",
  );
  assertEquals(
    normalizeSlashShorthand("coke / sprite / thats it"),
    "coke, sprite, thats it",
  );
  // Single slash, still whitespace-padded.
  assertEquals(normalizeSlashShorthand("turkey club / wheat"), "turkey club, wheat");
});

Deno.test("normalizeSlashShorthand: leaves tight (unspaced) slashes alone", () => {
  // Fractions, ratios, dates, abbreviations — never customer phrase-shorthand.
  assertEquals(normalizeSlashShorthand("I'll take 1/2 dozen bagels"), "I'll take 1/2 dozen bagels");
  assertEquals(normalizeSlashShorthand("50/50 cheese and pepperoni"), "50/50 cheese and pepperoni");
  assertEquals(normalizeSlashShorthand("N/A"), "N/A");
  assertEquals(normalizeSlashShorthand("ready by 9/16"), "ready by 9/16");
});

Deno.test("normalizeSlashShorthand: no slash is a no-op", () => {
  assertEquals(
    normalizeSlashShorthand("cheeseburger, medium, that's it"),
    "cheeseburger, medium, that's it",
  );
  assertEquals(normalizeSlashShorthand(""), "");
});

Deno.test("normalizeSlashShorthand: one-sided whitespace is left alone (narrow, conservative scope)", () => {
  // Only the unambiguous "spaced on both sides" shorthand shape is rewritten
  // -- a one-sided space is far more likely to be loose punctuation around a
  // genuinely tight token (e.g. a trailing "w/ fries") than list shorthand.
  assertEquals(normalizeSlashShorthand("w/ fries"), "w/ fries");
  assertEquals(normalizeSlashShorthand("fries /w gravy"), "fries /w gravy");
});

// Regression (2026-09-17, live QA report): Vito's real live menu (shop
// vitos-pizza) has two menu_items both literally named
// "Cheesesteak / Chicken Cheesesteak". The system prompt tells the model to
// recite menu item names verbatim, so the bot itself says this name to the
// customer -- if the customer names it back, the normalizer must not split
// it into two items.
Deno.test("normalizeSlashShorthand: does not split a live menu item name that itself contains a spaced slash", () => {
  const liveMenuItemNames = ["Cheesesteak / Chicken Cheesesteak", "Coke", "Sprite"];

  assertEquals(
    normalizeSlashShorthand("Cheesesteak / Chicken Cheesesteak", liveMenuItemNames),
    "Cheesesteak / Chicken Cheesesteak",
  );
  assertEquals(
    normalizeSlashShorthand("I'll take the Cheesesteak / Chicken Cheesesteak please", liveMenuItemNames),
    "I'll take the Cheesesteak / Chicken Cheesesteak please",
  );
  assertEquals(
    normalizeSlashShorthand("yes, Cheesesteak / Chicken Cheesesteak", liveMenuItemNames),
    "yes, Cheesesteak / Chicken Cheesesteak",
  );
  // Case-insensitive match.
  assertEquals(
    normalizeSlashShorthand("cheesesteak / chicken cheesesteak please", liveMenuItemNames),
    "cheesesteak / chicken cheesesteak please",
  );
});

// Synthetic equivalent of the ITEMK test-fixture shape (menu item name with
// multiple spaced slashes): "Traditional Cheesesteak / Chicken / Vegetarian
// (Small/Regular)". Every spaced slash inside the protected name must
// survive, while an unrelated spaced slash elsewhere in the same message
// still normalizes.
Deno.test("normalizeSlashShorthand: does not split a multi-slash live menu item name (ITEMK-shape)", () => {
  const liveMenuItemNames = ["Traditional Cheesesteak / Chicken / Vegetarian (Small/Regular)"];

  assertEquals(
    normalizeSlashShorthand("Traditional Cheesesteak / Chicken / Vegetarian (Small/Regular)", liveMenuItemNames),
    "Traditional Cheesesteak / Chicken / Vegetarian (Small/Regular)",
  );
  assertEquals(
    normalizeSlashShorthand(
      "I'll get the Traditional Cheesesteak / Chicken / Vegetarian (Small/Regular) / thats it",
      liveMenuItemNames,
    ),
    "I'll get the Traditional Cheesesteak / Chicken / Vegetarian (Small/Regular), thats it",
  );
});

Deno.test("normalizeSlashShorthand: original bug phrasing still normalizes when it does not match a menu item name", () => {
  const liveMenuItemNames = ["Cheesesteak / Chicken Cheesesteak"];

  assertEquals(
    normalizeSlashShorthand("cheeseburger / medium / thats it", liveMenuItemNames),
    "cheeseburger, medium, thats it",
  );
  assertEquals(
    normalizeSlashShorthand("coke / sprite / thats it", liveMenuItemNames),
    "coke, sprite, thats it",
  );
});
