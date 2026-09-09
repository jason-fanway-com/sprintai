/**
 * conv-named-remove-middle false-positive — Red-Green Evidence (2026-09-09)
 *
 * Bug: run 8bde8211-1793-47c3-aac8-d5fcf22d962c flagged this case as a cart
 * mutation defect: "Turn 1: \"No toppings, just cheese. Now can you re...\"
 * is a question/name/tip but cart changed from 2 to 1 items". The bot's
 * actual behavior was CORRECT — the customer's message explicitly said
 * "Now can you remove the pizza? I only want the garlic knots.", and the
 * bot removed the pizza and kept the garlic knots, satisfying both of the
 * case's success criteria.
 *
 * Root cause: isQuestion() in cart-ops.ts (the no_mutation_on_non_order
 * invariant's classifier) matched "can you" in the message and classified
 * the whole turn as a pure question, never noticing the explicit "remove
 * the pizza" command later in the same sentence. The invariant then flagged
 * the resulting (correct) cart mutation as unexpected. This is a test-scorer
 * defect, not a resolver/ask-plan-engine defect — the additive-intent carve
 * out already existed for "can I also add X?"; no symmetric carve-out
 * existed for removal commands like "can you remove X?".
 *
 * Fix: isQuestion() now also carves out messages containing an explicit
 * removal/cancellation verb (remove/cancel/delete/take off/take out/get rid
 * of/scratch/nix/don't want), matching the existing additive-intent pattern.
 *
 * Note: the LLM judge (advisory only, does not gate `passed`) also produced
 * an incorrect verdict for this case ("cart state from msg-2 still includes
 * pizza and knots" — false per the transcript). That is a separate judge-
 * accuracy issue, out of scope here since the judge does not gate pass/fail
 * (see supabase/functions/test-runner/index.ts: "LLM judge (advisory only —
 * does NOT gate pass/fail)").
 *
 * Run: deno test --allow-net --allow-env --allow-read scripts/test-suite/named-remove-middle.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyCartOpsInvariants } from "./cart-ops.ts";
import type { RunResult } from "./runner.ts";

// Exact transcript pulled from test_case_results
// (run_id=8bde8211-1793-47c3-aac8-d5fcf22d962c, case_id=conv-named-remove-middle).
const run: RunResult = {
  caseId: "conv-named-remove-middle",
  shopId: "vitos-pizza-qa",
  sessionId: "web:test-session",
  transcript: [
    {
      role: "customer",
      phase: "building",
      message: "I'd like a large cheese pizza and some garlic knots",
      reply:
        "Got it - large cheese pizza and garlic knots added. Any toppings for the pizza, or is that good as is?\n\n" +
        "Subtotal: $22.49\nService fee: $0.99\nTotal: $23.48\n\n" +
        "Msg & data rates may apply. Reply HELP for help or STOP to unsubscribe.",
      cart: [
        {
          name: "Cheese - Large (16\")",
          quantity: 1,
          modifiers: [],
          price_cents: 1650,
          menu_item_id: "8857b40a-e53b-44fa-8bf0-6fdafb7efa45",
        },
        {
          name: "Garlic Knots (6)",
          quantity: 1,
          modifiers: [],
          price_cents: 599,
          menu_item_id: "b0f51dd9-9380-4a48-989d-096467545ca6",
        },
      ],
    },
    {
      role: "customer",
      phase: "building",
      message: "No toppings, just cheese. Now can you remove the pizza? I only want the garlic knots.",
      reply: "Your cart:\n\nGarlic Knots (6) $5.99\nSubtotal $5.99\nService fee $0.99\nTotal $6.98\n\nWhat else can I add?",
      cart: [
        {
          name: "Garlic Knots (6)",
          quantity: 1,
          modifiers: [],
          price_cents: 599,
          menu_item_id: "b0f51dd9-9380-4a48-989d-096467545ca6",
        },
      ],
    },
  ],
} as unknown as RunResult;

Deno.test("no_mutation_on_non_order does not flag an explicit 'can you remove the pizza?' command", () => {
  const result = verifyCartOpsInvariants(run);
  const noMutationInv = result.invariants.find((inv) => inv.id === "no_mutation_on_non_order");
  assertEquals(noMutationInv?.passed, true, noMutationInv?.detail);
});
