// Probe for the X3 follow-up (2026-09-20): "House - Personal calzone" naming
// collision + "chicken add-on" opening a narrowing question instead of a
// clean decline. Same harness pattern as tmp-pepperoni-warts-probe-20260919.ts:
// real propose.ts model call + real decide() against live Vito's data.

import { proposeTurn } from "../supabase/functions/chat-sms/propose.ts";
import { decide, type TurnEngineMenuItem } from "../supabase/functions/chat-sms/turn-engine.ts";
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
  id: i.id,
  name: i.name,
  category: i.category,
  price_cents: i.price_cents,
  bot_state: i.bot_state,
  ask_plan: i.ask_plan as TurnEngineMenuItem["ask_plan"],
  upsell: i.upsell,
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
  term: r.term,
  target_id: r.target_id,
  category: metaByItemId.get(r.target_id)?.category ?? null,
  size_label: metaByItemId.get(r.target_id)?.size_label ?? null,
}));

function cartSummary(cart: Array<{ name: string; quantity: number; price_cents: number; options?: Record<string, string[]> }>) {
  const total = cart.reduce((s, l) => s + l.price_cents * l.quantity, 0);
  const lines = cart.map(l => `${l.quantity}x ${l.name} $${(l.price_cents / 100).toFixed(2)}${l.options ? " " + JSON.stringify(l.options) : ""}`);
  return { lines, total_cents: total };
}

async function reportReal(label: string, message: string) {
  const proposeResult = await proposeTurn(
    { cart: [], open: null, menu, lexicon: lexicon.map(l => ({ term: l.term, target_id: l.target_id })), history: [], message, orderContext: { orderType: "pickup" } },
    { supabase: { from: () => ({ insert: async () => ({ error: null }) }) } as unknown as import("https://esm.sh/@supabase/supabase-js@2.39.3").SupabaseClient, apiKey },
  );
  console.log(`[${label}] message=${JSON.stringify(message)}`);
  if (!proposeResult.ok) {
    console.log(`  PROPOSE FAILED:`, proposeResult.reason, proposeResult.detail);
    return;
  }
  console.log(`  raw proposal.adds = ${JSON.stringify(proposeResult.proposal.adds)}`);
  const result = decide(proposeResult.proposal, [], menu, lexicon, () => crypto.randomUUID(), message);
  const summary = cartSummary(result.cart.filter(l => typeof l.menu_item_id === "string") as never);
  console.log(`  cart lines: ${JSON.stringify(summary.lines)}`);
  console.log(`  total: $${(summary.total_cents / 100).toFixed(2)}`);
  console.log(`  declines: ${JSON.stringify(result.declines)}`);
  console.log(`  disambiguationCandidateIds: ${JSON.stringify(result.disambiguationCandidateIds)}`);
  console.log(`  categoryMismatchPending: ${JSON.stringify(result.categoryMismatchPending)}`);
  console.log("");
}

console.log("=== X3 follow-up live repro (v575) ===");
await reportReal("house-calzone-chicken-addon", "I'd like to try the House - Personal calzone, please. Oh, and can I get a chicken add-on for that too?");

console.log("=== isolate gap 1 alone: naming collision, no add-on text ===");
await reportReal("house-calzone-alone", "I'd like to try the House - Personal calzone, please.");

console.log("=== regression: plain unambiguous calzone order, no collision word ===");
await reportReal("calzone-plain", "Can I get a Personal Calzone Stromboli.");
