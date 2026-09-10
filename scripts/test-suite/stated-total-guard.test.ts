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
import { verifyStatedTotal, verifyCartOpsInvariants } from "./cart-ops.ts";
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

// ── RED→GREEN (2026-09-07): label-then-amount receipt format must not let
// "$0.99\nTotal" (fee line immediately followed by the Total line) be
// mistaken for the real total. findQuotedTotal's old Pattern 1 used \s*,
// which crosses the newline between the fee line and the Total line below
// it, matching "$0.99\nTotal" and returning 99 cents instead of the real
// total on the Total line itself. ──

Deno.test("receipt format: Wings item — 'Total $17.98' on its own line, not '$0.99' from the fee line above", () => {
  const cart = [{ name: "Wings (Bone-In) - 10 Pieces", quantity: 1, price_cents: 1699 }];
  const reply =
    `Wings (Bone-In) - 10 Pieces (Wing Flavor: Hot)  $16.99\n` +
    `Subtotal                                         $16.99\n` +
    `Service fee                                       $0.99\n` +
    `Total                                            $17.98`;
  const r = verifyStatedTotal(run(reply, cart));
  assertEquals(r.applied, true);
  assertEquals(r.passed, true);
});

Deno.test("receipt format: Cheese pizza — 'Total $13.94' extracted correctly", () => {
  const cart = [{ name: "Cheese - Small (10\")", quantity: 1, price_cents: 1295 }];
  const reply =
    `Cheese - Small (10")            $12.95\n` +
    `Subtotal                        $12.95\n` +
    `Service fee                      $0.99\n` +
    `Total                           $13.94`;
  const r = verifyStatedTotal(run(reply, cart));
  assertEquals(r.applied, true);
  assertEquals(r.passed, true);
});

Deno.test("receipt format: Cali Fries — 'Total $10.98' extracted correctly", () => {
  const cart = [{ name: "Cali Fries", quantity: 1, price_cents: 999 }];
  const reply =
    `Cali Fries                       $9.99\n` +
    `Subtotal                         $9.99\n` +
    `Service fee                      $0.99\n` +
    `Total                           $10.98`;
  const r = verifyStatedTotal(run(reply, cart));
  assertEquals(r.applied, true);
  assertEquals(r.passed, true);
});

Deno.test("receipt format: wrong stated total on the Total line still FAILS (guard not weakened)", () => {
  const cart = [{ name: "Cali Fries", quantity: 1, price_cents: 999 }];
  const reply =
    `Cali Fries                       $9.99\n` +
    `Subtotal                         $9.99\n` +
    `Service fee                      $0.99\n` +
    `Total                           $99.99`;
  const r = verifyStatedTotal(run(reply, cart));
  assertEquals(r.applied, true);
  assertEquals(r.passed, false);
});

// ── RED→GREEN (2026-09-10): findQuotedTotal's own service-fee cleaning step
// must not cross a newline either. Vito's Pizza category-coverage-pizza-
// finish-buffalo-chicken (Bleu Cheese, a $0.00 modifier-priced item) FAILED
// the cartops quoted_total_matches_cart invariant with "Quoted $1.98
// (subtotal Subtotal: : $0.99 + $0.99 fee) but cart computes to $0.99" even
// though the bot's actual reply was byte-for-byte correct. Root cause: the
// pre-clean `\$0[.,]\d{2}\s*(?:service\s+)?fee` regex used \s* (crosses
// newlines), so on a sub-$1.00 subtotal ("Subtotal: $0.00\nService fee:
// $0.99\n...") it matched "$0.00\nService fee" as ONE span across the line
// break and deleted it, splicing the Subtotal label's ": " onto the Service
// fee line's ": $0.99" — producing a corrupted "Subtotal: : $0.99" that
// Pattern 2 then misread as a $0.99 subtotal, doubling the $0.99 fee on top
// to get $1.98. This is a harness false-positive, not a live money defect —
// fixed by constraining the cleaning regex to [ \t]* / [ \t]+ so it can never
// span a line break, matching every other newline-safety guard in this file.
Deno.test("sub-$1.00 subtotal immediately followed by the fee line is not corrupted into a phantom double-fee total", () => {
  const cart = [{ name: "Bleu Cheese", quantity: 1, price_cents: 0 }];
  const reply =
    `Got the Bleu Cheese added. Is this for pickup or delivery today? And ` +
    `were you looking to add that as a finish to a Buffalo Chicken pizza, ` +
    `or just on its own?\n\n` +
    `Subtotal: $0.00\nService fee: $0.99\nTotal: $0.99\n\n` +
    `Msg & data rates may apply. Reply HELP for help or STOP to unsubscribe.`;
  const r = verifyStatedTotal(run(reply, cart));
  assertEquals(r.applied, true);
  assertEquals(r.passed, true);
});

// verifyCartOpsInvariants scans EVERY turn (not just the last, unlike
// verifyStatedTotal's reverse-scan), so it hit the corrupted-parse bug above
// on turn 1 even though the later checkout turn's total was fine — this is
// the invariant ("cartops:quoted_total_matches_cart") that actually failed
// on the real Vito's Pizza run. Reproduced with the real 3-turn shape.
Deno.test("cartops quoted_total_matches_cart: real Vito's Pizza Bleu Cheese transcript no longer false-fails", () => {
  const cart = [{ name: "Bleu Cheese", quantity: 1, price_cents: 0 }];
  const runResult = {
    transcript: [
      {
        role: "customer",
        message: "Hi, can I get a Bleu Cheese?",
        cart,
        phase: "building",
        reply:
          `Got the Bleu Cheese added. Is this for pickup or delivery today? And ` +
          `were you looking to add that as a finish to a Buffalo Chicken pizza, ` +
          `or just on its own?\n\n` +
          `Subtotal: $0.00\nService fee: $0.99\nTotal: $0.99\n\n` +
          `Msg & data rates may apply. Reply HELP for help or STOP to unsubscribe.`,
      },
      {
        role: "customer",
        message: "That's it, checkout please",
        cart,
        phase: "building",
        reply: "Got it! What's your name for the order?",
      },
      {
        role: "customer",
        message: "Jason",
        cart,
        phase: "checkout",
        reply:
          `Payment link sent! Your total is $0.99 (includes a $0.99 service fee). ` +
          `Tap it to complete your order. Check your text or email.\n\n` +
          `Pay here: https://pay.getsprintai.com/o/6701669a`,
      },
    ],
  } as unknown as RunResult;
  const result = verifyCartOpsInvariants(runResult);
  const totalInv = result.invariants.find((i) => i.id === "quoted_total_matches_cart");
  assertEquals(totalInv?.passed, true, totalInv?.detail);
  assertEquals(result.passed, true);
});
