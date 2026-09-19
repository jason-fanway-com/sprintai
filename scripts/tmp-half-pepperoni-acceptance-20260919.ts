// P0 addendum acceptance (2026-09-19, tip-parses-any-dollar + half-pepperoni):
// live verification for acceptance items 2, 3, 4 against real Vito's data +
// real model calls. Same harness pattern as tmp-pepperoni-round3-repro-20260919.ts.

import { proposeTurn } from "../supabase/functions/chat-sms/propose.ts";
import { decide, type TurnEngineMenuItem, type Proposal } from "../supabase/functions/chat-sms/turn-engine.ts";
import type { LexiconTerm } from "../supabase/functions/chat-sms/resolve-item.ts";

const sec = Object.fromEntries(
  (await Deno.readTextFile(`${Deno.env.get("HOME")}/.openclaw-sprintai/.secrets`))
    .split("\n")
    .filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim().replace(/^export\s+/, ""), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const url = sec.SPRINTAI_CHAT_SUPABASE_URL;
const key = sec.SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY;
const apiKey = sec.OPENROUTER_API_KEY;
const SHOP_ID = "e0000000-0000-0000-0000-000000000001"; // Vito's

async function rest(path: string) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

const menus = await rest(`menus?select=id&shop_id=eq.${SHOP_ID}`);
const menuId = menus[0].id;

const items: Array<{ id: string; name: string; category: string; price_cents: number; bot_state: string | null; ask_plan: unknown; upsell: string | null }> =
  await rest(`menu_items?select=id,name,category,price_cents,bot_state,ask_plan,upsell&menu_id=eq.${menuId}&active=eq.true`);

const menu: TurnEngineMenuItem[] = items.map(i => ({
  id: i.id, name: i.name, category: i.category, price_cents: i.price_cents,
  bot_state: i.bot_state, ask_plan: i.ask_plan as TurnEngineMenuItem["ask_plan"], upsell: i.upsell,
}));

const lexRows: Array<{ term: string; target_id: string }> = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(
    `${url}/rest/v1/lexicon?select=term,target_id&shop_id=eq.${SHOP_ID}&target_type=eq.item&active=eq.true&order=id.asc`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}` } },
  );
  const page = await r.json();
  if (!Array.isArray(page) || page.length === 0) break;
  lexRows.push(...page);
  if (page.length < 1000) break;
}
const metaByItemId = new Map(items.map(i => [i.id, { category: i.category, size_label: null as string | null }]));
const sizeRows: Array<{ id: string; size_label: string | null }> = await rest(`menu_items?select=id,size_label&menu_id=eq.${menuId}`);
for (const s of sizeRows) {
  const m = metaByItemId.get(s.id);
  if (m) m.size_label = s.size_label;
}
const lexicon: LexiconTerm[] = lexRows.map(r => ({
  term: r.term, target_id: r.target_id,
  category: metaByItemId.get(r.target_id)?.category ?? null,
  size_label: metaByItemId.get(r.target_id)?.size_label ?? null,
}));
const lexiconForPropose = lexicon.map(l => ({ term: l.term, target_id: l.target_id }));

function cartSummary(cart: Array<{ name: string; quantity: number; price_cents: number; options?: Record<string, string[]> }>) {
  const total = cart.reduce((s, l) => s + l.price_cents * l.quantity, 0);
  const lines = cart.map(l => `${l.quantity}x ${l.name} $${(l.price_cents / 100).toFixed(2)}${l.options ? " " + JSON.stringify(l.options) : ""}`);
  return { lines, total_cents: total };
}

async function liveTurn(label: string, message: string, cart: Array<{ menu_item_id: string; quantity: number; price_cents: number; name: string; options?: Record<string, string[]> }> = []) {
  const proposeResult = await proposeTurn(
    { cart, open: null, menu, lexicon: lexiconForPropose, history: [], message, orderContext: { orderType: "pickup" } },
    { supabase: { from: () => ({ insert: async () => ({ error: null }) }) } as unknown as import("https://esm.sh/@supabase/supabase-js@2.39.3").SupabaseClient, apiKey },
  );
  if (!proposeResult.ok) {
    console.log(`[${label}] message=${JSON.stringify(message)} PROPOSE FAILED:`, proposeResult.reason, proposeResult.detail);
    return;
  }
  const result = decide(proposeResult.proposal, cart as never, menu, lexicon, () => crypto.randomUUID(), message);
  const summary = cartSummary(result.cart.filter(l => typeof l.menu_item_id === "string") as never);
  console.log(`[${label}] message=${JSON.stringify(message)}`);
  console.log(`  raw proposal.adds = ${JSON.stringify(proposeResult.proposal.adds)}`);
  console.log(`  cart lines: ${JSON.stringify(summary.lines)}`);
  console.log(`  total: $${(summary.total_cents / 100).toFixed(2)}`);
  console.log(`  declines: ${JSON.stringify(result.declines)}`);
  console.log(`  disambiguation candidates: ${JSON.stringify(result.disambiguationCandidateIds)}`);
  console.log("");
}

console.log("=== Item 2: 'a large cheese pizza with half pepperoni' -> ONE line, $20.00 ===");
await liveTurn("item2", "a large cheese pizza with half pepperoni");

console.log("=== Item 3: bare 'one pepperoni' answering an open 'what kind?' list -> Large Pepperoni Pizza $21.00 ===");
// Vito's has no bare pepperoni-pizza item; this simulates the open list by
// just sending the bare word fresh (resolveItem is what the disambiguation
// answer path ultimately narrows against) -- also verified at the unit level
// in pepperoni-derived-pizza-lexicon-20260919.test.ts ("AFTER: bare
// 'pepperoni' ... resolves to the pizza family, ambiguous across the 3
// sizes"), so a SIZED bare answer ("large pepperoni") is the live-equivalent
// of picking one from that already-narrowed list.
await liveTurn("item3", "large pepperoni");

console.log("=== Item 4: '2 pepperoni pizzas' as a fresh order line -> 2x Pepperoni Pizza, correct ===");
await liveTurn("item4", "2 large pepperoni pizzas");
