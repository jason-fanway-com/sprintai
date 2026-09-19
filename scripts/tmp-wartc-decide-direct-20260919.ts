// Direct decide() probe for wart (c), bypassing PROPOSE's own (variable,
// real-model) phrasing of "a large pizza, half pepperoni half sausage" --
// isolates whether decide()'s own modifier floor now lands BOTH toppings
// once the base item is already resolved (the exact shape b65c5bea's own
// "isolate-2-withhalf" probe used).
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
const SHOP_ID = "e0000000-0000-0000-0000-000000000001";

async function rest(path: string) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  return r.json();
}
const menus = await rest(`menus?select=id&shop_id=eq.${SHOP_ID}`);
const menuId = menus[0].id;
const items: any[] = await rest(`menu_items?select=id,name,category,price_cents,bot_state,ask_plan,upsell&menu_id=eq.${menuId}&active=eq.true`);
const menu: TurnEngineMenuItem[] = items.map(i => ({
  id: i.id, name: i.name, category: i.category, price_cents: i.price_cents,
  bot_state: i.bot_state, ask_plan: i.ask_plan, upsell: i.upsell,
}));

const lexRows: any[] = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(`${url}/rest/v1/lexicon?select=term,target_id&shop_id=eq.${SHOP_ID}&target_type=eq.item&active=eq.true&order=id.asc`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}` } });
  const page = await r.json();
  if (!Array.isArray(page) || page.length === 0) break;
  lexRows.push(...page);
  if (page.length < 1000) break;
}
const metaByItemId = new Map(items.map((i: any) => [i.id, { category: i.category, size_label: null as string | null }]));
const sizeRows: any[] = await rest(`menu_items?select=id,size_label&menu_id=eq.${menuId}`);
for (const s of sizeRows) { const m = metaByItemId.get(s.id); if (m) m.size_label = s.size_label; }
const lexicon: LexiconTerm[] = lexRows.map((r: any) => ({
  term: r.term, target_id: r.target_id,
  category: metaByItemId.get(r.target_id)?.category ?? null,
  size_label: metaByItemId.get(r.target_id)?.size_label ?? null,
}));

function report(label: string, message: string, proposal: Proposal) {
  const result = decide(proposal, [], menu, lexicon, () => crypto.randomUUID(), message);
  const lines = result.cart.filter(l => typeof l.menu_item_id === "string").map((l: any) =>
    `${l.quantity}x ${l.name} $${(l.price_cents / 100).toFixed(2)}${l.options ? " " + JSON.stringify(l.options) : ""}`);
  console.log(`[${label}] message=${JSON.stringify(message)}`);
  console.log(`  cart lines: ${JSON.stringify(lines)}`);
  console.log(`  declines: ${JSON.stringify(result.declines)}`);
  console.log(`  disambiguationCandidateIds: ${JSON.stringify(result.disambiguationCandidateIds)}`);
  console.log("");
}

report("regression-2add-split", "a large cheese pizza with half pepperoni", {
  intent: "order",
  adds: [
    { item_span: "large cheese pizza", quantity: 1, choices: [] },
    { item_span: "pepperoni", quantity: 1, choices: [] },
  ],
  removes: [], modifies: [],
});

report("wartc-cheese-explicit-split", "a large cheese pizza, half pepperoni half sausage", {
  intent: "order",
  adds: [
    { item_span: "large cheese pizza", quantity: 1, choices: [] },
    { item_span: "pepperoni", quantity: 1, choices: [] },
    { item_span: "sausage", quantity: 1, choices: [] },
  ],
  removes: [], modifies: [],
});

report("wartc-single-add", "a large cheese pizza, half pepperoni half sausage", {
  intent: "order",
  adds: [{ item_span: "large cheese pizza, half pepperoni half sausage", quantity: 1, choices: [] }],
  removes: [], modifies: [],
});

report("wartc-nocomma-split", "a large cheese pizza half pepperoni half sausage", {
  intent: "order",
  adds: [
    { item_span: "large cheese pizza", quantity: 1, choices: [] },
    { item_span: "pepperoni", quantity: 1, choices: [] },
    { item_span: "sausage", quantity: 1, choices: [] },
  ],
  removes: [], modifies: [],
});
report("wartc-nocomma-single-add", "a large cheese pizza half pepperoni half sausage", {
  intent: "order",
  adds: [{ item_span: "large cheese pizza half pepperoni half sausage", quantity: 1, choices: [] }],
  removes: [], modifies: [],
});

report("comma-single-topping-baseline", "a large cheese pizza, half pepperoni", {
  intent: "order",
  adds: [
    { item_span: "large cheese pizza", quantity: 1, choices: [] },
    { item_span: "pepperoni", quantity: 1, choices: [] },
  ],
  removes: [], modifies: [],
});
