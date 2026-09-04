/**
 * Tests for the 2026-09-04 reply-rendering fixes.
 *
 * BUG 1 — Guard 2b destroyed the model's trailing punctuation when appending
 *         "Pickup or delivery today?", producing "What else can I add. Pickup...".
 * BUG 2 — Guards emitted "<items> — $21.49 total." and stripLlmMoneyLines()
 *         later removed the amount, shipping "1x French Fries — . What else".
 *
 * These are pure string functions, copied here verbatim from index.ts (which has
 * no exports — it is a Deno.serve entrypoint).
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

function cartTotalFragment(totalCents: number | null | undefined): string {
  if (totalCents === null || totalCents === undefined) return "";
  if (!Number.isFinite(totalCents) || totalCents <= 0) return "";
  return ` — $${(totalCents / 100).toFixed(2)} total`;
}

function repairOrphanedPunctuation(text: string): string {
  return text
    .replace(/\s*[—–-]\s*([.,;:!?])/g, "$1")
    .replace(/\s+[—–-]\s+total\b/gi, "")
    .replace(/\s*[—–-]\s*$/gm, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])\1{1,}/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function appendDeliveryQuestion(reply: string): string {
  const guardBase = reply.trimEnd();
  return guardBase
    ? `${guardBase}${/[.!?]$/.test(guardBase) ? "" : "."} Pickup or delivery today?`
    : "Pickup or delivery today?";
}

// ── BUG 2 ────────────────────────────────────────────────────────────────────

Deno.test("RED->GREEN: the exact shipped defect, dangling dash after total strip", () => {
  const shipped = 'Your cart: 1x Cheese - Large (16"), 1x French Fries — . What else can I add?';
  assertEquals(
    repairOrphanedPunctuation(shipped),
    'Your cart: 1x Cheese - Large (16"), 1x French Fries. What else can I add?',
  );
});

Deno.test("BUG2: hyphenated menu items are NOT mangled", () => {
  for (const name of [
    '1x Cheese - Large (16")',
    "1x Wings (Bone-In) - 10 Pieces",
    "2x Sweet Potato Fries",
  ]) {
    assertEquals(repairOrphanedPunctuation(`Your cart: ${name}. Anything else?`),
                 `Your cart: ${name}. Anything else?`);
  }
});

Deno.test("BUG2: 'Sub-total' is not truncated to 'Sub' (review finding)", () => {
  assertEquals(repairOrphanedPunctuation("Sub-total: $12.50"), "Sub-total: $12.50");
});

Deno.test("BUG2: a line-item price with a hyphen survives", () => {
  assertEquals(repairOrphanedPunctuation("1x Item - $5.00"), "1x Item - $5.00");
});

Deno.test("BUG2: orphaned ' — total' left by the money stripper is removed", () => {
  assertEquals(repairOrphanedPunctuation("Your cart: 1x Fries — total. What else?"),
               "Your cart: 1x Fries. What else?");
});

Deno.test("BUG2: trailing dash is removed", () => {
  assertEquals(repairOrphanedPunctuation("Your cart: 1x Fries —"), "Your cart: 1x Fries");
});

Deno.test("BUG2: fragment omitted for missing/zero/non-finite totals", () => {
  for (const v of [null, undefined, 0, -1, NaN, Infinity]) {
    assertEquals(cartTotalFragment(v as number | null | undefined), "");
  }
});

Deno.test("BUG2: fragment rendered for a real positive total", () => {
  assertEquals(cartTotalFragment(2148), " — $21.48 total");
});

// ── BUG 1 ────────────────────────────────────────────────────────────────────

Deno.test("RED->GREEN: question mark is preserved, not replaced with a period", () => {
  assertEquals(appendDeliveryQuestion("What else can I add?"),
               "What else can I add? Pickup or delivery today?");
});

Deno.test("BUG1: exclamation mark is preserved", () => {
  assertEquals(appendDeliveryQuestion("Fries are in!"),
               "Fries are in! Pickup or delivery today?");
});

Deno.test("BUG1: a reply with no terminal punctuation gets exactly one period", () => {
  assertEquals(appendDeliveryQuestion("Bone-in or boneless"),
               "Bone-in or boneless. Pickup or delivery today?");
});

Deno.test("BUG1: empty reply yields the bare question", () => {
  assertEquals(appendDeliveryQuestion("   "), "Pickup or delivery today?");
});

// ── BUG 1: "already present" suppression ─────────────────────────────────────

const hasExactQuestion = (r: string) => /Pickup or delivery today\?/i.test(r);
const statesPickupOnly = (r: string) =>
  /pickup[- ]only|only (?:doing|offering|available for) pickup|we (?:do not|don['’]t) (?:offer|do) delivery|no delivery (?:option|available|right now|today|at this time)/i.test(r);

Deno.test("BUG1: never double-appends — exact phrase already present", () => {
  assertEquals(hasExactQuestion("Fries added! Pickup or delivery today?"), true);
});

Deno.test("BUG1: suppressed when the reply already says pickup only", () => {
  assertEquals(statesPickupOnly("Just so you know, we're pickup only at this time."), true);
});

Deno.test("BUG1: 'no delivery fee' does NOT suppress the gate (review finding)", () => {
  for (const r of ["There's no delivery fee on that.", "No delivery minimum today.",
                   "no delivery charge on orders over $30"]) {
    assertEquals(statesPickupOnly(r), false);
  }
});

Deno.test("BUG1: a genuine 'no delivery available' DOES suppress", () => {
  assertEquals(statesPickupOnly("Sorry, no delivery available right now."), true);
});

// ── 2026-09-04 CHANGE 2: guard-overwrite regressions ─────────────────────────

function repairV2(text: string): string {
  return text
    .replace(/\(\s*\)/g, "")
    .replace(/\b\d+\s+items?\s*[—–-]\s*(?=[.!?]|$)/gim, "")
    .replace(/\s*[—–-]\s*([.,;:!?])/g, "$1")
    .replace(/\s+[—–-]\s+total\b/gi, "")
    .replace(/\s*[—–-]\s*$/gm, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])\1{1,}/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const claimsATotal = (r: string) =>
  /\b(?:total|subtotal|comes to|that['’]ll be|that will be|you owe|grand total|order total|due|to pay|adds up to|comes out to|altogether|all together)\b/i.test(r);

Deno.test("2c: offering menu prices is NOT quoting a total", () => {
  assertEquals(claimsATotal("Sure thing — bone-in ($16.99) or boneless ($11.99)?"), false);
  assertEquals(claimsATotal("For the wings, Bone-In is $16.99 and Boneless is $11.99."), false);
});

Deno.test("2c: an actual total claim still trips", () => {
  assertEquals(claimsATotal("Your total is $39.47"), true);
  assertEquals(claimsATotal("That comes to $39.47"), true);
  assertEquals(claimsATotal("3 items — $38.48 total (subtotal $37.49 + $0.99 service fee)"), true);
});

Deno.test("empty parens left by money stripping are removed", () => {
  assertEquals(repairV2("Sure thing — bone-in ( ) or boneless ( )?"),
               "Sure thing — bone-in or boneless?");
});

Deno.test("orphaned '3 items —' left by money stripping is removed", () => {
  assertEquals(repairV2("Want to mix flavors or keep as is? 3 items — ( )"),
               "Want to mix flavors or keep as is?");
});
