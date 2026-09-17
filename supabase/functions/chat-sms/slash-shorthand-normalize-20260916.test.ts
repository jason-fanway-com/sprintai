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
