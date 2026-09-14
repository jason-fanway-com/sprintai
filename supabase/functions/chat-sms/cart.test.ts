// Item 2 (2026-09-09, module extraction): unit tests for cart.ts, exercising
// the extracted functions directly — no LLM, no network, no Supabase.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractCustomerReferencedItems,
  filterNegatedItems,
  findMissingCartItems,
  isClosingReply,
  replyAcknowledgesCart,
  type CartLine,
} from "./cart.ts";

Deno.test("replyAcknowledgesCart: generic cart language is coherent", () => {
  assertEquals(replyAcknowledgesCart("Got it, anything else for your cart?", []), true);
});

Deno.test("replyAcknowledgesCart: names an item actually in the cart", () => {
  const cart: CartLine[] = [{ name: 'Cheese - Large (16")' }];
  assertEquals(replyAcknowledgesCart("Sounds good, large cheese coming up!", cart), true);
});

Deno.test("replyAcknowledgesCart: empty reply is never coherent", () => {
  assertEquals(replyAcknowledgesCart("", []), false);
});

Deno.test("replyAcknowledgesCart: unrelated text with no cart awareness is not coherent", () => {
  assertEquals(replyAcknowledgesCart("We open at 11am.", [{ name: "Cheese Pizza" }]), false);
});

Deno.test("isClosingReply: a total-line reply is closing", () => {
  assertEquals(isClosingReply("Your total comes to $21.49 — ready to check out?"), true);
});

Deno.test("isClosingReply: a plain question is not closing", () => {
  assertEquals(isClosingReply("What size would you like?"), false);
});

Deno.test("extractCustomerReferencedItems: current message is always scanned", () => {
  const menuNames = new Map([["shrimp scampi", "Shrimp Scampi"]]);
  const referenced = extractCustomerReferencedItems(
    [{ role: "user", content: "I'll take the shrimp scampi" }],
    menuNames,
  );
  assertEquals([...referenced], ["Shrimp Scampi"]);
});

Deno.test("extractCustomerReferencedItems: prior pure question is excluded", () => {
  const menuNames = new Map([["shrimp scampi", "Shrimp Scampi"]]);
  const referenced = extractCustomerReferencedItems(
    [
      { role: "user", content: "Do you have shrimp scampi?" },
      { role: "assistant", content: "Yes we do!" },
      { role: "user", content: "great, I'll take a coke" },
    ],
    menuNames,
  );
  assertEquals([...referenced], []);
});

Deno.test("findMissingCartItems: a referenced item present as an option choice is not missing", () => {
  const cart: CartLine[] = [{ name: "Cheese Pizza", options: { Toppings: ["Pepperoni (Whole pizza)"] } }];
  const missing = findMissingCartItems(new Set(["Pepperoni"]), cart);
  assertEquals(missing, []);
});

Deno.test("findMissingCartItems: a referenced item truly absent from the cart is missing", () => {
  const cart: CartLine[] = [{ name: "Cheese Pizza" }];
  const missing = findMissingCartItems(new Set(["Meatball Sub"]), cart);
  assertEquals(missing, ["Meatball Sub"]);
});

Deno.test("filterNegatedItems: a negated item in the current message is suppressed", () => {
  const result = filterNegatedItems(new Set(["Pepperoni Pizza"]), "actually, no pepperoni pizza — just the cheese");
  assertEquals([...result], []);
});

Deno.test("filterNegatedItems: a non-negated item passes through unchanged", () => {
  const result = filterNegatedItems(new Set(["Cheese Pizza"]), "I'll take the cheese pizza");
  assertEquals([...result], ["Cheese Pizza"]);
});
