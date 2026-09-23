// runner.ts — the I/O shell around the pure engine: load menu and form, get
// moves (closed vocabulary first, else one model call), validate addresses,
// run turn(), create or expire the checkout session, persist, return the reply.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { buildMenu, type LexiconEntry, type Menu, type RawMenuItem, type ShopConfig } from "./menu.ts";
import { newForm, type Move, type OrderForm } from "./form.ts";
import { closedAnswer } from "./vocab.ts";
import { interpret, summarizeOpen, type ModelConfig } from "./interpret.ts";
import { judgeOmissions } from "./judge.ts";
import { turn, JUDGE } from "./turn.ts";
import { render } from "./render.ts";
import { totals } from "./price.ts";
import { toCartJson } from "./project.ts";
import { scan } from "./crossread.ts";
import type { Geocoder } from "./address.ts";
import { logError } from "../../_shared/error-log.ts";

export interface RunnerShop {
  id: string;
  tenant_id: string;
  name: string;
  delivery_enabled: boolean;
  delivery_fee_cents: number | null;
  tax_rate_bps?: number | null;
  phone_number_e164?: string | null;
  latitude: number | null;
  longitude: number | null;
  delivery_radius_mi: number | null;
}
export interface RunnerCart {
  id: string;
  engine_form: OrderForm | null;
  test_mode: boolean;
  stripe_checkout_session_id: string | null;
  notes?: string | null;
}
export interface RunnerInput {
  shop: RunnerShop;
  conversationId: string;
  cart: RunnerCart;
  message: string;
  lastBotMessage: string | null;
  isFirstContact: boolean;
}
export interface CheckoutRequest {
  cartId: string; shopName: string; testMode: boolean; cartLines: ReturnType<typeof toCartJson>;
  orderType: "pickup" | "delivery"; deliveryFeeCents: number; tipCents: number; taxCents: number; notes: string | null;
}
export interface RunnerDeps {
  supabase: SupabaseClient;
  model: ModelConfig;
  geocoder: Geocoder;
  createCheckout: (req: CheckoutRequest) => Promise<{ ok: true; sessionId: string; url: string } | { ok: false; error: string }>;
  expireCheckout: (sessionId: string) => Promise<void>;
  serviceFeeCents: number;
  /** test seam; defaults to the real model call */
  interpretImpl?: typeof interpret;
  /** test seam; defaults to the real judge call (Jev via the same OpenRouter key) */
  judgeImpl?: typeof judgeOmissions;
}
export interface RunnerOutput { reply: string; form: OrderForm; assistantMessageId: string | null; ms: { model: number | null; judge?: number | null; total: number } }

const PAGE = 1000;
async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const menuCache = new Map<string, { at: number; menu: Menu }>();
const MENU_TTL_MS = 60_000;

export async function loadMenu(supabase: SupabaseClient, shop: RunnerShop, serviceFeeCents: number): Promise<Menu> {
  const cached = menuCache.get(shop.id);
  if (cached && Date.now() - cached.at < MENU_TTL_MS) return cached.menu;
  const { data: menuRow } = await supabase.from("menus").select("id")
    .eq("shop_id", shop.id)
    .or(`effective_until.is.null,effective_until.gte.${new Date().toISOString()}`)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const menuId = (menuRow as { id: string } | null)?.id;
  const items = menuId ? await pageAll<RawMenuItem>((a, b) => supabase.from("menu_items")
    .select("id, name, display_name, description, category, price_cents, bot_state, ask_plan, is_derived, derived_from, size_label, meta")
    .eq("menu_id", menuId).eq("active", true).order("id", { ascending: true }).range(a, b)) : [];
  const ids = items.map((i) => i.id);
  const groups: Array<{ id: string; menu_item_id: string; name: string; max_select: number | null; default_choice_id: string | null }> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from("option_groups").select("id, menu_item_id, name, max_select, default_choice_id").in("menu_item_id", ids.slice(i, i + 100));
    groups.push(...((data ?? []) as typeof groups));
  }
  const byItem = new Map<string, Array<{ id: string; name: string; max_select: number | null; default_choice_id: string | null }>>();
  for (const g of groups) { const arr = byItem.get(g.menu_item_id) ?? []; arr.push({ id: g.id, name: g.name, max_select: g.max_select, default_choice_id: g.default_choice_id }); byItem.set(g.menu_item_id, arr); }
  for (const it of items) it.option_groups = byItem.get(it.id) ?? [];
  const lexicon = menuId ? await pageAll<LexiconEntry & { menu_id: string }>((a, b) => supabase.from("lexicon")
    .select("term, target_type, target_id, menu_id").eq("shop_id", shop.id).eq("menu_id", menuId).eq("active", true)
    .order("id", { ascending: true }).range(a, b)) : [];
  let latest = "";
  for (const it of items) { const c = it.ask_plan?.compiled_at as string | undefined; if (c && c > latest) latest = c; }
  const shopCfg: ShopConfig = {
    shop_id: shop.id, name: shop.name, delivery_enabled: shop.delivery_enabled === true,
    delivery_fee_cents: shop.delivery_fee_cents ?? 0, tax_rate_bps: shop.tax_rate_bps ?? 0, service_fee_cents: serviceFeeCents,
    phone_display: shop.phone_number_e164 ?? null,
    ask_order: ["fulfillment", "address", "items", "tip", "confirm"],
  };
  const menu = buildMenu({ version: `${menuId ?? "none"}:${latest}:${items.length}`, items, lexicon, shop: shopCfg });
  menuCache.set(shop.id, { at: Date.now(), menu });
  return menu;
}

