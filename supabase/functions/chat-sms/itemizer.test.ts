// Item 2 (2026-09-09, module extraction): unit tests for itemizer.ts.
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { padReceiptLine, renderItemizedRecap, renderLedgerFooter, type ItemizedCartLine } from "./itemizer.ts";

Deno.test("padReceiptLine: pads to the fixed width, right-aligning the amount", () => {
  const line = padReceiptLine("Cheese Pizza", "$12.99", 20);
  assertEquals(line.length, 20);
  assertEquals(line.endsWith("$12.99"), true);
});

Deno.test("padReceiptLine: never throws when label alone fills the width", () => {
  const line = padReceiptLine("A".repeat(50), "$1.00", 38);
  assertEquals(line.endsWith("$1.00"), true);
});

Deno.test("renderItemizedRecap: lists each line, subtotal, service fee, and total", () => {
  const cart: ItemizedCartLine[] = [
    { name: "Cheese Pizza", price_cents: 1500, quantity: 1 },
    { name: "Coke", price_cents: 200, quantity: 2 },
  ];
  const recap = renderItemizedRecap(cart);
  assertStringIncludes(recap, "Cheese Pizza");
  assertStringIncludes(recap, "$15.00");
  assertStringIncludes(recap, "2x Coke");
  assertStringIncludes(recap, "$4.00");
  assertStringIncludes(recap, "Subtotal");
  assertStringIncludes(recap, "$19.00");
  assertStringIncludes(recap, "Service fee");
  assertStringIncludes(recap, "Total");
});

Deno.test("renderItemizedRecap: an incomplete bundle renders with '(selecting flavors)' flag (P0 fix 2026-09-09)", () => {
  // Prior behavior: skip entirely. New: show price + in-progress label so
  // the customer sees committed money before flavor choices are complete.
  const cart: ItemizedCartLine[] = [
    { type: "bundle", name: "Wing Bundle", price_cents: 1999, complete: false, selections: [] },
  ];
  const recap = renderItemizedRecap(cart);
  assertEquals(recap.includes("Wing Bundle (selecting flavors)"), true);
  assertEquals(recap.includes("$19.99"), true);
});

Deno.test("renderItemizedRecap: a complete bundle renders its flat price and selections", () => {
  const cart: ItemizedCartLine[] = [
    { type: "bundle", name: "Wing Bundle", price_cents: 1999, complete: true, selections: [{ flavor: "Buffalo", quantity: 10 }] },
  ];
  const recap = renderItemizedRecap(cart);
  assertStringIncludes(recap, "Wing Bundle (10x Buffalo)");
  assertStringIncludes(recap, "$19.99");
});

Deno.test("renderItemizedRecap: delivery fee and driver tip lines only render when present", () => {
  const cart: ItemizedCartLine[] = [{ name: "Cheese Pizza", price_cents: 1500, quantity: 1 }];
  const withoutFees = renderItemizedRecap(cart);
  assertEquals(withoutFees.includes("Delivery fee"), false);
  assertEquals(withoutFees.includes("Driver tip"), false);

  const withFees = renderItemizedRecap(cart, 300, 200);
  assertStringIncludes(withFees, "Delivery fee");
  assertStringIncludes(withFees, "Driver tip");
});

Deno.test("renderLedgerFooter: renders Subtotal / Service fee / Total lines", () => {
  const cart: ItemizedCartLine[] = [{ name: "Cheese Pizza", price_cents: 1500, quantity: 1 }];
  const footer = renderLedgerFooter(cart, "building");
  assertStringIncludes(footer, "Subtotal");
  assertStringIncludes(footer, "Service fee");
  assertStringIncludes(footer, "Total");
});

Deno.test("renderLedgerFooter: empty cart renders nothing", () => {
  assertEquals(renderLedgerFooter([], "building"), "");
});
