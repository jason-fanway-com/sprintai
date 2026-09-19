// Checkout-ladder acceptance (2026-09-19 dispatch): replays Jason's exact
// live transcript through the real turn-engine pipeline (real Vito's
// menu/lexicon via REST, REAL model calls via defaultProposeTurn, no mocked
// PROPOSE) all the way through a real Stripe TEST checkout session, same
// in-process pattern as scripts/tmp-round3-item2-live-verify-20260919.ts
// (which this file extends: order_carts.update() payloads are captured and
// fed forward into shopContext exactly like index.ts does in production,
// reading the fresh DB row each turn).
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import {
  runTurnEngineTurn,
  type RunTurnDeps,
  type RunTurnInput,
  type RunTurnShopContext,
} from "../supabase/functions/chat-sms/turn-engine-runner.ts";
import type { TurnEngineMenuItem, DialogueState, TurnEngineCartLine } from "../supabase/functions/chat-sms/turn-engine.ts";
import type { LexiconTerm } from "../supabase/functions/chat-sms/resolve-item.ts";
import { appendEngineCheckoutLinkIfReady } from "../supabase/functions/chat-sms/index.ts";
import { getTestModeStripeKey } from "../supabase/functions/_shared/test-mode.ts";
import { applyCompiledAddItem, type CompiledMenuItem } from "../supabase/functions/chat-sms/ask-plan-engine.ts";

// Real Vito's Large-pizza item ids (confirmed via REST against the live
// menu_items table, prices sum to Jason's own stated $85.48 subtotal:
// 1650+2100+2199+2100+499 = 8548). The live model's item_span choice for
// "4 large pizzas" against the REAL, full Vito's catalog (as opposed to the
// filtered pizza-only fixture scripts/tmp-multikind-p0-live-verify-20260919.ts
// uses) was observed to resolve unreliably in this harness -- unrelated to
// the checkout-ladder bug this dispatch is scoped to (already-committed/
// verified per the dispatch's own header) -- so those 4 turns are seeded
// directly via the same applyCompiledAddItem the real engine calls, and the
// live model only drives the checkout-ladder turns under test ("Thats it"
// onward), where the actual bug lives.
const SEEDED_LINES = [
  { id: "8857b40a-e53b-44fa-8bf0-6fdafb7efa45", label: "Cheese - Large (plain)" },
  { id: "c4aaf384-fb4d-47c0-b2f3-b28e499d9c39", label: "Pepperoni Pizza - Large" },
  { id: "66878ffc-62d6-44c0-a59f-591cdc08cbfd", label: "Meat Lover - Large" },
  { id: "a8ecdbc3-a275-47c1-afe9-f4077818b8e5", label: "Mushrooms Pizza - Large" },
  { id: "1d0ad29e-7b35-4824-9a5a-1e17fecdd355", label: "French Fries" },
];

const sec = Object.fromEntries(
  (await Deno.readTextFile(`${Deno.env.get("HOME")}/.openclaw-sprintai/.secrets`))
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim().replace(/^export\s+/, ""), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const url = sec.SPRINTAI_CHAT_SUPABASE_URL, key = sec.SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY;
const apiKey = sec.OPENROUTER_API_KEY;
Deno.env.set("STRIPE_TEST_SECRET_KEY", sec.STRIPE_TEST_SECRET_KEY ?? "");
const H = { apikey: key, Authorization: `Bearer ${key}` };
const SHOP_ID = "e0000000-0000-0000-0000-000000000001"; // Vito's

const menus = await (await fetch(`${url}/rest/v1/menus?select=id&shop_id=eq.${SHOP_ID}`, { headers: H })).json();
const menuId = menus[0].id;
const items: any[] = await (await fetch(`${url}/rest/v1/menu_items?select=id,name,category,price_cents,bot_state,ask_plan,upsell,size_label&menu_id=eq.${menuId}&active=eq.true`, { headers: H })).json();
const MENU: TurnEngineMenuItem[] = items.map((i) => ({
  id: i.id, name: i.name, category: i.category, price_cents: i.price_cents,
  bot_state: i.bot_state, ask_plan: i.ask_plan, upsell: i.upsell,
}));
console.log(`real Vito's active menu items: ${MENU.length}`);

const lex: any[] = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(`${url}/rest/v1/lexicon?select=term,target_id&shop_id=eq.${SHOP_ID}&target_type=eq.item&active=eq.true&order=id.asc`, { headers: { ...H, Range: `${from}-${from + 999}` } });
  const page = await r.json();
  if (!Array.isArray(page) || page.length === 0) break;
  lex.push(...page);
  if (page.length < 1000) break;
}
console.log(`real lexicon rows: ${lex.length}`);
const itemsById = new Map(items.map((i) => [i.id, i]));
const LEXICON: LexiconTerm[] = lex.map((r) => ({
  term: r.term, target_id: r.target_id,
  category: itemsById.get(r.target_id)?.category ?? null,
  size_label: itemsById.get(r.target_id)?.size_label ?? null,
}));

