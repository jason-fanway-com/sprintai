// Acceptance item 3, faithful repro: "one pepperoni" answering an ALREADY
// SIZE-NARROWED "what kind?" list (candidates = every real Large pizza item,
// exactly what the disambiguation flow hands answer() after a prior "what
// size?" question already resolved to Large) -- not a fresh whole-menu
// resolveItem call, which is a different code path this fix does not touch.
import { answer, type TurnEngineMenuItem, type DialogueState, type TurnEngineCartLine } from "../supabase/functions/chat-sms/turn-engine.ts";

const sec = Object.fromEntries(
  (await Deno.readTextFile(`${Deno.env.get("HOME")}/.openclaw-sprintai/.secrets`))
    .split("\n").filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim().replace(/^export\s+/, ""), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const url = sec.SPRINTAI_CHAT_SUPABASE_URL;
const key = sec.SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY;
const SHOP_ID = "e0000000-0000-0000-0000-000000000001";
async function rest(path: string) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  return r.json();
}
const menus = await rest(`menus?select=id&shop_id=eq.${SHOP_ID}`);
const menuId = menus[0].id;
const items: Array<{ id: string; name: string; category: string; price_cents: number; bot_state: string | null; ask_plan: unknown }> =
  await rest(`menu_items?select=id,name,category,price_cents,bot_state,ask_plan&menu_id=eq.${menuId}&active=eq.true&category=eq.Pizza`);
const menu: TurnEngineMenuItem[] = items.map(i => ({
  id: i.id, name: i.name, category: i.category, price_cents: i.price_cents,
  bot_state: i.bot_state, ask_plan: i.ask_plan as TurnEngineMenuItem["ask_plan"],
}));

const largeCandidateIds = items.filter(i => i.name.includes(`Large (16")`)).map(i => i.id);
console.log(`Large pizza candidate count: ${largeCandidateIds.length}`);

const state: DialogueState = {
  phase: "ordering",
  open: { kind: "disambiguation", candidates: largeCandidateIds, quantity: 1, spanText: "a large pizza" },
  upsell_offered: false,
  asked_message_id: null,
};

for (const msg of ["one pepperoni", "pepperoni"]) {
  const result = answer(state, [] as TurnEngineCartLine[], msg, menu, {});
  console.log(`message=${JSON.stringify(msg)} ->`, JSON.stringify(result));
  if (result.resolved && "menu_item_id" in (result.outcome as Record<string, unknown>)) {
    const id = (result.outcome as { menu_item_id: string }).menu_item_id;
    const item = items.find(i => i.id === id);
    console.log(`  resolved item: ${item?.name} $${((item?.price_cents ?? 0) / 100).toFixed(2)}`);
  }
}
