/**
 * conv-pickup-only-clarification — 4x overcharge via duplicate cart line
 * (Red-Green Evidence, 2026-09-11)
 *
 * Bug: run 3e607524-d84a-460b-8136-bfe9dbfd3b82, case_id
 * conv-pickup-only-clarification, Not Just Bagels (shop_id
 * b0000000-0000-0000-0000-000000000001). A customer ordered a Chicken
 * Cutlet Sandwich ($10.95), then asked "Can I get provolone on that?" — a
 * plain modifier-add follow-up referring to the sandwich already in the
 * cart, not a new order. The model called add_item (not modify_item) for
 * the follow-up, with a hallucinated quantity of 3. Because "Provolone"
 * isn't a recorded option for this item, it landed only in
 * unverified_requests — which differs from the existing line's (empty) set,
 * so the strict full-identity merge match in executeTool's add_item case
 * (index.ts, by design — see the D1 comment there) refused to merge it,
 * and a brand-new quantity-3 line was pushed instead. Cart went from 1 item
 * ($10.95) to 4 items ($43.80 subtotal, $44.79 with fee) — a ~4x
 * overcharge. Both no_duplicate_lines and no_mutation_on_non_order failed.
 *
 * Fix: executeTool's add_item case (index.ts) now recognizes this shape —
 * a call whose only differentiator would be a NEW unverified_requests entry
 * (no options/modifiers of its own), targeting a menu_item_id with exactly
 * one existing cart line, where the customer's own turn message never
 * names the item at all (only refers to it by pronoun) — and merges the
 * unverified request onto the EXISTING line instead of creating a
 * duplicate, leaving quantity untouched (the call's own quantity is never
 * trusted in this branch). See the "MODIFIER-FOLLOWUP GUARD" comment in
 * executeTool's add_item case for the full explanation and its scope
 * (explicitly does not touch the Vito's Flatbread D1 fix's "two distinct
 * items in one turn" case, GUARD 12/16, or pricing logic).
 *
 * This file cannot invoke executeTool directly (not exported from the edge
 * function, same constraint as every other *.test.ts in this directory) —
 * it proves the invariant checker correctly scores the pre-fix transcript
 * as FAILING and the post-fix transcript (same conversation, corrected
 * cart) as PASSING, matching the pattern in named-remove-middle.test.ts.
 * Live re-verification against the deployed fix is the real regression
 * gate (RUNBOOK.md convention: committed is not deployed).
 *
 * Run: deno test --allow-net --allow-env --allow-read scripts/test-suite/njb-modifier-followup-no-duplicate.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyCartOpsInvariants } from "./cart-ops.ts";
import type { RunResult } from "./runner.ts";

// Exact pre-fix transcript pulled from qa_ro.test_case_results
// (run_id=3e607524-d84a-460b-8136-bfe9dbfd3b82, case_id=conv-pickup-only-clarification).
function buggyRun(): RunResult {
  return {
    caseId: "conv-pickup-only-clarification",
    shopId: "b0000000-0000-0000-0000-000000000001",
    sessionId: "sms:test-session",
    transcript: [
      {
        role: "customer",
        phase: "greeting",
        message: "Do you guys deliver?",
        reply:
          "We're pickup only - we don't offer delivery. But you can call ahead to place your order and we'll have it ready when you get here. What can I get for you?\n\n" +
          "Msg & data rates may apply. Reply HELP for help or STOP to unsubscribe.",
        cart: [],
      },
      {
        role: "customer",
        phase: "building",
        message: "Alright, pickup works. Can I get a chicken cutlet sandwich? That's $10.95 right?",
        reply:
          "Yep, $10.95. The chicken cutlet comes with your choice of cheese, plus mayo, lettuce, tomatoes, and onions on a roll. What kind of cheese would you like?\n\n" +
          "Subtotal: $10.95\nService fee: $0.99\nTotal: $11.94",
        cart: [
          {
            name: "Chicken Cutlet Sandwich",
            quantity: 1,
            modifiers: [],
            price_cents: 1095,
            menu_item_id: "0df7f455-97a0-4149-8985-fbf66f503f97",
            sourcePhraseIndex: 1,
          },
        ],
      },
      {
        role: "customer",
        phase: "building",
        message: "Can I get provolone on that?",
        reply:
          "Chicken cutlet sandwich added - and I'll pass the provolone request along to the shop for confirmation. Anything else?\n\n" +
          "Subtotal: $43.80\nService fee: $0.99\nTotal: $44.79",
        cart: [
          {
            name: "Chicken Cutlet Sandwich",
            quantity: 1,
            modifiers: [],
            price_cents: 1095,
            menu_item_id: "0df7f455-97a0-4149-8985-fbf66f503f97",
            sourcePhraseIndex: 1,
          },
          {
            name: "Chicken Cutlet Sandwich",
            quantity: 3,
            modifiers: [],
            price_cents: 1095,
            menu_item_id: "0df7f455-97a0-4149-8985-fbf66f503f97",
            sourcePhraseIndex: 0,
            unverified_requests: ["Provolone"],
          },
        ],
      },
    ],
  } as unknown as RunResult;
}

// Same conversation, cart as the fix produces: the provolone request
// attaches to the SAME line (quantity untouched at 1), no duplicate.
function fixedRun(): RunResult {
  const run = buggyRun();
  run.transcript[2] = {
    ...run.transcript[2],
    reply:
      "Got it - I'll pass the provolone request along to the shop for confirmation. Anything else?\n\n" +
      "Subtotal: $10.95\nService fee: $0.99\nTotal: $11.94",
    cart: [
      {
        name: "Chicken Cutlet Sandwich",
        quantity: 1,
        modifiers: [],
        price_cents: 1095,
        menu_item_id: "0df7f455-97a0-4149-8985-fbf66f503f97",
        sourcePhraseIndex: 1,
        unverified_requests: ["Provolone"],
      },
    ],
  };
  return run;
}

Deno.test("RED: pre-fix transcript fails no_duplicate_lines", () => {
  const result = verifyCartOpsInvariants(buggyRun());
  const inv = result.invariants.find((i) => i.id === "no_duplicate_lines");
  assertEquals(inv?.passed, false, inv?.detail);
});

Deno.test("RED: pre-fix transcript fails no_mutation_on_non_order", () => {
  const result = verifyCartOpsInvariants(buggyRun());
  const inv = result.invariants.find((i) => i.id === "no_mutation_on_non_order");
  assertEquals(inv?.passed, false, inv?.detail);
});

Deno.test("GREEN: post-fix transcript (modifier merged onto existing line) passes no_duplicate_lines", () => {
  const result = verifyCartOpsInvariants(fixedRun());
  const inv = result.invariants.find((i) => i.id === "no_duplicate_lines");
  assertEquals(inv?.passed, true, inv?.detail);
});

Deno.test("GREEN: post-fix transcript passes no_mutation_on_non_order", () => {
  const result = verifyCartOpsInvariants(fixedRun());
  const inv = result.invariants.find((i) => i.id === "no_mutation_on_non_order");
  assertEquals(inv?.passed, true, inv?.detail);
});
