// 00-AV: the bot asked a customer their own name nine times.
//
// Live repro, 100-conversation sim run against 1992f4ab:
//
//   CUSTOMER: I already told you, it's Alex! Can we finalize the order now?
//   BOT:      What's the name for the order?
//   CUSTOMER: My name is Alex! Can we please just complete the order now?
//   BOT:      What's the name for the order?
//   ... eight more times, then the customer quit.
//
// Root cause: looksLikeCustomerName required the WHOLE message to be a bare
// name -- /^[A-Za-z][A-Za-z .'-]{0,30}$/, three words max, no terminal
// punctuation. "Alex" passes. "It's Alex!" does not, and neither does any
// other way a person actually answers. Nothing caps the repeat, so the only
// exit was the customer leaving.
//
// The fix reads the name OUT of the message instead of demanding the message
// be nothing but the name. Deterministic, code-owned, no model call.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractCustomerName } from "./dialogue-signals.ts";

Deno.test("00-AV: the exact phrasings from the live nine-times loop all yield the name", () => {
  const cases: Array<[string, string]> = [
    ["I already told you, it's Alex! Can we finalize the order now?", "Alex"],
    ["My name is Alex! Can we please just complete the order now?", "Alex"],
    ["I already told you, the name is Alex! Let's finish this up!", "Alex"],
    ["It's Alex! Can we finalize this order now?", "Alex"],
    ["The name is Alex! Please finish my order now!", "Alex"],
    ["It's Alex! I've already said that. Can we please complete the order?", "Alex"],
    ["Alex! That's the name! Can we finalize it now?", "Alex"],
  ];
  for (const [input, expected] of cases) {
    assertEquals(extractCustomerName(input), expected, `failed to read the name out of: ${input}`);
  }
});

Deno.test("00-AV: other natural ways people give a name", () => {
  assertEquals(extractCustomerName("Alex"), "Alex", "a bare name must still work");
  assertEquals(extractCustomerName("alex"), "alex", "lowercase is still a name");
  assertEquals(extractCustomerName("Mary Jane Watson"), "Mary Jane Watson");
  assertEquals(extractCustomerName("this is Sarah"), "Sarah");
  assertEquals(extractCustomerName("put it under Dave"), "Dave");
  assertEquals(extractCustomerName("under Dave please"), "Dave");
  assertEquals(extractCustomerName("name's Bob"), "Bob");
  assertEquals(extractCustomerName("I'm Jordan"), "Jordan");
  assertEquals(extractCustomerName("O'Brien"), "O'Brien", "apostrophes are real names");
});

Deno.test("00-AV: must NOT invent a name out of a message that has none", () => {
  // A false name is low harm and visible on the receipt; an infinite loop
  // loses the customer. So this leans toward extracting. But these must
  // still resolve nothing, or the bot will stamp an order "Pickup".
  for (const input of [
    "pickup please",
    "it's for pickup",
    "yes",
    "no thanks",
    "that's it",
    "how much is it?",
    "I want a large pepperoni pizza",
    "my name is not important",
    "can you just finish the order",
    "",
    "   ",
  ]) {
    assertEquals(extractCustomerName(input), null, `must not read a name out of: ${JSON.stringify(input)}`);
  }
});