function choicesFor(menu: Menu, form: OrderForm) {
  return (q: import("./form.ts").OpenQuestion): string[] | null => {
    if (q.kind === "line_slot") {
      const l = form.lines.find((x) => x.line_id === q.line_id);
      const it = l?.item_id ? menu.items.get(l.item_id) : null;
      const g = it?.groups.find((x) => x.id === q.group_id);
      if (!g) return null;
      const within = l!.slot_candidates[g.id];
      return (within ? g.choices.filter((c) => within.includes(c.id)) : g.choices).map((c) => c.name).slice(0, 12);
    }
    if (q.kind === "line_picks") {
      const l = form.lines.find((x) => x.line_id === q.line_id);
      const it = l?.item_id ? menu.items.get(l.item_id) : null;
      return it?.bundle ? it.bundle.choices.map((c) => c.name).slice(0, 30) : null;
    }
    if (q.kind === "line_ambiguous") {
      const l = form.lines.find((x) => x.line_id === q.line_id);
      if (!l || l.status.kind !== "ambiguous") return null;
      const cands = l.status.candidates.map((id) => menu.items.get(id)!).filter(Boolean);
      if (q.facet === "size") return [...new Set(cands.map((c) => c.facets.size).filter((s): s is string => !!s))];
      if (q.facet === "kind") return [...new Set(cands.map((c) => c.facets.kind ?? c.display_name))].slice(0, 12);
      return cands.slice(0, 8).map((c) => c.display_name);
    }
    return null;
  };
}

