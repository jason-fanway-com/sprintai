#!/usr/bin/env deno run --allow-net --allow-env --allow-read
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PROJECT_REF = "rvdqfxtrskxekfkqnegx";
const CHAT_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/chat-sms`;
const SHOP_ID = "e0000000-0000-0000-0000-000000000001";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const SESSION = `named-remove-verify-${crypto.randomUUID()}`;

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

console.log(`Session: ${SESSION}\n${"─".repeat(60)}`);

// Turn 1: order both items
const t1 = await chat("I'd like a large cheese pizza and garlic knots");
console.log(`customer: I'd like a large cheese pizza and garlic knots`);
console.log(`bot:      ${t1.reply}`);
console.log(`cart:     ${JSON.stringify(t1.cart.map(i => i.name ?? i.menu_item_id))}\n`);

// If there are pending option questions answer them
let latestCart = t1.cart;
if (t1.reply.toLowerCase().match(/which|size|option|small|large|medium/)) {
  const t2 = await chat("large please");
  console.log(`customer: large please`);
  console.log(`bot:      ${t2.reply}`);
  latestCart = t2.cart;
  console.log(`cart:     ${JSON.stringify(latestCart.map(i => i.name ?? i.menu_item_id))}\n`);
}

const beforeNames = latestCart.map(i => i.name ?? "").join(", ");
console.log(`Cart before remove: ${beforeNames}`);
console.log();

// The actual test: "remove the pizza"
const tRm = await chat("remove the pizza");
console.log(`customer: remove the pizza`);
console.log(`bot:      ${tRm.reply}`);
console.log(`cart:     ${JSON.stringify(tRm.cart.map(i => i.name ?? i.menu_item_id))}\n`);

const hasPizza = tRm.cart.some(i => {
  const n = (i.name ?? "").toLowerCase();
  return n.includes("cheese") || n.includes("pizza");
});
const hasKnots = tRm.cart.some(i => {
  const n = (i.name ?? "").toLowerCase();
  return n.includes("knot") || n.includes("garlic");
});

console.log("─".repeat(60));
if (!hasPizza && hasKnots) {
  console.log("✓ PASS: pizza removed, garlic knots remain");
  Deno.exit(0);
} else if (hasPizza && hasKnots) {
  console.log("✗ FAIL: pizza NOT removed (still in cart)");
  Deno.exit(1);
} else if (!hasPizza && !hasKnots) {
  console.log("✗ FAIL: both items gone (over-removed)");
  Deno.exit(1);
} else {
  console.log("✗ FAIL: garlic knots removed, pizza still there (wrong item)");
  Deno.exit(1);
}
