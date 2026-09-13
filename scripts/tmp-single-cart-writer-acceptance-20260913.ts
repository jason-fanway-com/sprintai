/**
 * Single-cart-writer acceptance matrix (2026-09-13) — DoD gate for
 * fix/single-cart-writer-20260913. Drives handleChatSmsRequest DIRECTLY
 * (in-process import from local index.ts — no deploy) against Vito's,
 * real Supabase DB, real LLM. Fresh session per case.
 *
 * Covers the 8 spec phrases plus the critical case-8 regular-offer path
 * (bare "yes" to a bot-offered regular/favorite, NOT just confirming an
 * explicitly-ordered item).
 *
 * Run:
 *   source ~/.openclaw-sprintai/.secrets
 *   SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *   SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *   OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
 *   STRIPE_TEST_SECRET_KEY="$STRIPE_TEST_SECRET_KEY" \
 *   deno run --allow-net --allow-env --no-check \
 *     scripts/tmp-single-cart-writer-acceptance-20260913.ts
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { handleChatSmsRequest } from "../supabase/functions/chat-sms/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VITOS_ID = "e0000000-0000-0000-0000-000000000001";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function seedCustomer(sessionId: string) {
  const customerPhone = `web:${sessionId}`;
  const now = "2026-09-01T12:00:00Z";
  const { error } = await supabase.from("customers").upsert({
    tenant_id: VITOS_ID, customer_phone: customerPhone, name: "Jason",
    order_count: 5, total_spent_cents: 8250,
    favorite_items: [{ name: "Cheese - Large (16\")", count: 5 }],
    first_seen_at: now, last_seen_at: now, last_order_at: now,
    last_order_type: "pickup",
    updated_at: now,
  }, { onConflict: "tenant_id,customer_phone" });
  if (error) throw new Error(`seed customer: ${error.message}`);
}

async function send(sessionId: string, message: string) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: VITOS_ID, message, session_id: sessionId, test: true }),
  });
  const res = await handleChatSmsRequest(req);
  const json = await res.json();
  console.log(`  YOU: "${message}"`);
  console.log(`  BOT: "${(json.reply as string)?.slice(0, 120)}"`);
  console.log(`  cart: ${JSON.stringify(json.cart)}`);
  console.log(`  phase: ${json.phase}`);
  return json;
}

type CaseResult = {
  label: string;
  message: string;
  cart: unknown;
  pass: boolean;
  note: string;
};
const results: CaseResult[] = [];

// Standard setup: order a large pepperoni pizza, confirm it.
async function setupPizza(sessionId: string) {
  await seedCustomer(sessionId);
  await send(sessionId, "Testmode");
  await send(sessionId, "pickup");
  await send(sessionId, "I'll take a large pepperoni pizza");
  await send(sessionId, "that's it");
}

function cartLines(cart: unknown): Array<{ menu_item_id: string; quantity: number }> {
  if (!Array.isArray(cart)) return [];
  return (cart as Array<Record<string, unknown>>)
    .filter(l => typeof l.menu_item_id === "string")
    .map(l => ({ menu_item_id: l.menu_item_id as string, quantity: Number(l.quantity) || 1 }));
}

// Cases 1-8: building-phase confirmation-word turns.
const BUILDING_CASES: Array<{
  label: string;
  message: string;
  check: (lines: Array<{ menu_item_id: string; quantity: number }>, rawCart: unknown) => { pass: boolean; note: string };
}> = [
  {
    label: "1",
    message: "Yes to Jason. Can you add fries to that?",
    check: (lines) => {
      const pizza = lines.find(l => l.menu_item_id && !l.menu_item_id.startsWith("SPECIAL"));
      const fries = lines.find(l => l.menu_item_id !== pizza?.menu_item_id);
      return {
        pass: lines.length === 2 && pizza?.quantity === 1 && fries?.quantity === 1,
        note: `expect 2 lines (pizza qty 1 + fries qty 1), got ${JSON.stringify(lines)}`,
      };
    },
  },
  {
    label: "2",
    message: "yes, and add fries",
    check: (lines) => {
      const pizza = lines.find(l => l.menu_item_id && !l.menu_item_id.startsWith("SPECIAL"));
      const fries = lines.find(l => l.menu_item_id !== pizza?.menu_item_id);
      return {
        pass: lines.length === 2 && pizza?.quantity === 1 && fries?.quantity === 1,
        note: `expect 2 lines (pizza qty 1 + fries qty 1), got ${JSON.stringify(lines)}`,
      };
    },
  },
  {
    label: "3",
    message: "yep but drop the pepperoni",
    check: (lines) => {
      return {
        pass: lines.length === 1 && lines[0].quantity === 1,
        note: `expect 1 line pizza qty 1 (topping removed), got ${JSON.stringify(lines)}`,
      };
    },
  },
  {
    label: "4",
    message: "that's right, also a coke",
    check: (lines) => {
      const pizza = lines.find(l => l.menu_item_id && !l.menu_item_id.startsWith("SPECIAL"));
      const coke = lines.find(l => l.menu_item_id !== pizza?.menu_item_id);
      return {
        pass: lines.length === 2 && pizza?.quantity === 1 && coke?.quantity === 1,
        note: `expect 2 lines (pizza qty 1 + coke qty 1), got ${JSON.stringify(lines)}`,
      };
    },
  },
  {
    label: "5",
    message: "correct, and a side salad",
    check: (lines) => {
      const pizza = lines.find(l => l.menu_item_id && !l.menu_item_id.startsWith("SPECIAL"));
      const salad = lines.find(l => l.menu_item_id !== pizza?.menu_item_id);
      return {
        pass: lines.length === 2 && pizza?.quantity === 1 && salad?.quantity === 1,
        note: `expect 2 lines (pizza qty 1 + salad qty 1), got ${JSON.stringify(lines)}`,
      };
    },
  },
  {
    label: "6",
    message: "yes that's me, add a coke",
    check: (lines) => {
      const pizza = lines.find(l => l.menu_item_id && !l.menu_item_id.startsWith("SPECIAL"));
      const coke = lines.find(l => l.menu_item_id !== pizza?.menu_item_id);
      return {
        pass: lines.length === 2 && pizza?.quantity === 1 && coke?.quantity === 1,
        note: `expect 2 lines (pizza qty 1 + coke qty 1), got ${JSON.stringify(lines)}`,
      };
    },
  },
  {
    label: "7",
    message: "yep, and two cokes",
    check: (lines) => {
      const pizza = lines.find(l => l.menu_item_id && !l.menu_item_id.startsWith("SPECIAL"));
      const coke = lines.find(l => l.menu_item_id !== pizza?.menu_item_id);
      return {
        pass: lines.length === 2 && pizza?.quantity === 1 && coke?.quantity === 2,
        note: `expect 2 lines (pizza qty 1 + coke qty 2), got ${JSON.stringify(lines)}`,
      };
    },
  },
  {
    label: "8",
    message: "yes",
    check: (lines, rawCart) => {
      const totalCents = (rawCart as Array<Record<string, unknown>>)
        ?.filter(l => typeof (l as Record<string, unknown>).menu_item_id === "string")
        .reduce((s, l) => s + (Number(l.price_cents) * (Number(l.quantity) || 1)), 0) ?? 0;
      return {
        pass: lines.length === 1 && lines[0].quantity === 1,
        note: `expect 1 line pizza qty 1 ($21.00), got ${JSON.stringify(lines)} total_cents=${totalCents}`,
      };
    },
  },
];

for (const c of BUILDING_CASES) {
  console.log(`\n########## CASE ${c.label}: "${c.message}" ##########`);
  const sessionId = `scw-matrix-${c.label}-${crypto.randomUUID()}`;
  await setupPizza(sessionId);
  const final = await send(sessionId, c.message);
  const lines = cartLines(final.cart);
  const { pass, note } = c.check(lines, final.cart);
  console.log(`  RESULT: ${pass ? "PASS" : "FAIL"} — ${note}`);
  results.push({ label: c.label, message: c.message, cart: final.cart, pass, note });
}

// Case 8b: bare "yes" via the REGULAR-OFFER accept path (the live v413
// defect path). The bot offers the customer their usual (favorite item),
// customer says just "yes". Must add pizza qty 1, never qty 2.
{
  console.log(`\n########## CASE 8b (regular-offer accept): "yes" after bot-offered regular ##########`);
  const sessionId = `scw-matrix-8b-${crypto.randomUUID()}`;
  const customerPhone = `web:${sessionId}`;
  const now = "2026-09-01T12:00:00Z";
  // Seed a returning customer whose regular item is Large Cheese Pizza.
  await supabase.from("customers").upsert({
    tenant_id: VITOS_ID, customer_phone: customerPhone, name: "Jason",
    order_count: 5, total_spent_cents: 8250,
    favorite_items: [{ name: "Cheese - Large (16\")", count: 5 }],
    first_seen_at: now, last_seen_at: now, last_order_at: now,
    last_order_type: "pickup",
    updated_at: now,
  }, { onConflict: "tenant_id,customer_phone" });
  await send(sessionId, "Testmode");
  // "pickup" triggers the regular-offer phrasing; accepting "yes" immediately
  // after is the case under test — no intermediate turn, because a third turn
  // resets the offer context and makes namedSignalRec=false.
  const greet = await send(sessionId, "pickup");
  console.log(`  BOT (greet/offer): "${(greet.reply as string)?.slice(0, 200)}"`);
  // Accept the regular offer with just "yes".
  const final8b = await send(sessionId, "yes");
  const lines8b = cartLines(final8b.cart);
  const pass8b = lines8b.length === 1 && lines8b[0].quantity === 1;
  const note8b = `expect 1 line (pizza qty 1) regular-offer accept, got ${JSON.stringify(lines8b)}`;
  console.log(`  RESULT: ${pass8b ? "PASS" : "FAIL"} — ${note8b}`);
  results.push({ label: "8b", message: "yes (regular-offer accept)", cart: final8b.cart, pass: pass8b, note: note8b });
}

// Summary
console.log("\n\n================ SUMMARY ================");
let totalPass = 0;
for (const r of results) {
  const status = r.pass ? "PASS" : "FAIL";
  console.log(`  Case ${r.label}: ${status} | "${r.message}" | cart=${JSON.stringify(cartLines(r.cart))}`);
  if (r.pass) totalPass++;
}
console.log(`\n${totalPass}/${results.length} cases passed`);
if (totalPass < results.length) {
  console.error(`\nFAILED CASES:`);
  for (const r of results.filter(r => !r.pass)) {
    console.error(`  Case ${r.label}: ${r.note}`);
  }
  Deno.exit(1);
}