export async function runEngineTurn(input: RunnerInput, deps: RunnerDeps): Promise<RunnerOutput> {
  const t0 = Date.now();
  const menu = await loadMenu(deps.supabase, input.shop, deps.serviceFeeCents);
  const form0: OrderForm = input.cart.engine_form ?? newForm(input.shop.id, menu.version);
  const lines = form0.lines.map((l) => ({ line_id: l.line_id, name: l.item_id ? (menu.items.get(l.item_id)?.display_name ?? l.span) : l.span, qty: l.qty }));

  // 1. moves: closed vocabulary, else the model
  let moves: Move[] | null = closedAnswer(form0, input.message, menu);
  const closed = moves !== null;
  let modelMs: number | null = null;
  if (!moves) {
    const r = await (deps.interpretImpl ?? interpret)({
      shop_name: input.shop.name, message: input.message, last_bot: input.lastBotMessage,
      open: form0.open, open_summary: summarizeOpen(form0.open, lines, choicesFor(menu, form0)), lines,
    }, deps.model);
    modelMs = r.ms;
    if (r.ok) {
      moves = r.moves;
      // The model sometimes returns an answer and silently drops the items in the same message.
      // The second reader knows items were named; give the model one more chance before we ask.
      const itemMoves = (ms: Move[]) => ms.filter((m) => m.kind === "add_line" || m.kind === "change_line" || m.kind === "remove_line" || m.kind === "answer_option").length;
      if (itemMoves(moves) === 0 && scan(input.message, menu).hits.length > 0 && !form0.open?.kind?.startsWith("line_")) {
        const r2 = await (deps.interpretImpl ?? interpret)({
          shop_name: input.shop.name, message: input.message, last_bot: input.lastBotMessage,
          open: form0.open, open_summary: summarizeOpen(form0.open, lines, choicesFor(menu, form0)), lines,
        }, deps.model);
        modelMs += r2.ms;
        if (r2.ok && itemMoves(r2.moves) > itemMoves(moves)) moves = r2.moves;
      }
    } else {
      await logError(deps.supabase, { conversationId: input.conversationId, shopId: input.shop.id, tenantId: input.shop.tenant_id, phase: "chat-sms", stage: "propose_call", customerMessage: input.message, error: new Error(`interpret failed: ${r.reason} ${r.detail}`), metadata: { model: deps.model.model, ms: r.ms } });
      moves = [{ kind: "control", what: "unclear" }];
    }
  }

  // 2. addresses are validated by I/O before the pure turn sees them
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (m.kind === "answer" && m.field === "address" && !m.value.validated) {
      moves[i] = { kind: "answer", field: "address", value: await deps.geocoder(m.value.text) };
    }
  }

  // 3. the turn
  const turnInput = { form: form0, menu, message: input.message, moves, closed, greet: input.isFirstContact && form0.turn_no === 0, checkoutUrl: form0.checkout_url ?? null };
  let out = turn(turnInput);
  // 3b. an uncovered mention the second reader wants to ask about goes to the judge first; the turn is
  // pure, so it is simply run again with the answers. A failed or slow judge means today's question.
  let judgeMs: number | null = null;
  const asks = out.ledger.filter((e) => e.event === "possible_omission").map((e) => e.data as { span: string; item_ids?: string[] })
    .map((d) => ({ span: d.span, candidates: (d.item_ids ?? []).map((id) => menu.items.get(id)?.display_name ?? id).slice(0, 8) }));
  if (JUDGE.enabled && asks.length > 0 && deps.model.provider === "openrouter") {
    const j = await (deps.judgeImpl ?? judgeOmissions)({ message: input.message, last_bot: input.lastBotMessage, asks }, { apiKey: deps.model.apiKey, timeoutMs: 1500 });
    judgeMs = j.ms;
    if (j.ok) out = turn({ ...turnInput, judgments: { omission_asked_p: j.p } });
    else console.warn("[engine] judge failed", j.reason, j.detail);
  }
  const form = out.form;
  let reply = out.reply;

  // 4. checkout: expire a stale session on reopen; create one on handoff
  const priorSession = input.cart.stripe_checkout_session_id ?? form0.checkout_session_id;
  if (priorSession && !form.confirmed) {
    try { await deps.expireCheckout(priorSession); } catch (e) { console.error("[engine] expire failed", e); }
    await deps.supabase.from("order_carts").update({ stripe_checkout_session_id: null, phase: "building" }).eq("id", input.cart.id);
  }
  const t = totals(form, menu);
  if (out.handoff && !form.checkout_session_id) {
    const res = await deps.createCheckout({
      cartId: input.cart.id, shopName: input.shop.name, testMode: input.cart.test_mode, cartLines: toCartJson(form, menu),
      orderType: form.fulfillment ?? "pickup", deliveryFeeCents: t.delivery_fee_cents, tipCents: t.tip_cents, taxCents: t.tax_cents, notes: input.cart.notes ?? null,
    });
    if (res.ok) {
      form.checkout_session_id = res.sessionId; form.checkout_url = res.url;
      out.plan.question = { kind: "handoff", totals: t, url: res.url };
      reply = render(out.plan, form, menu, { shop_name: menu.shop.name, phone_display: menu.shop.phone_display });
    } else {
      await logError(deps.supabase, { conversationId: input.conversationId, shopId: input.shop.id, tenantId: input.shop.tenant_id, phase: "chat-sms", stage: "render", customerMessage: input.message, error: new Error(`checkout failed: ${res.error}`) });
      form.confirmed = false; form.status = "confirming"; form.open = { kind: "confirm" };
      out.plan.declines.push({ code: "checkout_failed" });
      out.plan.question = null;
      reply = render(out.plan, form, menu, { shop_name: menu.shop.name, phone_display: menu.shop.phone_display });
    }
  }

  // 5. persist: the form is the truth; cart_json is its projection
  await deps.supabase.from("order_carts").update({
    engine_form: form,
    cart_json: toCartJson(form, menu),
    subtotal_cents: t.subtotal_cents,
    service_fee_cents: t.service_fee_cents,
    total_cents: t.total_cents,
    delivery_fee_cents: t.delivery_fee_cents,
    driver_tip_cents: t.tip_cents,
    tax_cents: t.tax_cents,
    order_type: form.fulfillment,
    delivery_address: form.address && form.address.validated && form.address.zone_ok ? { formatted: form.address.formatted ?? form.address.text } : null,
    ...(form.checkout_session_id ? {} : { phase: form.lines.length > 0 ? "building" : "greeting" }),
  }).eq("id", input.cart.id);
  const { data: msg } = await deps.supabase.from("messages").insert({
    conversation_id: input.conversationId, tenant_id: input.shop.tenant_id, role: "assistant", content: reply,
  }).select("id").single();
  await deps.supabase.from("engine_ledger").insert(out.ledger.map((e) => ({ cart_id: input.cart.id, turn_no: form.turn_no, event: e.event, data: e.data ?? null }))).then(() => {}, () => {});

  return { reply, form, assistantMessageId: (msg as { id: string } | null)?.id ?? null, ms: { model: modelMs, judge: judgeMs, total: Date.now() - t0 } };
}