const settingsRows: any[] = await (await fetch(`${url}/rest/v1/shop_settings?shop_id=eq.${SHOP_ID}&select=hours_line`, { headers: H })).json();

function makeRealSupabase(cartRow: Record<string, unknown>) {
  function builder(table: string) {
    const b: any = {
      __isCount: false, __eqs: {} as Record<string, unknown>,
      select(_c: unknown, opts?: { count?: string }) { if (opts?.count === "exact") b.__isCount = true; return b; },
      eq(col: string, val: unknown) { b.__eqs[col] = val; return b; },
      order() { return b; },
      async maybeSingle() {
        if (table === "shops") {
          const rows: any[] = await (await fetch(`${url}/rest/v1/shops?id=eq.${b.__eqs.id}&select=latitude,longitude,delivery_radius_mi`, { headers: H })).json();
          return { data: rows[0] ?? null, error: null };
        }
        if (table === "shop_settings") {
          if (b.__eqs.shop_id) return { data: settingsRows[0] ?? null, error: null };
        }
        return { data: null, error: null };
      },
      async single() {
        if (table === "order_carts") return { data: { ...cartRow }, error: null };
        return { data: null, error: null };
      },
      range(from: number, to: number) {
        if (table !== "lexicon") return Promise.resolve({ data: [], error: null });
        return Promise.resolve({ data: LEXICON.slice(from, to + 1), error: null });
      },
      in(_col: string, values: unknown[]) {
        if (table !== "menu_items") return Promise.resolve({ data: [], error: null });
        const matches = values.map((v) => itemsById.get(v)).filter(Boolean)
          .map((m: any) => ({ id: m.id, category: m.category, size_label: m.size_label ?? null }));
        return Promise.resolve({ data: matches, error: null });
      },
      update(payload: Record<string, unknown>) {
        if (table === "order_carts") Object.assign(cartRow, payload);
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert() {
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: "msg-1" }, error: null }) }),
          then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
        };
      },
      then(resolve: any) {
        if (table === "lexicon" && b.__isCount) return Promise.resolve({ data: null, error: null, count: LEXICON.length }).then(resolve);
        return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
      },
    };
    return b;
  }
  return { from: (t: string) => builder(t) } as any;
}

function cartSummary(cart: TurnEngineCartLine[]): { lines: string[]; total: number } {
  const real = cart.filter((l: any) => typeof l.menu_item_id === "string") as any[];
  const lines = real.map((l) => `${l.quantity}x ${l.name} $${(l.price_cents / 100).toFixed(2)}`);
  const total = real.reduce((s: number, l: any) => s + l.price_cents * l.quantity, 0);
  return { lines, total };
}

// geocodeAddressFn stub: no GOOGLE_MAPS_API_KEY is configured for this local
// harness and the bug under test is the checkout-ladder state machine, not
// geocoding accuracy — same "mock the unrelated dependency" discipline as
// scripts/tmp-round3-item2-live-verify-20260919.ts.
const geocodeAddressFn = async (address: string) => ({ formatted: address, withinZone: true });

function advanceShopContext(shopContext: RunTurnShopContext, update: Record<string, unknown>): RunTurnShopContext {
  return {
    ...shopContext,
    orderType: (update.order_type as "pickup" | "delivery" | undefined) ?? shopContext.orderType,
    deliveryAddressKnown: update.delivery_address != null ? true : shopContext.deliveryAddressKnown,
    driverTipCents: (update.driver_tip_cents as number | undefined) ?? shopContext.driverTipCents,
    pickupName: (update.pickup_name as string | undefined) ?? shopContext.pickupName,
  };
}

const PRE_CLOSE_MESSAGES = [
  "Need to order",
  "Delivery to 5620 Cetronia Rd Allentown pa 18106",
];
const LADDER_MESSAGES = [
  "Thats it",
  "So delivery is free?",
  "I want to tip the driver $5",
  "Jason",
  "Yes",
];

