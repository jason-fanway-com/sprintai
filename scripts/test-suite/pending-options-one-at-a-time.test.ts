// Red-green evidence for the pending-option one-at-a-time fix (2026-09-07).
//
// Bug: when an item has 2+ required option groups, the LLM asks about all
// in one reply. Customer answers ONE. The other silently vanishes — bot never
// asks again.
//
// Fix: a pre-LLM intercept checks for cart lines with pending_options.
// It tries to match the customer's message against the FIRST pending group's
// choices. If matched, it resolves that group, then deterministically asks
// for the NEXT pending group without calling the LLM.
//
// Test item: "Buffalo Chicken - Small (10")" on the test shop — two required
// groups: "Sauce" (Hot, Mild, BBQ) and "Bleu cheese or ranch" (Bleu Cheese, Ranch).
//
// Run: deno run --allow-net --allow-env --allow-read scripts/test-suite/pending-options-one-at-a-time.test.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PROJECT_REF = "rvdqfxtrskxekfkqnegx";
const CHAT_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/chat-sms`;
const SHOP_ID = "e0000000-0000-0000-0000-000000000001";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const SESSION = `pending-options-test-${crypto.randomUUID()}`;

async function chat(msg: string): Promise<{reply: string, cart: any[]}> {
  const resp = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_KEY}` },
    body: JSON.stringify({ shop_id: SHOP_ID, message: msg, session_id: SESSION, test: true }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const d = await resp.json();
  return { reply: d.reply ?? "", cart: Array.isArray(d.cart) ? d.cart : [] };
}

function findItem(cart: any[]): any {
  return cart.find(i => (i.name ?? "").includes("Buffalo Chicken"));
}

console.log(`Session: ${SESSION}\n${"─".repeat(60)}`);

// Turn 1: order the item
const t1 = await chat("I'd like a small buffalo chicken pizza");
console.log(`customer: I'd like a small buffalo chicken pizza`);
console.log(`bot:      ${t1.reply}`);
const item1 = findItem(t1.cart);
if (!item1) {
  console.error("FAIL: Buffalo Chicken not added to cart after turn 1");
  Deno.exit(1);
}
console.log(`cart item: ${JSON.stringify({ name: item1.name, options: item1.options, pending: item1.pending_options })}\n`);

// Turn 2: answer Sauce question
const t2 = await chat("hot");
console.log(`customer: hot`);
console.log(`bot:      ${t2.reply}`);
const item2 = findItem(t2.cart);
console.log(`cart item: ${JSON.stringify({ options: item2?.options, pending: item2?.pending_options })}`);

// Assert: Sauce resolved, "Bleu cheese or ranch" still pending
const sauceResolved = item2?.options?.["Sauce"]?.includes("Hot");
const secondStillPending = (item2?.pending_options ?? []).some((p: string) => p.toLowerCase().includes("bleu") || p.toLowerCase().includes("ranch"));

if (!sauceResolved) {
  console.error("\nFAIL: Sauce was not resolved after customer said 'hot'");
  Deno.exit(1);
}
if (!secondStillPending) {
  // Check if both already resolved (customer answered both implicitly)
  const hasBoth = item2?.options?.["Sauce"] && (item2?.options?.["Bleu cheese or ranch"] ?? item2?.options?.["Bleu Cheese or Ranch"]);
  if (!hasBoth) {
    console.error("\nFAIL: second option group ('Bleu cheese or ranch') silently dropped — not in pending_options and not in options");
    Deno.exit(1);
  }
  console.log(`\n✓ Both groups already resolved in one shot — no second question needed`);
  Deno.exit(0);
}

// Assert: bot asked about the second group
const botAskedSecond = t2.reply.toLowerCase().match(/bleu|ranch|dressing/i);
if (!botAskedSecond) {
  console.error("\nFAIL: bot did not ask about 'Bleu cheese or ranch' after Sauce was answered");
  console.error(`Bot said: "${t2.reply}"`);
  Deno.exit(1);
}
console.log(`\n✓ Turn 2: Sauce resolved ("Hot"), bot asked about second group\n`);

// Turn 3: answer Bleu cheese or ranch
const t3 = await chat("ranch");
console.log(`customer: ranch`);
console.log(`bot:      ${t3.reply}`);
const item3 = findItem(t3.cart);
console.log(`cart item: ${JSON.stringify({ options: item3?.options, pending: item3?.pending_options })}`);

const bleuResolved = (item3?.options?.["Bleu cheese or ranch"] ?? item3?.options?.["Bleu Cheese or Ranch"] ?? []).some(
  (v: string) => v.toLowerCase().includes("ranch")
);
const noPending = !item3?.pending_options?.length;

console.log(`\n${"─".repeat(60)}`);
if (sauceResolved && bleuResolved && noPending) {
  console.log("✓ PASS: both required groups filled one at a time, nothing dropped");
  Deno.exit(0);
} else {
  console.error(`✗ FAIL: sauceResolved=${sauceResolved}, bleuResolved=${bleuResolved}, noPending=${noPending}`);
  Deno.exit(1);
}
