// Single, sequential (not concurrent) confirmation of the exact "bare list"
// phrasing from RUNBOOK/DAILY's original repro evidence, post-fix. Run
// sequentially (not in parallel with other scripts) to avoid the
// concurrent-load IDLE_TIMEOUT seen in tmp-verify-baselist-quick-20260911.ts.
const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_ID = "e0000000-0000-0000-0000-000000000001";

interface Line { name: string; price_cents: number; quantity: number; menu_item_id: string; sourcePhraseIndex?: number }

async function send(message: string, sessionId: string): Promise<{ reply: string | null }> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: VITOS_ID, message, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

const restHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
async function fetchCart(sessionId: string): Promise<Line[]> {
  const convRes = await fetch(`${SUPABASE_URL}/rest/v1/conversations?select=id&session_id=eq.${sessionId}&order=started_at.desc&limit=1`, { headers: restHeaders });
  const [conv] = await convRes.json();
  const cartRes = await fetch(`${SUPABASE_URL}/rest/v1/order_carts?select=id,cart_json&conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`, { headers: restHeaders });
  const [cart] = await cartRes.json();
  return (cart.cart_json ?? []) as Line[];
}

const BBQ_CHICKEN_ID = "80d49c72-d238-4ef9-8b29-12ec7097b213";
const FLATBREAD_BASE_CENTS = 1050;
const PEPPERONI_UPCHARGE_CENTS = 50;
const TURN1 = "I'd like 4 flatbreads please";
const PHRASES = [
  "chicken bacon ranch bbq chicken pepperoni cheesesteak margherita, four flatbreads",
  "chicken bacon ranch bbq chicken with pepperoni cheesesteak margherita",
  "chicken bacon ranch bbq chicken with pepperoni cheesesteak margherita",
];

for (let i = 0; i < PHRASES.length; i++) {
  const sessionId = `single-barelist-${i}-${Math.floor(Math.random() * 1e9)}`;
  await send(TURN1, sessionId);
  await send(PHRASES[i], sessionId);
  const lines = await fetchCart(sessionId);
  const totalCents = lines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
  const bbq = lines.find(l => l.menu_item_id === BBQ_CHICKEN_ID);
  const others = lines.filter(l => l.menu_item_id !== BBQ_CHICKEN_ID);
  const leaked = others.filter(l => l.price_cents !== FLATBREAD_BASE_CENTS);
  const bbqMissing = !!bbq && bbq.price_cents !== FLATBREAD_BASE_CENTS + PEPPERONI_UPCHARGE_CENTS;
  console.log(
    `run ${i + 1} ("${PHRASES[i]}"): lines=${lines.length} total=${totalCents} bbqPrice=${bbq?.price_cents} ` +
    `leaked=${leaked.map(l => `${l.name}(${l.price_cents})`).join(",") || "none"} bbqMissing=${bbqMissing} ` +
    `phraseIdx=${lines.map(l => l.sourcePhraseIndex).join(",")}`,
  );
}
