/**
 * QA adversarial probes (2026-09-13) for the reconciler duplicate-line fix.
 * Independent of John Walsh's 9-case matrix. Drives handleChatSmsRequest
 * directly against the real Vito's shop, web channel + test:true.
 *
 * Probes target the ACTUAL root-cause path (C2b-regular offer-accept via a
 * bare "yes" to the proposed favorite) and stacked bare-confirmation turns —
 * the class of bug, not just the one matrix repro.
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
    last_order_type: "pickup", updated_at: now,
  }, { onConflict: "tenant_id,customer_phone" });
  if (error) throw new Error(`seed customer: ${error.message}`);
}

async function send(sessionId: string, message: string) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: VITOS_ID, message, session_id: sessionId, test: true }),
  });
  const res = await handleChatSmsRequest(req);
  const json = await res.json();
  console.log(`  YOU: "${message}"`);
  console.log(`  BOT: "${(json.reply || "").replace(/\n/g, " ")}"`);
  console.log(`  cart(lines=${(json.cart||[]).length}): ${JSON.stringify((json.cart||[]).map((c:any)=>({id:c.menu_item_id,name:c.name,qty:c.quantity,opts:c.options})))}`);
  return json;
}

async function dumpCart(sessionId: string, label: string) {
  const { data: conv } = await supabase.from("conversations").select("id").eq("session_id", sessionId).maybeSingle();
  const { data: cartRow } = await supabase.from("order_carts")
    .select("cart_json, subtotal_cents, total_cents, phase").eq("conversation_id", conv?.id).maybeSingle();
  const lines = (cartRow?.cart_json || []).map((c:any)=>({id:c.menu_item_id,name:c.name,qty:c.quantity}));
  console.log(`  >>> AUTHORITATIVE ${label}: lines=${lines.length} subtotal=${cartRow?.subtotal_cents} total=${cartRow?.total_cents}`);
  console.log(`  >>> ${JSON.stringify(lines)}`);
  return cartRow;
}

// ── PROBE A: the TRUE original repro — returning customer accepts the
// proposed favorite with a bare "yes" (C2b-regular offer-accept path). This
// is the $42-cheese-pizza defect's own path, which the matrix's case 8 does
// NOT hit (it orders an explicit pepperoni first, then confirms the name).
{
  console.log(`\n########## PROBE A: bare "yes" accepting the proposed regular favorite ##########`);
  const sid = `qa-probeA-${crypto.randomUUID()}`;
  await seedCustomer(sid);
  await send(sid, "Testmode");
  await send(sid, "pickup");   // bot offers "your regular, the Cheese - Large (16")?"
  await send(sid, "yes");      // <-- bare accept of the regular; C2b-regular offer-accept fires
  await dumpCart(sid, "after bare-yes accept");
}

// ── PROBE B: two consecutive bare confirmations — accept the regular ("yes")
// then confirm the name with a second bare "yes", no ordering signal between.
// Stresses the same identity across the offer-accept writer AND the name
// confirm turn.
{
  console.log(`\n########## PROBE B: bare "yes" (accept regular) then bare "yes" (confirm name) ##########`);
  const sid = `qa-probeB-${crypto.randomUUID()}`;
  await seedCustomer(sid);
  await send(sid, "Testmode");
  await send(sid, "pickup");
  await send(sid, "yes");   // accept regular
  await send(sid, "yes");   // second plain confirmation, no ordering signal
  await dumpCart(sid, "after two consecutive yes");
}

// ── PROBE C: accept the regular, then a THIRD bare confirmation ("yep") — a
// plain confirmation immediately followed by another plain confirmation, to
// see if any writer re-adds the same favorite line.
{
  console.log(`\n########## PROBE C: accept regular, then "yep" then "correct" (stacked confirms) ##########`);
  const sid = `qa-probeC-${crypto.randomUUID()}`;
  await seedCustomer(sid);
  await send(sid, "Testmode");
  await send(sid, "pickup");
  await send(sid, "yes");      // accept regular
  await send(sid, "yep");      // stacked confirm
  await send(sid, "correct");  // another confirm
  await dumpCart(sid, "after stacked confirms");
}
