// One-shot live proof of the returning-customer delivery-memory feature
// (docs/specs/2026-09-12-returning-customer-delivery-memory.md), against the
// deployed chat-sms function (v394+). Seeds `customers`/`conversations`
// fixture rows via service role, then drives real conversations over the
// web JSON test path (test: true) exactly like the existing tmp-*-verify
// scripts in this directory. Vito's Pizza (is_test=true) is the target shop.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") || "https://rvdqfxtrskxekfkqnegx.supabase.co";
const SERVICE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_SHOP_ID = "e0000000-0000-0000-0000-000000000001";
const VITOS_TENANT_ID = "e0000000-0000-0000-0000-000000000001";
const CHEESEBURGER_ID = "442f650d-dc96-4a95-9762-f6b571a4dd8c"; // Cheese Burger $8.49, Temp option group

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function send(message: string, sessionId: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ shop_id: VITOS_SHOP_ID, message, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

async function seedReturningCustomer(phone: string, opts: {
  name: string;
  lastOrderType: "pickup" | "delivery";
  lastDeliveryAddress?: Record<string, unknown> | null;
}) {
  const now = "2026-09-01T12:00:00Z";
  await supabase.from("customers").upsert({
    tenant_id: VITOS_TENANT_ID,
    customer_phone: phone,
    name: opts.name,
    order_count: 1,
    total_spent_cents: 949,
    favorite_items: [],
    first_seen_at: now,
    last_seen_at: now,
    last_order_at: now,
    last_order_type: opts.lastOrderType,
    last_delivery_address: opts.lastDeliveryAddress ?? null,
    updated_at: now,
  }, { onConflict: "tenant_id, customer_phone" });

  // Prior conversation so isLifetimeFirstContact = false for this phone.
  // NOTE: conversations has no shop_id column — tenant_id + customer_phone is
  // the isLifetimeFirstContact lookup key (see index.ts's own count query).
  const { error: convErr } = await supabase.from("conversations").insert({
    tenant_id: VITOS_TENANT_ID,
    customer_phone: phone,
    channel: "web",
    session_id: `${phone}-prior-visit`,
    status: "resolved",
    metadata: {},
  });
  if (convErr) throw new Error(`seed prior conversation failed: ${convErr.message}`);
}

async function cleanupSession(sessionId: string, phone: string) {
  // best-effort cleanup, not required for correctness of the proof
  await supabase.from("conversations").delete().eq("customer_phone", phone);
  await supabase.from("customers").delete().eq("tenant_id", VITOS_TENANT_ID).eq("customer_phone", phone);
  void sessionId;
}

function hr(title: string) {
  console.log(`\n${"=".repeat(10)} ${title} ${"=".repeat(10)}`);
}

async function scenarioA_returningDelivery() {
  hr("SCENARIO A — returning DELIVERY customer greeted+confirms in one reply");
  const phone = "web:crm-proof-delivery-1";
  const session = "crm-proof-delivery-1";
  await cleanupSession(session, phone);
  await seedReturningCustomer(phone, {
    name: "Christine",
    lastOrderType: "delivery",
    // Known in-range address (already geocoded successfully in prior Vito's
    // test orders) so this scenario proves the full happy path end to end,
    // not just the offer wording.
    lastDeliveryAddress: { street: "5620 Cetronia Rd", city: "Allentown", state: "PA", zip: "18106", formatted: "5620 Cetronia Rd, Allentown, PA 18106" },
  });
  const r1 = await send("Hi", session);
  console.log(`customer: Hi\nbot: ${r1.reply}`);
  const r2 = await send("yes", session);
  console.log(`customer: yes\nbot: ${r2.reply}`);
  const { data: convRow } = await supabase.from("conversations").select("id").eq("session_id", session).maybeSingle();
  const { data: cartRow } = await supabase.from("order_carts").select("order_type, delivery_address").eq("conversation_id", convRow?.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
  console.log(`[DB state after confirm] order_type=${cartRow?.order_type} delivery_address=${JSON.stringify(cartRow?.delivery_address)}`);
}

async function scenarioB_returningPickup() {
  hr("SCENARIO B — returning PICKUP customer offered pickup, not delivery");
  const phone = "web:crm-proof-pickup-1";
  const session = "crm-proof-pickup-1";
  await cleanupSession(session, phone);
  await seedReturningCustomer(phone, { name: "Marco", lastOrderType: "pickup" });
  const r1 = await send("Hey it's Marco", session);
  console.log(`customer: Hey it's Marco\nbot: ${r1.reply}`);
}

async function scenarioC_correctionSameTurn() {
  hr("SCENARIO C — correction 'no, 88 Bridge St' replaces address, same turn, no re-ask");
  const phone = "web:crm-proof-correction-1";
  const session = "crm-proof-correction-1";
  await cleanupSession(session, phone);
  await seedReturningCustomer(phone, {
    name: "Dana",
    lastOrderType: "delivery",
    lastDeliveryAddress: { street: "5620 Cetronia Rd", city: "Allentown", state: "PA", zip: "18106", formatted: "5620 Cetronia Rd, Allentown, PA 18106" },
  });
  const r1 = await send("Hi", session);
  console.log(`customer: Hi\nbot: ${r1.reply}`);
  const r2 = await send("no, 1 S 4th St, Allentown PA 18102", session);
  console.log(`customer: no, 1 S 4th St, Allentown PA 18102\nbot: ${r2.reply}`);
}

async function scenarioD_nameConfirmNotAsk() {
  hr("SCENARIO D — known customer's name is CONFIRMED at checkout, never re-asked");
  const phone = "web:crm-proof-name-1";
  const session = "crm-proof-name-1";
  await cleanupSession(session, phone);
  await seedReturningCustomer(phone, { name: "Jason", lastOrderType: "pickup" });
  const r1 = await send("Can I get a Cheese Burger, medium", session);
  console.log(`customer: Can I get a Cheese Burger, medium\nbot: ${r1.reply}`);
  const r2 = await send("pickup", session);
  console.log(`customer: pickup\nbot: ${r2.reply}`);
  const r3 = await send("checkout", session);
  console.log(`customer: checkout\nbot: ${r3.reply}`);
  const r4 = await send("yes", session);
  console.log(`customer: yes\nbot: ${r4.reply}`);
}

async function scenarioE_deliveryDisabledFallback() {
  hr("SCENARIO E — delivery disabled → falls back to pickup with honest reason");
  const phone = "web:crm-proof-disabled-1";
  const session = "crm-proof-disabled-1";
  await cleanupSession(session, phone);
  await seedReturningCustomer(phone, {
    name: "Priya",
    lastOrderType: "delivery",
    lastDeliveryAddress: { street: "412 Main St", city: "Phoenixville", state: "PA", zip: "19460", formatted: "412 Main St, Phoenixville, PA 19460" },
  });
  // Temporarily disable delivery on Vito's for this one scenario, restore after.
  await supabase.from("shops").update({ delivery_enabled: false }).eq("id", VITOS_SHOP_ID);
  try {
    const r1 = await send("Hi", session);
    console.log(`customer: Hi\nbot: ${r1.reply}`);
  } finally {
    await supabase.from("shops").update({ delivery_enabled: true }).eq("id", VITOS_SHOP_ID);
    console.log("[restored delivery_enabled=true on Vito's]");
  }
}

async function scenarioF_personalizationDisabled() {
  hr("SCENARIO F — customer_personalization_enabled=false disables all of it");
  const phone = "web:crm-proof-optout-1";
  const session = "crm-proof-optout-1";
  await cleanupSession(session, phone);
  await seedReturningCustomer(phone, {
    name: "Wendy",
    lastOrderType: "delivery",
    lastDeliveryAddress: { street: "412 Main St", city: "Phoenixville", state: "PA", zip: "19460", formatted: "412 Main St, Phoenixville, PA 19460" },
  });
  await supabase.from("shops").update({ customer_personalization_enabled: false }).eq("id", VITOS_SHOP_ID);
  try {
    const r1 = await send("Hi", session);
    console.log(`customer: Hi\nbot: ${r1.reply}`);
  } finally {
    await supabase.from("shops").update({ customer_personalization_enabled: true }).eq("id", VITOS_SHOP_ID);
    console.log("[restored customer_personalization_enabled=true on Vito's]");
  }
}

async function canary() {
  hr("CANARY — Cheese Burger $8.49 + $0.99 = $9.48, one line, Temp: Medium");
  const session = "crm-proof-canary-1";
  await supabase.from("conversations").delete().eq("session_id", session);
  const r1 = await send("I'd like a Cheese Burger", session);
  console.log(`customer: I'd like a Cheese Burger\nbot: ${r1.reply}`);
  const r2 = await send("Medium", session);
  console.log(`customer: Medium\nbot: ${r2.reply}`);
}

const args = Deno.args;
const scenarios: Record<string, () => Promise<void>> = {
  a: scenarioA_returningDelivery,
  b: scenarioB_returningPickup,
  c: scenarioC_correctionSameTurn,
  d: scenarioD_nameConfirmNotAsk,
  e: scenarioE_deliveryDisabledFallback,
  f: scenarioF_personalizationDisabled,
  canary,
};

const which = args.length > 0 ? args : Object.keys(scenarios);
for (const key of which) {
  const fn = scenarios[key];
  if (!fn) { console.error(`Unknown scenario: ${key}`); continue; }
  await fn();
}
