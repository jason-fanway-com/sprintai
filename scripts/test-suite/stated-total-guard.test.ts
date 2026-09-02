/**
 * stated-total false-positive guard — Red-Green Evidence (2026-09-02)
 *
 * Bug: findQuotedTotal's Pattern 3 alternative `comes? to` matched "come to"
 * inside the greeting "Welcome to Vito's Pizza", and the greedy `\D*` then
 * reached the first "$10.99" inside a disambiguation QUESTION ~40 chars away.
 * Result: menu-single-510 / -517 FAILED stated-total ("bot quoted $10.99, cart
 * empty") when the bot behaved correctly — it asked which item the customer
 * meant and added nothing.
 *
 * Fix: \bcomes? to\b (word boundaries) + \D{0,15} (amount must be adjacent to
 * the total-claim keyword). A price inside a question/options list is not a
 * total claim; a real "total is $X" / "comes to $X" still is.
 *
 * Run: deno test scripts/test-suite/stated-total-guard.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyStatedTotal } from "./cart-ops.ts";
import type { RunResult } from "./runner.ts";

function run(reply: string, cart: unknown): RunResult {
  return { transcript: [{ reply, cart }] } as unknown as RunResult;
}

// ── RED→GREEN: disambiguation questions must NOT be read as quoted totals ──

Deno.test("510: 'Welcome to' greeting + price in a 'did you mean' question is not a total", () => {
  const reply =
    `Hey there! Welcome to Vito's Pizza. We've got a few "Greek" options — ` +
    `did you mean the Greek Salad ($10.99) or the Greek Chicken Wrap ($10.99)?`;
  const r = verifyStatedTotal(run(reply, []));
  assertEquals(r.applied, false); // nothing to verify → not a FAIL
  assertEquals(r.passed, true);
});

Deno.test("517: 'Welcome to' greeting + options-list price is not a total", () => {
  const reply =
    `Hi! Welcome to Vito's Pizza! Just to clarify — when you say "Everything," ` +
    `did you mean the Everything Stromboli Roll ($9.99 — pepperoni, onions)?`;
  const r = verifyStatedTotal(run(reply, []));
  assertEquals(r.applied, false);
  assertEquals(r.passed, true);
});

// ── Must STILL catch a genuine wrong total (guard not weakened) ──

Deno.test("wrong total: 'your total is $99.99' with an $11.98 cart FAILS", () => {
  const cart = [{ name: "Gyro", quantity: 1, price_cents: 1099 }];
  const r = verifyStatedTotal(run("Your total is $99.99 — ready to check out?", cart));
  assertEquals(r.applied, true);
  assertEquals(r.passed, false);
});

Deno.test("empty-cart phantom total 'that'll be $10.99' still FAILS", () => {
  const r = verifyStatedTotal(run("Great — that'll be $10.99 total.", []));
  assertEquals(r.applied, true);
  assertEquals(r.passed, false);
});

// ── Must STILL pass a correct total (both P3 and P1 phrasings) ──

Deno.test("correct total via P3 'comes to $11.98' matches a $10.99 cart", () => {
  const cart = [{ name: "Gyro", quantity: 1, price_cents: 1099 }];
  const r = verifyStatedTotal(run("Your order comes to $11.98.", cart));
  assertEquals(r.applied, true);
  assertEquals(r.passed, true);
});

Deno.test("correct total via P1 '$11.98 total' matches a $10.99 cart", () => {
  const cart = [{ name: "Gyro", quantity: 1, price_cents: 1099 }];
  const reply = "1 item — $11.98 total\n(subtotal $10.99 + $0.99 service fee)";
  const r = verifyStatedTotal(run(reply, cart));
  assertEquals(r.applied, true);
  assertEquals(r.passed, true);
});
