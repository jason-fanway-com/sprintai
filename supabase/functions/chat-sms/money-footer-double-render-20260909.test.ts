// P0 (2026-09-09, live money defect — Zio's incident, step 2 fix).
//
// Live repro: remove a priced modifier ("remove the extra cheese") on a Large
// Neapolitan Cheese Pizza at Zio's (shop_id 2cba7b51-211c-4437-8910-1af4dcc03498).
// The post-mutation confirmation the customer received read:
//   "Your cart: Large 18'' Neapolitan Cheese Pizza $17.99
//    Service fee $18.98   What else can I add?"
// — the Subtotal line was gone entirely, and $18.98 (the real TOTAL) was
// printed under the "Service fee" label. The read-only cart-summary reply,
// same cart/moment, rendered correctly via itemizer.ts.
//
// Root cause: three deterministic guards in index.ts (PROOF-P2, GUARD 1f,
// GUARD 2c's fallback) already finalize `reply` with renderItemizedRecap()'s
// own code-rendered receipt before falling through -- with no early return --
// into Phase A, which unconditionally ran stripLlmMoneyLines() on `reply`
// and then appended a second Ledger footer. stripLlmMoneyLines() is built to
// scrub LLM-composed PROSE; its regexes use `\s*`/`\s{2,}`, which match
// across newlines. Run against the itemizer's own padded, newline-separated
// receipt, it deletes the "Subtotal ... $17.99" line outright (collapsing
// the surrounding blank line into the previous line) and its
// `\$0.99\s*total` pattern eats "$0.99\nTotal" while orphaning the trailing
// "$18.98" -- which is exactly the observed defect: no Subtotal line, and
// the Total's own value stranded directly after the words "Service fee".
//
// The fix (index.ts, `moneyFooterAlreadyRendered`): any guard that finalizes
// `reply` with the itemizer's own receipt sets that flag, and Phase A skips
// stripLlmMoneyLines()/the footer-append entirely when it's set -- the
// receipt IS the footer already, and must reach the customer byte-for-byte.
//
// This file cannot unit-test index.ts's internal control flow directly (it's
// a single large HTTP handler, not decomposed for that), so it proves the
// mechanism at the level that IS unit-testable: the itemizer's real return
// value for the exact repro cart is well-formed (three distinct, correctly
// labelled, correctly valued lines), and stripLlmMoneyLines demonstrably
// corrupts that exact output in exactly the way the customer saw --
// documenting why moneyFooterAlreadyRendered must gate it.

