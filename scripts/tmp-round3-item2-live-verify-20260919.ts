// Round 3, item 2 acceptance verification — real Vito's menu/lexicon (live
// REST pull), REAL model calls (defaultProposeTurn via propose.ts, no mock),
// run through the actual local runTurnEngineTurn pipeline. No deploy, no
// recompile — same in-process pattern as scripts/tmp-round3-item1-live-
// verify-20260919.ts.
import { runTurnEngineTurn, type RunTurnDeps, type RunTurnInput, type RunTurnShopContext } from "../supabase/functions/chat-sms/turn-engine-runner.ts";
import type { TurnEngineMenuItem, DialogueState, TurnEngineCartLine } from "../supabase/functions/chat-sms/turn-engine.ts";
import type { LexiconTerm } from "../supabase/functions/chat-sms/resolve-item.ts";

const sec = Object.fromEntries(
  (await Deno.readTextFile(`${Deno.env.get("HOME")}/.openclaw-sprintai/.secrets`))
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim().replace(/^export\s+/, ""), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const url = sec.SPRINTAI_CHAT_SUPABASE_URL, key = sec.SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY;
const apiKey = sec.OPENROUTER_API_KEY;
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

// real shop_settings.hours_line, for the confirmShopFacts lazy-load path
const settingsRows: any[] = await (await fetch(`${url}/rest/v1/shop_settings?shop_id=eq.${SHOP_ID}&select=hours_line`, { headers: H })).json();
console.log(`real hours_line: ${JSON.stringify(settingsRows[0]?.hours_line)}`);

// Captures every order_carts .update() payload so the replay loop can
// advance shopContext the same way index.ts does in production (re-reading
// order_type/driver_tip_cents/delivery_address off the DB row each turn) —
// the original version of this script left shopContextBase frozen across
// turns (its update() stub silently discarded the payload), so order_type
// and driver_tip_cents set on turn N were invisible on turn N+1, hiding
// exactly the interaction (fries disambiguation still open when the
// delivery+address message arrives) item 2b's live repro depends on.
const orderCartsUpdates: Record<string, unknown>[] = [];

function makeRealSupabase() {
  // A real supabase-js client would work too, but this repo's other tmp
  // scripts all use a lightweight REST-backed fake — reused here so
  // loadShopGeo/loadHoursLine/loadUpsellEnabled/loadItemLexicon (all real
  // runner code, unmodified) get REAL answers instead of defaults.
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
        if (table === "order_carts") orderCartsUpdates.push(payload);
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

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  const shopContext: RunTurnShopContext = {
    deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
    driverTipCents: null, pickupName: null, deliveryFeeCents: 0,
  };
  return {
    conversationId: "conv-1", shopId: SHOP_ID, tenantId: "tenant-1", cartId: "cart-1",
    message: "", history: [], menu: MENU, cart: [], dialogueState: null,
    shopContext,
    ...overrides,
  } as RunTurnInput;
}

function cartSummary(cart: TurnEngineCartLine[]): { lines: string[]; total: number } {
  const real = cart.filter((l: any) => typeof l.menu_item_id === "string") as any[];
  const lines = real.map((l) => `${l.quantity}x ${l.name} $${(l.price_cents / 100).toFixed(2)}`);
  const total = real.reduce((s: number, l: any) => s + l.price_cents * l.quantity, 0);
  return { lines, total };
}

// geocodeAddressFn stub: the bug under test is tip-asking logic, not
// geocoding accuracy — no GOOGLE_MAPS_API_KEY is configured for this local
// harness, so a stub that accepts any address deterministically isolates
// the actual fix being verified, same "mock the unrelated dependency"
// discipline the other tmp scripts in this repo already use.
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

async function runReplay(runLabel: string) {
  orderCartsUpdates.length = 0;
  const supabase = makeRealSupabase();
  const deps: RunTurnDeps = { supabase, apiKey, geocodeAddressFn };
  let cart: TurnEngineCartLine[] = [];
  let state: DialogueState | null = null;
  let shopContext: RunTurnShopContext = {
    deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
    driverTipCents: null, pickupName: null, deliveryFeeCents: 0,
  };

  async function turn(message: string) {
    const result = await runTurnEngineTurn(
      { conversationId: "conv-1", shopId: SHOP_ID, tenantId: "tenant-1", cartId: "cart-1",
        message, history: [], menu: MENU, cart, dialogueState: state, shopContext },
      deps,
    );
    cart = result.cart;
    state = result.dialogueState;
    if (orderCartsUpdates.length > 0) shopContext = advanceShopContext(shopContext, orderCartsUpdates[orderCartsUpdates.length - 1]);
    const s = cartSummary(cart);
    console.log(`[${runLabel}] msg=${JSON.stringify(message)}`);
    console.log(`  reply=${JSON.stringify(result.reply)}`);
    console.log(`  open=${state.open?.kind ?? "null"} openRepeatCount=${state.openRepeatCount} phase=${state.phase}`);
    console.log(`  cart=${JSON.stringify(s.lines)} total=$${(s.total / 100).toFixed(2)}`);
    console.log("");
    return result;
  }

  await turn("4 large pizzas");
  await turn("One plain, one pepperoni, one meat lovers and one mushroom");
  await turn("Yes, I want some fries too.");
  await turn("Delivery to 5620 Cetronia Rd, Allentown PA 18106");
  await turn("So delivery is free?");
  await turn("$5 tip");
}

for (let i = 1; i <= 3; i++) {
  console.log(`\n========== FULL REPLAY RUN ${i} ==========`);
  await runReplay(`run-${i}`);
}