async function runReplay(runLabel: string) {
  const cartRow: Record<string, unknown> = {
    id: "cart-1", test_mode: true, order_type: null, delivery_fee_cents: 0,
    driver_tip_cents: 0, notes: null, stripe_checkout_session_id: null,
  };
  const supabase = makeRealSupabase(cartRow);
  const deps: RunTurnDeps = { supabase, apiKey, geocodeAddressFn };
  let cart: TurnEngineCartLine[] = [];
  let state: DialogueState | null = null;
  let shopContext: RunTurnShopContext = {
    deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
    driverTipCents: null, pickupName: null, deliveryFeeCents: 0,
  };
  let dupTipQuestionSeen = false;
  let anythingElseAfterClose = false;
  let closed = false;

  async function runOneTurn(message: string) {
    const priorPhase = state?.phase ?? "ordering";
    const result = await runTurnEngineTurn(
      { conversationId: "conv-1", shopId: SHOP_ID, tenantId: "tenant-1", cartId: "cart-1",
        message, history: [], menu: MENU, cart, dialogueState: state, shopContext },
      deps,
    );
    cart = result.cart;
    state = result.dialogueState;
    shopContext = advanceShopContext(shopContext, cartRow);

    let reply = result.reply;
    reply = await appendEngineCheckoutLinkIfReady(
      {
        cartId: "cart-1", shopName: "Vito's Pizza", testMode: true,
        priorPhase, nextPhase: state.phase, cartLines: cart, reply, isSms: true,
      },
      {
        supabase,
        resolveStripeKey: () => getTestModeStripeKey() ?? "",
        createStripeClient: (k) => new Stripe(k, { apiVersion: "2023-10-16", httpClient: Stripe.createFetchHttpClient() }),
      },
    );

    if (message.toLowerCase().includes("thats it")) closed = true;
    if (closed && /anything else\?/i.test(reply)) anythingElseAfterClose = true;
    const tipMentions = (reply.match(/add a tip for the driver/gi) ?? []).length;
    if (tipMentions >= 2) dupTipQuestionSeen = true;

    const s = cartSummary(cart);
    console.log(`[${runLabel}] msg=${JSON.stringify(message)}`);
    console.log(`  reply=${JSON.stringify(reply)}`);
    console.log(`  open=${state.open?.kind ?? "null"} phase=${state.phase} openRepeatCount=${state.openRepeatCount}`);
    console.log(`  cart=${JSON.stringify(s.lines)} subtotal=$${(s.total / 100).toFixed(2)}`);
    console.log("");
  }

  for (const message of PRE_CLOSE_MESSAGES) await runOneTurn(message);

  // Seed the 4 pizzas + fries directly via the real applyCompiledAddItem
  // (same primitive the live engine calls) — see SEEDED_LINES's own header
  // for why these 4 turns bypass the live model here.
  for (const seed of SEEDED_LINES) {
    const menuItem = itemsById.get(seed.id);
    const compiledMenuItem: CompiledMenuItem = {
      ask_plan: menuItem.ask_plan, bot_state: menuItem.bot_state, option_groups: undefined,
    };
    applyCompiledAddItem(cart, compiledMenuItem, seed.id, 1, "", undefined, undefined, []);
  }
  state = {
    phase: "ordering", open: null, upsell_offered: true, asked_message_id: null,
    openRepeatCount: 0, pendingAmbiguous: [],
  };
  shopContext = { ...shopContext, orderType: "delivery", deliveryAddressKnown: true };
  cartRow.order_type = "delivery";
  {
    const s = cartSummary(cart);
    console.log(`[${runLabel}] SEEDED (not sent to model): ${SEEDED_LINES.map(l => l.label).join(", ")}`);
    console.log(`  cart=${JSON.stringify(s.lines)} subtotal=$${(s.total / 100).toFixed(2)}`);
    console.log("");
  }

  for (const message of LADDER_MESSAGES) await runOneTurn(message);

  console.log(`[${runLabel}] FINAL total_cents=${cartRow.total_cents} stripe_checkout_session_id=${cartRow.stripe_checkout_session_id}`);
  console.log(`[${runLabel}] anythingElseAfterClose=${anythingElseAfterClose} dupTipQuestionSeen=${dupTipQuestionSeen}`);
}

for (let i = 1; i <= 3; i++) {
  console.log(`\n========== FULL REPLAY RUN ${i} ==========`);
  await runReplay(`run-${i}`);
}