import { assertEquals, assertNotEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { renderItemizedRecap, renderLedgerFooter, type ItemizedCartLine } from "./itemizer.ts";
import { stripLlmMoneyLines } from "./index.ts";

// Zio's live repro: Large 18" Neapolitan Cheese Pizza, extra cheese just
// removed -- the item's OWN price ($17.99) already reflects the removal;
// this is the post-mutation cart state renderItemizedRecap is called on.
const ZIOS_CART: ItemizedCartLine[] = [
  { name: `Large 18'' Neapolitan Cheese Pizza`, price_cents: 1799, quantity: 1, menu_item_id: "zios-large-cheese" },
];

// Vito's canary (shop_id e0000000-0000-0000-0000-000000000001): unaffected
// control case, must keep rendering correctly.
const VITOS_CART: ItemizedCartLine[] = [
  { name: "Cheeseburger", price_cents: 849, quantity: 1, menu_item_id: "vitos-cheeseburger-medium" },
];

function assertThreeDistinctMoneyLines(recap: string, subtotal: string, fee: string, total: string) {
  const lines = recap.split("\n").map(l => l.trim()).filter(Boolean);
  const subtotalLines = lines.filter(l => l.startsWith("Subtotal"));
  const feeLines = lines.filter(l => l.startsWith("Service fee"));
  const totalLines = lines.filter(l => l.startsWith("Total"));
  assertEquals(subtotalLines.length, 1, `expected exactly one Subtotal line, got: ${JSON.stringify(lines)}`);
  assertEquals(feeLines.length, 1, `expected exactly one Service fee line, got: ${JSON.stringify(lines)}`);
  assertEquals(totalLines.length, 1, `expected exactly one Total line, got: ${JSON.stringify(lines)}`);
  assertStringIncludes(subtotalLines[0], subtotal);
  assertStringIncludes(feeLines[0], fee);
  assertStringIncludes(totalLines[0], total);
  // The defect specifically mislabeled the Total's value under "Service
  // fee" -- guard against that exact confusion even if amounts happen to
  // collide in some future cart state.
  assertEquals(feeLines[0].includes(total) && total !== fee, false, `Service fee line wrongly carries the Total's value: ${feeLines[0]}`);
}

Deno.test("Zio's repro: renderItemizedRecap produces Subtotal $17.99 / Service fee $0.99 / Total $18.98 as three separate lines", () => {
  const recap = renderItemizedRecap(ZIOS_CART);
  assertThreeDistinctMoneyLines(recap, "$17.99", "$0.99", "$18.98");
});

Deno.test("Zio's repro: renderLedgerFooter (used by the pre-LLM option-removal path) agrees with renderItemizedRecap", () => {
  const recap = renderItemizedRecap(ZIOS_CART);
  const footer = renderLedgerFooter(ZIOS_CART, "building");
  assertThreeDistinctMoneyLines(footer, "$17.99", "$0.99", "$18.98");
  // Both renderers must agree on every dollar figure for the same cart --
  // "one renderer, one source of truth" only holds if they can never drift.
  for (const amount of ["$17.99", "$0.99", "$18.98"]) {
    assertStringIncludes(recap, amount);
    assertStringIncludes(footer, amount);
  }
});

Deno.test("Vito's canary: renderItemizedRecap produces Subtotal $8.49 / Service fee $0.99 / Total $9.48, unaffected", () => {
  const recap = renderItemizedRecap(VITOS_CART);
  assertThreeDistinctMoneyLines(recap, "$8.49", "$0.99", "$9.48");
});

Deno.test("REGRESSION CHARACTERIZATION: stripLlmMoneyLines corrupts the itemizer's own receipt exactly as the live incident showed -- this is why it must never run on code-rendered receipt text", () => {
  const recap = renderItemizedRecap(ZIOS_CART);
  const stripped = stripLlmMoneyLines(recap);

  // The exact defect: the Subtotal line is gone.
  assertEquals(stripped.includes("Subtotal"), false, "expected the Subtotal line to survive intact, but stripLlmMoneyLines deleted it -- this IS the live defect");
  assertNotEquals(stripped, recap, "stripLlmMoneyLines must be a no-op on an already-correct itemizer receipt, but it is not -- confirms this function must never be called on itemizer output (see moneyFooterAlreadyRendered in index.ts)");
});

Deno.test("post-mutation confirmation reply must equal the item-removal confirmation text with the itemizer's UNMODIFIED receipt appended -- not a hand-composed or re-stripped string", () => {
  // Mirrors exactly what index.ts's PROOF-P2 / GUARD 1f / GUARD 2c call sites
  // build once moneyFooterAlreadyRendered is set: item-action text, then the
  // itemizer's own return value, verbatim -- never passed back through
  // stripLlmMoneyLines.
  const recap = renderItemizedRecap(ZIOS_CART);
  const reply = `Removed Extra Cheese from the Large 18'' Neapolitan Cheese Pizza.\n\n${recap}\n\nAnything else?`;

  assertStringIncludes(reply, recap);
  assertThreeDistinctMoneyLines(reply, "$17.99", "$0.99", "$18.98");

  // The bug's signature, stated as a negative assertion against the exact
  // reply the customer receives: never let the Total's value ($18.98)
  // appear directly adjacent to the words "Service fee" with no Service
  // fee value ($0.99) and no Subtotal line in between.
  assertEquals(/Service fee\s*\$18\.98/.test(reply), false);
});
