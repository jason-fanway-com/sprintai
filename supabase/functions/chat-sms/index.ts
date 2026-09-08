/**
 * SprintAI chat-sms Edge Function — Ordering State Machine
 *
 * Supports two channels:
 *   a) Twilio SMS webhook  (application/x-www-form-urlencoded)
 *   b) Web chat test       (application/json { shop_id, message, session_id })
 *
 * Uses DeepSeek V4 Flash (via OpenRouter) for the conversation engine.
 * Persists messages to the messages table and cart state to order_carts.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { guardedSend, type OutboundContext } from "../_shared/outbound-guard.ts";
import { SERVICE_FEE_CENTS } from "../_shared/connect.ts";
import { getTestModeStripeKey } from "../_shared/test-mode.ts";
import { classifyTelnyxSendError } from "../_shared/telnyx-error.ts";
import { dayWindows } from "../_shared/hours.ts";
import { claimsAddedWithoutMutation } from "./phantom-add-guard.ts";
import { stripInventedActions } from "./invented-action-guard.ts";
import {
  buildZeroOptionAttributeChangeHint,
  resolveZeroOptionAttributeChange,
  renderZeroOptionAttributeChangeReply,
  combineNotes,
  type ZeroOptionMenuItemFull,
} from "./zero-option-attribute-hint.ts";
import {
  categoryDisplayWord,
  categoryWordMatches,
  displayGroupName,
  isPendingDisambiguationDeclined,
  resolveNamedCartRemoval,
  resolvePendingDisambiguation,
  stemWord,
  type PendingCandidate,
  type PendingDisambiguation,
} from "./pending-disambiguation.ts";
import {
  findPendingOptionQuestion,
  resolveAdditionalGroupSelections,
  resolvePendingOptionAnswer,
} from "./pending-option.ts";
import { computeGuard9, impliesOrderConfirmation } from "./guard9-unconsented-affirmation.ts";
import { computeGuard13 } from "./guard13-unconsented-quantity-growth.ts";
import type { AskPlan } from "../_shared/compile-menu.ts";
import { applyCompiledAddItem, allSlotsResolved, type CompiledCartLine, type CompiledMenuItem } from "./ask-plan-engine.ts";
import { matchReactiveExtras, type ReactiveCandidate } from "./reactive-modifier-match.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const CHAT_MODEL = Deno.env.get("CHAT_MODEL") ?? "deepseek/deepseek-v4-pro";
const CHAT_API   = "https://openrouter.ai/api/v1/messages";
const MAX_RETRIES = 8;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Compliance texts (EXACT registered strings from TCR campaign CSMB9HG) ──
const COMPLIANCE_STOP = "You've been unsubscribed and will receive no further messages from this restaurant. Reply START to opt back in.";
/** Appended verbatim to the first outbound reply of a conversation, last. */
const COMPLIANCE_DISCLOSURE = "Msg & data rates may apply. Reply HELP for help or STOP to unsubscribe.";
const COMPLIANCE_HELP = "SprintAI text ordering. Text your order to this number to order from this restaurant. Message frequency varies by order, typically 3-8 messages per order. Support: support@getsprintai.com. Msg & data rates may apply. Reply STOP to opt out.";
const COMPLIANCE_START = "Thanks for texting! You'll receive order-related messages from this restaurant. Message frequency may vary. Msg&data rates may apply. Reply HELP for help, STOP to opt out.";

// ─── Customer-facing name ask (ONE wording, both order types) ───────────────
// Jason 2026-09-05: no pickup/delivery variant. "pickup" is wrong on a delivery
// order and branching was overruled. Field stays `pickup_name` internally.
// Straight apostrophe on purpose: U+2019 is not in GSM-7 and would push every
// SMS containing it to UCS-2 (67 chars/segment instead of 153).
// NOTE: C2's askedForName detector (below) must keep matching this string.
const NAME_ASK = "What's your name for the order?";

// ─── Provider resolution ─────────────────────────────────────────────────────
function resolveSmsProvider(): "telnyx" | "twilio" {
  const telnyxKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  return telnyxKey.length > 0 ? "telnyx" : "twilio";
}

type SmsProvider = ReturnType<typeof resolveSmsProvider>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Escape user-controlled strings for HTML safety. */
function h(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Strip newlines from email header values (prevents header injection). */
function hs(s: string): string {
  return s.replace(/[\r\n]/g, " ");
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface OptionChoice {
  id: string;
  name: string;
  price_cents: number;
  is_default: boolean;
}

interface OptionGroup {
  id: string;
  name: string;
  required: boolean;
  min_select: number;
  max_select: number;
  choices: OptionChoice[];
  // Item 8 (spec §7/§11): looked up separately from ask_plan because
  // CompiledStep does not itself carry which choice is the group's default
  // (see ask-plan-engine.ts header comment) — the apply_default sequencer
  // path needs this to resolve a default deterministically instead of
  // falling back to asking.
  default_choice_id?: string | null;
}

interface EffectiveMenuItem {
  id:            string;
  name:          string;
  description:   string | null;
  price_cents:   number;
  category:      string;
  modifiers_json: Array<{ name: string; price_cents: number }> | null;
  // The importer recorded that this item REQUIRES a choice (e.g. "which wing
  // flavor(s)", "which dressing") without recording what the choices are. 398
  // active items carry this and chat-sms never read it, so the bot saw a
  // description saying "Choose flavor(s)" with no list and invented one.
  prompt_for?:    string | null;
  option_groups?: OptionGroup[];
  // Item 8: compiler output (supabase/functions/_shared/compile-menu.ts).
  // Null until compile-menu has actually been run for this item — every
  // item at every shop is null today (see BLOCKED.txt PIVOT entry,
  // 2026-09-07). The compiled-engine path in executeTool's add_item case is
  // a no-op whenever ask_plan is null, regardless of the shop flag.
  ask_plan?:        AskPlan | null;
  bot_state?:       string | null;
  bot_state_reason?: string | null;
}

interface CartItem {
  menu_item_id: string;
  name:         string;
  quantity:     number;
  price_cents:  number;
  modifiers:    string[];
  options?:     Record<string, string[]>;
  pending_options?: string[];  // option group names not yet chosen (required groups with no selection)
  // A customer request naming something that doesn't match any real option
  // group (e.g. a wing flavor when the shop never recorded the flavor list).
  // NEVER treated as a validated menu selection and NEVER priced — surfaced
  // to a human (chat + kitchen ticket) as an unverified ask, e.g. "Flavor: Boosenberry".
  unverified_requests?: string[];
  // Item 8 (spec §7/§11): group_id -> choice_id for slots resolved via the
  // compiled ask_plan engine. Authoritative source of truth for a compiled
  // line's price and pending question — price_cents/options/pending_options
  // above are still populated (for receipt/checkout code that doesn't know
  // about this path) but are DERIVED from this map on every compiled-path
  // add_item call, never hand-adjusted. Absent entirely for legacy-path
  // lines (i.e. every line at every shop until a menu is compiled AND the
  // shop flag is set — see ask-plan-engine.ts).
  ask_plan_selections?: Record<string, string>;
}

interface BundleItem {
  type:        "bundle";
  name:        string;
  target:      number;
  price_cents: number;
  selections:  Array<{ flavor: string; quantity: number }>;
  complete:    boolean;
}

type AnyCartItem = CartItem | BundleItem;

type OrderPhase = "greeting" | "building" | "review" | "checkout" | "payment" | "confirmed" | "expired";

interface Shop {
  id:                      string;
  name:                    string;
  slug:                    string;
  // Wing policy, collected at onboarding. TRI-STATE: null/undefined means the
  // owner never told us, which is NOT the same as "no". An unset column must
  // never be spoken to a customer as policy - the bot asks instead.
  wing_flavors_included:   number | null;
  wing_mix_extra:          boolean | null;
  tenant_id:               string;
  phone_number_e164:       string | null;
  reply_from_e164:         string | null;
  open_hours:              Record<string, { closed?: boolean; open?: string; close?: string } | Array<{ open: string; close: string }>>;
  timezone:                string;
  email_ticket_recipient:  string | null;
  is_paused:               boolean;
  pause_message:           string | null;
  delivery_enabled:         boolean;
  delivery_paused_until:    string | null;
  delivery_pause_reason:    string | null;
  delivery_fee_cents:       number | null;
  shop_context:            string | null;
  ai_instructions:         string | null;
  latitude:                 number | null;
  longitude:                number | null;
  delivery_radius_mi:       number | null;
  // Item 8 (spec §7/§11 item 8). Default false in the DB (migration 118) —
  // must stay false for Vito's. See ask-plan-engine.ts.
  compiled_ordering_engine_enabled?: boolean;
}

interface OrderCart {
  id:                         string;
  shop_id:                    string;
  conversation_id:            string;
  phase:                      OrderPhase;
  cart_json:                  AnyCartItem[];
  notes:                      string | null;
  subtotal_cents:             number | null;
  total_cents:                number | null;
  stripe_checkout_session_id: string | null;
  test_mode:                  boolean;
  order_type:                 string | null;
  delivery_address:           Record<string, unknown> | null;
  delivery_fee_cents:         number | null;
  driver_tip_cents:           number | null;
  ticket_send_attempt_at:     string | null;
  fee_disclosed_at:           string | null;
  // BLOCKER 1 (docs/specs/2026-09-06-disambiguation-and-menu-gaps.md): the
  // candidates GUARD 7 offered, so the NEXT inbound message can be resolved
  // deterministically before the LLM ever runs. Null once resolved, reset,
  // or expired.
  pending_disambiguation:     PendingDisambiguation | null;
}

interface ContentBlock {
  type:         string;
  id?:          string;
  name?:        string;
  input?:       Record<string, unknown>;
  text?:        string;
  tool_use_id?: string;
  content?:     string;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const ORDERING_TOOLS = [
  {
    name: "add_item",
    description: "Add a menu item to the customer's cart. Only use IDs from the available menu.",
    input_schema: {
      type: "object",
      properties: {
        menu_item_id: { type: "string", description: "Exact ID from the available menu list" },
        quantity:     { type: "integer", minimum: 1, description: "How many to add" },
        modifiers:    { type: "array", items: { type: "string" }, description: "Modifier names from the item's options" },
        options:      { type: "object", description: "Selected options from option groups. Keys are group names (e.g. 'Bread Type'), values are arrays of chosen names (e.g. ['Roll']). Required for items with required option groups.", additionalProperties: { type: "array", items: { type: "string" } } },
      },
      required: ["menu_item_id", "quantity"],
    },
  },
  {
    name: "remove_item",
    description: "Remove a menu item from the cart entirely.",
    input_schema: {
      type: "object",
      properties: {
        menu_item_id: { type: "string" },
      },
      required: ["menu_item_id"],
    },
  },
  {
    name: "modify_item",
    description: "Change the quantity, modifiers, or options of a cart item. Use this to swap bread type, add/remove modifiers, change quantity, or update option group selections.",
    input_schema: {
      type: "object",
      properties: {
        menu_item_id: { type: "string" },
        quantity:     { type: "integer", minimum: 1 },
        modifiers:    { type: "array", items: { type: "string" }, description: "Full list of modifiers to set (replaces existing)" },
        options:      { type: "object", description: "Option group selections, e.g. {\"Bread Type\": [\"Everything Bagel\"]}. Keys are group names, values are arrays of chosen names.", additionalProperties: { type: "array", items: { type: "string" } } },
      },
      required: ["menu_item_id"],
    },
  },
  {
    name: "clear_cart",
    description: "Remove all items from the cart.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "submit_order",
    description: "Submit the order and create a Stripe payment link. Only call this after the customer explicitly confirms they want to pay (e.g. they say yes, confirm, place order).",
    input_schema: {
      type: "object",
      properties: {
        pickup_name: { type: "string", description: "Customer name for the pickup order" },
      },
    },
  },
  {
    name: "start_bundle",
    description: "Start collecting flavor/variety selections for a bundle item (e.g. Dozen Bagels). Use when the customer orders a bundle with multiple flavor slots. The system tracks the count for you.",
    input_schema: {
      type: "object",
      properties: {
        bundle_item_name:  { type: "string",  description: "Display name for the bundle, e.g. 'Dozen Bagels (14)'" },
        bundle_size:       { type: "integer", description: "Total number of individual selections in the bundle" },
        bundle_price_cents:{ type: "integer", description: "Total price for the bundle in cents" },
      },
      required: ["bundle_item_name", "bundle_size", "bundle_price_cents"],
    },
  },
  {
    name: "add_to_bundle",
    description: "Add a flavor/variety selection to the active bundle. The system validates the count and tells you how many slots remain. Keep calling until the bundle is marked complete.",
    input_schema: {
      type: "object",
      properties: {
        flavor:   { type: "string",  description: "Flavor or variety name, e.g. 'Everything Bagel'" },
        quantity: { type: "integer", description: "How many of this flavor to add" },
      },
      required: ["flavor", "quantity"],
    },
  },
  {
    name: "cancel_bundle",
    description: "Cancel and remove the active (incomplete) bundle from the cart.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "set_note",
    description: "Set or update the order notes for prep instructions like toasted, scooped, extra cream cheese, cut in half, lightly toasted, etc. Call this whenever the customer mentions a preparation preference. Replaces any previous notes.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "The preparation instructions, e.g. 'Everything bagels toasted, plain bagels not toasted' or 'All bagels scooped'" },
      },
      required: ["note"],
    },
  },
  {
    name: "set_order_type",
    description: "Set whether this is a pickup or delivery order. Call early in the conversation when the customer indicates their preference.",
    input_schema: {
      type: "object",
      properties: {
        order_type: { type: "string", enum: ["pickup", "delivery"] },
      },
      required: ["order_type"],
    },
  },
  {
    name: "set_delivery_address",
    description: "Set the delivery address for a delivery order. Collect the street, city, state, and zip from the customer first.",
    input_schema: {
      type: "object",
      properties: {
        street: { type: "string" },
        unit:   { type: "string" },
        city:   { type: "string" },
        state:  { type: "string" },
        zip:    { type: "string" },
      },
      required: ["street", "city", "state", "zip"],
    },
  },
  {
    name: "set_driver_tip",
    description: "Add an optional driver tip to a delivery order. Only call for delivery orders, and only after the address is set.",
    input_schema: {
      type: "object",
      properties: {
        tip_cents: { type: "integer", minimum: 0, maximum: 5000 },
      },
      required: ["tip_cents"],
    },
  },
];

// ─── Effective menu builder ───────────────────────────────────────────────────

// PostgREST caps a single response at 1000 rows by default and returns that
// cap SILENTLY — no error, no truncation flag, just fewer rows than the table
// actually has. Vito's has 2640 option_choices across 186 groups; almost all
// rows share display_order=0, so which 1000 of the 2640 survive the cut is
// whatever order Postgres happens to return ties in, and that shifted between
// requests. The Chicken Caesar's 18-choice Dressing group would sometimes
// land inside the surviving 1000 and sometimes not — the model wasn't failing
// to recite data it had; the data silently never arrived that request
// (2026-09-06, Jason's live "I don't have the dressing list" transcript).
// Page through with .range() so a table of any size is read in full, with a
// stable secondary sort (id) so ties don't reshuffle rows between pages.
const FETCH_PAGE_SIZE = 1000;
async function fetchAllRows<T>(queryBuilder: () => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await (queryBuilder() as any).range(from, from + FETCH_PAGE_SIZE - 1);
    if (error) {
      console.error(`[chat-sms] fetchAllRows error at offset ${from}:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < FETCH_PAGE_SIZE) break;
    from += FETCH_PAGE_SIZE;
  }
  return rows;
}

// A `.in("col", ids)` filter with enough UUIDs makes the request URL long
// enough to fail outright (same defect already found and fixed in
// compile-menu/index.ts's own fetchAllRows: ~492 UUIDs on Zio's option
// groups threw `TypeError: fetch failed`, not a graceful PostgREST error).
// Ported here 2026-09-07 after live-testing the stated-provenance gate fix
// surfaced the EXACT same failure on THIS file's own unbatched
// `option_choices` fetch below — confirmed live via the platform's own
// function logs: "fetchAllRows error at offset 0: TypeError: error sending
// request... option_choices?...&option_group_id=in.(492 UUIDs)". Every
// group's `choices` array came back empty menu-wide on Zio's as a result —
// not just the newly-orderable items — silently breaking GUARD 10's
// is_default lookup (reverting every compiled-engine auto-resolved slot
// back to pending, since `group.choices.find(...)` on an empty array can
// never find a default) and any legacy-path choice/price validation that
// depends on `option_groups[].choices` being populated. Batches the ID
// list itself, not just the result page, for any `.in()` filter whose
// value list scales with menu size rather than a fixed small set.
const IN_BATCH_SIZE = 150;
async function fetchAllRowsBatchedIn<T, K>(
  ids: K[],
  queryBuilder: (batch: K[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_BATCH_SIZE) {
    const batch = ids.slice(i, i + IN_BATCH_SIZE);
    rows.push(...await fetchAllRows(() => queryBuilder(batch)));
  }
  return rows;
}

async function buildEffectiveMenu(
  supabase:     SupabaseClient,
  shopId:       string,
  businessDate: string,
): Promise<{ menu: EffectiveMenuItem[]; soldOutNames: string[] }> {
  const { data: menu } = await supabase
    .from("menus")
    .select("id")
    .eq("shop_id", shopId)
    .or(`effective_until.is.null,effective_until.gte.${new Date().toISOString()}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!menu) return { menu: [], soldOutNames: [] };

  const items = await fetchAllRows<{ id: string; name: string; description: string | null; price_cents: number; category: string; modifiers_json: Array<{ name: string; price_cents: number }> | null; prompt_for: string | null; ask_plan: AskPlan | null; bot_state: string | null; bot_state_reason: string | null }>(() =>
    supabase
      .from("menu_items")
      .select("id, name, description, price_cents, category, modifiers_json, prompt_for, ask_plan, bot_state, bot_state_reason")
      .eq("menu_id", menu!.id)
      .eq("active", true)
      .order("display_order", { ascending: true })
      .order("id", { ascending: true }),
  );

  if (!items.length) return { menu: [], soldOutNames: [] };

  // Load option groups and choices for these menu items. Both `.in()` value
  // lists scale with menu size (one entry per active item / per group), so
  // both go through fetchAllRowsBatchedIn — see its header comment: a menu
  // Zio's-sized (492 groups) makes the option_choices URL long enough to
  // fail outright, silently emptying every group's `choices` menu-wide, not
  // just for the newly-large item set.
  const itemIds = items.map(i => i.id);
  const optionGroupsData = await fetchAllRowsBatchedIn<{ id: string; menu_item_id: string; name: string; required: boolean; min_select: number; max_select: number; display_order: number; default_choice_id: string | null }, string>(
    itemIds,
    batch =>
      supabase
        .from("option_groups")
        .select("id, menu_item_id, name, required, min_select, max_select, display_order, default_choice_id")
        .in("menu_item_id", batch)
        .order("display_order", { ascending: true })
        .order("id", { ascending: true }),
  );

  const groupIds = optionGroupsData.map(g => g.id);
  const optionChoicesData = groupIds.length > 0
    ? await fetchAllRowsBatchedIn<{ id: string; option_group_id: string; name: string; price_cents: number; is_default: boolean; display_order: number }, string>(
        groupIds,
        batch =>
          supabase
            .from("option_choices")
            .select("id, option_group_id, name, price_cents, is_default, display_order")
            .in("option_group_id", batch)
            .order("display_order", { ascending: true })
            .order("id", { ascending: true }),
      )
    : [];

  // Assemble option groups with their choices
  const choicesByGroup: Record<string, OptionChoice[]> = {};
  for (const c of (optionChoicesData || [])) {
    if (!choicesByGroup[c.option_group_id]) choicesByGroup[c.option_group_id] = [];
    choicesByGroup[c.option_group_id].push({
      id: c.id,
      name: c.name,
      price_cents: c.price_cents,
      is_default: c.is_default,
    });
  }
  const groupsByItem: Record<string, OptionGroup[]> = {};
  for (const g of (optionGroupsData || [])) {
    if (!groupsByItem[g.menu_item_id]) groupsByItem[g.menu_item_id] = [];
    groupsByItem[g.menu_item_id].push({
      id: g.id,
      name: g.name,
      required: g.required,
      min_select: g.min_select,
      max_select: g.max_select,
      choices: choicesByGroup[g.id] || [],
      default_choice_id: g.default_choice_id ?? null,
    });
  }

  const { data: overrides } = await supabase
    .from("availability_overrides")
    .select("menu_item_id")
    .eq("shop_id", shopId)
    .eq("business_date", businessDate);

  const soldOutIds = new Set((overrides ?? []).map((o: { menu_item_id: string }) => o.menu_item_id));
  const soldOutNames = items
    .filter((item: { id: string }) => soldOutIds.has(item.id))
    .map((item: { name: string }) => item.name);

  const effectiveItems = items
    .filter((item: { id: string }) => !soldOutIds.has(item.id))
    .map((item: EffectiveMenuItem) => ({
      id:             item.id,
      name:           item.name,
      description:    item.description,
      price_cents:    item.price_cents,
      category:       item.category,
      modifiers_json: item.modifiers_json,
      prompt_for:     item.prompt_for ?? null,
      option_groups:  groupsByItem[item.id] || [],
      ask_plan:         item.ask_plan ?? null,
      bot_state:        item.bot_state ?? null,
      bot_state_reason: item.bot_state_reason ?? null,
    }));

  return { menu: effectiveItems, soldOutNames };
}

// ─── System prompt builder ────────────────────────────────────────────────────

// A group whose max_select is >= the number of choices imposes no real limit —
// the shop just lets you add whatever you want (pizza toppings, add-ons). Reading
// that stored number back to a customer ("pick up to 32 toppings") is nonsense and
// makes the menu look machine-generated. Say "any number" instead, and only print
// a number when it is a genuine cap the customer can hit.
function optionCardinality(g: { required: boolean; min_select: number; max_select: number; choices: unknown[] }): string {
  const n = g.choices.length;
  const capped = g.max_select > 1 && n > 0 && g.max_select < n;
  if (g.required) {
    if (g.max_select <= 1) return "required, pick 1";
    if (capped) return `required, pick ${g.min_select}-${g.max_select}`;
    return g.min_select > 1 ? `required, pick at least ${g.min_select}` : "required, pick 1 or more";
  }
  if (g.max_select <= 1) return "optional";
  return capped ? `optional, pick up to ${g.max_select}` : "optional, pick any number";
}

function buildSystemPrompt(
  shop:           Shop,
  phase:          OrderPhase,
  menu:           EffectiveMenuItem[],
  cart:           AnyCartItem[],
  currentTime:    string,
  isFirstMessage: boolean,
  notes?:         string | null,
  priorLinkExpired = false,
  soldOutNames:   string[] = [],
  orderTypeStr?:  string | null,
  deliveryAddress?: Record<string, unknown> | null,
  driverTipCents?: number | null,
  deliveryFeeCents?: number | null,
  deliveryEnabled?: boolean,
  testMode?: boolean,
  deliveryGeoAvailable?: boolean,
): string {
  const today = getBusinessDayKey(shop.timezone);
  const hours = dayWindows(shop.open_hours?.[today]);
  const hoursStr = hours.length > 0
    ? hours.map((h: { open: string; close: string }) => `${h.open}-${h.close}`).join(", ")
    : "Hours not specified";

  const cartStr = cart.length === 0
    ? "Empty"
    : cart.map(i => {
        if ((i as BundleItem).type === "bundle") {
          const b = i as BundleItem;
          const filled = b.selections.reduce((s, sel) => s + sel.quantity, 0);
          if (b.complete) {
            const detail = b.selections.map(s => `${s.quantity}x ${s.flavor}`).join(", ");
            return `${b.name} [${detail}] - $${(b.price_cents / 100).toFixed(2)}`;
          }
          return `[ACTIVE BUNDLE] ${b.name}: ${filled} of ${b.target} selected. Selections so far: ${b.selections.map(s => `${s.quantity}x ${s.flavor}`).join(", ") || "none"}`;
        }
        const r = i as CartItem;
        const mods = r.modifiers?.length > 0 ? ` [${r.modifiers.join(", ")}]` : "";
        const opts = r.options ? ` [${Object.entries(r.options).map(([_k, v]) => v.join(', ')).join(', ')}]` : "";
        const qty = r.quantity || 1;
        // NOT a validated menu selection — never priced, never phrased as "noted"/selected.
        const unverified = r.unverified_requests?.length
          ? ` [customer asked for: ${r.unverified_requests.join(", ")} (not a menu option — unconfirmed, pass to shop)]`
          : "";
        return `${qty}x ${r.name}${mods}${opts}${unverified} - $${((r.price_cents * qty) / 100).toFixed(2)}`;
      }).join("\n");
  const subtotal = cart.reduce((s, i) => {
    if ((i as BundleItem).type === "bundle") {
      return s + ((i as BundleItem).complete ? (i as BundleItem).price_cents : 0);
    }
    const r = i as CartItem;
    return s + (r.price_cents * (r.quantity || 1));
  }, 0);

  const menuByCategory: Record<string, EffectiveMenuItem[]> = {};
  for (const item of menu) {
    const cat = item.category ?? "Other";
    if (!menuByCategory[cat]) menuByCategory[cat] = [];
    menuByCategory[cat].push(item);
  }
  // Detect same-name across categories for disambiguation in prompt.
  const nameAppearances = new Map<string, number>();
  for (const [, items] of Object.entries(menuByCategory)) {
    for (const item of items) {
      const norm = item.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      nameAppearances.set(norm, (nameAppearances.get(norm) || 0) + 1);
    }
  }
  const duplicatedNames = new Set([...nameAppearances.entries()].filter(([,c]) => c > 1).map(([n]) => n));

  const menuStr = Object.entries(menuByCategory)
    .map(([cat, items]) => {
      const rows = items.map(item => {
        const norm = item.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        const label = duplicatedNames.has(norm)
          ? `${item.name} (${cat})`
          : item.name;
        const price = `$${(item.price_cents / 100).toFixed(2)}`;
        const desc  = item.description ? ` - ${item.description}` : "";
        const groups = item.option_groups || [];
        if (groups.length > 0) {
          const groupLines = groups.map(g => {
            const reqLabel = optionCardinality(g);
            return `    → ${g.name} (${reqLabel}): ${g.choices.map(c => c.name + (c.is_default ? ' [default]' : '') + (c.price_cents > 0 ? ` +$${(c.price_cents/100).toFixed(2)}` : '')).join(', ')}`;
          }).join('\n');
          return `  ID:${item.id} | ${label} ${price}${desc}\n${groupLines}`;
        } else {
          const mods = item.modifiers_json?.map(m => m.name).join(", ") ?? "";
          // The importer knew this item needs a choice but never captured WHAT
          // the choices are. Say that a choice is REQUIRED and that the list is
          // unknown, so the bot asks instead of inventing one. Deliberately
          // phrased with no examples: any example becomes the answer it recites.
          const ask = (!mods && item.prompt_for)
            ? ` | REQUIRES A CHOICE: ${item.prompt_for} - the available choices are NOT recorded. ASK the customer; never state or guess a list.`
            : "";
          return `  ID:${item.id} | ${label} ${price}${desc}${mods ? ` | Options: ${mods}` : ""}${ask}`;
        }
      }).join("\n");
      return `${cat}:\n${rows}`;
    })
    .join("\n\n");

  // The compliance disclosure is NOT the model's job. It used to be instructed
  // here, and the model placed it wherever it liked — on 2026-09-05 a tester's
  // very first reply began "Msg & data rates may apply. Reply HELP for help or
  // STOP to unsubscribe." before any content, and another began mid-sentence at
  // "to unsubscribe." It is now stripped from model output unconditionally and
  // appended deterministically, last, once, on first contact only. See the
  // append site near the end of the request handler.
  const complianceNote = isFirstMessage
    ? "\n\nCOMPLIANCE NOTE: Do NOT write any 'Msg & data rates' or 'Reply HELP/STOP' text yourself. The system appends the required disclosure automatically."
    : "";

  // SYNCHRONOUS expired-link nudge (lead directive 2026-06-22). This is added
  // to the prompt ONLY because the customer just texted us again (a fresh
  // inbound). We never PUSH an expired notice; we only mention it inline in a
  // reply the customer's own message triggered.
  const expiredNote = priorLinkExpired
    ? "\n\nEXPIRED LINK CONTEXT: The customer's previous payment link expired. Since they just messaged again, gently let them know that link expired and ask if they want to reorder, then help them start fresh."
    : "";

  // A shop that cannot take a delivery order must never be asked to choose one.
  // Vito's has delivery_enabled=true but no delivery radius, so DELIVERY
  // AVAILABLE below said "No — pickup only" while this line said "REQUIRED: ask
  // pickup or delivery?". The model obeyed whichever it read last, so the very
  // first reply a tester saw was a coin flip between "we're pickup only" and
  // "pickup or delivery today?" — for the same shop, in the same minute. Two
  // instructions that contradict each other are one instruction the bot ignores.
  const canActuallyDeliver = deliveryEnabled === true && deliveryGeoAvailable !== false;
  const orderTypeInfo = orderTypeStr === "delivery"
    ? `\nORDER TYPE: Delivery`
    : orderTypeStr === "pickup"
      ? `\nORDER TYPE: Pickup`
      : canActuallyDeliver
        ? `\nORDER TYPE: Not chosen. REQUIRED: In your response, ask the customer \"pickup or delivery?\" Do NOT proceed without asking.`
        : `\nORDER TYPE: Pickup — this shop cannot take delivery orders right now, so there is nothing to choose. Do NOT ask \"pickup or delivery?\". Mention pickup once, in passing, and keep the order moving.`;

  const deliveryInfo = deliveryAddress
    ? `\nDELIVERY ADDRESS: ${(deliveryAddress as Record<string,unknown>).formatted || JSON.stringify(deliveryAddress)}`
    : "";

  const tipInfo = driverTipCents && driverTipCents > 0
    ? `\nDRIVER TIP: $${(driverTipCents / 100).toFixed(2)}`
    : "";

  const deliveryFeeInfo = deliveryFeeCents && deliveryFeeCents > 0
    ? `\nDELIVERY FEE: $${(deliveryFeeCents / 100).toFixed(2)} (added at checkout)`
    : "";

  const deliveryAvail = (() => {
    if (deliveryEnabled !== true) {
      return `\nDELIVERY AVAILABLE: No — this shop is pickup only. Never offer delivery.`;
    }
    if (deliveryGeoAvailable === false) {
      return `\nDELIVERY AVAILABLE: No — delivery is temporarily unavailable while we finalize our delivery zone. Please order for pickup only. Never offer delivery.`;
    }
    return `\nDELIVERY AVAILABLE: Yes — the customer can choose delivery or pickup.`;
  })();

  // WING POLICY (2026-09-04). Collected by onboarding-save and, until now, never
  // read by chat-sms - so a bot told a customer "You can mix and match!" with no
  // basis at all. Emitted ONLY when the owner actually set a value. Unset stays
  // silent so the OPTION GROUNDING rules make the bot ask; the alternative -
  // treating the column default false as policy - would have the bot telling
  // every shop's customers that mixing costs extra, which is equally invented.
  const wingIncluded = shop.wing_flavors_included;
  const wingMixExtra = shop.wing_mix_extra;
  const wingPolicy = (() => {
    const lines: string[] = [];
    if (typeof wingIncluded === "number" && wingIncluded > 0) {
      lines.push(wingIncluded === 1
        ? `one flavor is included per order of wings`
        : `up to ${wingIncluded} flavors are included per order of wings`);
    }
    if (wingMixExtra === true) lines.push(`splitting an order across flavors costs extra`);
    else if (wingMixExtra === false && typeof wingIncluded === "number") {
      lines.push(`splitting an order across flavors costs nothing extra`);
    }
    if (lines.length === 0) {
      return `\nWING POLICY: NOT CONFIGURED for this shop. You do NOT know how many flavors are included, or whether an order can be split across flavors. Do NOT tell the customer they can mix and match, and do NOT tell them they cannot. Ask the customer what they want, add it, and move on. Do NOT say you will check with the kitchen - you cannot check with anyone.`;
    }
    return `\nWING POLICY (authoritative, from this shop's settings): ${lines.join("; ")}. Do not state any wing policy beyond this.`;
  })();

  const testModeDirective = testMode
    ? `\nTEST MODE: Ignore all business-hours restrictions — allow ordering at any time. Do NOT refuse orders based on the current time or TODAY'S HOURS.`
    : "";

  return `You are the ordering assistant for ${shop.name}. Help customers order for pickup or delivery via text.

You are replying by SMS text message. Plain text only. Never use markdown, tables, headings, or bullet points of any kind - no hyphens, asterisks, or numbers starting a line, and never put each item on its own line. Write lists inline in a sentence, the way a person texts: "Large cheese pizza, french fries, and bone-in wings (hot)". Keep replies under about 300 characters. Write the way a person texts.

CURRENT PHASE: ${phase}
CURRENT TIME: ${currentTime}
TODAY'S HOURS: ${hoursStr}${deliveryAvail}${orderTypeInfo}${deliveryInfo}${deliveryFeeInfo}${tipInfo}${wingPolicy}

AVAILABLE MENU:
${menuStr}
${soldOutNames.length > 0 ? `\nSOLD OUT TODAY (do not offer these, but if a customer asks, tell them we're temporarily out): ${soldOutNames.join(", ")}\n` : ""}${shop.ai_instructions ? `\nSPECIAL INSTRUCTIONS (HIGHEST PRIORITY, follow these exactly):\n${shop.ai_instructions}\n` : ""}${testModeDirective}
PRECEDENCE RULE: The structured fields above (DELIVERY AVAILABLE, TODAY'S HOURS, ORDER TYPE) are authoritative and override any conflicting statements in SPECIAL INSTRUCTIONS. If SPECIAL INSTRUCTIONS says "we do not deliver" but DELIVERY AVAILABLE says "Yes", delivery IS available — follow the structured field. ITEM-NAME PRECEDENCE: The AVAILABLE MENU is authoritative for item NAMES and PRICES. If SPECIAL INSTRUCTIONS (or ai_instructions) reference an item by a name or unit that does not match the AVAILABLE MENU exactly (e.g. "a tub of cream cheese" when the menu lists "Cream Cheese Spread (per pound)"), use the menu's real item name and unit — e.g. offer "Cream Cheese Spread (per pound)", not "a tub". The menu is the single source of truth for what items exist and what they cost.
${shop.shop_context ? `\nBackground information about this shop (use to answer customer questions about the business, NOT for ordering): ${shop.shop_context}\n` : ""}
CURRENT CART:
${cartStr}${cart.length > 0 ? `\nSubtotal: $${(subtotal / 100).toFixed(2)}\nService fee: $${(SERVICE_FEE_CENTS / 100).toFixed(2)}${deliveryFeeCents ? `\nDelivery fee: $${(deliveryFeeCents / 100).toFixed(2)}` : ""}${driverTipCents ? `\nDriver tip: $${(driverTipCents / 100).toFixed(2)}` : ""}\nOrder total: $${((subtotal + SERVICE_FEE_CENTS + (deliveryFeeCents ?? 0) + (driverTipCents ?? 0)) / 100).toFixed(2)} (for your reference only — do NOT quote in your reply)` : ""}
${notes ? `\nORDER NOTES: ${notes}` : ""}

RULES:
- Keep ALL responses under 300 characters for SMS
- MONEY/SCOPE RULE (CRITICAL): NEVER state a total, subtotal, service fee, delivery fee, tip amount, item count, or dollar figure in your response. The system appends the correct numbers from the Ledger automatically. If you need to summarize the cart, say "I've got your items" without listing how many. When asking for the customer's name, say "What's your name for the order?" without quoting a total. When confirming before submit_order, say "All good — confirm?" without restating the price. The numbers BELOW in the CURRENT CART section are for YOUR reference only — do NOT quote them in your reply.
- Only use item IDs exactly as shown in the menu (the ID: prefix is part of the ID)
- Never add items not in the available menu
- SOLD OUT ITEMS: If a customer asks for an item that is listed as SOLD OUT TODAY, tell them we're temporarily out of it today (e.g., "We're actually out of Everything bagels today — sorry about that!"). Do NOT say the item doesn't exist or isn't on the menu. Suggest alternatives if available.
- Never use em dashes in responses
- When cart has items and customer says they are done or asks to check out, ask for the customer's name. Do NOT restate every item in the cart — they just built it, they know what's in it. Do NOT quote a total (the system adds it). Ask it EXACTLY like this, for pickup AND delivery orders alike: "What's your name for the order?"
- When confirming before submit_order, just say "Confirm?" — not the full itemised receipt and do NOT quote a total
- Only call submit_order after the customer explicitly confirms (e.g., "yes", "confirm", "that's it", "place order")
- Be friendly but concise — every character over 160 costs a segment
- SERVICE FEE: A $0.99 service fee is added to every order. The system automatically displays it with the total and checkout link — you do NOT need to state or calculate it. Never quote any dollar amount in your reply.
- OFF-MENU ITEMS: If a customer asks for an item that is NOT on the available menu, politely tell them it is not available and suggest similar items that ARE on the menu. NEVER call clear_cart when handling an off-menu request. NEVER remove items already in the cart. Off-menu requests only get a polite "sorry, we don't have that" — nothing more.
- CLEAR_CART RESTRICTION (CRITICAL): NEVER call clear_cart unless the customer explicitly asks to cancel, restart, or start a new order. Words like "also", "add another", "and a", "can I also get", "let me also", "I also want" are ADDITIVE — they mean ADD to the existing cart, not replace it. Calling clear_cart when the customer asks to add more items will DESTROY their existing order. Only call clear_cart for explicit cancel/restart messages.
- SAFE WORDS: At every decision point where a customer might want to abandon or change something, offer CHANGE to modify or RESTART to begin again. NEVER use the word "cancel" in a prompt or instruction — if a customer cancels, offer CHANGE or RESTART as the alternative.
- CUSTOMER QUESTIONS (CRITICAL): ALWAYS answer a direct question from the customer explicitly before or alongside advancing the order. If they ask whether you carry an item or category (e.g. "do you have coffee?", "any hot drinks?", "got lattes?"), answer plainly — "We don't carry coffee, sorry" — no matter how many times they've already asked. A question is NEVER an order-completion signal. If the customer asks a question and also says they're done, declines something, or lists more items, answer the question FIRST, then handle the rest. NEVER reply with "what else can I add?" or ask for the pickup name while an unanswered question is on the table. If the customer asks about an entire category you don't carry (coffee, hot drinks, desserts), decline the category clearly (e.g. "We don't carry any coffee or hot drinks — just bagels and sandwiches") — don't fixate on one item.
- ITEM AVAILABILITY: Every item in the AVAILABLE MENU is in stock and orderable unless it appears in the SOLD OUT TODAY list. NEVER tell a customer an item is "out of stock," "unavailable," or "we don't have that" unless it is in the SOLD OUT TODAY list. If a customer asks for an item and it is in the menu, it is available — add it.
- QUANTITY PARSING: When a customer says a number followed by an item (e.g., "2 BOBO sandwiches", "3 everything bagels"), add the item with that quantity in a single add_item call with quantity set to that number. Do NOT add the item multiple times.
- QUANTITY REDUCTION (CRITICAL): When a customer wants to reduce the quantity of an item already in the cart (e.g. "actually just one", "make it 1", "only one please", "change it to 1", "reduce to 1", "I only want one"), you MUST call modify_item with the new quantity — NOT add_item. add_item ADDS to the existing quantity; it will make the cart LARGER, not smaller. modify_item SETS the quantity. For complete removal (customer says "remove it", "take it off", "cancel the X"), use remove_item instead. NEVER call add_item when the intent is to decrease or remove.
- CRITICAL MULTI-ITEM RULE: Process the ENTIRE customer message in ONE turn. When a customer lists multiple items in a single message (e.g. "plain bagel with butter, everything bagel with cream cheese, and a coffee"), use MULTIPLE add_item tool calls in the same turn to add ALL items at once. Do NOT pick only the first item and ignore the rest. Do NOT reply with "I didn't catch that" or "can you repeat that" when items are clearly listed — ADD THEM ALL. If an item needs a modifier or option you don't have yet (e.g. bread choice), add what you can and ask about what you're missing. Never silently drop items. PARTIAL ACCEPTANCE: When a multi-item message contains some items that ARE on the menu and some that are NOT, add the valid items via add_item AND explicitly tell the customer which items aren't available with a brief, polite explanation. NEVER invent off-menu items — only suggest alternatives that are actually on the menu. NEVER reject the entire message just because one item isn't on the menu.
- PICKUP NAME RULE (CRITICAL): When you ask for a pickup name and the customer's VERY NEXT message is a name ("Jason", "Mike", "Sarah"), call submit_order with that name IMMEDIATELY. Do NOT ask "is that your name?" Do NOT ask for confirmation. A single word or short name after asking for a pickup name is ALWAYS the pickup name. Just submit the order.
- EARLY ORDER TYPE GATE (DELIVERY-AVAILABLE SHOPS — CRITICAL): When DELIVERY AVAILABLE is "Yes" and the cart is empty and no order type has been chosen yet, your first response MUST ask whether the customer wants pickup or delivery. CRITICAL EXCEPTION: if the customer's FIRST message already names recognizable menu item(s), you MUST call add_item for those items AND ask pickup/delivery IN THE SAME RESPONSE. Both things — item in cart + delivery question — must happen in one turn. Example: "Got it — one Special Stromboli added. Are you ordering pickup or delivery today?" Do NOT silently default to pickup when items were named; the customer must be asked. Only if the customer explicitly says "pickup" (or ignores the delivery question twice while continuing to order) may you default to pickup and proceed. If they say "delivery": call set_order_type("delivery") then IMMEDIATELY ask for the delivery address — collect the address BEFORE they order anything else. The system will check the zone automatically. If the set_delivery_address result says they're outside the delivery area, warmly offer pickup instead (the item stays in the cart — do NOT remove it). This ONLY applies when DELIVERY AVAILABLE is "Yes"; pickup-only shops never ask this question.
- DELIVERY FLOW: Only offer delivery when DELIVERY AVAILABLE is "Yes" above. If it is "No", never offer delivery — this shop is pickup only. Phrase any delivery decline as PERMANENT ("we're pickup only" / "we don't offer delivery") — never imply it's temporary; do NOT say "right now", "at the moment", or "currently". When delivery IS available and the customer asks about delivery in ANY way, answer with a clear YES and offer to take their address. Once they confirm delivery, call set_order_type("delivery"), then collect the address. Once the address is set and accepted, offer an optional driver tip. Do NOT ask for delivery address for pickup orders.
- ADDRESS COLLECTION: Ask for the delivery address naturally like a real shop — don't present a form. Example: "Where should we bring it?" Get street, city, state, and zip. Apt/unit is optional. Once you have all required fields, call set_delivery_address. Validate that the zip looks like a 5-digit US zip before calling.
- DRIVER TIP: After the address is set, ask once: "Would you like to add a tip for your driver?" Offer simple options: $1, $2, $3, or $5. If they pick one, call set_driver_tip. If they say no or skip, move on. Do NOT badger them.
- SANDWICH MAPPING: "Bacon egg and cheese" = BOBO Sandwich (Bacon). "Sausage egg and cheese" = SOBO Sandwich. "Ham egg and cheese" = HOBO Sandwich. "Pork roll egg and cheese" = PROBO Sandwich. "Turkey bacon egg and cheese" = TBOBO Sandwich. These all come on a bagel by default. If a customer asks for one of these, add the matching item immediately. Do NOT say "I don't see that on the menu."
- MULTI-ITEM FOCUS: When a customer asks for multiple items in sequence, process EACH one fully before moving on. If you said you're adding something, USE THE TOOL to actually add it. Never claim you added something without calling add_item. If add_item fails, tell the customer the specific error.
- CRITICAL BUNDLE RULE: When a customer says "a dozen", "I'll take a dozen", "dozen bagels", "half dozen", etc., you MUST call start_bundle IMMEDIATELY in that same turn. Do NOT just acknowledge it in text. You MUST use the tool. "I'll take a dozen" = call start_bundle with bundle_item_name="One Dozen Bagels", bundle_size=14, bundle_price_cents=1500. "half dozen" = call start_bundle with bundle_item_name="Half Dozen Bagels", bundle_size=6, bundle_price_cents=750.
- If the customer also provides flavors in the same message, call start_bundle THEN add_to_bundle for each flavor -- all in one turn. If they just say "a dozen" without flavors, call start_bundle and then ask for flavors.
- Example 1: "I'll take a dozen" → call start_bundle(bundle_item_name="One Dozen Bagels", bundle_size=14, bundle_price_cents=1500), then reply asking for flavors.
- Example 2: "I want a dozen bagels -- 6 plain, 3 everything, 2 jalapeno, 3 sesame" → call start_bundle, then add_to_bundle for each flavor. All in one turn.
- When a bundle is active and the customer provides flavors, call add_to_bundle for EACH flavor immediately. Do NOT ask for clarification. If they say "7 sesame and 7 plain" and a dozen bundle is active, that is 14 bagels which completes the dozen. Just add them.
- While a bundle is active, you may ONLY use add_to_bundle, cancel_bundle, or clear_cart. Do not call add_item or submit_order until the bundle is complete or cancelled.
- OPTION GROUNDING (CRITICAL - covers flavors, sauces, dressings, toppings, cheeses, breads, sizes, formats, and every other choice): You may ONLY name a specific option if that exact option appears in THIS item's own menu entry above - in its "Options:" list, its option groups, or spelled out in its own description. If the item's entry does not enumerate the choices, you DO NOT know them. Do not assemble a list from other items, other categories, sauces used elsewhere on the menu, or general knowledge of what restaurants usually offer. Naming an option the shop did not list is inventing a product: the kitchen cannot make it, and the customer was promised it in the shop's name.
- WHEN YOU DO NOT KNOW THE CHOICES: say so plainly and ask - never guess, never imply a list exists, and never offer to go find out. Do NOT offer "examples" of what the options might be either ("like buffalo, BBQ, something else?"); to a customer an example reads as availability, and it is the same invented promise in softer words. Ask an open question instead. Good: "What flavor would you like on those?" or "I don't have the dressing list for that one - what were you thinking?" Never: "We've got Hot, Mild, BBQ, and Sweet & Spicy", and never "like buffalo or BBQ", when the menu entry does not list them.
- NEVER CLAIM AN ACTION YOU DO NOT TAKE (CRITICAL): you can do exactly two things - read the menu above and call the tools listed below. You cannot check with the kitchen, ask the owner, ask anyone, look anything up, call, walk back, confirm with staff, or go find out and come back. Never say or imply that you will. Banned in every wording: "let me check", "I'll check with the kitchen", "let me ask", "I'll find out", "let me confirm", "let me look that up", "one moment", "give me a sec", "I'll get back to you", "hold on while I". When you do not know something, say you do not know it and ask the customer in the same breath, then keep the order moving. Good: "I don't have the flavor list for these - what flavor would you like?" Never: "Let me check with the kitchen on which ones we have." Inventing an action is the same lie as inventing an option, and worse, because it is a lie about yourself. The one thing you may promise is what the tools actually do: adding an item, saving a note, sending the payment link.
- NEVER NARRATE A TECHNICAL FAILURE TO THE CUSTOMER: if a tool call comes back with an error, that is between you and the system. A customer ordering dinner has no use for "that's giving me a system hiccup", "there's a glitch on my end", "an error came back", or "the system won't let me". Say the plain human version instead - "I can't add the large cheese right now" - and immediately offer the closest real thing on the menu. Never invent a technical excuse for something you simply could not find.
- NEVER STATE SHOP POLICY YOU WERE NOT TOLD: whether flavors can be mixed or split across an order, whether substitutions are allowed, whether extras cost more, minimums, or timing. If a policy is not given to you above, do not assert it in either direction. Say plainly that you do not have it and ask the customer what they want. "You can mix and match!" is a promise the kitchen may not be able to keep.
- Never state the NUMBER of available flavors or menu items ("we have 12 flavors"). If the item's entry does list its options, you may name them, without counting.
- NEVER suggest switching from a larger bundle to a smaller one. If the count does not match, tell the customer how many slots remain.
- NEVER ask "are you ordering individual bagels or a bundle?" If the customer already said "a dozen" or you started a bundle, they are ordering a bundle. Period.
- REQUIRED OPTIONS: When adding an item that has REQUIRED option groups (marked "required" in the menu above), call add_item IMMEDIATELY for the item — even if you don't yet know the required option. The system will accept the item and store the missing option as pending. In the SAME reply, casually ask the customer for the missing choice(s) — e.g. "What kind of meat on that gyro — beef or chicken?" The item is already in the cart at its base price; the option surcharge applies once chosen. If the customer already specified their choice in the same message (e.g. "bacon egg and cheese on a roll"), include it in the add_item call without asking.
- OPTIONAL OPTIONS: For optional groups (like condiments), ask AFTER the required choices are settled. Keep it brief: "Salt, pepper, or ketchup?" If the customer says "nothing" or moves on, skip it.
- OPTIONS IN add_item: When calling add_item for an item with option groups, pass the selections in the "options" parameter as an object like {"Bread Type": ["Roll"], "Condiments": ["Salt", "Pepper"]}. Keys must match the option group names exactly as shown in the menu.
- EXACT-NAME MATCHING: When a customer orders a menu item by its EXACT name (e.g. "Pumpernickel Bagel", "Everything Bagel", "Bagel with Jelly"), acknowledge it and add it immediately. Do NOT ask about cream cheese, butter, or other add-ons that are SEPARATE menu items in the "Bagel With" or "Cream Cheese Spread" categories. A plain bagel is a complete order at its listed price. Only ask about add-ons if the customer explicitly asks for a variation ("with cream cheese") or if the item has modifiers the customer must choose.
- COMBO ITEMS: Items in the "Bagel With" category (e.g. "Bagel with Plain Cream Cheese", "Bagel with Flavored Cream Cheese", "Bagel with Jelly", "Bagel with Butter") ALREADY INCLUDE the bagel and are COMPLETE standalone items at their listed price. Do NOT add a standalone bagel AND a "Bagel With" item separately. Do NOT ask for a base bagel flavor for "Bagel With" items — just add them directly. When a customer says "cinnamon raisin bagel with cream cheese", add ONE item from "Bagel With" (e.g. "Bagel with Plain Cream Cheese" at $3.50) and note the bagel flavor choice. NEVER double-charge by adding a standalone bagel plus a spread item.
- BAGEL WITH PRICING: Every "Bagel With" item's listed price is the COMPLETE price for that bagel-and-spread combination, no matter how low the price. "Bagel with Jelly" at $0.75 is a full standalone item — it is NOT an add-on or surcharge. The phrase "(additional charge)" in descriptions is internal menu wording; ignore it for classification. The price column is authoritative: if an item has its own row and price in the menu, it is a complete standalone item. Add it directly — never ask for a base bagel flavor.
- UPSELL GUARD: When suggesting upsells, ONLY suggest items that exist in the AVAILABLE MENU above. Never invent items or use language not in the menu (do not say "tub", "pint", "side container" unless the menu uses those exact words). Use menu item names exactly as shown.
- MODIFIER GROUNDING (CRITICAL): Only offer a format, bread, or size choice (bagel vs flagel vs wrap; plain/wheat/spinach/tomato-basil; small/large; etc.) for an item when THAT EXACT item's menu entry lists those as selectable options for it. Do NOT assume a sandwich, platter, salad, or any item can be made on a flagel, wrap, or alternate bread — or in another size — unless the menu explicitly lists that choice for that item. Flagels and wraps existing elsewhere on the menu does NOT mean another item can be upgraded to them. When an item has no listed options, add it exactly as named at its listed price and do NOT invent upgrade paths or ask "want it on a flagel or wrap?".
- CREAM CHEESE DISAMBIGUATION: This menu has TWO types of cream cheese products. (1) "Bagel With" items -- a single bagel WITH cream cheese already on it. (2) "Cream Cheese Spread (per pound)" -- a full pound of cream cheese to take home. If a customer just says "cream cheese" after ordering bagels, ask ONE time: "Do you want cream cheese on a bagel ($3.50-$4.95) or a pound of cream cheese spread to go ($10.95-$13.95)?" Then REMEMBER their answer. NEVER ask again. If they say "by the pound" or "a pound" at ANY point, they want the Spread. Use add_item immediately. When adding a "Bagel With" item that has cream cheese variants (Plain, Flavored, etc.), if the customer did NOT specify which variant, ask which one they want BEFORE adding. NEVER assume a variant.
- CONTEXT MEMORY: Pay close attention to what the customer said in previous messages. If they already told you what type/flavor they want, do NOT ask again. If they said "jalapeno cheddar" two messages ago, you KNOW the flavor. Do not lose track.
- TOASTED PROMPT: After adding a "Bagel With" item (cream cheese bagel) or a breakfast sandwich, if the customer has NOT already mentioned toasting preference, ask: "Want that toasted?" Keep it casual and brief, just like a real bagel shop counter. If they already said "toasted" or "not toasted" in their message, do NOT ask -- just note it. Only ask ONCE per order, not for every item. Do NOT ask about toasting for bundle orders (dozen, half dozen, baker's dozen) or standalone plain bagels -- those are take-home items.
- PREP INSTRUCTIONS: When a customer says "toasted", "scooped", "extra toasted", "lightly toasted", "cut in half", "extra cream cheese", "light butter", or any other preparation preference, call set_note to save it. These instructions go directly to the kitchen. NEVER tell the customer to "let the shop know" -- YOU are the shop. Capture it and confirm: "Got it, noted toasted." If they mention prep preferences along with items, add the items AND set the note in the same turn.

PHASE BEHAVIOR:
- greeting/building: Help build the order, answer menu questions
- checkout: Payment link was sent. Remind them to check their text or email for the payment link.
- confirmed: Order is confirmed and paid. Thank them and give pickup info.
- expired: Their payment link expired. Ask if they want to restart.${expiredNote}${complianceNote}`;
}

// ─── Haversine distance in miles ────────────────────────────────────────────

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ─── Tool executor ────────────────────────────────────────────────────────────

async function executeTool(
  toolName:  string,
  input:     Record<string, unknown>,
  cart:      AnyCartItem[],
  menu:      EffectiveMenuItem[],
  cartId:    string,
  supabase:  SupabaseClient,
  shopName:  string,
  testMode:  boolean = false,
  deliveryFeeCents?: number | null,
  shopGeo?: { lat: number; lng: number; radiusMi: number } | null,
  // Item 8 (spec §7/§11 item 8). All three default to falsy/undefined at
  // every existing call site except the main tool loop in runOrderingLoop —
  // so every OTHER caller of executeTool (remove_item/modify_item/
  // submit_order call sites elsewhere in this file) is unaffected by this
  // param addition, and add_item itself is a no-op change unless
  // compiledEngineEnabled is true AND the target item has a compiled
  // ask_plan (see the branch at the top of the "add_item" case below).
  compiledEngineEnabled?: boolean,
  customerMessage?: string,
  shopPhone?: string | null,
): Promise<{ ok: boolean; result: unknown; checkoutUrl?: string; newPhase?: OrderPhase }> {
  const menuMap = new Map(menu.map(m => [m.id, m]));

  // Guard: while a bundle is active, only allow bundle/cart tools
  const activeBundle = cart.find(i => (i as BundleItem).type === "bundle" && !(i as BundleItem).complete) as BundleItem | undefined;
  if (activeBundle && !["add_to_bundle", "cancel_bundle", "clear_cart"].includes(toolName)) {
    const filled = activeBundle.selections.reduce((s, sel) => s + sel.quantity, 0);
    return { ok: false, result: { error: `A bundle is in progress: ${activeBundle.name} (${filled} of ${activeBundle.target} selected). Finish or cancel the bundle before using ${toolName}.` } };
  }

  switch (toolName) {
    case "add_item": {
      const { menu_item_id, quantity = 1, modifiers = [] } = input as {
        menu_item_id: string; quantity?: number; modifiers?: string[];
      };
      const menuItem = menuMap.get(menu_item_id);
      if (!menuItem) {
        return { ok: false, result: { error: `Item ID "${menu_item_id}" not found in the available menu. Use an exact ID from the menu list.` } };
      }

      // ── Item 8: compiled ordering engine (spec §7/§11 item 8) ──────────
      // Gate: shop flag AND this item has actually been compiled (non-null
      // ask_plan). Both are false for every item at every shop today (see
      // BLOCKED.txt PIVOT entry, 2026-09-07) — this branch is provably
      // unreachable until a shop is explicitly flagged in the DB AND its
      // menu has been compiled. Vito's is never flagged; nothing below this
      // block (the entire legacy path) is touched by this change. Logic
      // lives in ask-plan-engine.ts's applyCompiledAddItem so it is
      // directly unit-testable rather than requiring a hand-copied mirror.
      if (compiledEngineEnabled && menuItem.ask_plan) {
        const engineOutcome = applyCompiledAddItem(
          cart as unknown as CompiledCartLine[],
          menuItem as unknown as CompiledMenuItem,
          menu_item_id,
          quantity as number,
          customerMessage ?? "",
          shopPhone,
        );
        if (engineOutcome.cartChanged) await saveCart(supabase, cartId, cart, "building");
        // BLOCKED-SUGGESTION GUARD (2026-09-07, Jason: "double burger" decline
        // suggested Burger/Cheese Burger/Zio's Deluxe Burger/Mamma Mia Burger/
        // BBQ Cheese Burger — every single Burgers item was bot_state='blocked'
        // at the time, same pending owner question affecting the whole
        // category). The model was drawing alternatives from the full menu
        // text in the system prompt, which carries no bot_state signal at all,
        // so it can only ever suggest by category coincidence, never by
        // orderability. General pattern, not Burgers-specific: whenever a
        // compiled item is declined, hand the model a REAL, code-computed list
        // of bot_state='orderable' siblings in the same category (possibly
        // empty) and tell it to use ONLY that list — never its own menu
        // recall — so a whole-category block can never surface a same-category
        // blocked item as a false alternative.
        if (!engineOutcome.ok && (engineOutcome.result as { declined?: boolean })?.declined) {
          const orderableAlternatives = menu
            .filter(m => m.category === menuItem.category && m.id !== menu_item_id && m.bot_state === "orderable")
            .map(m => m.name);
          return {
            ok: false,
            result: {
              ...(engineOutcome.result as Record<string, unknown>),
              orderable_alternatives: orderableAlternatives,
              instruction: orderableAlternatives.length > 0
                ? `Do not suggest any item name from your own menu knowledge. If offering an alternative, offer ONLY from this exact list: ${orderableAlternatives.join(", ")}.`
                : "Do not suggest any alternative item by name — nothing in this category is currently orderable by text. Only offer the phone number.",
            },
          };
        }
        return { ok: engineOutcome.ok, result: engineOutcome.result };
      }

      const validMods    = menuItem.modifiers_json?.map(m => m.name) ?? [];
      let inputMods      = (modifiers as string[]).slice();

      // Validate option groups
      const itemGroups = menuItem.option_groups || [];
      const rawOptions = ((input as any).options || {}) as Record<string, string[]>;

      // ── Normalize modifiers misrouted into `options` ──────────────────
      // The menu renders modifiers_json under "Modifiers: ...", but the model
      // occasionally passes an upgrade (e.g. "Upgrade to Flagel") as an option
      // group key instead of the `modifiers` array. Route any option key/value
      // that matches a real modifier name (and is NOT a real option group) into
      // the modifiers array so its price is summed. Otherwise the price silently
      // omits the upgrade (existential pricing bug).
      const modifierNames = new Set(validMods);
      const groupNames = new Set(itemGroups.map(g => g.name));
      const inputOptions: Record<string, string[]> = {};
      for (const [key, vals] of Object.entries(rawOptions)) {
        if (modifierNames.has(key) && !groupNames.has(key)) {
          for (const v of vals) {
            if (modifierNames.has(v) && !inputMods.includes(v)) inputMods.push(v);
          }
        } else {
          inputOptions[key] = vals;
        }
      }

      // ── Reactive modifier/topping match (bug 4, 2026-09-07) ────────────
      // "buffalo chicken pizza with pepperoni" silently dropped the topping
      // and its $3.00 price: this legacy path applies ONLY what the LLM's
      // tool call names in `modifiers`/`options`, with no fallback onto the
      // customer's own words. Catch anything the LLM's call missed by
      // matching customerMessage against real modifiers_json entries and
      // non-required option_groups' choices (toppings/add-ons — required/
      // slot-like groups such as size are untouched, they stay on the
      // existing pending/ask flow). See reactive-modifier-match.ts.
      const reactiveAlreadyNamed = new Set<string>([
        ...inputMods.map(m => m.toLowerCase()),
        ...Object.values(inputOptions).flat().map(v => v.toLowerCase()),
      ]);
      const reactiveCandidates: ReactiveCandidate[] = [
        ...(menuItem.modifiers_json ?? []).map(m => ({ groupName: null, name: m.name, price_cents: m.price_cents })),
        ...itemGroups.filter(g => !g.required).flatMap(g =>
          g.choices.map(c => ({ groupName: g.name, name: c.name, price_cents: c.price_cents }))),
      ];
      for (const m of matchReactiveExtras(reactiveCandidates, customerMessage ?? "", reactiveAlreadyNamed)) {
        if (m.groupName === null) {
          if (!inputMods.includes(m.name)) inputMods.push(m.name);
        } else {
          if (!inputOptions[m.groupName]) inputOptions[m.groupName] = [];
          if (!inputOptions[m.groupName].includes(m.name)) inputOptions[m.groupName].push(m.name);
        }
      }

      const invalidMods  = inputMods.filter(m => !validMods.includes(m));
      if (invalidMods.length > 0) {
        return { ok: false, result: { error: `Invalid modifiers: ${invalidMods.join(", ")}. Valid options for ${menuItem.name}: ${validMods.join(", ") || "none"}` } };
      }

      // Sum modifier price adjustments
      const modPriceCents = inputMods.reduce((sum, modName) => {
        const mod = menuItem.modifiers_json?.find(m => m.name === modName);
        return sum + (mod?.price_cents ?? 0);
      }, 0);

      let extraCents = 0;
      const pending: string[] = [];
      const unverifiedRequests: string[] = [];
      const defaultedGroups: string[] = [];

      // Reject/redirect option keys that are not a real option group for this
      // item — symmetric with invalidMods above. Without this, a key the
      // model invents (no group matches) sailed straight into
      // normalizedOptions and was stored as if it were a validated menu
      // selection (the Boosenberry-wings defect).
      for (const [key, vals] of Object.entries(inputOptions)) {
        if (groupNames.has(key)) continue;
        // REGRESSION FIX (2026-09-05): an item with NO option groups recorded
        // has nothing to correct toward, so a hard reject only kills a
        // legitimate add. "large cheese pizza" failed on turn 1 — the page's
        // own suggested phrase — because the model tacked a size/style key
        // onto an item with zero groups. Drop the key rather than the order;
        // it still NEVER becomes a validated selection or affects price.
        if (menuItem.prompt_for || itemGroups.length === 0) {
          // The shop flagged this item as needing a choice but never recorded
          // the valid values — don't invent a menu selection, and don't block
          // the add. Preserve the customer's own words for a human to resolve.
          const descriptor = menuItem.name.toLowerCase();
          for (const v of vals) {
            // A value the item name already states ("Size: Large (16\")" on
            // `Cheese - Large (16\")`) is redundant, not a customer request —
            // it must not land on a kitchen ticket as an unresolved ask.
            if (descriptor.includes(String(v).toLowerCase())) continue;
            unverifiedRequests.push(`${key}: ${v}`);
          }
          delete inputOptions[key];
        } else {
          const validNames = itemGroups.map(g => g.name).join(", ");
          return { ok: false, result: { error: `"${key}" is not a valid option for ${menuItem.name}. ${validNames ? `Valid option groups: ${validNames}.` : "This item has no option groups recorded."}` } };
        }
      }

      for (const group of itemGroups) {
        const selections = inputOptions[group.name] || [];
        if (group.required && selections.length === 0) {
          // DEFAULT-FILL (2026-09-06, Jason): a required group with a
          // recorded free default is applied deterministically instead of
          // left to the model — this was the source of the model picking a
          // different dressing/default across otherwise-identical orders.
          // A default that costs extra is never auto-applied (no surprise
          // charges); that case still falls through to pending below.
          const defaultChoice = group.choices.find(c => c.is_default && c.price_cents === 0);
          if (defaultChoice) {
            inputOptions[group.name] = [defaultChoice.name];
            defaultedGroups.push(`${group.name}: ${defaultChoice.name}`);
            continue;
          }
          // Required option not yet chosen — mark pending instead of rejecting.
          // Item enters cart at base price; surcharge applies when option is resolved.
          pending.push(group.name);
          continue;
        }
        if (selections.length > group.max_select) {
          return { ok: false, result: { error: `"${group.name}" allows max ${group.max_select} selection(s), got ${selections.length}.` } };
        }
        for (const sel of selections) {
          const choice = group.choices.find(c => c.name.toLowerCase() === sel.toLowerCase());
          if (!choice) {
            const validNames = group.choices.map(c => c.name).join(', ');
            return { ok: false, result: { error: `"${sel}" is not a valid choice for ${group.name}. Valid: ${validNames}` } };
          }
          extraCents += choice.price_cents;
        }
      }

      // Dedup: normalize empty options to undefined for comparison
      const normalizedOptions = Object.keys(inputOptions).length > 0 ? inputOptions : undefined;

      // PHANTOM-ADD GUARD (2026-09-06, DEFECT 1): filling in a previously-open
      // required option can never satisfy the options-equality match below —
      // the line's options go from empty to filled, which by construction
      // never equals what they were before. Without this, an add_item call
      // that answers a pending option question (the model reaching for
      // add_item instead of modify_item) spawns a brand-new line instead of
      // landing on the one waiting for it, silently doubling the cart. This
      // is the general version of whatever accidentally protects "large
      // cheese pizza" + "add pepperoni" (that path merges only because pizza
      // toppings aren't a recorded required option group, so its options
      // never diverge in the first place) — extended to cover ANY item with
      // an open required group, not just that accidental case. Filling a
      // pending group is a resolution of the SAME order, not a repeat order,
      // so quantity is left untouched here (unlike the stacking-merge branch
      // below, which intentionally adds quantities together).
      let resolvingPendingIdx = -1;
      if (Object.keys(inputOptions).length > 0) {
        resolvingPendingIdx = cart.findIndex(i => {
          const ci = i as CartItem;
          return ci.menu_item_id === menu_item_id &&
            (ci.pending_options?.length ?? 0) > 0 &&
            ci.pending_options!.some(p => (inputOptions[p]?.length ?? 0) > 0);
        });
      }

      // Match on menu_item_id + options; merge pending_options when stacking quantity
      const existing = resolvingPendingIdx >= 0 ? -1 : cart.findIndex(i =>
        (i as CartItem).menu_item_id === menu_item_id &&
        JSON.stringify((i as CartItem).options ?? undefined) === JSON.stringify(normalizedOptions)
      );
      if (resolvingPendingIdx >= 0) {
        const target = cart[resolvingPendingIdx] as CartItem;
        const mergedOptions = { ...(target.options ?? {}), ...inputOptions };
        target.options = Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined;
        target.modifiers = inputMods;
        let mergedExtraCents = 0;
        for (const group of itemGroups) {
          for (const sel of (mergedOptions[group.name] ?? [])) {
            const choice = group.choices.find(c => c.name.toLowerCase() === sel.toLowerCase());
            if (choice) mergedExtraCents += choice.price_cents;
          }
        }
        target.price_cents = menuItem.price_cents + mergedExtraCents + modPriceCents;
        const remainingPending = (target.pending_options ?? []).filter(p => !(inputOptions[p]?.length));
        target.pending_options = remainingPending.length > 0 ? remainingPending : undefined;
        const existingUnverified = target.unverified_requests ?? [];
        const mergedUnverified = [...new Set([...existingUnverified, ...unverifiedRequests])];
        target.unverified_requests = mergedUnverified.length > 0 ? mergedUnverified : undefined;
      } else if (existing >= 0) {
        (cart[existing] as CartItem).quantity += (quantity as number);
        (cart[existing] as CartItem).modifiers = inputMods;
        (cart[existing] as CartItem).price_cents = menuItem.price_cents + extraCents + modPriceCents;
        // Merge pending_options — resolve any that now have selections
        const existingPending = (cart[existing] as CartItem).pending_options || [];
        const mergedPending = [...new Set([...existingPending, ...pending])].filter(
          p => !(inputOptions[p] && inputOptions[p].length > 0)
        );
        (cart[existing] as CartItem).pending_options = mergedPending.length > 0 ? mergedPending : undefined;
        const existingUnverified = (cart[existing] as CartItem).unverified_requests || [];
        const mergedUnverified = [...new Set([...existingUnverified, ...unverifiedRequests])];
        (cart[existing] as CartItem).unverified_requests = mergedUnverified.length > 0 ? mergedUnverified : undefined;
      } else {
        cart.push({ menu_item_id, name: menuItem.name, quantity: quantity as number, price_cents: menuItem.price_cents + extraCents + modPriceCents, modifiers: inputMods, options: normalizedOptions, pending_options: pending.length > 0 ? pending : undefined, unverified_requests: unverifiedRequests.length > 0 ? unverifiedRequests : undefined });
      }
      await saveCart(supabase, cartId, cart, "building");
      const total = cart.reduce((s, i) => s + (i as CartItem).price_cents * (i as CartItem).quantity, 0);
      const notes: string[] = [];
      if (unverifiedRequests.length > 0) {
        notes.push(`${unverifiedRequests.join(", ")} could not be verified against this item's menu options and was NOT recorded as a selection — it was saved only as an unverified customer request for the shop to confirm. Do not tell the customer it was selected/noted as a menu choice; say it will be passed along to the shop for confirmation, or ask them to choose once options are available.`);
      }
      if (defaultedGroups.length > 0) {
        notes.push(`${defaultedGroups.join(", ")} defaulted automatically (no charge) since the customer didn't specify — mention this casually in your reply (e.g. "I put the usual ranch on that") and let them change it if they'd like.`);
      }
      return {
        ok: true,
        result: {
          added: menuItem.name,
          quantity,
          cart_total: `$${(total / 100).toFixed(2)}`,
          ...(unverifiedRequests.length > 0 ? { unverified_requests: unverifiedRequests } : {}),
          ...(defaultedGroups.length > 0 ? { defaulted_options: defaultedGroups } : {}),
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
        },
        newPhase: "building",
      };
    }

    case "remove_item": {
      const { menu_item_id } = input as { menu_item_id: string };
      const idx = cart.findIndex(i => (i as CartItem).menu_item_id === menu_item_id);
      if (idx < 0) return { ok: false, result: { error: "Item not found in cart." } };
      const removed = (cart[idx] as CartItem).name;
      cart.splice(idx, 1);
      await saveCart(supabase, cartId, cart, "building");
      return { ok: true, result: { removed } };
    }

    case "modify_item": {
      const { menu_item_id, quantity, modifiers, options } = input as {
        menu_item_id: string; quantity?: number; modifiers?: string[]; options?: Record<string, string[]>;
      };
      const idx = cart.findIndex(i => (i as CartItem).menu_item_id === menu_item_id);
      if (idx < 0) return { ok: false, result: { error: "Item not in cart." } };
      if (quantity !== undefined) (cart[idx] as CartItem).quantity = quantity;
      const menuItem = menuMap.get(menu_item_id);
      const validMods = menuItem?.modifiers_json?.map(m => m.name) ?? [];
      const modifierNames = new Set(validMods);
      let newModifiers = (modifiers ?? (cart[idx] as CartItem).modifiers ?? []).slice();
      let newOptions = options ?? (cart[idx] as CartItem).options;
      let newUnverified = (cart[idx] as CartItem).unverified_requests ?? [];
      let unverifiedNote: string | undefined;
      if (options !== undefined) {
        const groupNames = new Set((menuItem?.option_groups || []).map(g => g.name));
        // Seed with existing valid group selections so partial-resolve calls
        // (e.g. "Bleu cheese or ranch" answered on turn 3) don't erase a group
        // that was already resolved on an earlier turn (e.g. "Sauce" on turn 2).
        const existingOpts = (cart[idx] as CartItem).options ?? {};
        const cleaned: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(existingOpts)) {
          if (groupNames.has(k)) cleaned[k] = v;
        }
        const unverifiedThisCall: string[] = [];
        for (const [key, vals] of Object.entries(options)) {
          if (modifierNames.has(key) && !groupNames.has(key)) {
            for (const v of vals) {
              if (modifierNames.has(v) && !newModifiers.includes(v)) newModifiers.push(v);
            }
            continue;
          }
          if (groupNames.has(key)) {
            cleaned[key] = vals;
            continue;
          }
          // Unknown key — same rule as add_item: reject unless the shop
          // flagged this item as needing an unrecorded choice, in which case
          // preserve the customer's ask as unverified rather than as a
          // validated selection (the Boosenberry-wings defect, via modify_item).
          // Same regression fix as add_item: zero recorded groups means there
          // is nothing to correct toward, so never fail the modify over it.
          if (menuItem?.prompt_for || (menuItem?.option_groups || []).length === 0) {
            const descriptor = (menuItem?.name ?? "").toLowerCase();
            for (const v of vals) {
              if (descriptor && descriptor.includes(String(v).toLowerCase())) continue;
              unverifiedThisCall.push(`${key}: ${v}`);
            }
          } else {
            const validNames = (menuItem?.option_groups || []).map(g => g.name).join(", ");
            return { ok: false, result: { error: `"${key}" is not a valid option for ${menuItem?.name ?? "this item"}. ${validNames ? `Valid option groups: ${validNames}.` : "This item has no option groups recorded."}` } };
          }
        }
        newOptions = Object.keys(cleaned).length > 0 ? cleaned : undefined;
        newUnverified = unverifiedThisCall;
        if (unverifiedThisCall.length > 0) {
          unverifiedNote = `NOTE: ${unverifiedThisCall.join(", ")} could not be verified against this item's menu options and was NOT recorded as a selection — it was saved only as an unverified customer request for the shop to confirm. Do not tell the customer it was selected/noted as a menu choice; say it will be passed along to the shop for confirmation, or ask them to choose once options are available.`;
        }
      }
      // ── Reactive modifier/topping match (bug 4, 2026-09-07) ────────────
      // Same gap as add_item, on the separate-turn path ("large buffalo
      // chicken pizza" then, next turn, "add pepperoni"): catch anything
      // customerMessage names that the LLM's modify_item call itself
      // didn't. See reactive-modifier-match.ts / add_item's identical block.
      {
        const modifyItemGroups = menuItem?.option_groups || [];
        const reactiveAlreadyNamed = new Set<string>([
          ...newModifiers.map(m => m.toLowerCase()),
          ...Object.values(newOptions ?? {}).flat().map(v => v.toLowerCase()),
        ]);
        const reactiveCandidates: ReactiveCandidate[] = [
          ...(menuItem?.modifiers_json ?? []).map(m => ({ groupName: null, name: m.name, price_cents: m.price_cents })),
          ...modifyItemGroups.filter(g => !g.required).flatMap(g =>
            g.choices.map(c => ({ groupName: g.name, name: c.name, price_cents: c.price_cents }))),
        ];
        for (const m of matchReactiveExtras(reactiveCandidates, customerMessage ?? "", reactiveAlreadyNamed)) {
          if (m.groupName === null) {
            if (!newModifiers.includes(m.name)) newModifiers.push(m.name);
          } else {
            const merged = { ...(newOptions ?? {}) };
            if (!merged[m.groupName]) merged[m.groupName] = [];
            if (!merged[m.groupName].includes(m.name)) merged[m.groupName].push(m.name);
            newOptions = merged;
          }
        }
      }

      const invalidMods = newModifiers.filter(m => !validMods.includes(m));
      if (invalidMods.length > 0) return { ok: false, result: { error: `Invalid modifiers: ${invalidMods.join(", ")}` } };
      (cart[idx] as CartItem).modifiers = newModifiers;
      if (newOptions !== undefined) (cart[idx] as CartItem).options = newOptions;
      (cart[idx] as CartItem).unverified_requests = newUnverified.length > 0 ? newUnverified : undefined;
      if (menuItem) {
        let extraCents = 0;
        for (const group of (menuItem.option_groups || [])) {
          const selections = (newOptions?.[group.name] ?? []);
          for (const sel of selections) {
            const choice = group.choices.find(c => c.name.toLowerCase() === sel.toLowerCase());
            if (choice) extraCents += choice.price_cents;
          }
        }
        const modPriceCents = newModifiers.reduce((sum, modName) => {
          const mod = menuItem.modifiers_json?.find(m => m.name === modName);
          return sum + (mod?.price_cents ?? 0);
        }, 0);
        (cart[idx] as CartItem).price_cents = menuItem.price_cents + extraCents + modPriceCents;
        // Recompute pending_options: any required group still without a selection stays pending
        const newPending = (menuItem.option_groups || [])
          .filter(g => g.required && (!newOptions || !newOptions[g.name] || newOptions[g.name].length === 0))
          .map(g => g.name);
        (cart[idx] as CartItem).pending_options = newPending.length > 0 ? newPending : undefined;
      }
      await saveCart(supabase, cartId, cart, "building");
      return {
        ok: true,
        result: {
          modified: (cart[idx] as CartItem).name,
          quantity: (cart[idx] as CartItem).quantity,
          price: (cart[idx] as CartItem).price_cents,
          ...(newUnverified.length > 0 ? { unverified_requests: newUnverified, note: unverifiedNote } : {}),
        },
      };
    }

    case "clear_cart": {
      cart.splice(0, cart.length);
      await saveCart(supabase, cartId, cart, "building");
      return { ok: true, result: { cleared: true } };
    }

    case "submit_order": {
      if (cart.length === 0) {
        return { ok: false, result: { error: "Cart is empty. Please add items before submitting." } };
      }
      // Reject if an incomplete bundle is still active
      const incompleteBundle = cart.find(i => (i as BundleItem).type === "bundle" && !(i as BundleItem).complete) as BundleItem | undefined;
      if (incompleteBundle) {
        const filled = incompleteBundle.selections.reduce((s, sel) => s + sel.quantity, 0);
        return { ok: false, result: { error: `Cannot submit. Bundle "${incompleteBundle.name}" is still in progress (${filled} of ${incompleteBundle.target} selected). Finish or cancel the bundle first.` } };
      }
      // Cart-population fix: reject submit_order if any item has unresolved required options.
      // Deterministic — no LLM loop. The error message names the item + missing option groups
      // so the bot asks once and the customer resolves with modify_item.
      // FIX (2026-09-06, Jason — internal-name leak): `pending` below is
      // structured (name + raw option-group names) for any CUSTOMER-facing
      // caller (e.g. D1) to run through renderMissingOptionsPrompt() — never
      // interpolate it into a sentence directly. `error` stays a plain
      // English instruction FOR THE MODEL (which calls submit_order itself
      // outside of D1's forced path) and is allowed to name items/groups
      // since it's a tool-result the model reads, not a customer-facing string.
      const pendingItems = cart
        .filter(i => (i as CartItem).pending_options && (i as CartItem).pending_options!.length > 0)
        .map(i => ({ name: (i as CartItem).name, missingGroups: (i as CartItem).pending_options! }));
      if (pendingItems.length > 0) {
        const itemsWithPending = pendingItems.map(p => `${p.name} (needs: ${p.missingGroups.join(', ')})`);
        return {
          ok: false,
          result: {
            error: `Cannot submit yet — these items still need options chosen: ${itemsWithPending.join('; ')}. Ask the customer for each missing option, then use modify_item to set them.`,
            pending: pendingItems,
          },
        };
      }
      const { pickup_name } = input as { pickup_name?: string };
      // C1 (2026-08-28): Deterministic hard gate — pickup_name is required for submit_order.
      // No name → reject. LLM must collect name before submitting.
      if (!pickup_name || pickup_name.trim().length === 0) {
        return { ok: false, result: { error: "Cannot submit order. A pickup name is required — ask the customer for their name first." } };
      }
      await saveCart(supabase, cartId, cart, "review");
      if (pickup_name) {
        await supabase.from("order_carts").update({ pickup_name }).eq("id", cartId);
      }
      const subtotal = cart.reduce((s, i) => {
        if ((i as BundleItem).type === "bundle") return s + (i as BundleItem).price_cents;
        const r = i as CartItem;
        return s + (r.price_cents * (r.quantity || 1));
      }, 0);
      await supabase.from("order_carts").update({ subtotal_cents: subtotal }).eq("id", cartId);

      // HARD-GATE: test mode MUST use test Stripe, never live keys.
      // Uses the shared test-mode key helper (single source of truth).
      // If test_mode is true and no valid test key is available, fail closed.
      const stripeKey = testMode
        ? (getTestModeStripeKey() ?? "")
        : (Deno.env.get("STRIPE_SECRET_KEY") ?? "");
      if (!stripeKey) {
        return { ok: false, result: { error: "Payment system not configured. Please call the shop directly." } };
      }
      const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16", httpClient: Stripe.createFetchHttpClient() });
      const lineItems = cart.map(item => {
        if ((item as BundleItem).type === "bundle") {
          const b = item as BundleItem;
          const detail = b.selections.map(s => `${s.quantity}x ${s.flavor}`).join(", ");
          return {
            price_data: {
              currency:     "usd",
              unit_amount:  b.price_cents,
              product_data: { name: b.name, description: detail || undefined },
            },
            quantity: 1,
          };
        }
        const r = item as CartItem;
        return {
          price_data: {
            currency:     "usd",
            unit_amount:  r.price_cents,
            product_data: {
              name:        r.name,
              description: r.modifiers?.length > 0 ? r.modifiers.join(", ") : (r.options ? Object.entries(r.options).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') : undefined),
            },
          },
          quantity: r.quantity || 1,
        };
      });

      // Fetch notes + delivery fields for Stripe metadata
      const { data: cartRow } = await supabase.from("order_carts")
        .select("notes, order_type, delivery_address, delivery_fee_cents, driver_tip_cents")
        .eq("id", cartId).single();
      const orderNotes = cartRow?.notes || "";
      const orderType = (cartRow?.order_type as string) || "pickup";

      // C1 (2026-08-28): No fulfillment mode → reject submit_order.
      // LLM must call set_order_type before submitting.
      if (!cartRow?.order_type) {
        return { ok: false, result: { error: "Cannot submit order. Please confirm pickup or delivery first." } };
      }
      const deliveryAddress = cartRow?.delivery_address as Record<string, unknown> | null;
      const deliveryFeeCents = (cartRow?.delivery_fee_cents as number) || 0;
      const driverTipCents = (cartRow?.driver_tip_cents as number) || 0;

      // Pre-submit delivery validation
      if (orderType === "delivery") {
        if (!deliveryAddress) {
          return { ok: false, result: { error: "Please provide a delivery address first." } };
        }
      }

      // Add notes as a $0 line item so the shop sees them on the receipt
      if (orderNotes) {
        lineItems.push({
          price_data: {
            currency:     "usd",
            unit_amount:  0,
            product_data: { name: `Prep Notes: ${orderNotes}`, description: undefined },
          },
          quantity: 1,
        });
      }

      // Delivery fee line item (if delivery)
      if (orderType === "delivery" && deliveryFeeCents > 0) {
        lineItems.push({
          price_data: {
            currency:     "usd",
            unit_amount:  deliveryFeeCents,
            product_data: { name: "Delivery fee", description: undefined },
          },
          quantity: 1,
        });
      }

      // Driver tip line item (if > 0)
      if (driverTipCents > 0) {
        lineItems.push({
          price_data: {
            currency:     "usd",
            unit_amount:  driverTipCents,
            product_data: { name: "Driver tip", description: undefined },
          },
          quantity: 1,
        });
      }

      // Add Sprint service fee as a visible line item
      lineItems.push({
        price_data: {
          currency:     "usd",
          unit_amount:  SERVICE_FEE_CENTS,
          product_data: {
            name: "Service fee",
            description: "SprintAI platform service fee",
          },
        },
        quantity: 1,
      });

      const totalCents = subtotal + SERVICE_FEE_CENTS + deliveryFeeCents + driverTipCents;
      await supabase.from("order_carts").update({
        subtotal_cents: subtotal,
        service_fee_cents: SERVICE_FEE_CENTS,
        total_cents: totalCents,
        delivery_fee_cents: deliveryFeeCents,
        driver_tip_cents: driverTipCents,
      }).eq("id", cartId);

      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://your-project.supabase.co";
      const session = await stripe.checkout.sessions.create({
        mode:                 "payment",
        payment_method_types: ["card"],
        line_items:           lineItems,
        metadata:             { order_cart_id: cartId, notes: orderNotes },
        custom_text:          { submit: { message: `Your order from ${shopName}${orderNotes ? ` -- ${orderNotes}` : ""}` } },
        success_url:          testMode
          ? `https://getsprintai.com/order-success-test?cart=${cartId}`
          : `https://getsprintai.com/order-success?cart=${cartId}`,
        cancel_url:           `https://getsprintai.com/order-cancel?cart=${cartId}`,
      });

      await supabase.from("order_carts").update({
        stripe_checkout_session_id: session.id,
        phase: "checkout",
      }).eq("id", cartId);

      // Short branded link: pay.getsprintai.com/o/<code> → 302 → Supabase → 302 → Stripe
      // Stripe URL is the fallback path when DNS/DB/provisioning chain fails.
      const shortCode = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      supabase.from("pay_links").insert({
        cart_id:    cartId,
        short_code: shortCode,
        stripe_url: session.url!,
      }).then(({ error }) => {
        if (error) console.error("[chat-sms] Failed to insert pay_link:", error);
      });
      const shortUrl = `https://pay.getsprintai.com/o/${shortCode}`;
      return {
        ok:          true,
        result:      { checkout_url: shortUrl, message: "Payment link created. Tell the customer there's one last step: they need to tap the payment link to pay and confirm their order. Do NOT say the order is confirmed or ready. Do NOT say thank you or goodbye yet. Payment is still pending." },
        checkoutUrl: shortUrl,
        newPhase:    "checkout",
      };
    }

    case "start_bundle": {
      const { bundle_item_name, bundle_size, bundle_price_cents } = input as {
        bundle_item_name: string; bundle_size: number; bundle_price_cents: number;
      };
      if (!bundle_item_name || !bundle_size || bundle_size < 1) {
        return { ok: false, result: { error: "bundle_item_name and a positive bundle_size are required." } };
      }
      // FIX 4: Prevent multiple bundles for same category
      // Check if a completed bundle with a similar name already exists
      const existingCompleted = cart.find(i => 
        (i as BundleItem).type === "bundle" && 
        (i as BundleItem).complete &&
        ((i as BundleItem).name.toLowerCase().includes("dozen") && bundle_item_name.toLowerCase().includes("dozen"))
      ) as BundleItem | undefined;
      
      if (existingCompleted) {
        return { ok: false, result: { error: `Already have "${existingCompleted.name}" in cart. Ask the customer if they want to replace it or add another bundle.` } };
      }

      const newBundle: BundleItem = {
        type:        "bundle",
        name:        bundle_item_name,
        target:      bundle_size,
        price_cents: bundle_price_cents,
        selections:  [],
        complete:    false,
      };
      cart.push(newBundle);
      await saveCart(supabase, cartId, cart, "building");
      return { ok: true, result: { message: `Bundle started: ${bundle_item_name}. 0 of ${bundle_size} selected. Ask the customer what flavors they want.` }, newPhase: "building" };
    }

    case "add_to_bundle": {
      const { flavor, quantity } = input as { flavor: string; quantity: number };
      const bundleIdx = cart.findIndex(i => (i as BundleItem).type === "bundle" && !(i as BundleItem).complete);
      if (bundleIdx < 0) {
        return { ok: false, result: { error: "No active bundle. Use start_bundle first." } };
      }
      // Validate flavor against effective menu (must be an available, non-sold-out item)
      // Normalize accents for matching (e.g. jalapeño vs jalapeno)
      const normalize = (s: string) => s.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const flavorNorm = normalize(flavor);
      const flavorMatch = menu.find(
        (item: { name: string }) => {
          const itemNorm = normalize(item.name);
          return itemNorm === flavorNorm
            || itemNorm.startsWith(flavorNorm)
            || itemNorm.includes(flavorNorm)
            || flavorNorm.includes(itemNorm);
        }
      );
      if (!flavorMatch) {
        const availableFlavors = menu
          .filter((item: { category: string }) => item.category.toLowerCase().includes("bagel"))
          .map((item: { name: string }) => item.name)
          .slice(0, 15);
        return { ok: false, result: { error: `"${flavor}" is not available right now. Available options include: ${availableFlavors.join(", ")}. Ask the customer to pick something else.` } };
      }
      const bundle = cart[bundleIdx] as BundleItem;
      const filled  = bundle.selections.reduce((s, sel) => s + sel.quantity, 0);
      const remaining = bundle.target - filled;
      if (quantity > remaining) {
        return { ok: false, result: { error: `Cannot add ${quantity} ${flavor}. Only ${remaining} slot${remaining === 1 ? "" : "s"} remaining in the bundle. Ask the customer to pick ${remaining} or fewer.` } };
      }
      // Use the matched item name for consistency in the cart
      const matchedName = flavorMatch.name;
      const existing = bundle.selections.findIndex(s => s.flavor === matchedName);
      if (existing >= 0) {
        bundle.selections[existing].quantity += quantity;
      } else {
        bundle.selections.push({ flavor: matchedName, quantity });
      }
      const newFilled = bundle.selections.reduce((s, sel) => s + sel.quantity, 0);
      if (newFilled >= bundle.target) {
        bundle.complete = true;
        await saveCart(supabase, cartId, cart, "building");
        const detail = bundle.selections.map(s => `${s.quantity} ${s.flavor}`).join(", ");
        return { ok: true, result: { message: `Bundle complete! ${bundle.name}: ${detail}.` }, newPhase: "building" };
      }
      const stillRemaining = bundle.target - newFilled;
      await saveCart(supabase, cartId, cart, "building");
      return { ok: true, result: { message: `Added ${quantity} ${flavor}. Total: ${newFilled} of ${bundle.target} selected. ${stillRemaining} remaining.` }, newPhase: "building" };
    }

    case "cancel_bundle": {
      const bundleIdx = cart.findIndex(i => (i as BundleItem).type === "bundle" && !(i as BundleItem).complete);
      if (bundleIdx < 0) {
        return { ok: false, result: { error: "No active bundle to cancel." } };
      }
      cart.splice(bundleIdx, 1);
      await saveCart(supabase, cartId, cart, "building");
      return { ok: true, result: { message: "Bundle cancelled." } };
    }

    case "set_note": {
      const { note } = input as { note: string };
      await supabase.from("order_carts").update({ notes: note }).eq("id", cartId);
      return { ok: true, result: { message: `Order notes saved: ${note}` } };
    }

    case "set_order_type": {
      const { order_type } = input as { order_type: "pickup" | "delivery" };
      const update: Record<string, unknown> = { order_type };
      // Clear delivery fields if switching to pickup
      if (order_type === "pickup") {
        update.delivery_address = null;
        update.driver_tip_cents = 0;
        update.delivery_fee_cents = 0;
      }
      await supabase.from("order_carts").update(update).eq("id", cartId);
      return { ok: true, result: { message: `Order type set to ${order_type}.` }, newPhase: "building" };
    }

    case "set_delivery_address": {
      const { street, unit, city, state, zip } = input as {
        street: string; unit?: string; city: string; state: string; zip: string;
      };
      const formatted = [street, unit, `${city}, ${state} ${zip}`].filter(Boolean).join(", ");
      const address: Record<string, unknown> = { street, city, state, zip, formatted };
      if (unit) address.unit = unit;
      const update: Record<string, unknown> = {
        order_type: "delivery",
        delivery_address: address,
      };
      if (deliveryFeeCents && deliveryFeeCents > 0) {
        update.delivery_fee_cents = deliveryFeeCents;
      }

      // ── Geocode + haversine zone check (FAIL CLOSED) ────────────
      // Set the delivery address ONLY when the geocode is positively qualified
      // (street-level ROOFTOP/RANGE_INTERPOLATED, non-partial) AND in-zone.
      // Every other path returns without writing order_carts.
      if (shopGeo && shopGeo.lat != null && shopGeo.lng != null && shopGeo.radiusMi > 0) {
        const geoKey = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";
        if (geoKey) {
          const addrQuery = encodeURIComponent(formatted);
          const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${addrQuery}&key=${geoKey}`;
          type GeoResult = {
            status: string;
            results: Array<{
              geometry: { location: { lat: number; lng: number }; location_type?: string };
              partial_match?: boolean;
            }>;
          };

          // Geocode with one retry on transient failure (throw / HTTP 5xx / timeout).
          let geoJson: GeoResult | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 8000);
              const geoRes = await fetch(geoUrl, { signal: ctrl.signal });
              clearTimeout(timer);
              if (geoRes.status >= 500) {
                throw new Error(`geocode HTTP ${geoRes.status}`);
              }
              geoJson = await geoRes.json() as GeoResult;
              break;
            } catch (_err) {
              if (attempt === 0) continue;
              return { ok: true, result: { message: `We can't confirm delivery addresses right now. Please try again shortly, or switch to pickup and we'll have it ready for you.` }, newPhase: "building" };
            }
          }

          if (!geoJson) {
            return { ok: true, result: { message: `We can't confirm delivery addresses right now. Please try again shortly, or switch to pickup and we'll have it ready for you.` }, newPhase: "building" };
          }

          const top = geoJson.results[0];
          const qualified = geoJson.status === "OK" &&
            geoJson.results.length > 0 &&
            top.partial_match !== true &&
            (top.geometry.location_type === "ROOFTOP" || top.geometry.location_type === "RANGE_INTERPOLATED");

          if (!qualified) {
            // partial match / centroid-only / ZERO_RESULTS / any non-OK status → fail closed
            return { ok: true, result: { message: `We couldn't confirm ${formatted} as a deliverable address. Please double-check the street number and ZIP, or switch to pickup and we'll have it ready for you.` }, newPhase: "building" };
          }

          const loc = top.geometry.location;
          const distance = haversineMiles(shopGeo.lat, shopGeo.lng, loc.lat, loc.lng);

          if (distance > shopGeo.radiusMi) {
            return { ok: true, result: { message: `We're sorry, but ${formatted} is outside our delivery area (${distance.toFixed(1)} mi away; we deliver up to ${shopGeo.radiusMi.toFixed(1)} mi). Would you like to switch to pickup instead?` }, newPhase: "greeting" };
          }

          // qualified + in-zone → fall through to set the address below
        }
      }

      await supabase.from("order_carts").update(update).eq("id", cartId);
      return { ok: true, result: { message: `Delivery address set: ${formatted}` }, newPhase: "building" };
    }

    case "set_driver_tip": {
      const { tip_cents } = input as { tip_cents: number };
      await supabase.from("order_carts").update({ driver_tip_cents: tip_cents }).eq("id", cartId);
      return { ok: true, result: { message: `Driver tip set to $${(tip_cents / 100).toFixed(2)}.` }, newPhase: "building" };
    }

    default:
      return { ok: false, result: { error: `Unknown tool: ${toolName}` } };
  }
}

async function saveCart(
  supabase: SupabaseClient,
  cartId:   string,
  cart:     AnyCartItem[],
  phase:    OrderPhase,
): Promise<void> {
  // ── Guard C: phase="checkout" only after a Stripe session exists ──────
  // INVARIANT (Fix 4 — Checkout backstop): No code path may set phase to
  // "checkout" unless submit_order has already created a real Stripe
  // checkout session on this row. The cart stays in "building" until a
  // Stripe session ID is present. This is the definitive gate — every path
  // through the system that attempts phase="checkout" is funneled through
  // saveCart, and saveCart enforces this. There is no bypass.
  let resolvedPhase = phase;
  if (phase === "checkout") {
    const { data: row } = await supabase
      .from("order_carts").select("stripe_checkout_session_id")
      .eq("id", cartId).single();
    if (!row?.stripe_checkout_session_id) {
      console.warn(`[chat-sms] GUARD C (saveCart): blocked phase="checkout" — no Stripe session exists for cart=${cartId}. Downgrading to "review".`);
      resolvedPhase = "review";
    }
  }

  const subtotal = cart.reduce((s, i) => {
    if ((i as BundleItem).type === "bundle") {
      return s + ((i as BundleItem).complete ? (i as BundleItem).price_cents : 0);
    }
    const r = i as CartItem;
    return s + (r.price_cents * (r.quantity || 1));
  }, 0);
  await supabase.from("order_carts")
    .update({ cart_json: cart, phase: resolvedPhase, subtotal_cents: subtotal, total_cents: subtotal })
    .eq("id", cartId);
}

// ─── Ordering LLM loop ────────────────────────────────────────────────────────

async function runOrderingLoop(
  systemPrompt: string,
  history:      Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }>,
  userMessage:  string,
  cart:         AnyCartItem[],
  menu:         EffectiveMenuItem[],
  cartId:       string,
  supabase:     SupabaseClient,
  shopName:     string,
  testMode:     boolean = false,
  deliveryFeeCents?: number | null,
  shopGeo?:      { lat: number; lng: number; radiusMi: number } | null,
  correctionApplied?: boolean,
  // Item 8 (spec §7/§11 item 8) — see executeTool's matching params.
  compiledEngineEnabled?: boolean,
  shopPhone?: string | null,
): Promise<{ reply: string; checkoutUrl?: string; finalPhase?: OrderPhase; declinedBlockedItems?: Array<{ category: string; name: string }> }> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");

  const messages: Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }> = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let checkoutUrl: string | undefined;
  let finalPhase:  OrderPhase | undefined;
  // BLOCKED-SUGGESTION GUARD (2026-09-07, Jason): categories where a
  // bot_state='blocked' item was declined this turn — GUARD 15 below (in the
  // caller, after this function returns the model's free-text reply) uses
  // this to catch the model suggesting another blocked item from the SAME
  // category by its own menu recall, since the tool result's own
  // orderable_alternatives instruction (executeTool's add_item case) is a
  // prompt-level constraint only, not a guarantee.
  const declinedBlockedItems: Array<{ category: string; name: string }> = [];

  // ── Fix 1 & 2: Deterministic pre-loop guards ──────────────────────────
  //
  // Fix 2: Correction short-circuit — if the caller already applied a
  // correction (set qty→1 or removed last item), skip the LLM and return
  // a confirmation with the actual cart state.
  if (correctionApplied) {
    const subtotal = cart.reduce((s, i) => {
      if ((i as BundleItem).type === "bundle") return s + ((i as BundleItem).complete ? (i as BundleItem).price_cents : 0);
      const r = i as CartItem;
      return s + (r.price_cents * (r.quantity || 1));
    }, 0);
    const cartTotal = subtotal + SERVICE_FEE_CENTS + (deliveryFeeCents ?? 0) + (cart.reduce((s, i) => { const r = (i as any); return s + (r.driver_tip_cents ?? 0); }, 0));
    // We need to read driver_tip from the DB row — use the cart's tip from the caller
    // For now: compute total from cart items + fee + delivery. Tip will be added when loaded.
    const totalWithoutTip = subtotal + SERVICE_FEE_CENTS + (deliveryFeeCents ?? 0);
    if (cart.length === 0) {
      return { reply: "Your cart is empty. What would you like to order?", finalPhase: "building" };
    }
    const itemList = cart.map(i => {
      const r = i as CartItem;
      return `${(r.quantity || 1)}x ${r.name}`;
    }).join(", ");
    return {
      // BUG-2 FIX: guard the dash+total fragment (see cartTotalFragment).
      reply: `Updated! Your cart: ${itemList}${cartTotalFragment(totalWithoutTip)}. Add anything else?`,
      finalPhase: "building",
    };
  }

  // Fix 1: Detect bare-tip reply — when the prior assistant turn offered a
  // driver tip and the user replied with a bare tip amount, this is a tip-only
  // turn. Capture the prior assistant's last message to check.
  let tipSuppressAddItem = false;
  {
    const lastAssistant = [...history].reverse().find(h => h.role === "assistant");
    const offeredTip = lastAssistant && typeof lastAssistant.content === "string"
      && /\b(?:tip|driver tip)\b/i.test(lastAssistant.content)
      && /\$(?:1|2|3|5)\b/i.test(lastAssistant.content);
    const userMsg = userMessage.trim();
    const isBareTip = offeredTip && (
      /^\$?\s*(1|2|3|5)\s*$/.test(userMsg) ||
      /^(no tip|no thanks|skip|none|pass|no)\s*$/i.test(userMsg)
    );
    if (isBareTip) {
      tipSuppressAddItem = true;
      console.log(`[chat-sms] GUARD: bare-tip reply detected, suppressing add_item this turn (conv msg="${userMsg}")`);
    }
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // ── Fix 1 tip shortcut: bare tip reply skips the LLM ─────────────────
    // When the user responds to a tip offer, call set_driver_tip directly
    // and return. No LLM inference needed — and no risk of add_item hallucination.
    if (tipSuppressAddItem && attempt === 0) {
      const userMsg = userMessage.trim();
      const tipMatch = userMsg.match(/\$?\s*([0-9]+)/);
      const tipArg = tipMatch ? parseInt(tipMatch[1], 10) : 0;
      if (tipArg > 0) {
        const tipResult = await executeTool(
          "set_driver_tip", { tip_cents: tipArg * 100 }, cart, menu, cartId, supabase, shopName, testMode,
          deliveryFeeCents ?? null, shopGeo ?? null,
        );
        if (tipResult.ok) {
          return { reply: `Got it — $${tipArg.toFixed(2)} driver tip added. Let me confirm your order. ${NAME_ASK}`, finalPhase: "building" };
        }
        console.warn(`[chat-sms] Tip shortcut: set_driver_tip failed, falling through to LLM`);
      } else {
        // User declined tip — proceed without calling tool (tip already $0)
        return { reply: `No problem — no tip added. Let me confirm your order. ${NAME_ASK}`, finalPhase: "building" };
      }

      // Fall through to normal LLM path if tip tool fails
    }

    const res = await fetch(CHAT_API, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://getsprintai.com",
        "X-Title":      "SprintAI",
      },
      body: JSON.stringify({
        model:      CHAT_MODEL,
        max_tokens: 2048,
        reasoning:  { enabled: false },
        system:     systemPrompt,
        messages,
        tools:      ORDERING_TOOLS,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[chat-sms] Chat API error:", res.status, errText);
      break;
    }

    const data: { stop_reason: string; content: ContentBlock[] } = await res.json();
    const content    = data.content ?? [];
    const toolBlocks = content.filter(b => b.type === "tool_use");
    const textBlocks = content.filter(b => b.type === "text");

    // Only finish when there are NO pending tool calls. Previously an `end_turn`
    // stop_reason short-circuited here even when the model had emitted tool_use
    // blocks in the same turn (DeepSeek Flash does this for some items, e.g.
    // breakfast sandwiches). Those calls were dropped — the item never got added
    // and, with no text, the customer got "I couldn't process that". Always
    // execute pending tools; only return once the model stops calling them.
    if (toolBlocks.length === 0) {
      const reply = textBlocks.map(b => b.text ?? "").join("").trim();
      if (reply) return { reply, checkoutUrl, finalPhase, declinedBlockedItems };
      // Model produced neither tools nor text — degrade gracefully, never error at the customer.
      const soft = cart.length > 0
        ? `You've got ${cart.length} item${cart.length === 1 ? "" : "s"} in your cart. Anything else, or ready to check out?`
        : "Sorry, I didn't quite catch that — what can I get started for you?";
      return { reply: soft, checkoutUrl, finalPhase };
    }

    messages.push({ role: "assistant", content });

    const toolResults: ContentBlock[] = [];
    for (const toolBlock of toolBlocks) {
      // ── Fix 1: Tip turn must never mutate items ─────────────────────────
      // When the user is responding to a tip offer, skip add_item — the LLM
      // may spuriously "add" the same item to confirm the order. The tip tool
      // (set_driver_tip) still runs normally.
      if (tipSuppressAddItem && toolBlock.name === "add_item") {
        console.warn(`[chat-sms] GUARD: suppressed add_item during tip turn (attempted ID=${toolBlock.input?.menu_item_id})`);
        toolResults.push({
          type:        "tool_result",
          tool_use_id: toolBlock.id!,
          content:     JSON.stringify({ ok: false, error: "Cannot add items while confirming tip — prior tip offer is being resolved." }),
        });
        continue;
      }

      // ── E1 (2026-08-29): Cross-turn clear_cart guard ────────────────
      // Extends B3 to the free-form conversational path: the model sometimes
      // calls clear_cart when the user says something additive like "and also",
      // "and a", etc. — even when no add_item is in the same turn. This catches
      // the cross-turn case that the same-turn B3 guard misses. Suppress
      // clear_cart when: (a) user message is additive AND (b) cart has items.
      // Explicit "start over"/"cancel everything" still clears normally.
      // ── E1 FIX (2026-09-01): Broaden isExplicitRestart to catch messages
      // that CONTAIN a cancel/restart phrase (e.g. "Actually, cancel my order")
      // — the anchored ^…$ pattern missed these. The broader check uses a
      // second non-anchored regex so "actually" + "cancel my order" passes.
      if (toolBlock.name === "clear_cart" && cart.length > 0) {
        const e1msg = userMessage.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const isExplicitRestart = /^(start over|restart|cancel (?:everything|all|the order|it all|my order)|new order|clear (?:the cart|it all|everything)|reset|wipe (?:the cart|it|everything))[!.]?$/i.test(e1msg)
          || /\b(?:cancel\s+(?:my\s+)?order|cancel\s+(?:everything|all|it\s+all)|forget\s+(?:it|the whole|everything)|start\s+over|wipe\s+(?:the\s+)?(?:cart|it|everything|all))\b/i.test(e1msg);
        const isAdditive = /\b(?:also|add(?: another| a| an)?|and a|and another|and some|and the|can i also|let me also|let me get|i also|ill also|ill have|i'll also|i'll have|i want|gimme|give me|actually |oh and|plus)\b/i.test(e1msg);
        if (isAdditive && !isExplicitRestart) {
          console.warn(`[chat-sms] E1 GUARD: suppressed clear_cart — additive user intent (cartId=${cartId}, cart has ${cart.length} items). Message: ${JSON.stringify(userMessage).slice(0, 120)}`);
          toolResults.push({
            type:        "tool_result",
            tool_use_id: toolBlock.id!,
            content:     JSON.stringify({ ok: false, error: "Cannot clear the cart when the customer is adding more items. Use modify_item or remove_item to change existing items." }),
          });
          continue;
        }
      }

      // ── B3 (2026-08-28): Clear-cart + add-item in same turn = REPLACE, not ADD ─
      // When the LLM clears then adds, it's trying to replace the cart content
      // instead of mutating. Corrections should use modify_item/remove_item,
      // not a destroy-then-rebuild. Suppress clear_cart and let add_item proceed.
      if (toolBlock.name === "clear_cart" && cart.length > 0 &&
          toolBlocks.some((tb: { name?: string }) => tb.name === "add_item")) {
        console.warn(`[chat-sms] GUARD: suppressed clear_cart — add_item present in same turn (cart has ${cart.length} items, likely a replace-not-add mistake)`);
        toolResults.push({
          type:        "tool_result",
          tool_use_id: toolBlock.id!,
          content:     JSON.stringify({ ok: false, error: "Cannot clear the cart when adding items. Use modify_item or remove_item to update existing items instead." }),
        });
        continue;
      }

      const result = await executeTool(
        toolBlock.name!,
        toolBlock.input! as Record<string, unknown>,
        cart,
        menu,
        cartId,
        supabase,
        shopName,
        testMode,
        deliveryFeeCents,
        shopGeo ?? null,
        compiledEngineEnabled,
        userMessage,
        shopPhone,
      );
      // OBSERVABILITY (2026-09-05): a failed tool call used to leave no trace at
      // all. When add_item failed the model narrated it to the customer ("that's
      // giving me a system hiccup") and the only record was the customer's
      // screenshot. Every rejection is logged with the arguments that caused it.
      if (!result.ok) {
        console.warn(
          `[chat-sms] TOOL FAILED: ${toolBlock.name} args=${JSON.stringify(toolBlock.input).slice(0, 300)} -> ${JSON.stringify(result.result).slice(0, 300)}`,
        );
      }
      if (result.checkoutUrl) checkoutUrl = result.checkoutUrl;
      if (result.newPhase)    finalPhase  = result.newPhase;
      if (toolBlock.name === "add_item" && (result.result as { declined?: boolean })?.declined) {
        const declinedId = (toolBlock.input as { menu_item_id?: string })?.menu_item_id;
        const declinedItem = declinedId ? menu.find(m => m.id === declinedId) : undefined;
        if (declinedItem) declinedBlockedItems.push({ category: declinedItem.category, name: declinedItem.name });
      }
      toolResults.push({
        type:        "tool_result",
        tool_use_id: toolBlock.id!,
        content:     JSON.stringify(result.result),
      });
      // Stop immediately after checkout is created — don't let the model generate
      // another turn that could hallucinate a confirmation message
      if (toolBlock.name === "create_checkout" && checkoutUrl) {
        return {
          reply:      "Payment link sent! Tap it to complete your order. Check your text or email.",
          checkoutUrl,
          finalPhase,
        };
      }
      // Fix 1 (2026-09-01): After submit_order creates a real checkout session,
      // return the real payment link deterministically — never let the LLM type a
      // link or claim payment without including the actual session URL.
      if (toolBlock.name === "submit_order" && checkoutUrl) {
        return {
          reply:      `All set! Here's your payment link — tap to finish your order: ${checkoutUrl}`,
          checkoutUrl,
          finalPhase: finalPhase || "checkout",
        };
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { reply: "Sorry, I ran into a problem. Please call us directly to place your order.", checkoutUrl, finalPhase };
}

// ─── Response helpers ─────────────────────────────────────────────────────────

// FIX 1: Strip markdown from all replies
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")      // **bold** → bold
    .replace(/\*(.+?)\*/g, "$1")           // *italic* → italic
    .replace(/__(.+?)__/g, "$1")            // __bold__ → bold
    .replace(/_(.+?)_/g, "$1")              // _italic_ → italic
    .replace(/^###\s+(.+)$/gm, "$1")       // ### heading → heading
    .replace(/^##\s+(.+)$/gm, "$1")        // ## heading → heading
    .replace(/^#\s+(.+)$/gm, "$1");        // # heading → heading
}

// ─── Phantom-link guard ───────────────────────────────────────────────────────
//
// PROBLEM (launch-critical): the model sometimes writes prose like "Payment
// link sent!" / "You're all set" WITHOUT calling submit_order. The result is a
// reply that PROMISES a payment link while no Stripe checkout session was ever
// created (cart stays phase="building", stripe_checkout_session_id stays null).
// The customer then waits for a link that never arrives — the worst possible
// failure for an ordering bot.
//
// claimsPaymentSent() is a deterministic detector for that payment-claim/
// order-placed language. It is exported for unit testing. The main handler uses
// it as a POST-TURN SAFETY NET: a reply that asserts "payment link sent / order
// placed" is only ever allowed to go out if a REAL checkout session exists.
//
// Matching strategy: normalize the text (lowercase, collapse whitespace, strip
// most punctuation) then test against a maintained list of phrase patterns.
// Patterns are intentionally specific to *claims that a link/payment is already
// sent or the order is placed* — NOT normal building chatter ("want that
// toasted?", "added to your cart", "ready to check out?").
export const PAYMENT_CLAIM_PATTERNS: RegExp[] = [
  // Link was sent / is coming
  /\bpayment link (?:is )?(?:sent|on (?:its|the) way|coming|ready|created|below|here|attached)\b/,
  /\b(?:a |the )?link (?:is |has been |was )?(?:sent|on (?:its|the) way|coming|ready)\b/,
  /\b(?:sent|sending) (?:you )?(?:a |the |your )?(?:payment )?link\b/,
  /\bhere(?:'s| is) (?:your |the |a )?(?:payment )?link\b/,
  /\b(?:tap|click|use|follow) (?:the|your|this) (?:payment )?link\b/,
  /\bcheck (?:your )?(?:text|texts|phone|email|inbox|messages)\b.*\blink\b/,
  /\blink\b.*\bcheck (?:your )?(?:text|texts|phone|email|inbox|messages)\b/,
  // "All set" / order placed / confirmed (claims completion)
  /\byou(?:'re| are) all set\b/,
  /\ball set\b.*\b(?:link|pay|payment|text|email)\b/,
  /\b(?:your )?order (?:is|has been|was) (?:placed|submitted|confirmed|complete|completed|in|on its way)\b/,
  /\b(?:i(?:'ve| have) )?(?:placed|submitted|confirmed|sent) (?:your |the )?order\b/,
  /\border(?:'s| is) (?:placed|in|confirmed|all set|on the way)\b/,
  // Bare past-participle completion claims with no copula:
  // "Order placed!", "Order confirmed!", "Order submitted!", "Order complete[d]!".
  // The verb FOLLOWS "order", so the instruction "complete your order" (verb
  // before noun) does NOT match — only the completion sense fires.
  /\border (?:placed|confirmed|submitted|complete|completed)\b/,
  // Generic payment-ready claims
  /\bready (?:to|for) (?:pay|payment|checkout)\b.*\b(?:link|text|email|tap|click)\b/,
  /\bproceed to (?:pay|payment|checkout)\b.*\b(?:link|text|email)\b/,
];

export function claimsPaymentSent(text: string): boolean {
  if (!text) return false;
  // Normalize: lowercase, replace curly quotes, collapse whitespace.
  const norm = text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return PAYMENT_CLAIM_PATTERNS.some(re => re.test(norm));
}

// True if the cart row already carries a real Stripe session id (defensive:
// avoid creating a second session if one exists).
function checkoutAlreadyExists(row: { stripe_checkout_session_id?: string | null; phase?: string } | null | undefined): boolean {
  return !!row && (!!row.stripe_checkout_session_id || row.phase === "checkout");
}

// Honest reply used when the model falsely claimed a link was sent but we could
// NOT create a real session. It asks for the missing piece and never asserts a
// link/payment was sent. Stays under the 300-char SMS budget.
//
// DEFECT 2 (2026-09-06 live QA): the empty-cart branch used to return the
// first-contact greeting unconditionally, with no check on whether this was
// actually the start of the conversation. Several guards above call this as
// their fallback whenever cart_json is still empty — which is completely
// normal mid-order (e.g. an item is stuck in a pending disambiguation and
// hasn't been confirmed into cart_json yet). A guard tripping in that state
// overwrote the model's reply with a cold "What can I get started for you?"
// greeting landing mid-conversation, right before a carried disambiguation
// question got appended — reading like two unrelated bot turns stapled
// together. `hasHistory` (the caller passes `!isLifetimeFirstContact`) is the
// only signal that distinguishes true first contact from a guard tripping
// mid-order with an empty cart.
function honestFallbackReply(cart: AnyCartItem[], incompleteBundle = false, hasHistory = false): string {
  if (!cart || cart.length === 0) {
    return hasHistory
      ? "Sorry, I didn't catch that — what would you like to order?"
      : "What can I get started for you? Let me know your items and I'll get your order going.";
  }
  if (incompleteBundle) {
    return "Almost there! Your bundle still needs a few more picks before I can send your payment link. What else would you like in it?";
  }
  // Has items, just missing the pickup name to submit.
  return `Got your order! ${NAME_ASK} Once I have that I'll send your payment link.`;
}

// ─── Phase A: Deterministic Ledger-status rendering ─────────────────────────

/**
 * Render the authoritative money/status footer from Ledger truth.
 * The LLM owns the conversational framing; the Ledger owns the numbers.
 * This is appended to every non-checkout reply that has cart items.
 *
 * Line 1 (item count + total) appears every turn. Line 2 (the fee breakdown)
 * is noise on repeat — Jason's product call was to state it once, the first
 * turn the fee applies, and again at checkout (the checkout path is separate,
 * see the checkoutUrl branch below). Callers pass `showFeeBreakdown = false`
 * once `order_carts.fee_disclosed_at` is already set for this cart.
 */
function renderLedgerFooter(
  cart: AnyCartItem[],
  phase: string,
  deliveryFeeCents?: number,
  driverTipCents?: number,
  showFeeBreakdown = true,
): string {
  if (cart.length === 0) return "";

  const subtotal = cart.reduce((s, i) => {
    if ((i as BundleItem).type === "bundle") {
      return s + ((i as BundleItem).complete ? (i as BundleItem).price_cents : 0);
    }
    const r = i as CartItem;
    return s + (r.price_cents * (r.quantity || 1));
  }, 0);

  const totalCents = subtotal + SERVICE_FEE_CENTS + (deliveryFeeCents ?? 0) + (driverTipCents ?? 0);
  const itemCount = cart.reduce((s, i) => {
    if ((i as BundleItem).type === "bundle") return s + ((i as BundleItem).complete ? 1 : 0);
    return s + ((i as CartItem).quantity || 1);
  }, 0);

  const lines: string[] = [];
  lines.push(`${itemCount} item${itemCount === 1 ? "" : "s"} — $${(totalCents / 100).toFixed(2)} total`);
  if (showFeeBreakdown) {
    lines.push(`(subtotal $${(subtotal / 100).toFixed(2)} + $${(SERVICE_FEE_CENTS / 100).toFixed(2)} service fee${deliveryFeeCents ? ` + $${(deliveryFeeCents / 100).toFixed(2)} delivery` : ""}${driverTipCents ? ` + $${(driverTipCents / 100).toFixed(2)} tip` : ""})`);
  }

  return lines.join("\n");
}

/**
 * Deterministic itemized recap — lists each cart line with its chosen
 * options/modifiers, not just the total renderLedgerFooter already shows.
 * Reuses the same "group: choice" formatting submit_order's own Stripe line
 * items use (see the lineItems.map description logic in executeTool) so the
 * two never drift apart.
 */
/**
 * Right-pads `label`, right-aligns `amount`, to a fixed total width — a
 * plain-text receipt column, no box-drawing characters (reads correctly in
 * an SMS). Falls back to a single space when the label alone already fills
 * the width, so a long item name never throws on a negative repeat count.
 */
function padReceiptLine(label: string, amount: string, width = 38): string {
  const gap = Math.max(1, width - label.length - amount.length);
  return `${label}${" ".repeat(gap)}${amount}`;
}

/**
 * Deterministic itemized recap — a full plain-text receipt (line items with
 * their own price, chosen options, subtotal, service fee, and total), not
 * just a count and a total. This is the structural defense against the
 * double-charge class (2026-09-06, Jason: "Luca only caught a $37 error
 * because he happened to read a number") — the model never states these
 * figures itself.
 */
function renderItemizedRecap(cart: AnyCartItem[], deliveryFeeCents?: number, driverTipCents?: number): string {
  const lines: string[] = [];
  let subtotal = 0;
  for (const i of cart) {
    if ((i as BundleItem).type === "bundle") {
      const b = i as BundleItem;
      if (!b.complete) continue; // an incomplete bundle has no settled price yet
      subtotal += b.price_cents;
      const detail = b.selections.map(s => `${s.quantity}x ${s.flavor}`).join(", ");
      lines.push(padReceiptLine(`${b.name}${detail ? ` (${detail})` : ""}`, `$${(b.price_cents / 100).toFixed(2)}`));
      continue;
    }
    const r = i as CartItem;
    const lineTotal = r.price_cents * (r.quantity || 1);
    subtotal += lineTotal;
    const qtyPrefix = (r.quantity || 1) > 1 ? `${r.quantity}x ` : "";
    const detail = r.modifiers?.length > 0
      ? r.modifiers.join(", ")
      : (r.options ? Object.entries(r.options).map(([k, v]) => `${k}: ${v.join(", ")}`).join("; ") : "");
    lines.push(padReceiptLine(`${qtyPrefix}${r.name}${detail ? ` (${detail})` : ""}`, `$${(lineTotal / 100).toFixed(2)}`));
  }
  const totalCents = subtotal + SERVICE_FEE_CENTS + (deliveryFeeCents ?? 0) + (driverTipCents ?? 0);
  lines.push(padReceiptLine("Subtotal", `$${(subtotal / 100).toFixed(2)}`));
  lines.push(padReceiptLine("Service fee", `$${(SERVICE_FEE_CENTS / 100).toFixed(2)}`));
  if (deliveryFeeCents) lines.push(padReceiptLine("Delivery fee", `$${(deliveryFeeCents / 100).toFixed(2)}`));
  if (driverTipCents) lines.push(padReceiptLine("Driver tip", `$${(driverTipCents / 100).toFixed(2)}`));
  lines.push(padReceiptLine("Total", `$${(totalCents / 100).toFixed(2)}`));
  return lines.join("\n");
}

/**
 * FIX (2026-09-06, Jason): the system prompt already tells the model never
 * to use em dashes (line ~694), but a prompt instruction is a request, not a
 * guarantee — and several of the codebase's own hardcoded guard replies use
 * them too. This is the deterministic backstop, applied at the two places
 * every outbound message funnels through (sendSms for real SMS delivery,
 * jsonResponse for the JSON reply field used by the web/test-mode chat), so
 * no customer-facing text — from the model OR from our own code — can ship
 * with an em dash, regardless of which of the many reply/guard/branch sites
 * produced it.
 */
function stripEmDashes(text: string): string {
  // QA-found (Melvin, 2026-09-06): the blanket `\s{2,}` collapse this used to
  // end with ran on the WHOLE message, not just around the dash it replaced —
  // `\s` matches newlines too, so it silently flattened the itemized recap's
  // column padding AND merged its "\n\n" paragraph break into a single space,
  // running the name-ask and the receipt together on one line. The primary
  // replacement below already normalizes spacing directly around the dash
  // (`\s*—\s*` → " - "), so the extra collapse was redundant for its actual
  // job and only destructive everywhere else.
  return text
    .replace(/\s*—\s*/g, " - ")
    .trim();
}

/**
 * Does this text ask the customer for their pickup name? Shared by C2 (was
 * the customer's PRIOR message a name-ask, so this turn's short reply is
 * the name) and by the itemized-recap wiring below (is THIS turn's reply a
 * name-ask, regardless of whether GUARD 2 forced it or the model asked on
 * its own initiative). Extracted from C2's original inline check so both
 * call sites can never drift apart on what counts as a name-ask.
 */
function isAskingForPickupName(text: string): boolean {
  return /\bname\b/i.test(text)
    && /pickup|pick up|under (?:what|which)|who(?:'s| is) (?:this|it) for|order for|(?:for|on) (?:the|this|your) order/i.test(text);
}

/**
 * FIX (2026-09-06, Jason — internal-name leak, the 4th place a raw name
 * reached a customer today, this one written AFTER the earlier sweep): a
 * customer was told "Almost - I still need to know: Chicken Caesar
 * (Dressing). What'll it be?" — an item name with an option-group name
 * bolted on in parentheses is not how a person talks; a person asks "what
 * dressing do you want on the Caesar salad?"
 *
 * This is the ONE place any customer-facing text asks about missing
 * required options, on ANY item — GUARD 2's pending-options branch and D1's
 * pending-options failure branch both call this instead of interpolating
 * `${item.name} (${groups.join(", ")})` themselves. A new call site cannot
 * reintroduce this leak by accident because there is no raw interpolation
 * left to copy.
 */
function renderMissingOptionsPrompt(items: Array<{ name: string; missingGroups: string[] }>): string {
  const clauses = items.map(item => {
    // BUG 2 fix (2026-09-07): missingGroups holds the RAW group name as
    // stored in pending_options (must stay raw there — it's matched by
    // exact string elsewhere) but a Slice import artifact like "Choose an
    // option" must never be read aloud to the customer. Sanitize only here,
    // at render time.
    const displayGroups = item.missingGroups.map(displayGroupName);
    const groups = displayGroups.length > 1
      ? `${displayGroups.slice(0, -1).join(", ")} and ${displayGroups[displayGroups.length - 1]}`
      : displayGroups[0];
    return `what ${groups.toLowerCase()} you'd like on the ${item.name}`;
  });
  const joined = clauses.length > 1
    ? `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`
    : clauses[0];
  return `I still need to know ${joined}. What'll it be?`;
}

/**
 * Deterministic menu-request detector. Matches an explicit ask for "the
 * menu" or "a link" — deliberately narrow so it does NOT fire on a specific
 * question about one item/category ("what wing flavors do you have?"),
 * which the model should keep answering directly.
 */
function impliesMenuRequest(text: string): boolean {
  const t = text.trim();
  // FIX (2026-09-06, QA-found): the original verb list (send/share/text/get/
  // see/have/got + menu/link within 20 chars) over-fired on ordinary food
  // language that happens to contain "menu" or "have" — "what desserts do
  // you have on the menu", "I'll have the menu special", and "do you have a
  // kids menu" all wrongly hijacked into a menu-link reply. Narrowed to
  // send/share/text/show/see (unambiguous document-request verbs) plus a
  // short list of exact phrases that are unambiguous asks for the menu
  // itself. "have" is deliberately NOT in the verb group — it's the word
  // that caused the over-fire — but is still covered as its own standalone
  // exact phrase below, so it stays safe without reintroducing the bug.
  //
  // WIDENED (2026-09-06, Jason — both real testers' actual phrasing):
  // "show"/"see" added to the verb group (fixes "can you show me the menu",
  // the exact phrase that failed). "what do you have" added as its OWN
  // phrase, deliberately anchored to the (near-)WHOLE message — a customer
  // asking "what do you have for wings?" is still a narrow question and
  // must stay with the model; only a bare "what do you have" is a menu ask.
  return /\b(send|share|text|show|see)\b[^.?!]{0,20}\b(menu|link)\b/i.test(t)
    || /\bmenu\b[^.?!]{0,20}\blink\b/i.test(t)
    || /\b(what('?s| is) on the menu|do you have a menu|can (i|we) see (a |the )?(full |whole )?menu|full menu|whole menu|menu please)\b/i.test(t)
    || /^\s*menu\s*[?.!]?\s*$/i.test(t)
    || /^\s*what do you have\s*[?!.]*\s*$/i.test(t);
}

/**
 * Strip LLM-emitted money/status lines from the reply so they don't conflict
 * with the deterministic Ledger footer. The LLM keeps A1 conversational
 * framing; this removes any numbers it leaked.
 */
/**
 * BUG-2 FIX (2026-09-04): render the " — $X.XX total" fragment ONLY when the
 * total is real. Previously guards interpolated the total unconditionally and a
 * later stripLlmMoneyLines() pass removed the dollar amount, leaving a dangling
 * dash and a stray period: "1x French Fries — . What else can I add".
 * Missing / non-finite / <= 0 totals now yield an empty fragment, so the
 * sentence reads "Your cart: 1x French Fries. What else can I add?".
 */
function cartTotalFragment(totalCents: number | null | undefined): string {
  if (totalCents === null || totalCents === undefined) return "";
  if (!Number.isFinite(totalCents) || totalCents <= 0) return "";
  return ` — $${(totalCents / 100).toFixed(2)} total`;
}

/**
 * BUG-2 FIX (2026-09-04): after money-stripping, remove punctuation fragments
 * orphaned by the removal (a dash with nothing after it, a stray leading
 * period). This is the safety net for any path that emits a total we later
 * strip — it guarantees no reply ever ships a dangling "— ." to a customer.
 */
function repairOrphanedPunctuation(text: string): string {
  return text
    // "Fries — . What else"  /  "Fries —. What else"  → "Fries. What else"
    // empty brackets left where a stripped amount used to be: "bone-in ( )"
    .replace(/\(\s*\)/g, "")
    // "3 items — ( )" / "3 items —" left when the model's own total was stripped
    .replace(/\b\d+\s+items?\s*[—–-]\s*(?=[.!?]|$)/gim, "")
    .replace(/\s*[—–-]\s*([.,;:!?])/g, "$1")
    // "Fries — total. What" → "Fries. What"  (word "total" left behind alone)
    .replace(/\s+[—–-]\s+total\b/gi, "")
    // dash left at end of a line / string
    .replace(/\s*[—–-]\s*$/gm, "")
    // ORPHANED SENTENCE REMAINDER (2026-09-06, Jason's Test Kitchen transcript).
    // The strippers delete a claim from the MIDDLE of a sentence and leave its
    // tail behind. The model wrote "I've got 1 item in your cart now. Large
    // cheese with pepperoni added!"; the item-count stripper removed "I've got
    // 1 item in your cart" and what reached the customer opened with "now. ".
    // Same family as the "Fries — ." artefact above: we edit replies by string
    // surgery and leave debris.
    //
    // A reply never legitimately opens with a short lowercase fragment that
    // ends in sentence punctuation — that shape only occurs when something
    // upstream ate the start of the sentence. Drop it and let the next real
    // sentence lead. Bounded to 30 chars so this can never swallow real copy.
    .replace(/^[a-z][a-z'’ ,]{0,29}[.!?]+\s+(?=[A-Z"'“])/, "")
    // Same fragment with nothing after it — the whole reply was the tail.
    .replace(/^[a-z][a-z'’ ,]{0,29}[.!?]+\s*$/, "")
    // collapse the ". ." / " ." artefacts
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])\1{1,}/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripLlmMoneyLines(text: string): string {
  let out = text;

  // Dollar amounts in prose: "$X.XX total", "$X.XX (includes...)", "comes to $X.XX", etc.
  out = out.replace(/(?:[Tt]hat['’]s|That is|[Tt]otal is|[Cc]omes to|[Tt]hat['’]ll be|[Yy]ou owe|[It]t['’]s|is)\s+\$?\d+[.,]\d{2}(?:\s*(?:total|with|each|plus|\+.*?fee))?/g, "");
  out = out.replace(/\$\d+[.,]\d{2}\s*(?:total|due|to pay|owed|grand total|order total)/gi, "");
  out = out.replace(/\(includes?\s+(?:a\s+)?\$\d+[.,]\d{2}\s+(?:service\s+)?fee\)/gi, "");
  out = out.replace(/\$\d+[.,]\d{2}\s*(?:\(\s*includes?[^)]*\))?/g, (m) => {
    // If the dollar amount is the ONLY content on the line (after stripping),
    // remove the whole line. Otherwise it's a line-item price — keep it.
    return "";
  });
  // ... actually, we need a more careful approach. We want to remove ONLY
  // standalone dollar amounts that are totals/fees, not line-item prices.
  // Revert that last over-broad regex — rebuild more precisely.

  // Re-apply: remove total-line patterns from the original text
  out = text;
  // "Your total is $X.XX (includes $0.99 service fee)"
  out = out.replace(/\b(?:[Yy]our|the|order)\s+total\s+(?:is|comes to|of)\s*\$\d+[.,]\d{2}(?:\s*(?:\(includes?[^)]*\)|\+\s*\$0[.,]\d{2}\s*service fee))?/g, "");
  // "$X.XX total (includes $0.99 fee)"
  out = out.replace(/\$\d+[.,]\d{2}\s*(?:total|grand total)\s*(?:\(includes?[^)]*\))?/gi, "");
  // "comes to $X.XX", "that'll be $X.XX"
  out = out.replace(/\b(?:comes to|that['’]ll be|that will be|you owe|adds up to|comes out to)\s*\$\d+[.,]\d{2}/gi, "");
  // "Subtotal: $X.XX" / "Subtotal $X.XX"
  out = out.replace(/\b[Ss]ubtotal[\s:]*\$\d+[.,]\d{2}/g, "");
  // "+ $0.99 service fee" / "$0.99 service fee"
  out = out.replace(/(?:\+\s*)?\$0[.,]\d{2}\s*(?:service\s+)?fee/gi, "");
  // "I've got X items in your cart" / "X items in your cart"
  out = out.replace(/\b(?:I['’]ve got|you['’]ve got|you have|that['’]s|there are|there's|we're at|I see)\s*\d+\s+items?(?:\s+(?:in\s+(?:your|the)\s+cart|so far|total))?/gi, "");
  // "X items" standalone on its own line
  out = out.replace(/^\d+\s+items?(?:\s*(?:in\s+(?:your|the)\s+cart|so far|total))?$/gim, "");

  // Collapse multiple spaces and trim
  out = out.replace(/\s{2,}/g, " ").replace(/^[,.\s]+|[,.\s]+$/g, "").trim();

  // BUG-2 FIX (2026-09-04): stripping a total can orphan the dash that
  // introduced it ("Fries — $21.49 total." → "Fries — ."). Repair before return.
  out = repairOrphanedPunctuation(out);

  return out;
}

// ─── Deterministic order guards ───────────────────────────────────────────────

// Build a vocabulary set from all menu item names (words > 2 chars, lowercase).
// Used by menu-grounding guards to detect when the LLM invents portion/container
// words that don't appear on the actual menu.
function buildMenuVocabulary(menu: EffectiveMenuItem[]): Set<string> {
  const vocab = new Set<string>();
  for (const item of menu) {
    const words = item.name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
    for (const w of words) vocab.add(w);
  }
  return vocab;
}

// Guard 1b helper: detects off-menu portion/container words in the reply.
// Common container/portion words NOT present in the shop's menu vocabulary are
// flagged when adjacent to words that ARE in the menu vocabulary (meaning the
// LLM is describing a real item using invented language).
const OFF_MENU_PORTION_WORDS = [
  "tub", "pint", "quart", "scoop",
  "jar", "carton", "baggie", "jug", "crock",
  "bowl", "container",
];

function claimsOffMenuPortion(reply: string, menuVocab: Set<string>): { tripped: boolean; offWord?: string } {
  if (!reply || menuVocab.size === 0) return { tripped: false };
  const words = reply.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const replyWordSet = new Set(words);
  const hasMenuWord = words.some(w => menuVocab.has(w));
  if (!hasMenuWord) return { tripped: false };
  const offWord = words.find(w => OFF_MENU_PORTION_WORDS.includes(w) && !menuVocab.has(w));
  return offWord ? { tripped: true, offWord } : { tripped: false };
}

// ─── F1 (2026-08-29): Menu-item hallucination detection ───────────────────
// Maps canonical lowercased menu names to display names, including last-word
// variants for customer shorthand (e.g. "stromboli" → "Special Stromboli").
/**
 * Words that describe a size, a format, or a whole course rather than a
 * specific dish. Never usable as a one-word alias for a menu item: matching
 * them produces confident nonsense ("large" → 'Cheese - Large (16")').
 */
const GENERIC_LAST_WORDS = new Set([
  "large", "medium", "small", "regular", "mini", "jumbo", "giant", "personal",
  "half", "whole", "single", "double", "triple", "side", "sides", "plain",
  "pizza", "pizzas", "pie", "pies", "roll", "rolls", "wrap", "wraps", "sub",
  "subs", "sandwich", "sandwiches", "salad", "salads", "soup", "soups",
  "platter", "platters", "combo", "combos", "special", "specials", "dinner",
  "lunch", "breakfast", "meal", "meals", "plate", "plates", "basket",
  "pieces", "piece", "order", "orders", "cup", "bowl", "slice", "slices",
]);

function buildMenuItemNames(menu: EffectiveMenuItem[]): Map<string, string> {
  const names = new Map<string, string>();

  // Pass 1: detect duplicate canonical names across different rows (same name,
  // different id → same-name collision). The set push pattern ensures we know
  // which names need category disambiguation BEFORE building the map.
  const nameCount = new Map<string, number>();
  for (const item of menu) {
    const full = item.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    nameCount.set(full, (nameCount.get(full) || 0) + 1);
  }
  const duplicateNames = new Set(
    [...nameCount.entries()].filter(([, c]) => c > 1).map(([n]) => n),
  );

  // How many distinct menu items contain each word? A one-word alias is only
  // safe when the word belongs to exactly ONE dish. "scampi" identifies Shrimp
  // Scampi; "cheese" appears in Cheese - Large, Cheese - Medium, Grilled
  // Cheese, Cheesesteak and Cheese Ravioli, so it identifies nothing.
  // Aliasing it made "large cheese pizza and garlic knots" produce
  // "Want me to add the Grilled Cheese too?" — an item nobody mentioned.
  const wordItemCount = new Map<string, number>();
  for (const item of menu) {
    const words = new Set(
      item.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' '),
    );
    for (const w of words) wordItemCount.set(w, (wordItemCount.get(w) || 0) + 1);
  }

  for (const item of menu) {
    const full = item.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const catShort = (item.category ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

    // Always register by ID (unique).
    names.set(item.id.toLowerCase(), item.name);

    if (duplicateNames.has(full)) {
      // Qualify with category to avoid overwrites: "tuna (salads)" vs "tuna (wraps)".
      const qualified = `${full} (${catShort})`;
      names.set(qualified, item.name);
      // Also register the unqualified name so broad queries still find SOMETHING,
      // but only for the FIRST item (others are only reachable via qualified).
      if (!names.has(full)) names.set(full, item.name);
    } else {
      names.set(full, item.name);
    }

    // Last-word alias, so "scampi" finds "Shrimp Scampi". Deliberately NOT
    // applied to size/format/generic words.
    //
    // 2026-09-05: this registered the bare word "large" as an alias for
    // 'Cheese - Large (16")' (normalised "cheese large 16" → last word "large").
    // A customer typing "large pepperoni and a side of garlic knots" therefore
    // matched Cheese - Large AND the Pepperoni stromboli, and Guard 4 asked
    // 'Did you also want cheese - large (16"), and pepperoni, or good to go?' —
    // offering back, in mangled form, the thing they had just asked for. A word
    // this generic identifies a SIZE, never a dish.
    const parts = full.split(' ').filter(w => w.length >= 3);
    if (parts.length > 1) {
      const lastName = parts[parts.length - 1];
      const unique = (wordItemCount.get(lastName) ?? 0) === 1;
      if (unique && !GENERIC_LAST_WORDS.has(lastName) && !names.has(lastName)) {
        names.set(lastName, item.name);
      }
    }
  }
  return names;
}

function claimsOffMenuItem(
  reply: string,
  menuItemNames: Map<string, string>,
  guardCart: AnyCartItem[],
): string | null {
  if (!reply || menuItemNames.size === 0) return null;
  const lowerReply = reply.toLowerCase();
  const cartItemNames = guardCart.map(i =>
    (i as BundleItem).type === "bundle" ? (i as BundleItem).name.toLowerCase() : (i as CartItem).name.toLowerCase()
  );
  const STOP = new Set(["change","restart","pickup","delivery","your","order","cart","total",
    "subtotal","service","fee","tip","driver","name","phone","number","address"]);

  const claimPatterns = [
    /(?:we\s+have|i\s+(?:can\s+)?(?:add|offer|recommend)|how\s+about|would\s+you\s+like|try\s+our|we\s+(?:carry|offer))\s+(?:a|an|some|the)?\s+([\w\s&'-]{3,40}?)(?:\s+for|\s+to|\s+at|\s*$|[.!?])/gi,
    /added\s+(?:a|an|some|the)?\s+([\w\s&'-]{3,40}?)\s+to\s+(?:your\s+)?cart/gi,
    /([\w\s&'-]{3,30}?)\s+(?:is|are)\s+\$\d/gi,
  ];

  for (const re of claimPatterns) {
    re.lastIndex = 0;
    for (let m = re.exec(reply); m !== null; m = re.exec(reply)) {
      let claimed = m[1].toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (claimed.length < 3 || STOP.has(claimed)) continue;
      if (cartItemNames.some(n => n.includes(claimed) || claimed.includes(n))) continue;
      const menuMatch = [...menuItemNames.keys()].find(k =>
        k.includes(claimed) || claimed.includes(k)
      );
      if (!menuMatch) {
        console.warn(`[chat-sms] F1 claimsOffMenuItem: claimed "${claimed}" not found in menu`);
        return claimed;
      }
    }
  }
  return null;
}

// Guard 1e helper: detects when the reply offers a format/size upgrade
// (e.g. "upgrade to a flagel or wrap") for an item that does NOT list that
// modifier. Deterministic: modifier availability comes from each item's
// modifiers_json. Only trips when the reply names an item AND offers a
// modifier that item genuinely lacks — so it cannot fire on legitimate offers.
function offersUngroundedUpgrade(
  reply: string,
  menu: EffectiveMenuItem[],
): { tripped: boolean; term?: string } {
  if (!reply) return { tripped: false };
  const lower = reply.toLowerCase();

  // Map distinctive modifier word -> full item names (lowercased) that HAVE it.
  const STOP = new Set(["upgrade","plain","wheat","white","small","large","choose","select","option","extra","side","with","your"]);
  const termToItems = new Map<string, string[]>();
  for (const item of menu) {
    const nm = item.name.toLowerCase();
    for (const mod of item.modifiers_json ?? []) {
      for (const w of mod.name.toLowerCase().split(/[^a-z]+/).filter(x => x.length >= 4)) {
        if (STOP.has(w)) continue;
        const arr = termToItems.get(w) ?? [];
        arr.push(nm);
        termToItems.set(w, arr);
      }
    }
  }
  if (termToItems.size === 0) return { tripped: false };

  // Which menu items are named in the reply?
  const namedItems = menu
    .filter(it => lower.includes(it.name.toLowerCase()))
    .map(it => it.name.toLowerCase());
  if (namedItems.length === 0) return { tripped: false }; // can't attribute → no trip

  // Look for upgrade-offer phrasing followed by a guarded modifier term.
  const offerRe = /(?:upgrade to|make it|want it (?:on|as)|on a|as a|swap (?:it )?(?:to|for))\s+(?:a |an )?([a-z]+)/g;
  let m: RegExpExecArray | null;
  while ((m = offerRe.exec(lower)) !== null) {
    const term = m[1];
    const owners = termToItems.get(term);
    if (!owners) continue; // not a real menu modifier term → ignore
    const grounded = namedItems.some(n => owners.includes(n));
    if (!grounded) return { tripped: true, term };
  }
  return { tripped: false };
}

// Guard 2b helper: detects LLM claims about items being in the cart that don't
// match the authoritative cart state. Returns the claimed item name, or null.
function claimsItemInCart(reply: string, guardCart: AnyCartItem[]): string | null {
  if (!reply) return null;

  // If cart is empty, ANY assertion of cart contents is a hallucination.
  if (guardCart.length === 0) {
    if (/\b(?:in\s+(?:your|the)\s+cart|already\s+(?:have|in|added)|you\s+(?:have|got).*(?:in\s+(?:your|the)\s+cart))\b/i.test(reply)) {
      return "(empty cart)";
    }
    return null;
  }

  // Cart has items — extract what the LLM claims is in the cart and verify.
  //
  // CHANGE 3 (2026-09-05, Jason): every pattern now REQUIRES the literal phrase
  // "in your/the cart". Pattern 2 used to make that suffix optional against a
  // lazy capture, so plain English tripped it: "I can add it if you have a
  // preference" matched "you have a pr" and was reported as a claim that an item
  // called "pr" was in the cart. On 2026-09-05 that discarded the model's honest
  // answer to "you're not really checking with the kitchen, you're a bot" and
  // shipped a cart recital instead — the customer's direct question went
  // unanswered. Pattern 3's bare "already" alternative had the same shape.
  // A cart-content claim says "in your cart". Nothing else is one.
  const patterns = [
    /(?:one\s+)?(["']?[A-Za-z][\w\s&'-]{1,40}?)(?:\s+is\s+)?(?:already\s+)?in\s+(?:your|the)\s+cart/i,
    /you\s+(?:already\s+)?have\s+(?:a\s+|an\s+|the\s+)?(["']?[A-Za-z][\w\s&'-]{1,40}?)\s+in\s+(?:your|the)\s+cart/i,
    /i['"]?(?:ve|\s+have)\s+(?:already\s+)?(?:got\s+)?(?:a\s+)?(["']?[A-Za-z][\w\s&'-]{1,40}?)\s+(?:already\s+)?in\s+(?:your|the)\s+cart/i,
  ];

  for (const re of patterns) {
    const m = reply.match(re);
    if (!m) continue;
    const claimed = m[1].replace(/["']/g, '').trim();
    // A one- or two-letter fragment is never a menu item name; it is the regex
    // catching a preposition. Require enough characters to be a real claim.
    if (claimed.length < 4) continue;
    // CHANGE 2 (2026-09-04, Jason): an item COUNT is not an item NAME. These
    // patterns capture "You've got 3 items in your cart" as a claim that an
    // item literally called "3 items" is in the cart, so a TRUE statement was
    // flagged as a hallucination and the whole reply was thrown away. Verify a
    // count as a count: right number, no hallucination.
    const countClaim = claimed.match(/\b(\d+)\s+items?\b/i);
    if (countClaim) {
      if (Number(countClaim[1]) === guardCart.length) continue; // truthful
      return claimed;                                           // wrong count
    }
    const cartNames = guardCart.map(i =>
      (i as BundleItem).type === "bundle" ? (i as BundleItem).name : (i as CartItem).name
    );
    const found = cartNames.some(n =>
      n.toLowerCase().includes(claimed.toLowerCase()) ||
      claimed.toLowerCase().includes(n.toLowerCase())
    );
    if (!found) return claimed;
  }

  return null;
}

// Guard 1d helper `claimsAddedWithoutMutation` lives in ./phantom-add-guard.ts
// (pure + unit-tested; see guard-phantom-add.test.ts). Imported at top of file.

// Guard 1 helper: detects dollar amounts quoted when the cart is empty.
// Only fires when cart is empty; a non-empty cart quoting its total is fine.
function claimsTotal(text: string): boolean {
  if (!text) return false;
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    /\$\d+\.?\d*\s*(?:total|plus|each|comes to|would be|will be|is|cost|for that|covers)/i.test(norm) ||
    /(?:total|subtotal|comes to|that'?s|that is|cost|price)\s*(?:\$|of\s*\$)\s*\d+/i.test(norm) ||
    /(?:comes to|totals?|brings? your|your total|order total|that'?ll be|that will be)\s*\$?\s*\d+/i.test(norm)
  );
}

// Helper: extract dollar amounts from text (returns array of cents)
function extractDollarCents(text: string): number[] {
  const matches = text.matchAll(/\$(\d+(?:\.\d{2})?)/g);
  const cents: number[] = [];
  for (const m of matches) {
    cents.push(Math.round(parseFloat(m[1]) * 100));
  }
  return cents;
}

// Helper: detects "fixed it", "removed that", "that's one now", etc.
// when the model narrates a correction but no cart mutation occurred.
/**
 * CHANGE 2 (2026-09-04, Jason): does the model's reply already acknowledge the
 * cart state?
 *
 * Guard 1f used to REPLACE the model's reply with a flat recital
 * ("Your cart: 1x Cheese - Large (16"), 1x French Fries. What else can I add?")
 * whenever it suspected a narrated correction that never mutated the cart. In a
 * six-turn test it discarded two perfectly coherent replies, because its
 * predicate matches a plain cart listing ("1x ...") next to the word "want".
 *
 * The recital is now a FALLBACK, not a blanket replacement: it is used only when
 * the model produced nothing usable, or wrote something that shows no awareness
 * of what is in the cart. A reply that names an item in the cart, or refers to
 * the cart/order at all, is coherent — send the model's words.
 */
function replyAcknowledgesCart(reply: string, cart: AnyCartItem[]): boolean {
  const text = (reply ?? "").trim();
  if (text.length === 0) return false;

  // Generic cart/order awareness.
  if (/\b(?:cart|order|added|got it|that'?s|so far|total)\b/i.test(text)) return true;

  // Or it names something actually in the cart. Match on the item's most
  // distinctive word so "Cheese - Large (16\")" is recognised in "large cheese".
  const norm = text.toLowerCase();
  for (const item of cart) {
    const name = ((item as CartItem).name ?? (item as BundleItem).name ?? "").toLowerCase();
    if (!name) continue;
    if (norm.includes(name)) return true;
    const words = name.split(/[^a-z0-9]+/).filter(w => w.length > 3);
    if (words.some(w => norm.includes(w))) return true;
  }
  return false;
}

function claimsCorrectedWithoutMutation(reply: string, cartBefore: AnyCartItem[], cartAfter: AnyCartItem[]): boolean {
  if (!reply) return false;
  // If the cart actually changed, the correction was real
  if (JSON.stringify(cartBefore) !== JSON.stringify(cartAfter)) return false;
  const norm = reply.toLowerCase();
  return (
    /\b(?:fixed|corrected|updated|changed|adjusted|removed|took\s+(?:that|it)\s+off|took\s+(?:that|it)\s+out)\b/i.test(norm) ||
    /\b(?:just\s+one|only\s+one|1x|one\s+(?:left|now|total)|that'?s\s+one)\b/i.test(norm) &&
    /\b(?:want|wanted|said|asked|meant|need|needed)\b/i.test(norm)
  );
}

// Guard 2 / Guard 9 helper `impliesOrderConfirmation` now lives in
// guard9-unconsented-affirmation.ts (imported above) — kept with GUARD 9's
// pure decision logic since that guard's internal bare-affirmation gate must
// use the exact same function, not a reimplementation.

// ─── Guard 4 helpers: Under-populated cart backstop ─────────────────────────

/**
 * Detect when the LLM's reply is "closing" — summarizing the order, quoting
 * a total, asking to confirm, or heading to checkout. These are the moments
 * where a missing item in the cart is most dangerous.
 */
function isClosingReply(reply: string): boolean {
  if (!reply) return false;
  const norm = reply.toLowerCase();
  // Check 1: Total-line patterns — dollar amount adjacent to total/summary language.
  const hasTotal = (
    /\$\d+[.,]\d{2}/.test(norm) &&
    /\b(?:total|comes to|that['\u2019]s|that is|that['\u2019]ll be|order (?:total|summary)|your (?:total|order)|subtotal|plus.*fee|all together|grand total)\b/i.test(norm)
  );
  // Check 2: Checkout/confirmation language — the LLM is asking to close.
  const hasCheckoutSignal = (
    /\b(?:confirm\??|ready to check out|ready to check|ready to pay|check(?:-| )?out|place your order|all set|good to go|proceed(?: to (?:pay|checkout|order))?|all good\??|look good\??|looks good\??|that look good|that sound good|how['\u2019]s that look|how['\u2019]s that sound|i['\u2019]ll send|sending your|payment link|your order is|let me know if|just confirm|just let me know)\b/i.test(norm)
  );
  // Check 3: Closing item-count summary (with cart/summary context).
  const hasCountSummary = (
    /\b\d+\s+items?\b/i.test(norm) &&
    /\b(?:in (?:your|the) (?:cart|order)|so far|total(?:ing)?|that['\u2019]s \d+ items?|i['\u2019]ve got|you['\u2019]ve got|you have|your (?:cart|order)|we have)\b/i.test(norm)
  );
  return hasTotal || hasCheckoutSignal || hasCountSummary;
}

/**
 * Walk conversation history and return the set of menu-item display names the
 * customer has referenced. Uses the same canonical-key matching as
 * buildMenuItemNames. Scans the CURRENT user message + all prior user messages
 * that contain ordering conjunctions ("and", "also", etc.) — pure questions
 * ("Do you have coffee?") are excluded from prior-turn scanning to avoid
 * false positives on items the customer merely asked about.
 *
 * The current message is always scanned regardless of form.
 */
function extractCustomerReferencedItems(
  history: Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }>,
  menuNames: Map<string, string>,
): Set<string> {
  const referenced = new Set<string>();
  const userMessages = history
    .filter(h => h.role === "user" && typeof h.content === "string")
    .map(h => (h.content as string).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim());

  for (let i = 0; i < userMessages.length; i++) {
    const msg = userMessages[i];
    const isCurrent = i === userMessages.length - 1;
    // For prior messages, only scan ones that look like orders (contain
    // conjunctions/connectors), not pure questions.
    if (!isCurrent && !/\b(?:and|also|plus|with|then|as well|too)\b/i.test(msg)) continue;

    for (const [key, displayName] of menuNames) {
      // Skip ID-based keys (UUIDs / short hashes) — not natural language.
      if (/^[a-f0-9-]{8,}$/.test(key)) continue;
      if (msg.includes(key)) {
        referenced.add(displayName);
      }
    }
  }
  return referenced;
}

/**
 * Return menu-item display names that the customer referenced but are absent
 * from the cart. Match is bidirectional substring ("Shrimp Scampi" ref matches
 * cart item "Shrimp Scampi", and vice versa).
 */
function findMissingCartItems(
  referencedItems: Set<string>,
  cart: AnyCartItem[],
): string[] {
  // A referenced name is satisfied by ANYTHING already on the cart that
  // means it, not just a cart LINE whose own name matches. Before this fix,
  // ordering "large cheese pizza ... add pepperoni and mushrooms" put
  // pepperoni into the cart as an OPTION CHOICE
  // (options: {"Toppings": ["Pepperoni (Whole pizza)"]}) on the cheese pizza
  // line — never as a line item literally named "Pepperoni". Guard 4 read
  // that as still missing and offered to add pepperoni immediately after
  // adding it (2026-09-06, Jason's Test Kitchen transcript). Modifiers,
  // selected option choices, AND unverified_requests (a customer ask the shop
  // hasn't confirmed a real choice for) all count as "this is on the ticket".
  const cartLower = new Set<string>();
  for (const i of cart) {
    if ((i as BundleItem).type === "bundle") { cartLower.add((i as BundleItem).name.toLowerCase()); continue; }
    const ci = i as CartItem;
    cartLower.add(ci.name.toLowerCase());
    for (const m of ci.modifiers ?? []) cartLower.add(m.toLowerCase());
    for (const selections of Object.values(ci.options ?? {})) {
      for (const sel of selections) cartLower.add(sel.toLowerCase());
    }
    for (const u of ci.unverified_requests ?? []) cartLower.add(u.toLowerCase());
  }

  const missing: string[] = [];
  for (const displayName of referencedItems) {
    const itemLower = displayName.toLowerCase();
    const inCart = [...cartLower].some(cn =>
      cn.includes(itemLower) || itemLower.includes(cn)
    );
    if (!inCart) {
      missing.push(displayName);
    }
  }
  return missing;
}

/**
 * Remove items from the referenced set that appear inside a negated phrase
 * in the current customer message. Safety net — the narrowing-order guard
 * already suppresses prior-history scanning on "just"/"only", but this
 * catches the remaining case where a customer says e.g.
 * "actually, no pepperoni pizza — just the cheese" in the CURRENT message.
 *
 * Prefer under-asking to nagging: when in doubt about a negation, suppress.
 */
function filterNegatedItems(
  referencedItems: Set<string>,
  currentMessage: string,
): Set<string> {
  if (!currentMessage) return referencedItems;
  const msg = currentMessage.toLowerCase();
  const result = new Set<string>();
  for (const displayName of referencedItems) {
    const itemLower = displayName.toLowerCase();
    const escaped = itemLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Patterns: "no <item>", "not <item>", "remove <item>", "skip <item>",
    // "drop <item>", "scratch <item>", "don't want/need/get <item>",
    // "cancel <item>", "i don't want <item>".
    const negRegex = new RegExp(
      `\\b(?:no|not|remove|skip|drop|scratch|removing|skipping|dropping|cancel(?:ling)?|i\\s+don['\\u2019]t\\s+(?:want|need|get))\\s+(?:the\\s+)?(?:any\\s+)?${escaped}\\b|` +
      `\\bdon['\\u2019]t\\s+(?:want|need|get)\\s+(?:the\\s+)?(?:any\\s+)?${escaped}\\b`,
      'i'
    );
    if (!negRegex.test(msg)) {
      result.add(displayName);
    } else {
      console.log(`[chat-sms] GUARD 4 v2 negation-filter: suppressed "${displayName}" (appears in negated context)`);
    }
  }
  return result;
}

function twimlResponse(message: string): Response {
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`,
    { headers: { ...CORS_HEADERS, "Content-Type": "text/xml" } },
  );
}

function emptyTwiml(): Response {
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { ...CORS_HEADERS, "Content-Type": "text/xml" } },
  );
}

// NOTE: currently unused. Kept gated so it can NEVER become an ungated send
// path: it requires an OutboundContext, same as every other call site.
async function smsReply(ctx: OutboundContext, shop: Shop, toNumber: string, message: string): Promise<Response> {
  const replyFrom = shop.reply_from_e164 || shop.phone_number_e164;
  if (!replyFrom) {
    console.error("[chat-sms] No reply number configured for shop");
    return emptyTwiml();
  }
  await sendSmsViaTwilio(ctx, replyFrom, toNumber, message);
  return emptyTwiml();
}

function jsonResponse(data: unknown, status = 200): Response {
  const body = (data && typeof data === "object" && typeof (data as Record<string, unknown>).reply === "string")
    ? { ...(data as Record<string, unknown>), reply: stripEmDashes((data as Record<string, unknown>).reply as string) }
    : data;
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

function getBusinessDate(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === "year")?.value  ?? "";
    const m = parts.find(p => p.type === "month")?.value ?? "";
    const d = parts.find(p => p.type === "day")?.value   ?? "";
    return `${y}-${m}-${d}`;
  } catch {
    return new Date().toISOString().split("T")[0];
  }
}

function getCurrentTime(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true,
    }).format(new Date());
  } catch {
    return new Date().toLocaleTimeString();
  }
}

// Day-of-week KEY (mon/tue/...) in the SHOP'S local timezone. Using
// new Date().getDay() returns the SERVER (UTC) day, which can be wrong near
// midnight — e.g. 11:30pm Sun in America/New_York is already Mon in UTC, so the
// bot would read Monday's hours on a Sunday night. open_hours is keyed by the
// shop's local day, so the lookup must use the shop's local day too.
function getBusinessDayKey(timezone: string): string {
  const dayMap: Record<string, string> = {
    Sun: "sun", Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat",
  };
  try {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date());
    return dayMap[wd] ?? wd.slice(0, 3).toLowerCase();
  } catch {
    const fallback = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    return fallback[new Date().getDay()];
  }
}

// Current minutes-since-midnight in the shop's local timezone (0–1439).
// Computed from formatted local parts so it is correct regardless of where the
// function runs (no reliance on server timezone or Date parsing quirks).
function getLocalMinutes(timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const h = Number(parts.find(p => p.type === "hour")?.value ?? "0") % 24;
    const m = Number(parts.find(p => p.type === "minute")?.value ?? "0");
    return h * 60 + m;
  } catch {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }
}

async function saveMessage(
  supabase:       SupabaseClient,
  conversationId: string,
  tenantId:       string,
  role:           "customer" | "assistant" | "system",
  content:        string,
  messageSid?:    string,
): Promise<{ inserted: boolean }> {
  const { error } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    tenant_id: tenantId,
    role,
    content,
    ...(messageSid ? { message_sid: messageSid } : {}),
  });
  if (error) {
    // 23505 = unique_violation → duplicate message_sid, already processed
    if (error.code === "23505") return { inserted: false };
    console.error("[chat-sms] Failed to save message:", error.message);
  }
  return { inserted: true };
}

// ─── System event handler ────────────────────────────────────────────────────

// STRUCTURAL OUTBOUND WATCHDOG: every customer-facing SMS send goes through
// the guard. The signature REQUIRES an OutboundContext as its first argument,
// so a call site cannot reach Twilio without declaring a valid reason. The real
// network call lives inside guardedSend's `deliver` closure and runs ONLY on
// ALLOW; on DENY the guard logs CRITICAL and nothing leaves the system.
async function sendSmsViaTwilio(
  ctx:        OutboundContext,
  fromNumber: string,
  toNumber:   string,
  message:    string,
): Promise<void> {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const authToken  = Deno.env.get("TWILIO_AUTH_TOKEN")  ?? "";

  if (!accountSid || !authToken) {
    console.error("[chat-sms] Twilio credentials not configured");
    return;
  }

  const { sent } = await guardedSend({ ...ctx, to: toNumber }, async () => {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method:  "POST",
        headers: {
          "Authorization": `Basic ${btoa(`${accountSid}:${authToken}`)}`,
          "Content-Type":  "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: fromNumber,
          To: toNumber,
          Body: message,
          ...(Deno.env.get("TWILIO_MESSAGING_SERVICE_SID")
            ? { MessagingServiceSid: Deno.env.get("TWILIO_MESSAGING_SERVICE_SID")! }
            : {}),
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[chat-sms] Twilio send failed: ${res.status} ${errText}`);
    } else {
      console.log(`[chat-sms] SMS sent to ${toNumber}`);
    }
  });

  if (!sent) {
    // Watchdog blocked it. Already logged CRITICAL inside the guard.
    console.warn(`[chat-sms] OUTBOUND BLOCKED by watchdog (reason=${ctx.reason}); no SMS sent.`);
  }
}

// ─── Telnyx outbound ────────────────────────────────────────────────────────

async function sendSmsViaTelnyx(
  supabase:   SupabaseClient,
  shopId:     string,
  ctx:        OutboundContext,
  fromNumber: string,
  toNumber:   string,
  message:    string,
): Promise<void> {
  const apiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  if (!apiKey) {
    console.error("[chat-sms] Telnyx API key not configured");
    return;
  }

  const { sent } = await guardedSend({ ...ctx, to: toNumber }, async () => {
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: fromNumber, to: toNumber, text: message }),
    });

    if (res.ok) {
      console.log(`[chat-sms] SMS sent to ${toNumber} via Telnyx`);
      return;
    }

    const errText = await res.text();
    let errCode: string | undefined;
    let errDetail: string | undefined;
    try {
      const errJson = JSON.parse(errText);
      errCode = errJson?.errors?.[0]?.code;
      errDetail = errJson?.errors?.[0]?.detail ?? errJson?.errors?.[0]?.title;
    } catch { /* not JSON */ }

    // Opt-out / blocked detection: Telnyx rejects sends to opted-out numbers.
    // Known opt-out codes: 40002 (blocked/opted-out), 40003 (messaging profile blocked).
    // 10036 = campaign not approved (pre-send system/delivery error) — NOT an opt-out.
    // Do NOT persist opt-out state or close the conversation for 10036.
    if (classifyTelnyxSendError(errCode) === "transient") {
      console.warn(
        `[chat-sms] Telnyx send TRANSIENT DELIVERY ERROR to=${toNumber} ` +
        `code=${errCode} detail=${errDetail ?? "(none)"} — campaign/system issue, not an opt-out. Conversation stays open.`,
      );

      // 10036 escalation: non-test shops that hit 10036 have structurally
      // undeliverable A2P traffic. Raise a critical issue so Command Center
      // surfaces it prominently.
      if (errCode === "10036" && shopId) {
        const { data: shopInfo } = await supabase
          .from("shops")
          .select("is_test, campaign_assignment_status, name")
          .eq("id", shopId)
          .maybeSingle();

        if (shopInfo && shopInfo.is_test !== true) {
          if (shopInfo.campaign_assignment_status !== "approved") {
            // Expected: campaign not approved — escalate so the operator sees
            // the structural gap. The campaign-status-reader will advance it
            // to approved once both mapping statuses read ADDED.
            const { data: existingIssue } = await supabase
              .from("issues")
              .select("id")
              .eq("detection_rule", "campaign_not_approved")
              .eq("tenant_id", shopId)
              .eq("status", "open")
              .limit(1);
            if (!existingIssue || existingIssue.length === 0) {
              await supabase.from("issues").insert({
                tenant_id: shopId,
                shop_id: shopId,
                severity: "sev_1",
                detection_rule: "campaign_not_approved",
                title: `Campaign assignment not approved for ${shopInfo.name ?? shopId}`,
                description:
                  `Telnyx returned 10036 (campaign not approved) for outbound SMS from ${fromNumber} to ${toNumber}. ` +
                  `campaign_assignment_status is "${shopInfo.campaign_assignment_status}". ` +
                  `The campaign-status-reader polls mapping status automatically — no manual action needed unless this ` +
                  `persists beyond 2 hours after number provision.`,
                metadata: {
                  from_number: fromNumber,
                  to_number: toNumber,
                  campaign_assignment_status: shopInfo.campaign_assignment_status,
                },
              });
              console.warn(
                `[chat-sms] Raised campaign_not_approved issue for shop ${shopId} (status=${shopInfo.campaign_assignment_status})`,
              );
            }
          } else {
            // Unexpected: campaign is approved but 10036 still returned.
            // This should not happen — escalate as a mystery.
            const { data: existingIssue } = await supabase
              .from("issues")
              .select("id")
              .eq("detection_rule", "campaign_10036_unexpected")
              .eq("tenant_id", shopId)
              .eq("status", "open")
              .limit(1);
            if (!existingIssue || existingIssue.length === 0) {
              await supabase.from("issues").insert({
                tenant_id: shopId,
                shop_id: shopId,
                severity: "sev_1",
                detection_rule: "campaign_10036_unexpected",
                title: `Unexpected 10036 — campaign approved but Telnyx refused for ${shopInfo.name ?? shopId}`,
                description:
                  `Telnyx returned 10036 (campaign not approved) for outbound SMS from ${fromNumber} to ${toNumber}, ` +
                  `but campaign_assignment_status is ALREADY "approved". This is unexpected — investigate. ` +
                  `The mapping status may have changed since the last status-reader run.`,
                metadata: {
                  from_number: fromNumber,
                  to_number: toNumber,
                  campaign_assignment_status: shopInfo.campaign_assignment_status,
                },
              });
              console.error(
                `[chat-sms] Raised campaign_10036_unexpected issue for shop ${shopId} — status is already approved!`,
              );
            }
          }
        }
        // is_test shops: 10036 is expected (demo number rides shared brand, not
        // individually campaign-approved). Don't raise an issue.
      }

      return;
    }
    if (classifyTelnyxSendError(errCode) === "opt_out") {
      console.warn(
        `[chat-sms] Telnyx send BLOCKED (likely opt-out) to=${toNumber} ` +
        `code=${errCode} detail=${errDetail ?? "(none)"}`,
      );
      // Persist opt-out state: update conversation metadata + durable table
      if (shopId && toNumber) {
        await persistTelnyxOptOut(supabase, shopId, toNumber, errCode, errDetail);
        await upsertOptOut(supabase, shopId, toNumber, `telnyx_reject:${errCode ?? "unknown"}`);
      }
    } else {
      console.error(`[chat-sms] Telnyx send failed: ${res.status} ${errText}`);
    }
  });

  if (!sent) {
    console.warn(`[chat-sms] OUTBOUND BLOCKED by watchdog (reason=${ctx.reason}); no SMS sent.`);
  }
}

/** Persist opt-out state when Telnyx rejects a send to an opted-out number. */
async function persistTelnyxOptOut(
  supabase: SupabaseClient,
  shopId:   string,
  toNumber: string,
  errCode:  string | undefined,
  errDetail: string | undefined,
): Promise<void> {
  // Store in the most recent active conversation for this (shop, phone) pair.
  const key = `telnyx_opt_out:${errCode ?? "unknown"}`;
  const { data: convs } = await supabase
    .from("conversations")
    .select("id, metadata")
    .eq("tenant_id", shopId)
    .eq("customer_phone", toNumber)
    .eq("status", "active")
    .order("last_message_at", { ascending: false })
    .limit(1);

  const conv = convs?.[0];
  if (!conv) {
    console.warn(`[chat-sms] persistTelnyxOptOut: no active conversation for ${toNumber} in shop ${shopId}`);
    return;
  }

  const meta = (conv.metadata ?? {}) as Record<string, unknown>;
  meta.opted_out = true;
  meta.opted_out_at = new Date().toISOString();
  meta.opted_out_reason = `telnyx_reject:${errCode}:${errDetail ?? ""}`;
  meta[key] = new Date().toISOString();

  const { error } = await supabase
    .from("conversations")
    .update({ metadata: meta, status: "resolved" })
    .eq("id", conv.id);

  if (error) {
    console.error(`[chat-sms] persistTelnyxOptOut: failed to update conversation ${conv.id}:`, error.message);
  } else {
    console.log(`[chat-sms] persistTelnyxOptOut: opted out ${toNumber} shop=${shopId} code=${errCode}`);
  }
}

/**
 * Upsert into sms_opt_outs — durable per-(phone, tenant) opt-out.
 * Called from: proactive STOP handlers, Telnyx rejection path, and web STOP.
 *
 * The UNIQUE constraint on (tenant_id, customer_phone) makes this idempotent.
 * opted_back_at is only cleared when the customer texts START — see the START
 * handler which calls upsertOptOut with reason="start".
 */
async function upsertOptOut(
  supabase: SupabaseClient,
  tenantId:  string,
  phone:     string,
  reason:    string, // "proactive_stop", "telnyx_reject:40002", "start"
): Promise<void> {
  if (!tenantId || !phone) return;

  try {
    if (reason === "start") {
      // Customer texted START — mark as opted back in.
      const { error } = await supabase
        .from("sms_opt_outs")
        .update({ opted_back_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("customer_phone", phone)
        .is("opted_back_at", null);
      if (error) {
        console.error(`[chat-sms] upsertOptOut START failed for ${phone} shop=${tenantId}:`, error.message);
      } else {
        console.log(`[chat-sms] upsertOptOut START: ${phone} shop=${tenantId}`);
      }
    } else {
      // Opt-out: UPSERT to handle repeat STOPs or Telnyx-reject after proactive STOP.
      const { error } = await supabase
        .from("sms_opt_outs")
        .upsert({
          tenant_id:        tenantId,
          customer_phone:   phone,
          opted_out_at:     new Date().toISOString(),
          opted_out_reason: reason,
          opted_back_at:    null,
          updated_at:       new Date().toISOString(),
        }, { onConflict: "tenant_id, customer_phone" });
      if (error) {
        console.error(`[chat-sms] upsertOptOut failed for ${phone} shop=${tenantId}:`, error.message);
      } else {
        console.log(`[chat-sms] upsertOptOut: ${phone} shop=${tenantId} reason=${reason}`);
      }
    }
  } catch (e) {
    // Non-fatal: the STOP reply still goes out, and Telnyx has its own enforcement.
    console.error(`[chat-sms] upsertOptOut error for ${phone}:`, e);
  }
}

/** Check whether a (phone, tenant) pair is currently opted out. */
async function isOptedOut(
  supabase: SupabaseClient,
  tenantId: string,
  phone:    string,
): Promise<boolean> {
  if (!tenantId || !phone) return false;
  try {
    const { data, error } = await supabase
      .from("sms_opt_outs")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("customer_phone", phone)
      .is("opted_back_at", null)
      .maybeSingle();
    if (error) {
      console.error(`[chat-sms] isOptedOut query error for ${phone}:`, error.message);
      return false; // Fail open — let Telnyx be the backstop.
    }
    return !!data;
  } catch {
    return false;
  }
}

// ─── SMS dispatcher ─────────────────────────────────────────────────────────

/**
 * Single routing function for all outbound SMS. Routes to Telnyx or Twilio
 * based on the provider argument. Always wraps in guardedSend (via the
 * per-provider send functions).
 */
async function sendSms(
  supabase:  SupabaseClient,
  shopId:    string,
  ctx:       OutboundContext,
  provider:  SmsProvider,
  fromNumber: string,
  toNumber:   string,
  message:    string,
): Promise<void> {
  const cleaned = stripEmDashes(message);
  if (provider === "telnyx") {
    await sendSmsViaTelnyx(supabase, shopId, ctx, fromNumber, toNumber, cleaned);
  } else {
    await sendSmsViaTwilio(ctx, fromNumber, toNumber, cleaned);
  }
}

export async function handleSystemEvent(
  supabase:    SupabaseClient,
  body:        { system_event?: string; conversation_id?: string; order_cart_id?: string },
): Promise<Response> {
  const { system_event, conversation_id, order_cart_id } = body;
  if (!system_event || !conversation_id || !order_cart_id) {
    return jsonError("system_event, conversation_id, and order_cart_id are required");
  }

  const { data: cartRow } = await supabase
    .from("order_carts")
    .select("*, shops(*)")
    .eq("id", order_cart_id)
    .single();

  if (!cartRow) return jsonError("Cart not found", 404);
  const shop = cartRow.shops as Shop;

  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, channel, customer_phone, tenant_id, metadata")
    .eq("id", conversation_id)
    .single();

  if (!conversation) return jsonError("Conversation not found", 404);

  let message: string;

  // ── ALLOWED TRANSACTIONAL EXCEPTIONS (lead directive 2026-06-22) ──────────
  // Only payment_confirmed (paid receipt) and order_refunded (refund notice)
  // may produce a customer-facing push. Both directly follow the customer's
  // OWN action and are consented transactional messages. Every other
  // unsolicited system_event outbound is KILLED (see payment_expired below).
  if (system_event === "payment_confirmed") {
    // ALLOWED EXCEPTION #1 of 2: paid-order receipt (customer just paid).
    const items = (cartRow.cart_json as AnyCartItem[]).map((i: AnyCartItem) => {
      if ((i as BundleItem).type === "bundle") return (i as BundleItem).name;
      const r = i as CartItem;
      return `${(r.quantity || 1)}x ${r.name}`;
    }).join(", ");
    const subtotal   = ((cartRow.subtotal_cents ?? 0) / 100).toFixed(2);
    const serviceFee  = ((cartRow.service_fee_cents ?? 0) / 100).toFixed(2);
    const total  = ((cartRow.total_cents ?? 0) / 100).toFixed(2);
    const pickup = cartRow.pickup_name ? ` for ${cartRow.pickup_name}` : "";
    // Reconciliation line shown only when a service fee was charged (new orders).
    const feeLine = (cartRow.service_fee_cents ?? 0) > 0
      ? ` (Subtotal $${subtotal} + Service fee $${serviceFee})`
      : "";

    const today    = getBusinessDayKey(shop.timezone);
    const hours    = dayWindows(shop.open_hours?.[today]);
    const fmt12Confirm = (t: string) => { const [h, m] = t.split(":").map(Number); const ampm = h >= 12 ? "p.m." : "a.m."; const h12 = h % 12 || 12; return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2,"0")} ${ampm}`; };
    const hoursStr = hours.length > 0
      ? hours.map((h: { open: string; close: string }) => `${fmt12Confirm(h.open)}-${fmt12Confirm(h.close)}`).join(", ")
      : "see our hours for details";

    const orderNum = cartRow.order_number ? ` ORDER #${cartRow.order_number} ` : " ";
    const closeTime = hours.length > 0 ? fmt12Confirm(hours[hours.length - 1].close) : null;
    const closePart  = closeTime ? ` (we're open til ${closeTime})` : "";
    message = `Payment confirmed!${orderNum}Order${pickup}: ${items}. Total: $${total}${feeLine}. Give us about 10 - 15 minutes for pick up${closePart}. Thank you for your business!!`;
  } else if (system_event === "payment_expired") {
    // KILLED (TCPA/10DLC, lead directive 2026-06-22): a checkout link expiring
    // is NOT a customer action. We never push an unsolicited "your link
    // expired" text. The upstream stripe-webhook no longer enqueues this; this
    // branch is kept ONLY as a fail-closed guard so any stray call produces NO
    // outbound. If the customer texts again with an expired link, the normal
    // inbound reply path handles it synchronously ("that link expired — want to
    // reorder?").
    return jsonResponse({ ok: true, silent: true, killed: "payment_expired_outbound" });
  } else if (system_event === "order_refunded") {
    // ALLOWED EXCEPTION #2 of 2: refund notice (customer's paid order refunded).
    const refunded = ((cartRow.refunded_cents ?? 0) / 100).toFixed(2);
    message = `A refund of $${refunded} has been issued for your order. It may take a few business days to appear on your statement.`;
  } else if (system_event === "order_disputed") {
    // Internal/shop-facing event; no diner-facing copy needed, but ack so the
    // webhook's notify call succeeds. Keep diner messaging silent here.
    message = ``;
  } else {
    return jsonError(`Unknown system event: ${system_event}`);
  }

  // Silent events (e.g. order_disputed) produce no diner-facing message.
  if (!message) {
    return jsonResponse({ ok: true, silent: true });
  }

  await saveMessage(supabase, conversation_id, conversation.tenant_id, "assistant", message);

  // ── Order ticket email (payment_confirmed only) ──────────────────────────
  //
  // send-then-claim pattern: serialize concurrent callers using a SHORT-LIVED
  // ticket_send_attempt_at claim (NOT ticket_emailed_at). ticket_emailed_at is
  // set ONLY after a confirmed 2xx from Resend. The old claim-before-send
  // pattern would burn the slot on a failed send with no retry and no alarm.
  //
  // Failure modes guarded:
  //   A) Resend non-2xx / throw → retry up to 3x inline (~2 min total),
  //      then clear attempt_at and raise a CRITICAL issue for the issue-detector
  //      to re-drive later. No silent ticket loss.
  //   B) NULL email_ticket_recipient on a paid order → write CRITICAL issue
  //      immediately (no destination to send to).
  if (system_event === "payment_confirmed") {
    if (!shop.email_ticket_recipient) {
      // B) No destination — CRITICAL issue, not a silent skip.
      const { data: existingIssue } = await supabase
        .from("issues")
        .select("id")
        .eq("detection_rule", "ticket_no_destination")
        .eq("tenant_id", conversation.tenant_id)
        .eq("conversation_id", conversation_id)
        .eq("status", "open")
        .limit(1);
      if (!existingIssue || existingIssue.length === 0) {
        await supabase.from("issues").insert({
          tenant_id: conversation.tenant_id,
          shop_id: shop.id,
          conversation_id: conversation_id,
          severity: "sev_1",
          detection_rule: "ticket_no_destination",
          title: `Order #${cartRow.order_number ?? cartRow.id} has no ticket destination`,
          description: `Shop "${shop.name}" has no email_ticket_recipient set but received a paid order. The kitchen ticket cannot be sent. Set an email recipient in shop settings.`,
          metadata: {
            cart_id: order_cart_id,
            order_number: cartRow.order_number ?? null,
            shop_name: shop.name,
            total_cents: cartRow.total_cents ?? null,
          },
        });
        console.error(`[chat-sms] CRITICAL: ticket_no_destination for cart ${order_cart_id} (shop ${shop.id})`);
      }
    } else {
      // ── Serialization: claim ticket_send_attempt_at (short-lived lock) ──
      // Claim if NULL (first caller) OR older than 30s (stale claim from a
      // caller that crashed before clearing). ticket_emailed_at is NOT touched
      // until a 2xx is received.
      const now = new Date().toISOString();
      const staleThreshold = new Date(Date.now() - 30_000).toISOString();
      const { data: claimed } = await supabase
        .from("order_carts")
        .update({ ticket_send_attempt_at: now })
        .eq("id", order_cart_id)
        .or(`ticket_send_attempt_at.is.null,ticket_send_attempt_at.lte.${staleThreshold}`)
        .select("id");
      if (!claimed || claimed.length === 0) {
        console.log(`[chat-sms] ticket send already in progress for cart ${order_cart_id}, skipping`);
      } else {
        // ── Build email payload once (same for each retry attempt) ──
        const emailOrderNum = cartRow.order_number ? `#${cartRow.order_number}` : "";
        const emailTotal = ((cartRow.total_cents ?? 0) / 100).toFixed(2);
        const emailPickup = cartRow.pickup_name ?? "Unknown";
        const emailOrderType = (cartRow.order_type as string) === "delivery" ? "DELIVERY" : "TAKEOUT";
        const emailDeliveryAddr = cartRow.delivery_address as Record<string, unknown> | null;
        const emailDeliveryFormatted = emailDeliveryAddr
          ? ((emailDeliveryAddr.formatted as string) || `${emailDeliveryAddr.street || ""}, ${emailDeliveryAddr.city || ""}, ${emailDeliveryAddr.state || ""} ${emailDeliveryAddr.zip || ""}`.trim().replace(/^, /, "").replace(/, $/, ""))
          : null;
        const etTime = new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "long", timeStyle: "short" });
        const emailNotes = (cartRow.notes as string | null) ?? null;
        const cartItems = (cartRow.cart_json as AnyCartItem[]).map((i: AnyCartItem) => {
          if ((i as BundleItem).type === "bundle") {
            const b = i as BundleItem;
            const bPrice = b.price_cents != null ? `$${(b.price_cents / 100).toFixed(2)}` : "";
            const flavorSub = b.selections?.length
              ? `<br><span style="font-size:11px;color:#888;">${b.selections.map(s => `${s.quantity}\u00d7 ${h(s.flavor)}`).join(", ")}</span>`
              : "";
            return `<tr><td style="padding:6px 8px;">${h(b.name)}${flavorSub}</td><td style="padding:6px 8px;text-align:center;">1</td><td style="padding:6px 8px;text-align:right;">${bPrice}</td></tr>`;
          }
          const r = i as CartItem;
          const linePrice = r.price_cents != null ? `$${((r.price_cents * (r.quantity || 1)) / 100).toFixed(2)}` : "";
          const mods = r.modifiers?.length ? r.modifiers.map(m => h(m)) : [];
          const opts = r.options ? Object.values(r.options).flat().map(o => h(o)) : [];
          const detail = [...new Set([...mods, ...opts])].join(", ");
          const detailSub = detail ? `<br><span style="font-size:11px;color:#888;">${detail}</span>` : "";
          // Not a validated menu selection — kept visually distinct so the kitchen
          // never confuses it for a real option (the Boosenberry-wings defect).
          const unverifiedSub = r.unverified_requests?.length
            ? `<br><span style="font-size:11px;color:#b45309;">customer asked for: ${r.unverified_requests.map(u => h(u)).join(", ")} (not a menu option)</span>`
            : "";
          return `<tr><td style="padding:6px 8px;">${h(r.name)}${detailSub}${unverifiedSub}</td><td style="padding:6px 8px;text-align:center;">${r.quantity || 1}</td><td style="padding:6px 8px;text-align:right;">${linePrice}</td></tr>`;
        }).join("");
        const emailHtml = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f4f4f4;">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#1a1a2e;padding:24px 32px;">
      <h1 style="margin:0;color:#fff;font-size:20px;">${h(shop.name)}</h1>
      <p style="margin:4px 0 0;color:#fff;font-size:14px;font-weight:bold;">${emailOrderNum ? `New ${emailOrderType} Order ${h(emailOrderNum)}` : `New ${emailOrderType} Order`}</p>
    </div>
    <div style="padding:24px 32px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:2px solid #eee;">
            <th style="text-align:left;padding:6px 8px;font-size:13px;color:#666;">Item</th>
            <th style="text-align:center;padding:6px 8px;font-size:13px;color:#666;">Qty</th>
            <th style="text-align:right;padding:6px 8px;font-size:13px;color:#666;">Price</th>
          </tr>
        </thead>
        <tbody>${cartItems}</tbody>
        <tfoot>
          <tr style="border-top:2px solid #eee;">
            <td colspan="2" style="padding:10px 8px;font-weight:bold;">Total</td>
            <td style="padding:10px 8px;text-align:right;font-weight:bold;">$${emailTotal}</td>
          </tr>
        </tfoot>
      </table>
      <div style="margin-top:20px;padding:16px;background:#f8f8f8;border-radius:6px;">
        ${emailOrderNum ? `<p style="margin:0 0 6px;"><strong>Order:</strong> ${h(emailOrderNum)}</p>` : ""}
        ${emailOrderType === "DELIVERY" && emailDeliveryFormatted
          ? `<p style="margin:0 0 6px;"><strong>Delivery Address:</strong> ${h(emailDeliveryFormatted)}</p>`
          : `<p style="margin:0 0 6px;"><strong>Pickup Name:</strong> ${h(emailPickup)}</p>`}
        ${emailNotes ? `<p style="margin:0 0 6px;"><strong>Prep Notes:</strong> ${h(emailNotes)}</p>` : ""}
        <p style="margin:0;"><strong>Time Received:</strong> ${etTime}</p>
      </div>
    </div>
    <div style="padding:16px 32px;background:#f4f4f4;text-align:center;">
      <p style="margin:0;font-size:12px;color:#999;">Powered by SprintAI</p>
    </div>
  </div>
</body>
</html>`;
        // Dedupe subject on order_number (for the same cart, regardless of recipient).
        const emailSubject = `New ${emailOrderType}${emailOrderNum ? ` ${hs(emailOrderNum)}` : ""} \u2014 ${emailOrderType === "DELIVERY" && emailDeliveryFormatted ? hs(emailDeliveryFormatted) : hs(emailPickup)} \u2014 $${emailTotal} \u2014 ${hs(shop.name)}`;

        // ── Bounded retry: up to 3 attempts, ~2 min total inline window ──
        const MAX_ATTEMPTS = 3;
        const resendApiKey = Deno.env.get("RESEND_API_KEY");
        if (!resendApiKey) {
          console.warn("[chat-sms] RESEND_API_KEY not set — skipping order ticket email");
          // Clear the claim so issue-detector can re-drive if the key appears later.
          await supabase.from("order_carts").update({ ticket_send_attempt_at: null }).eq("id", order_cart_id);
        } else {
          let sentOk = false;
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
              const emailResp = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  from: "SprintAI Orders <orders@getsprintai.com>",
                  to: [shop.email_ticket_recipient],
                  subject: emailSubject,
                  html: emailHtml,
                }),
              });

              // ── Log EVERY attempt to ticket_send_log ──
              try {
                let resendMessageId: string | null = null;
                try {
                  const resendBody = await emailResp.clone().json();
                  resendMessageId = (resendBody && typeof resendBody === "object" && "id" in resendBody) ? String((resendBody as Record<string, unknown>).id) : null;
                } catch { /* body may not be JSON or already consumed */ }
                await supabase.from("ticket_send_log").insert({
                  cart_id: order_cart_id,
                  shop_id: shop.id,
                  order_number: cartRow.order_number ?? null,
                  recipient: shop.email_ticket_recipient,
                  resend_message_id: resendMessageId,
                  http_status: emailResp.status,
                  attempt_number: attempt,
                });
              } catch (auditErr) {
                console.error(`[chat-sms] Non-fatal: failed to insert ticket_send_log row (attempt ${attempt}):`, auditErr);
              }

              if (emailResp.ok) {
                // ── Success: mark ticket_emailed_at (the durable success marker) ──
                const successTime = new Date().toISOString();
                await supabase.from("order_carts").update({ ticket_emailed_at: successTime }).eq("id", order_cart_id);
                console.log(`[chat-sms] Order ticket email sent to ${shop.email_ticket_recipient} (attempt ${attempt})`);
                sentOk = true;
                break;
              }

              const errText = await emailResp.text();
              console.error(`[chat-sms] Resend email failed (attempt ${attempt}/${MAX_ATTEMPTS}, HTTP ${emailResp.status}): ${errText}`);
            } catch (emailErr) {
              console.error(`[chat-sms] Resend email threw (attempt ${attempt}/${MAX_ATTEMPTS}):`, emailErr);
            }

            // Backoff before retry (~1s, then ~3s).
            if (attempt < MAX_ATTEMPTS) {
              const delayMs = attempt === 1 ? 1_200 : 3_500;
              await new Promise(r => setTimeout(r, delayMs));
            }
          }

          if (!sentOk) {
            // ── Exhausted all attempts: clear claim, raise CRITICAL issue ──
            console.error(`[chat-sms] CRITICAL: ticket send exhausted after ${MAX_ATTEMPTS} attempts for cart ${order_cart_id}`);
            await supabase.from("order_carts").update({ ticket_send_attempt_at: null }).eq("id", order_cart_id);

            const { data: existingIssue } = await supabase
              .from("issues")
              .select("id")
              .eq("detection_rule", "ticket_send_failed")
              .eq("tenant_id", conversation.tenant_id)
              .eq("conversation_id", conversation_id)
              .eq("status", "open")
              .limit(1);
            if (!existingIssue || existingIssue.length === 0) {
              await supabase.from("issues").insert({
                tenant_id: conversation.tenant_id,
                shop_id: shop.id,
                conversation_id: conversation_id,
                severity: "sev_1",
                detection_rule: "ticket_send_failed",
                title: `Order #${cartRow.order_number ?? cartRow.id} ticket send failed`,
                description: `Kitchen ticket email for order #${cartRow.order_number ?? cartRow.id} ($${emailTotal}) failed after ${MAX_ATTEMPTS} attempts. The issue-detector will re-attempt on next cycle.`,
                metadata: {
                  cart_id: order_cart_id,
                  order_number: cartRow.order_number ?? null,
                  max_attempts: MAX_ATTEMPTS,
                  total_cents: cartRow.total_cents ?? null,
                  recipient: shop.email_ticket_recipient,
                },
              });
            }
          }
        }
      } // closes claimed block
    } // closes has recipient
  }

  // ── STRUCTURAL OUTBOUND WATCHDOG: transactional push context ──────────────
  // The reason here is the system_event itself (payment_confirmed/order_refunded
  // are the only two that produce a non-empty message and reach this point).
  // We attach VERIFIED cart state as evidence: payment_status for the receipt,
  // refunded_cents for the refund. If the cart state does not actually back the
  // claimed transaction, the guard DENIES and nothing is sent or queued.
  const txnCtx: OutboundContext = {
    reason: system_event as OutboundContext["reason"],
    shopId: shop.id,
    tenantId: conversation.tenant_id as string,
    conversationId: conversation.id as string,
    cartId: order_cart_id,
    cartPaymentStatus: (cartRow.payment_status as string | null) ?? null,
    cartRefundedCents: (cartRow.refunded_cents as number | null) ?? null,
  };

  if (conversation.channel === "sms" && conversation.customer_phone) {
    // Direct SMS delivery via the active provider
    if (!shop.phone_number_e164) {
      console.error("[chat-sms] Shop has no phone number configured for SMS confirmation");
    } else {
      await sendSms(supabase, shop.tenant_id, txnCtx, resolveSmsProvider(), shop.phone_number_e164, conversation.customer_phone, message);
    }
  } else if (conversation.customer_phone?.startsWith("web:imsg-")) {
    // iMessage bridge: extract real phone from "web:imsg-{identifier}-{sessionid}"
    // Two formats supported:
    //   web:imsg-p6102565023-1781561505 → +16102565023 (digit-only)
    //   web:imsg-jasonfanwaycom-1783778364 → lookup real phone in conversation metadata or fall back to session lookup
    let realPhone: string | null = null;
    
    // Try format 1: web:imsg-p{digits}-{sessionid}
    const digitMatch = conversation.customer_phone.match(/web:imsg-p(\d+)-/);
    if (digitMatch) {
      realPhone = "+" + digitMatch[1];
    } else {
      // Format 2: web:imsg-{email_or_id}-{sessionid} — lookup real phone from conversation metadata or shop config
      const emailMatch = conversation.customer_phone.match(/web:imsg-(.+?)-([a-f0-9]+)$/);
      if (emailMatch) {
        // Fallback: use conversation metadata, then shop phone
        const metaPhone = (conversation.metadata as { phone?: string } | null)?.phone;
        if (metaPhone) {
          realPhone = metaPhone;
        } else {
          // Last fallback: shop phone (likely the test shop owner)
          if (shop.phone_number_e164) {
            realPhone = shop.phone_number_e164;
          }
        }
      }
    }

    if (realPhone) {
      // WATCHDOG GATE: only ENQUEUE for the bridge to drain if the same
      // transactional invariant holds. Fail closed — a cart that is not paid /
      // not refunded never gets a queued push, so the bridge can't send one.
      const { sent } = await guardedSend({ ...txnCtx, to: realPhone }, async () => {
        // Delay confirmation 10s so the payment link message always arrives first
        const sendAfter = new Date(Date.now() + 10_000).toISOString();
        const { error: qErr } = await supabase
          .from("outbound_queue")
          .insert({ to_phone: realPhone, message, send_after: sendAfter });
        if (qErr) {
          console.error("[chat-sms] Failed to queue outbound iMessage:", qErr.message);
        } else {
          console.log(`[chat-sms] Queued outbound iMessage to ${realPhone}`);
        }
      });
      if (!sent) {
        console.warn(`[chat-sms] OUTBOUND QUEUE BLOCKED by watchdog (reason=${txnCtx.reason}); nothing queued.`);
      }
    } else {
      console.error(`[chat-sms] iMessage push blocked: could not determine phone for customer_phone=${conversation.customer_phone}; not queued.`);
    }
  }

  return jsonResponse({ ok: true, message });
}

/** Reset a cart into test mode — DB update + local mutation. Single source of
 *  truth for both the SMS TESTMODE keyword branch and the web `test` flag branch. */
async function activateTestMode(
  supabase: SupabaseClient,
  cart:      OrderCart,
): Promise<void> {
  const reset = {
    test_mode: true,
    cart_json: [] as AnyCartItem[],
    phase: "greeting" as const,
    notes: null,
    subtotal_cents: 0,
    total_cents: 0,
    stripe_checkout_session_id: null,
    pickup_name: null,
  };
  await supabase.from("order_carts").update(reset).eq("id", cart.id);
  cart.test_mode = true;
  cart.cart_json = [];
  cart.phase = "greeting";
  cart.notes = null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")              ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const contentType = req.headers.get("content-type") ?? "";
  let isSms         = contentType.includes("application/x-www-form-urlencoded");

  let shop:          Shop;
  let customerPhone: string;
  let userPhone:     string | null = null;
  let userMessage:   string;
  let sessionId:     string;
  let channel:       "sms" | "web";
  // WEB/iMessage test-mode affordance. Only ever set true when a WEB JSON
  // request carries an explicit `test: true` flag (see web parse below). The
  // SMS form path never sets it (default false), so SMS diners are unaffected.
  // When true it has the SAME effect as the customer-typed TESTMODE keyword:
  // test_mode=true on the cart, hours-gating bypassed, success_url ->
  // /order-success-test. The normal customer flow never sends this flag.
  let requestTestMode = false;
  let forceClosed = false;
  // STRUCTURAL OUTBOUND WATCHDOG: ctx for every synchronous SMS reply in this
  // request. Set for the SMS channel below; web channel never calls Twilio.
  let inboundReplyCtx: OutboundContext = { reason: "inbound_reply", inboundAtMs: Date.now() };
  let messageSid: string | undefined; // external message id for dedup
  let replyProvider: SmsProvider = resolveSmsProvider(); // fallback default

  // ── Parse channel ─────────────────────────────────────────────────────────
  if (isSms) {
    replyProvider = "twilio";
    const body   = await req.text();
    const params = new URLSearchParams(body);
    const toNumber   = params.get("To")   ?? "";
    const fromNumber = params.get("From") ?? "";
    userMessage  = (params.get("Body") ?? "").trim();
    messageSid   = params.get("MessageSid") ?? params.get("SmsMessageSid") ?? undefined;

    // ── STRUCTURAL OUTBOUND WATCHDOG: synchronous inbound-reply context ──────
    // Every SMS send in this handler is a SYNCHRONOUS reply to THIS inbound
    // webhook. The triggering inbound is the request we're handling right now:
    // its id is the Twilio MessageSid (fallback synthesized) and its timestamp
    // is now (we are processing it live, so it is by definition fresh). This
    // single ctx is passed to every sendSms call below so the guard can
    // prove freshness; if it were ever invoked outside a live inbound the
    // evidence would be absent and the guard would DENY.
    inboundReplyCtx = {
      reason: "inbound_reply",
      to: fromNumber,
      inboundMessageId:
        messageSid ?? `inbound-${crypto.randomUUID()}`,
      inboundAtMs: Date.now(),
    };

    const upper      = userMessage.toUpperCase().trim();
    const STOP_WORDS = new Set(["STOP","STOPALL","UNSUBSCRIBE","CANCEL","END","QUIT"]);
    if (STOP_WORDS.has(upper)) {
      await sendSms(supabase, "", inboundReplyCtx, replyProvider, toNumber, fromNumber, COMPLIANCE_STOP);
      // Persist opt-out before returning (non-fatal; Telnyx is the backstop).
      const { data: stopShop } = await supabase.from("shops").select("tenant_id").eq("phone_number_e164", toNumber).maybeSingle();
      if (stopShop?.tenant_id) await upsertOptOut(supabase, stopShop.tenant_id, fromNumber, "proactive_stop");
      return emptyTwiml();
    }
    if (upper === "HELP") {
      await sendSms(supabase, "", inboundReplyCtx, replyProvider, toNumber, fromNumber, COMPLIANCE_HELP);
      return emptyTwiml();
    }
    if (upper === "START") {
      await sendSms(supabase, "", inboundReplyCtx, replyProvider, toNumber, fromNumber, COMPLIANCE_START);
      const { data: startShop } = await supabase.from("shops").select("tenant_id").eq("phone_number_e164", toNumber).maybeSingle();
      if (startShop?.tenant_id) await upsertOptOut(supabase, startShop.tenant_id, fromNumber, "start");
      return emptyTwiml();
    }

    const { data: shopData } = await supabase
      .from("shops").select("*")
      .eq("phone_number_e164", toNumber)
      .single();
    if (!shopData) {
      console.error("[chat-sms] Shop not found for number:", toNumber);
      await sendSms(supabase, "", inboundReplyCtx, replyProvider, toNumber, fromNumber, "Sorry, this number is not configured for ordering.");
      return emptyTwiml();
    }
    shop = shopData as Shop;
    if (shop.is_paused) {
      await sendSms(supabase, shop.tenant_id ?? "", inboundReplyCtx, replyProvider, toNumber, fromNumber, shop.pause_message ?? "We are not accepting orders right now. Please try again later.");
      return emptyTwiml();
    }
    customerPhone = fromNumber;
    sessionId     = `sms:${fromNumber}`;
    channel       = "sms";
  } else {
    let body: { shop_id?: string; message?: string; session_id?: string; system_event?: string; conversation_id?: string; order_cart_id?: string; test?: boolean; test_hours?: string; phone?: string; message_sid?: string; data?: { event_type?: string; payload?: Record<string, unknown> } };
    try { body = await req.json(); } catch { return jsonError("Invalid JSON body"); }

    // ── Telnyx inbound webhook (JSON, `data.event_type`) ────────────────────
    // Telnyx POSTs application/json with `data.event_type`. Disambiguate from
    // the web-chat JSON path BEFORE the web parse. A Telnyx inbound is always
    // answered over Telnyx (replyProvider mirrors the inbound provider).
    if (body.data && typeof body.data.event_type === "string") {
      const telnyxEvent = body.data.event_type;
      const payload = (body.data.payload ?? {}) as Record<string, unknown>;

      // ── DLR / non-received events: never run order logic ─────────────────
      if (telnyxEvent !== "message.received") {
        const msgId = (payload.id as string) ?? "";
        const from  = (payload.from as { phone_number?: string } | undefined)?.phone_number ?? "";
        const toArr = (payload.to as Array<{ phone_number?: string }> | undefined) ?? [];
        const to    = toArr[0]?.phone_number ?? "";
        console.log(
          `[chat-sms] Telnyx DLR: event=${telnyxEvent} id=${msgId} ` +
          `from=${from} to=${to}`,
        );
        return jsonResponse({ received: true });
      }

      // ── message.received → normalize into the SMS flow ───────────────────
      const fromNumber = (payload.from as { phone_number?: string } | undefined)?.phone_number ?? "";
      const toArr      = (payload.to as Array<{ phone_number?: string }> | undefined) ?? [];
      const toNumber   = toArr[0]?.phone_number ?? "";
      const text       = (payload.text as string) ?? "";
      const msgId      = (payload.id as string) ?? "";

      if (!fromNumber || !toNumber) {
        console.error("[chat-sms] Telnyx inbound missing from/to number");
        return jsonResponse({ received: true });
      }

      replyProvider = "telnyx";
      channel       = "sms";
      isSms         = true;
      userMessage   = (text ?? "").trim();
      customerPhone = fromNumber;
      sessionId     = `sms:${fromNumber}`;
      messageSid    = msgId || undefined;
      inboundReplyCtx = {
        reason: "inbound_reply",
        to: fromNumber,
        inboundMessageId: msgId || `inbound-${crypto.randomUUID()}`,
        inboundAtMs: Date.now(),
      };

      // STOP / HELP / START keyword handling (same whole-message matching as Twilio).
      const upper      = userMessage.toUpperCase().trim();
      const STOP_WORDS = new Set(["STOP","STOPALL","UNSUBSCRIBE","CANCEL","END","QUIT"]);
      if (STOP_WORDS.has(upper)) {
        await sendSms(supabase, "", inboundReplyCtx, "telnyx", toNumber, fromNumber, COMPLIANCE_STOP);
        // Persist opt-out before returning (non-fatal; Telnyx is the backstop).
        const { data: tStopShop } = await supabase.from("shops").select("tenant_id").eq("phone_number_e164", toNumber).maybeSingle();
        if (tStopShop?.tenant_id) await upsertOptOut(supabase, tStopShop.tenant_id, fromNumber, "proactive_stop");
        return jsonResponse({ received: true });
      }
      if (upper === "HELP") {
        await sendSms(supabase, "", inboundReplyCtx, "telnyx", toNumber, fromNumber, COMPLIANCE_HELP);
        return jsonResponse({ received: true });
      }
      if (upper === "START") {
        await sendSms(supabase, "", inboundReplyCtx, "telnyx", toNumber, fromNumber, COMPLIANCE_START);
        const { data: tStartShop } = await supabase.from("shops").select("tenant_id").eq("phone_number_e164", toNumber).maybeSingle();
        if (tStartShop?.tenant_id) await upsertOptOut(supabase, tStartShop.tenant_id, fromNumber, "start");
        return jsonResponse({ received: true });
      }

      // Shop lookup by `to` number (same as Twilio).
      const { data: shopData } = await supabase
        .from("shops").select("*")
        .eq("phone_number_e164", toNumber)
        .single();
      if (!shopData) {
        console.error("[chat-sms] Shop not found for Telnyx number:", toNumber);
        await sendSms(supabase, "", inboundReplyCtx, "telnyx", toNumber, fromNumber, "Sorry, this number is not configured for ordering.");
        return jsonResponse({ received: true });
      }
      shop = shopData as Shop;
      if (shop.is_paused) {
        await sendSms(supabase, shop.tenant_id ?? "", inboundReplyCtx, "telnyx", toNumber, fromNumber, shop.pause_message ?? "We are not accepting orders right now. Please try again later.");
        return jsonResponse({ received: true });
      }

      // Fall through to the shared downstream conversational logic below.
    } else {

    if (body.system_event) {
      return await handleSystemEvent(supabase, body);
    }

    const { shop_id, message, session_id, phone, message_sid } = body;
    messageSid = message_sid ?? undefined;
    if (!shop_id || !message) return jsonError("shop_id and message are required");
    userMessage = message.trim();
    sessionId   = session_id ?? crypto.randomUUID();
    channel     = "web";
    userPhone = typeof phone === "string" && phone.length > 0 ? phone : null;
    // GATED test-mode signal: only the WEB JSON path can carry `test: true`,
    // and only an explicit boolean true counts. The normal diner flow never
    // sends this. Also accept ?test=1 on the function URL as an equivalent
    // affordance (whichever the web client can send). SMS path leaves
    // requestTestMode=false. See test-mode activation in the greeting block.
    //
    // HARD-GATE: test mode is FORBIDDEN when the Supabase key is live (sk_live_).
    // On production, ?test=1 is a silent no-op. No shared secret, no env var —
    // just key the gate directly to the one signal that tells us this is real money.
    {
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const isLive = supabaseKey.startsWith("sk_live_");
      const url = new URL(req.url);
      const testHoursVal = body.test_hours ?? url.searchParams.get("test_hours");
      // "open" implies as-if-open — included in requestTestMode.
      requestTestMode = isLive ? false : (
        body.test === true || testHoursVal === "open" || url.searchParams.get("test") === "1"
      );
      // forceClosed: deterministically force the closed branch. Never honored on live keys.
      forceClosed = !isLive && testHoursVal === "closed";
    }
    const { data: shopData } = await supabase
      .from("shops").select("*").eq("id", shop_id).single();
    if (!shopData) return jsonError("Shop not found", 404);
    shop = shopData as Shop;
    if (shop.is_paused) {
      return jsonResponse({ reply: shop.pause_message ?? "We are not accepting orders right now.", cart: [], phase: "greeting", session_id: sessionId });
    }

    // STOP/HELP/START keyword handling (mirrors SMS path at ~L1726).
    // On the WEB path these keywords must be intercepted BEFORE the LLM
    // ever runs, so a STOP produces an immediate opt-out with no model reply.
    const STOP_WORDS_WEB = new Set(["STOP","STOPALL","UNSUBSCRIBE","CANCEL","END","QUIT"]);
    if (STOP_WORDS_WEB.has(userMessage.toUpperCase().trim())) {
      return jsonResponse({
        reply: "You have been unsubscribed and will receive no further messages. Reply START to resubscribe.",
        cart: [], phase: "greeting", session_id: sessionId,
      });
    }
    if (userMessage.toUpperCase().trim() === "HELP") {
      return jsonResponse({
        reply: "For help with your order, reply with your question. Msg & data rates may apply. Reply STOP to unsubscribe.",
        cart: [], phase: "greeting", session_id: sessionId,
      });
    }
    if (userMessage.toUpperCase().trim() === "START") {
      return jsonResponse({
        reply: "You are now subscribed. Text us to start an order!",
        cart: [], phase: "greeting", session_id: sessionId,
      });
    }

    customerPhone = `web:${sessionId}`;
    }
  }

  // ── Find or create conversation ───────────────────────────────────────────
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let conversation: { id: string } | null = null;

  if (channel === "web") {
    // Mirror the SMS freshness window: only reuse a web conversation that is
    // still active AND was started within the last 24h. A stale prior-day
    // session no longer welds onto a new one -- it times out and we start a
    // fresh conversation. Within-window same-session reuse is unchanged
    // (started_at >= windowStart for any conversation begun today).
    const { data } = await supabase
      .from("conversations").select("id")
      .eq("session_id", sessionId).eq("channel", "web")
      .eq("status", "active")
      .gte("started_at", windowStart)
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    conversation = data;
  } else {
    const { data } = await supabase
      .from("conversations").select("id")
      .eq("tenant_id", shop.tenant_id).eq("customer_phone", customerPhone)
      .eq("channel", "sms").eq("status", "active")
      .gte("started_at", windowStart)
      .order("started_at", { ascending: false }).limit(1).single();
    conversation = data;
  }

  const isFirstMessage = !conversation;

  // Lifetime first contact: has this (consumer, shop) pair EVER had a conversation?
  // Keyed on (tenant_id, customer_phone), not per-session — a returning customer is not
  // a new first contact, even after months. Used to decide whether to strip the
  // compliance footer ("Msg & data rates...") from the reply.
  //
  // If the current conversation already exists (within 24h window), it is trivially
  // not a first contact. If this is a new conversation, query whether any prior
  // conversations exist for this pair.
  let isLifetimeFirstContact = true;
  // Covers BOTH sms and web. It used to be `isSms && customerPhone`, so the web
  // path (channel === "web", customerPhone = `web:${sessionId}`) never recomputed
  // and stayed true on every turn — the compliance footer therefore appended to
  // EVERY reply in the /try tester, not just the first. Reported 2026-09-05.
  // For web the (tenant_id, customer_phone) key is per-session (session id is in
  // the phone), so "any prior conversation for this pair" == "not this session's
  // first message", which is exactly the first-message-only rule we want.
  if ((isSms || channel === "web") && customerPhone) {
    if (conversation) {
      // Existing active conversation — definitely not first contact.
      isLifetimeFirstContact = false;
    } else {
      const { count } = await supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", shop.tenant_id)
        .eq("customer_phone", customerPhone);
      isLifetimeFirstContact = count === 0;
    }
  }

  if (!conversation) {
    const metadata = userPhone ? { phone: userPhone } : {};
    const { data: newConv, error: convErr } = await supabase
      .from("conversations")
      .insert({
        tenant_id:      shop.tenant_id,
        customer_phone: customerPhone,
        channel,
        session_id:     channel === "web" ? sessionId : null,
        status:         "active",
        metadata,
      })
      .select("id").single();
    if (convErr || !newConv) {
      console.error("[chat-sms] Failed to create conversation:", convErr);
      const errMsg = "Sorry, we had a problem starting your order. Please try again.";
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, errMsg); return emptyTwiml(); }
      return jsonError(errMsg, 500);
    }
    conversation = newConv;
  }

  // ── Find or create order cart ─────────────────────────────────────────────
  const { data: existingCart } = await supabase
    .from("order_carts").select("*")
    .eq("conversation_id", conversation.id)
    .not("phase", "in", "(confirmed,expired)")
    .order("created_at", { ascending: false }).limit(1).single();

  let cart: OrderCart;
  // SYNCHRONOUS expired-link handling (lead directive 2026-06-22): we never
  // PUSH an "expired" notice. But if the customer texts us again and their most
  // recent cart was expired, surface a reorder nudge INLINE in this reply.
  let priorLinkExpired = false;
  if (existingCart) {
    cart = existingCart as OrderCart;
  } else {
    const { data: lastExpired } = await supabase
      .from("order_carts").select("id, phase")
      .eq("conversation_id", conversation.id)
      .eq("phase", "expired")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (lastExpired) priorLinkExpired = true;
    const { data: newCart, error: cartErr } = await supabase
      .from("order_carts")
      .insert({ shop_id: shop.id, conversation_id: conversation.id, phase: "greeting", cart_json: [], test_mode: false, order_type: shop.delivery_enabled ? null : "pickup" })
      .select("*").single();
    if (cartErr || !newCart) {
      console.error("[chat-sms] Failed to create cart:", cartErr);
      const errMsg = "Sorry, we had a problem starting your order. Please try again.";
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, errMsg); return emptyTwiml(); }
      return jsonError(errMsg, 500);
    }
    cart = newCart as OrderCart;
  }

  // TRUE pre-turn snapshot, captured before any tool execution can mutate
  // cart_json. Guard 7 (ambiguous same-name match, below) needs to know what
  // was added THIS turn — `cartItems` (used elsewhere for the same purpose)
  // is mutated IN PLACE by executeTool's push()/splice() calls, since it's
  // the same array object by reference, so it cannot answer "what changed".
  // Deep-cloned because cart_json is a nested object graph, not flat.
  const cartSnapshotBeforeTurn: AnyCartItem[] = JSON.parse(JSON.stringify(cart.cart_json ?? []));

  // RESET keyword — expire current cart so next message gets a clean one
  if (userMessage.trim().toUpperCase() === "RESET") {
    await supabase.from("order_carts").update({ phase: "expired", test_mode: false, pending_disambiguation: null }).eq("id", cart.id);
    const reply = "Session reset. Text when the kitchen is open, or TESTMODE to test again.";
    await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
    await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
    if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
    return jsonResponse({ reply, cart: [], phase: "expired", session_id: sessionId });
  }

  // Short-circuit on terminal phases
  if (cart.phase === "confirmed") {
    const reply = "Your order is confirmed and paid. Thank you!";
    await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
    await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
    if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
    return jsonResponse({ reply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId });
  }
  if (cart.phase === "checkout") {
    const upper = userMessage.toUpperCase().trim();
    const wantsRestart = /\b(RESTART|START OVER|NEW ORDER)\b/.test(upper);
    const wantsChange = /\b(WAIT|CHANGE|WRONG|FIX|MODIFY|UPDATE|REMOVE|NOT RIGHT|THAT'S NOT|THATS NOT|CHARGED.*WRONG|ONLY ORDERED|DIDN'T ORDER|DIDNT ORDER)\b/.test(upper);

    if (wantsRestart) {
      // Clear cart and start fresh
      cart.cart_json = [];
      await supabase.from("order_carts").update({ cart_json: [], phase: "greeting", stripe_checkout_session_id: null, subtotal_cents: 0, total_cents: 0, pending_disambiguation: null }).eq("id", cart.id);
      const reply = "No problem! Starting fresh. What would you like to order?";
      await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
      await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
      return jsonResponse({ reply, cart: [], phase: "greeting", session_id: sessionId });
    }

    if (wantsChange) {
      // Go back to building phase so the LLM can handle modifications
      await supabase.from("order_carts").update({ phase: "building", stripe_checkout_session_id: null }).eq("id", cart.id);
      cart.phase = "building" as OrderPhase;
      // Fall through to the LLM loop below so it can process the change request
    } else {
      // Default: remind about payment but offer options
      // If this is a repeated status check (same message as last bot message),
      // shorten the reply to avoid duplicate segments consuming the budget.
      const { data: lastBotMsg } = await supabase
        .from("messages")
        .select("content")
        .eq("conversation_id", conversation.id)
        .eq("sender", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const isRepeatCheck = lastBotMsg &&
        lastBotMsg.content && (lastBotMsg.content as string).includes("payment link was sent");
      const reply = isRepeatCheck
        ? "Payment still pending — tap the link we sent to finish. Reply CHANGE to edit or RESTART to start over."
        : "Your payment link was sent — check your texts for it. Reply CHANGE to edit your order or RESTART to start over.";
      await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
      await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
      return jsonResponse({ reply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId });
    }
  }

  // ── Build effective menu ──────────────────────────────────────────────────
  const businessDate  = getBusinessDate(shop.timezone);
  const currentTime   = getCurrentTime(shop.timezone);
  const { menu: effectiveMenu, soldOutNames } = await buildEffectiveMenu(supabase, shop.id, businessDate);

  // ── Load today's specials & fold into effective menu ─────────────────────
  const todayDate = businessDate; // already in YYYY-MM-DD
  const { data: todaysSpecials } = await supabase
    .from("specials")
    .select("id, name, price_cents, description")
    .eq("shop_id", shop.id)
    .eq("active_date", todayDate);
  if (todaysSpecials && todaysSpecials.length > 0) {
    for (const s of todaysSpecials) {
      effectiveMenu.push({
        id: `SPECIAL-${s.id}`,
        name: s.name,
        price_cents: s.price_cents,
        description: s.description ?? `Today's daily special`,
        category: "Today's Specials",
        modifiers_json: null,
        option_groups: [],
      });
    }
  }

  if (effectiveMenu.length === 0 && cart.phase === "greeting") {
    const reply = "Sorry, our menu is not available right now. Please call us to place an order.";
    await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
    await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
    if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
    return jsonResponse({ reply, cart: [], phase: "greeting", session_id: sessionId });
  }

  // ── Business hours check ────────────────────────────────────────────────
  if (cart.phase === "greeting") {
    // Day-of-week and current time are both computed in the SHOP'S timezone so
    // the lookup is correct near midnight (see getBusinessDayKey/getLocalMinutes).
    const todayKey = getBusinessDayKey(shop.timezone);
    const todayHours = dayWindows(shop.open_hours?.[todayKey]);
    const nowMins = getLocalMinutes(shop.timezone);

    // Check if current time falls within any open window (handles multi-window
    // days, e.g. lunch + dinner, since open_hours[day] is an array).
    const isOpen = todayHours.some((window: { open: string; close: string }) => {
      const [openH, openM] = window.open.split(":").map(Number);
      const [closeH, closeM] = window.close.split(":").map(Number);
      const openMins = openH * 60 + openM;
      const closeMins = closeH * 60 + closeM;
      return nowMins >= openMins && nowMins < closeMins;
    });
    const effectiveOpen = forceClosed ? false : isOpen;

    // Test mode is activated either by the customer-typed TESTMODE keyword
    // (any channel) OR by a WEB request carrying the gated `test` flag
    // (requestTestMode). Both have the identical effect below. requestTestMode
    // is false for every SMS request and for any web request without the flag,
    // so real diners are never put into test mode.
    // The customer-typed TESTMODE keyword always resets the cart (explicit
    // user intent to start a clean test). The WEB `test` flag (requestTestMode)
    // is sent on EVERY message of a test session by the client, so it must NOT
    // reset a cart that is already in test mode -- otherwise an in-progress
    // test order would be wiped each turn. We therefore only act on the flag
    // the FIRST time (when the cart is not yet in test mode); after that it is
    // a no-op and the order proceeds normally through the test success page.
    // Normalize for keyword matching: trim, strip punctuation, collapse whitespace
    const normalizedMsg = userMessage.trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
    const keywordTestMode = normalizedMsg === "TEST MODE" || normalizedMsg === "TESTMODE";

    if (keywordTestMode) {
      // SMS KEYWORD: reset cart, set test flag, and send ack immediately.
      // The next message the customer sends goes through the normal ordering
      // flow with test_mode=true (hours bypass, test Stripe).
      await supabase.from("order_carts").update({
        test_mode: true,
        cart_json: [],
        phase: "greeting",
        notes: null,
        subtotal_cents: 0,
        total_cents: 0,
        stripe_checkout_session_id: null,
        pickup_name: null,
        pending_disambiguation: null,
      }).eq("id", cart.id);
      cart.test_mode = true;
      cart.cart_json = [];
      cart.phase = "greeting";
      cart.notes = null;
      const ack = "You're in test mode 🧪 Order just like it's the real thing — the kitchen's open and this behaves exactly like a live order. At checkout you'll use a test card, and you won't be charged a cent.";
      await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
      await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", ack);
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, ack); return emptyTwiml(); }
      return jsonResponse({ reply: ack, cart: [], phase: "greeting", session_id: sessionId, test_mode: true });
    }

    const activatingTestMode = requestTestMode && !cart.test_mode;
    if (activatingTestMode) {
      // WEB test flag: same effect as keyword but no ack (client already knows).
      // Only activates on first turn — preserves in-progress test orders.
      await supabase.from("order_carts").update({
        test_mode: true,
        cart_json: [],
        phase: "greeting",
        notes: null,
        subtotal_cents: 0,
        total_cents: 0,
        stripe_checkout_session_id: null,
        pickup_name: null,
        pending_disambiguation: null,
      }).eq("id", cart.id);
      cart.test_mode = true;
      cart.cart_json = [];
      cart.phase = "greeting";
      cart.notes = null;
    }
    if (!effectiveOpen && !cart.test_mode) {
      const fmt12 = (t: string) => { const [h, m] = t.split(":").map(Number); const ampm = h >= 12 ? "p.m." : "a.m."; const h12 = h % 12 || 12; return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2,"0")} ${ampm}`; };
      const dayConf = shop.open_hours?.[todayKey];
      // Distinguish: explicitly closed (closed:true) vs. outside windows vs. unconfigured
      const isClosedAllDay = dayConf && typeof dayConf === "object" && !Array.isArray(dayConf) && dayConf.closed === true;
      if (isClosedAllDay) {
        const closedMsg = `Hey! The kitchen is closed today. We'll be back during regular hours — check back soon!`;
        await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
        await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", closedMsg);
        if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, closedMsg); return emptyTwiml(); }
        return jsonResponse({ reply: closedMsg, cart: [], phase: "greeting", session_id: sessionId });
      }
      if (todayHours.length > 0) {
        const hoursDisplay = todayHours.map((h: { open: string; close: string }) => `${fmt12(h.open)}-${fmt12(h.close)}`).join(", ");
        const closedMsg = `Hey! The kitchen is closed right now. Today's hours are ${hoursDisplay}. Come back during business hours — you'll be happy you did!`;
        await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
        await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", closedMsg);
        if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, closedMsg); return emptyTwiml(); }
        return jsonResponse({ reply: closedMsg, cart: [], phase: "greeting", session_id: sessionId });
      }
    }
  }

  // ── Load conversation history ─────────────────────────────────────────────

  // ── Delivery pause enforcement ───────────────────────────────────────────
  // If the shop has paused delivery and it's still in effect, inform the
  // customer immediately. This overrides normal ordering flow.
  const now = new Date();
  const pausedUntil = shop.delivery_paused_until ? new Date(shop.delivery_paused_until) : null;
  // delivery_enabled === false means the shop is PERMANENTLY pickup-only — that is
  // NOT "delivery paused right now" and must not hijack the order flow (it did: every
  // first message got the pickup-only pause message instead of taking the order).
  // Only a future delivery_paused_until (a shop that normally delivers but paused it
  // temporarily) triggers the pickup-only-right-now message. Permanent pickup-only is
  // handled by the "DELIVERY AVAILABLE: No" system-prompt field, which declines
  // delivery requests gracefully while still taking the order.
  const deliveryIsPaused = !!(pausedUntil && pausedUntil > now);
  if (deliveryIsPaused && cart.phase === "greeting" && !cart.test_mode) {
    const reason = shop.delivery_pause_reason
      ? ` ${shop.delivery_pause_reason}`
      : "";
    const resumeTime = pausedUntil
      ? new Date(pausedUntil.getTime() - now.getTime()).getMinutes() > 0
        ? ` Back in about ${Math.ceil((pausedUntil.getTime() - now.getTime()) / 60_000)} minutes.`
        : " Back shortly."
      : "";
    const resumeTimeStr = pausedUntil
      ? ` Back in about ${Math.ceil((pausedUntil.getTime() - now.getTime()) / 60_000)} minutes.`
      : "";
    const pauseMsg = `Quick heads up — we're pickup-only right now.${reason}${resumeTimeStr} Want to put in a pickup order?`;
    await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
    await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", pauseMsg);
    if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, pauseMsg); return emptyTwiml(); }
    return jsonResponse({ reply: pauseMsg, cart: [], phase: "greeting", session_id: sessionId });
  }

  // ── Load conversation history ─────────────────────────────────────────────
  // Fetch the MOST RECENT 40 messages (descending), then reverse for chronological order.
  // Using 40 to give enough context for complex multi-item orders.
  const { data: historyRows } = await supabase
    .from("messages").select("role, content")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false }).limit(40);

  const history = (historyRows ?? [])
    .reverse()
    .filter((m: { role: string }) => m.role === "customer" || m.role === "assistant")
    .map((m: { role: string; content: string }) => ({
      role:    m.role === "customer" ? "user" as const : "assistant" as const,
      content: m.content,
    }));

  // Save user message with dedup on message_sid (prevents double-processing on
  // retransmitted SMS or duplicate webhook). If this message_sid was already
  // persisted by a prior invocation, the unique constraint blocks the insert
  // atomically and we return a no-op — no LLM, no cart mutation, no charge.
  {
    const result = await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage, messageSid);
    if (!result.inserted) {
      console.log("[chat-sms] Duplicate message ignored (message_sid = " + (messageSid ?? "none") + ")");
      if (isSms) return emptyTwiml();
      return jsonResponse({ reply: "", action: "noop", duplicate: true });
    }
  }

  // ── Defense-in-depth: refuse delivery when coords are missing ────────────
  // If the shop has delivery_enabled but no geo coordinates, delivery cannot
  // function (the set_delivery_address tool needs coords for the zone check).
  // Tell the LLM delivery is unavailable; never fall through to delivery.
  // Must match the shopGeo condition below exactly. Coords alone are not enough:
  // set_delivery_address builds shopGeo from coords AND delivery_radius_mi > 0,
  // so a shop with coords but no radius would be told to offer delivery and then
  // save the address with no zone check at all — a delivery promise, in the
  // restaurant's name, to an address nobody verified we can reach.
  const deliveryGeoAvailable = shop.delivery_enabled === true
    ? (shop.latitude != null && shop.longitude != null && Number(shop.delivery_radius_mi) > 0)
    : false;

  // ── Pending disambiguation resolution (BLOCKER 1) ───────────────────────
  // GUARD 7 (below) asks a clarifying question when two active menu items
  // share a name and persists the offered candidates on
  // order_carts.pending_disambiguation. This is the other half: on the VERY
  // NEXT turn, resolve the customer's answer deterministically BEFORE the
  // LLM/tool loop ever runs — a plain answer like "the salad one" or "the
  // 12.95 one" must never fall into the normal tool loop with no memory of
  // which two candidates were offered (docs/specs/2026-09-06-disambiguation-
  // and-menu-gaps.md, BLOCKER 1).
  //
  // FIX C (2026-09-06, live QA — customer could not exit with a pending
  // question open): resolvePendingDisambiguation() is now the ONLY gate for
  // "does this message pick a candidate". Anything it can't deterministically
  // resolve — a genuinely new order ("large pepperoni pizza"), a checkout
  // signal ("that's it", "no thanks", "checkout", "nothing else"), or a
  // garbled answer — falls through to the normal LLM/tool loop rather than
  // re-asking and returning. The re-ask used to fire on everything except
  // "names a different real menu item", which meant "checkout" or "nothing
  // else" hit the re-ask branch and returned immediately: food sat in the
  // cart with no path to pay. There is no special-casing for checkout intent
  // here — it simply isn't resolved, so it takes the same fall-through every
  // other unresolved message takes. The still-open question rides along on
  // whatever reply the loop produces (see carriedDisambiguation append near
  // the end of this function), which also clears pending_disambiguation once
  // that turn reaches checkout. (A decline of THIS item specifically —
  // "forget the salad" — is a separate, narrower case handled below by
  // isPendingDisambiguationDeclined; unlike a checkout signal it IS fully
  // resolved information, so it is not part of this fall-through.)
  let carriedDisambiguation: PendingDisambiguation | null = null;
  if (cart.pending_disambiguation) {
    const pending = cart.pending_disambiguation;

    // DEFECT 2 (2026-09-06, live QA — "forget the salad" ADDED the salad):
    // negation/abandonment must be checked BEFORE resolvePendingDisambiguation
    // ever runs its category match, not folded into it — a decline cue next
    // to a candidate word ("salad", "wrap", "caesar") must never be read as a
    // selection of that same word.
    const declined = isPendingDisambiguationDeclined(userMessage, pending.candidates);
    const resolved = declined ? null : resolvePendingDisambiguation(userMessage, pending.candidates);

    if (declined) {
      // Live QA (2026-09-06): falling through to the normal LLM/tool loop
      // here — as the deterministic layer does for an unresolved answer —
      // let the model re-litigate the very question the customer just
      // declined. "forget the salad" cleared pending_disambiguation
      // correctly, but the model then guessed the customer meant the OTHER
      // candidate (the wrap) and added THAT, which is exactly the "add
      // nothing" contract broken from the other direction. A decline is
      // fully resolved information — same footing as a resolved answer —
      // so it gets the same short-circuit-and-return treatment: acknowledge,
      // add nothing, never hand this turn to the LLM at all.
      console.log(`[chat-sms] Pending disambiguation declined (conv=${conversation.id}): "${pending.query_name}" abandoned by customer ("${userMessage}"). Clearing state, adding nothing.`);
      await supabase.from("order_carts").update({ pending_disambiguation: null }).eq("id", cart.id);
      const reply = "No problem — I won't add that. Anything else?";
      await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
      return jsonResponse({ reply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId });
    } else if (resolved) {
      const localCartItems = [...cart.cart_json];
      const addResult = await executeTool(
        "add_item", { menu_item_id: resolved.menu_item_id, quantity: 1 },
        localCartItems, effectiveMenu, cart.id, supabase, shop.name, cart.test_mode,
      );
      await supabase.from("order_carts").update({ pending_disambiguation: null }).eq("id", cart.id);
      // DEFECT 2 fix (2026-09-06, P0 money defect): this reply used to state
      // its own bespoke total straight off addResult.cart_total, which is a
      // raw item-price sum with no service fee — it silently printed the
      // SUBTOTAL and called it the total. Route through the same
      // renderLedgerFooter() every other reply path uses (subtotal + $0.99
      // service fee = total) so this number can never drift from what the
      // rest of the bot says about the same cart.
      const feeAlreadyDisclosedGuard7 = !!cart.fee_disclosed_at;
      const footerGuard7 = addResult.ok
        ? renderLedgerFooter(localCartItems, "building", cart.delivery_fee_cents ?? undefined, cart.driver_tip_cents ?? undefined, !feeAlreadyDisclosedGuard7)
        : "";
      const resolvedWord = categoryDisplayWord(resolved.category);
      const reply = addResult.ok
        ? `Got it — ${resolved.name}${resolvedWord ? ` ${resolvedWord}` : ""} added.${footerGuard7 ? `\n\n${footerGuard7}` : ""} Anything else?`
        : "Sorry, I had trouble adding that one — mind trying again?";
      if (addResult.ok && !feeAlreadyDisclosedGuard7) {
        await supabase.from("order_carts").update({ fee_disclosed_at: new Date().toISOString() }).eq("id", cart.id);
      }
      console.log(`[chat-sms] Pending disambiguation resolved (conv=${conversation.id}): "${pending.query_name}" -> ${resolved.name} (${resolved.category ?? "no category"}, ${resolved.price_cents}c).`);
      await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
      return jsonResponse({ reply, cart: localCartItems, phase: "building", session_id: sessionId });
    } else {
      // Did not resolve deterministically — could be a checkout signal, a
      // genuinely new/unrelated order, or a garbled answer. All of them get
      // the same treatment now: fall through to the normal LLM/tool loop and
      // carry the still-open question forward (see carriedDisambiguation
      // append near the end of this function). pending_disambiguation is
      // left untouched in the DB here — cleared later if this turn reaches
      // checkout.
      console.log(`[chat-sms] Pending disambiguation carried forward (conv=${conversation.id}): "${pending.query_name}" still open; customer message did not resolve it ("${userMessage}"). Falling through to the LLM/tool loop.`);
      carriedDisambiguation = pending;
    }
  }

  // ── Guard 7c (2026-09-06, Jason — live QA): proactive same-message category resolution ──
  // Identical input ("chicken caesar salad"), three fresh sessions, three
  // different journeys: sometimes the model asked "salad or wrap?" even
  // though "salad" already disambiguates; sometimes it added the wrong
  // thing; sometimes it invented a dressing nobody asked about. All three
  // are the LLM improvising on a decision the data already answers. GUARD 7
  // /7b only catch this AFTER the LLM has already acted (ambiguous add_item
  // rolled back, or a free-text question asked) — this runs BEFORE the
  // LLM/tool loop, on the customer's fresh message, using the exact same
  // categoryWordMatches() the reactive guards already trust. If the message
  // names a duplicate-name item family AND a category word in that SAME
  // message resolves to exactly one candidate, resolve and add it directly
  // — the LLM never gets a turn to be inconsistent about something that
  // isn't ambiguous. A bare "chicken caesar" with no category word supplies
  // no signal (0 matches) and is untouched — genuine ambiguity still asks,
  // same as before.
  if (!cart.pending_disambiguation) {
    const byName7c = new Map<string, EffectiveMenuItem[]>();
    for (const mi of effectiveMenu) {
      const key = mi.name.trim().toLowerCase();
      const arr = byName7c.get(key) ?? [];
      arr.push(mi);
      byName7c.set(key, arr);
    }
    const userMsgLower7c = userMessage.toLowerCase();
    for (const [name7c, candidates7c] of byName7c) {
      if (candidates7c.length < 2) continue;
      const escapedName7c = name7c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const nameRe7c = new RegExp(`\\b${escapedName7c}\\b`);
      if (!nameRe7c.test(userMsgLower7c)) continue;
      // FIX (QA-found before ship): "I don't want the chicken caesar salad"
      // also names the item + a category word — without this check it would
      // have been ADDED despite the negation. Adjacency-based, same pattern
      // GUARD 4 v2's negation-filter already uses (immediately before the
      // item name, not just co-occurring anywhere in the message) — that
      // matters here: "chicken caesar salad, no croutons please" must still
      // resolve and add (the negation is about a topping, nowhere near the
      // item name), which a bare co-occurrence check would have wrongly
      // suppressed. A declined message is left to the normal LLM/tool loop,
      // exactly as it was before this guard existed.
      const negRe7c = new RegExp(
        // WIDENED (QA-found): "dont" (no apostrophe) and "do not" are at
        // least as common in real SMS as the apostrophized form; "add" joins
        // want/need/get since "don't add the salad" is an equally common phrasing.
        `\\b(?:no|not|remove|skip|drop|scratch|cancel(?:ling)?|(?:don['’]?t|do\\s+not|dont)\\s+(?:want|need|get|add))\\s+(?:the\\s+)?(?:any\\s+)?${escapedName7c}\\b`,
      );
      if (negRe7c.test(userMsgLower7c)) continue;
      const categoryMatches7c = candidates7c.filter(c => categoryWordMatches(c.category, userMessage));
      if (categoryMatches7c.length !== 1) continue; // no signal, or still genuinely ambiguous — let the existing flow handle it
      const resolved7c = categoryMatches7c[0];
      // FIX (QA-found LIVE before ship, TWO rounds): a customer ASKING ABOUT
      // a duplicate-name item was being silently ADDED and never answered.
      // Round 1's fix was a deny-list of question shapes ("?", a leading
      // interrogative) — QA found a THIRD round of leaks past it: "price on
      // the chicken caesar salad", "wondering about...", "tell me about...",
      // "curious if... is gluten free", "...whats in it" (interrogative not
      // leading, or no interrogative word at all). A deny-list of question
      // forms is whack-a-mole by construction. Replaced with an allow-list:
      // require a POSITIVE signal to add — either an explicit order-intent
      // phrase, or the message being essentially JUST the item name/category
      // (optionally with a simple "no/with/without/extra <thing>" modifier
      // clause, e.g. "chicken caesar salad, no croutons please"). Any other
      // leftover content word (a verb, a question word, an inquiry noun)
      // means this isn't a bare order — fall through and let the model
      // actually answer it.
      const hasOrderIntent7c = /\b(?:i'?ll\s+(?:have|take|get)|i\s+want|i'?d\s+like|give\s+me|let\s+me\s+get|(?:can|could)\s+(?:i|we|you)\s+(?:get|have|order|grab|add))\b/i.test(userMessage);
      if (!hasOrderIntent7c) {
        const FILLER_WORDS_7C = new Set(["a", "an", "the", "i", "want", "please", "get", "order", "one", "some", "and", "also", "plus", "for", "me", "ill", "id", "like", "that", "some"]);
        const itemStems7c = new Set(resolved7c.name.toLowerCase().split(/\s+/).map(stemWord));
        const categoryStem7c = resolved7c.category ? stemWord(categoryDisplayWord(resolved7c.category)) : null;
        const cleaned7c = userMessage.toLowerCase().replace(/\b(?:no|with|without|extra)\s+\w+/g, " ");
        const words7c = cleaned7c.replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
        const leftover7c = words7c.filter(w => {
          if (FILLER_WORDS_7C.has(w)) return false;
          const s = stemWord(w);
          if (itemStems7c.has(s)) return false;
          if (categoryStem7c && s === categoryStem7c) return false;
          return true;
        });
        if (leftover7c.length > 0) continue; // leftover content word — not a bare order, leave it to the model
      }

      const localCartItems = [...cart.cart_json];
      const addResult7c = await executeTool(
        "add_item", { menu_item_id: resolved7c.id, quantity: 1 },
        localCartItems, effectiveMenu, cart.id, supabase, shop.name, cart.test_mode,
      );
      if (!addResult7c.ok) break; // never swallow a real failure here — fall through to the normal loop

      const addedLine7c = localCartItems.find(i => (i as CartItem).menu_item_id === resolved7c.id) as CartItem | undefined;
      const pending7c = addedLine7c?.pending_options ?? [];
      const feeAlreadyDisclosed7c = !!cart.fee_disclosed_at;
      let reply7c: string;
      if (pending7c.length > 0) {
        // Same rule as the is_default fix and the missing-options humanizer:
        // ask deterministically, with the REAL recorded choices (GUARD 8's
        // own reason to exist — the model recalling an 18-choice list from a
        // ~17k-token prompt is exactly the kind of thing this file no longer
        // trusts an LLM to do reliably), never invent or default a choice
        // that was never in the data.
        const askText7c = renderMissingOptionsPrompt([{ name: resolved7c.name, missingGroups: pending7c }]);
        const choiceClauses7c = pending7c
          .map(groupName => {
            const group = resolved7c.option_groups?.find(g => g.name === groupName);
            return group && group.choices.length > 0 ? `Choices for ${displayGroupName(group.name)}: ${group.choices.map(c => c.name).join(", ")}.` : "";
          })
          .filter(Boolean)
          .join(" ");
        reply7c = choiceClauses7c ? `${askText7c} ${choiceClauses7c}` : askText7c;
      } else {
        const footer7c = renderLedgerFooter(localCartItems, "building", cart.delivery_fee_cents ?? undefined, cart.driver_tip_cents ?? undefined, !feeAlreadyDisclosed7c);
        const resolvedWord7c = categoryDisplayWord(resolved7c.category);
        reply7c = `Got it — ${resolved7c.name}${resolvedWord7c ? ` ${resolvedWord7c}` : ""} added.${footer7c ? `\n\n${footer7c}` : ""} Anything else?`;
      }
      if (!feeAlreadyDisclosed7c) {
        await supabase.from("order_carts").update({ fee_disclosed_at: new Date().toISOString() }).eq("id", cart.id);
      }
      console.log(`[chat-sms] GUARD 7c (proactive category resolution) tripped (conv=${conversation.id}). "${name7c}" -> ${resolved7c.name} (${resolved7c.category ?? "no category"}).`);
      await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply7c);
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply7c); return emptyTwiml(); }
      return jsonResponse({ reply: reply7c, cart: localCartItems, phase: "building", session_id: sessionId });
    }
  }

  // ── Pending option-answer resolution (DEFECT 1, 2026-09-06 P0) ──────────
  // A required option group left open on a cart line (e.g. add_item stored
  // pending_options: ["Temp"] on a cheeseburger and the reply asked "how do
  // you want that cooked?") must resolve against that SAME line on the very
  // next turn, deterministically, before the LLM/tool loop ever runs — same
  // shape as the pending-disambiguation resolver above. Routing the answer
  // through the LLM at all left "call add_item again" as a real, sometimes-
  // taken path: add_item's own dedup key is options-equality, and filling in
  // a previously-empty required option can never match the line's own
  // (still-empty) prior options, so a phantom second line was the
  // deterministic consequence, not a rare model slip (docs: the "add
  // pepperoni" pizza path only avoids this by accident — pizza toppings
  // aren't a recorded required option group, so the key never diverges).
  // Resolving here calls modify_item directly; add_item is never reachable
  // this turn for this item, so it cannot create a second line.
  // Item 8 (spec §7/§11 item 8, bug 5 fix — 2026-09-07): the block above
  // this comment is the LEGACY pending-answer resolver — it calls
  // modify_item, which has no ask_plan/price_delta_cents awareness, so
  // answering a compiled item's pending slot ("large", on a separate turn
  // from the add) recorded the choice NAME but never applied its real
  // price. Confirmed live: "chicken cheesesteak sub" then "large" (two
  // turns) stayed at $10.99 instead of $18.99, while "a large chicken
  // cheesesteak sub" (one turn) correctly applied the $8.00 delta via
  // add_item's own compiled branch — the gap was specifically this
  // separate-turn answer path, which every real conversation uses at least
  // once per item. Gated identically to add_item's branch: shop flag AND
  // the pending line's item has a non-null ask_plan. Structurally
  // unreachable for any uncompiled item/shop, including Vito's.
  const compiledOrderingEngineEnabled = shop.compiled_ordering_engine_enabled === true;
  if (compiledOrderingEngineEnabled) {
    const menuById8 = new Map(effectiveMenu.map(mi => [mi.id, mi]));
    const pendingCompiledLine = (cart.cart_json as CartItem[]).find(ci => {
      if (!ci.ask_plan_selections) return false;
      const mi = menuById8.get(ci.menu_item_id);
      return mi?.ask_plan && !allSlotsResolved(mi.ask_plan, new Set(Object.keys(ci.ask_plan_selections)));
    });
    if (pendingCompiledLine) {
      const menuItem8 = menuById8.get(pendingCompiledLine.menu_item_id)!;
      const localCartItems8 = [...cart.cart_json] as unknown as CompiledCartLine[];
      const outcome = applyCompiledAddItem(
        localCartItems8,
        menuItem8 as unknown as CompiledMenuItem,
        pendingCompiledLine.menu_item_id,
        1,
        userMessage,
        shop.phone_number_e164,
      );
      if (outcome.cartChanged) {
        await saveCart(supabase, cart.id, localCartItems8 as unknown as AnyCartItem[], "building");
        const feeAlreadyDisclosed8 = !!cart.fee_disclosed_at;
        const footer8 = renderLedgerFooter(localCartItems8 as unknown as AnyCartItem[], "building", cart.delivery_fee_cents ?? undefined, cart.driver_tip_cents ?? undefined, !feeAlreadyDisclosed8);
        const r8 = outcome.result as { instruction?: string; next_question?: string | null };
        const reply8 = r8.next_question
          ? `Got it — ${r8.next_question}${footer8 ? `\n\n${footer8}` : ""}`
          : `Got it!${footer8 ? `\n\n${footer8}` : ""} Anything else?`;
        if (!feeAlreadyDisclosed8) {
          await supabase.from("order_carts").update({ fee_disclosed_at: new Date().toISOString() }).eq("id", cart.id);
        }
        console.log(`[chat-sms] Item 8 compiled pending-answer resolved (conv=${conversation.id}): "${pendingCompiledLine.name}" turn="${userMessage}".`);
        await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply8);
        if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply8); return emptyTwiml(); }
        return jsonResponse({ reply: reply8, cart: localCartItems8, phase: "building", session_id: sessionId });
      }
      // Not resolved this turn (customer's message didn't match any pending
      // choice) — fall through to the legacy resolver below, then the
      // LLM/tool loop, same as the uncompiled path already does.
    }
  }

  {
    const menuById = new Map(effectiveMenu.map(mi => [mi.id, mi]));
    const pendingQuestion = findPendingOptionQuestion(cart.cart_json as CartItem[], menuById);
    if (pendingQuestion) {
      const resolvedChoice = resolvePendingOptionAnswer(userMessage, pendingQuestion.choices);
      if (resolvedChoice) {
        const localCartItems = [...cart.cart_json];
        // BUG 4 fix (2026-09-07): the answer to the pending required group
        // ("medium") may name an ADDITIONAL real choice from a different,
        // non-pending group in the same message ("medium with pepperoni") —
        // scan the item's other groups for that too, so it lands in the SAME
        // modify_item call instead of silently vanishing because only the
        // one pending group was ever resolved here.
        const pendingLine = (cart.cart_json as CartItem[]).find(i => i.menu_item_id === pendingQuestion.menu_item_id);
        const pendingMenuItem = menuById.get(pendingQuestion.menu_item_id);
        const additionalSelections = pendingMenuItem
          ? resolveAdditionalGroupSelections(
              userMessage,
              pendingMenuItem,
              new Set(Object.keys(pendingLine?.options ?? {})),
              pendingQuestion.group_name,
            )
          : [];
        const resolvedOptions: Record<string, string[]> = { [pendingQuestion.group_name]: [resolvedChoice.name] };
        for (const sel of additionalSelections) resolvedOptions[sel.group_name] = [sel.choice.name];
        const modResult = await executeTool(
          "modify_item",
          { menu_item_id: pendingQuestion.menu_item_id, options: resolvedOptions },
          localCartItems, effectiveMenu, cart.id, supabase, shop.name, cart.test_mode,
        );
        const feeAlreadyDisclosed = !!cart.fee_disclosed_at;
        // After resolving this group, check for the NEXT pending group on the
        // same line — ask it deterministically instead of saying "Anything else?"
        // (fixes the silent-drop when an item has 2+ required option groups).
        const nextQuestion = modResult.ok ? findPendingOptionQuestion(localCartItems as CartItem[], menuById) : null;
        const footer = modResult.ok
          ? renderLedgerFooter(localCartItems, "building", cart.delivery_fee_cents ?? undefined, cart.driver_tip_cents ?? undefined, !feeAlreadyDisclosed)
          : "";
        // Reply must name every choice actually applied this turn, not just
        // the one group this block set out to resolve — otherwise it under-
        // states what's on the order (BUG 4: additional named choices must
        // never be applied silently, same "code decides what's true" rule
        // as never claiming one that wasn't applied).
        const appliedNames = [resolvedChoice.name, ...additionalSelections.map(s => s.choice.name)].join(", ");
        const reply = !modResult.ok
          ? "Sorry, I had trouble setting that — mind trying again?"
          : nextQuestion
            ? `Got it — ${appliedNames}. For the ${nextQuestion.item_name}: what ${displayGroupName(nextQuestion.group_name).toLowerCase()} — ${nextQuestion.choices.map(c => c.name).join(", ")}?${footer ? `\n\n${footer}` : ""}`
            : `Got it — ${appliedNames} on the ${pendingQuestion.item_name}.${footer ? `\n\n${footer}` : ""} Anything else?`;
        if (modResult.ok && !feeAlreadyDisclosed) {
          await supabase.from("order_carts").update({ fee_disclosed_at: new Date().toISOString() }).eq("id", cart.id);
        }
        console.log(`[chat-sms] Pending option resolved (conv=${conversation.id}): "${pendingQuestion.item_name}" / ${pendingQuestion.group_name} -> ${resolvedChoice.name}.`);
        await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
        if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
        return jsonResponse({ reply, cart: localCartItems, phase: "building", session_id: sessionId });
      }
      // Unresolved — not necessarily a garbled answer; could be a genuine
      // new item, a question, or a request the deterministic stem-matcher
      // just doesn't cover. Unlike disambiguation there is no numbered list
      // to force a re-ask against, so fall through to the normal LLM/tool
      // loop; the phantom-add guard in add_item's dedup logic below still
      // protects this same line if the model reaches for add_item there.
    }
  }

  // ── Deterministic correction handler (Fix 2: Corrections must write back) ──
  // Before the LLM ever runs, detect correction intent in the user message
  // and directly mutate the cart. "just want one" / "make it one" / "remove one"
  // must update cart_json AND persist BEFORE any summary is shown.
  let cartItems    = [...cart.cart_json];
  let correctionApplied = false;
  {
    const norm = userMessage.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

    // Bucket 3 (ambiguous, 2026-09-06 — "no thanks" deleted the only line;
    // "forget it" added 2026-09-07 — same idiom family as "forget that",
    // reproduced live wiping the WHOLE cart via the LLM, not just the last
    // line, because it also disabled Guard P2's restore-safety-net below —
    // see that guard's comment): bare "never mind" / "forget that" / "forget
    // it" with items already in the cart and no pending disambiguation
    // question open. These phrases are genuinely ambiguous — "I'm done"
    // after "anything else?" or "don't add that" after a proposed item —
    // but must NEVER be read as "delete something I already ordered" as a
    // side effect of guessing wrong. Ask instead of guessing, and never hand
    // this to the LLM either (it can guess wrong the same way — reproduced
    // live: "forget it" alone made the model reply "Done - cart's cleared").
    // A named-item form ("forget the salad") is not covered here — see the
    // named-item regexes below and isPendingDisambiguationDeclined upstream.
    const isAmbiguousBareDecline = cartItems.length > 0 && !cart.pending_disambiguation &&
      /^(never ?mind|forget (?:it|that))$/i.test(norm);
    if (isAmbiguousBareDecline) {
      console.log(`[chat-sms] Ambiguous bare decline (conv=${conversation.id}): "${userMessage}" with ${cartItems.length} cart item(s), no pending question open. Asking instead of guessing.`);
      const reply = "Just to make sure — did you want to remove your last item, or are you all set and ready to checkout?";
      await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
      return jsonResponse({ reply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId });
    }

    // Bucket 1 (completion, 2026-09-06): "no thanks", "no thank you", "nope",
    // "that's all", "im good"/"i'm good", "all set", "that'll do" must NOT be
    // treated as corrections at all — same as "that's it"/"checkout" today,
    // they simply aren't matched below and fall through to the normal
    // LLM/tool loop with the cart untouched.
    // Named-item removal: "remove the pizza", "drop my garlic knots", etc.
    // Capture the item name text so we can resolve it against the cart — a
    // boolean .test() would throw the name away and always remove the last
    // item regardless of what the customer said.
    const namedRemoveMatch = norm.match(
      /^(?:remove the|remove my|drop the|drop my|take off the|take off my|cancel the|cancel my|get rid of the|scratch the)\s+(.+)$/i
    );
    const capturedName = namedRemoveMatch ? namedRemoveMatch[1].trim() : null;

    const isCorrection = cartItems.length > 0 && (
      /^(just want one|make it one|just one|only one|one is fine|just 1|make it 1|one of those|one of them|just the one|actually just one|actually one)$/i.test(norm) ||
      /^(i just want|i only want|i want just|ill take just|ill take one|ill have just|i just need|i wanted just|i meant just|give me just|let me get just)\s+(one|1)$/i.test(norm) ||
      /^(remove one|remove that|remove it|take it off|take that off|scratch that)$/i.test(norm) ||
      capturedName !== null
    );
    if (isCorrection) {
      // Bucket 2 (removal, 2026-09-06): requires an actual removal verb.
      // "no thanks"/"never mind"/"nevermind" no longer qualify — they're
      // either bucket 1 (never reach isCorrection) or bucket 3 (handled and
      // returned above, before isCorrection is even evaluated).
      // "take (it|that|this|them) off" is matched explicitly alongside bare
      // "take off" — the old `take off\b` alternative never matched "take it
      // off"/"take that off" (word-order mismatch), so those two phrases
      // silently fell through to the quantity-reduction branch below instead
      // of removing the item. Fixed here since it's the same verb check.
      const isRemove = /^(remove|delete|drop|take\s+(?:it|that|this|them)\s+off|take off|cancel|scratch|get rid of)\b/i.test(norm);
      if (isRemove && cartItems.length > 0) {
        if (capturedName) {
          // Named-item removal: resolve the captured name against cart lines.
          // Stored cart-line names are the raw variant label ("Cheese - Large
          // (16\")"), not the word a customer actually uses ("pizza") — a
          // name-only match misses that entirely. resolveNamedCartRemoval
          // also checks the item's MENU CATEGORY (joined here from
          // effectiveMenu by menu_item_id), the same category-stem-match
          // GUARD 7's disambiguation flow already relies on.
          const menuByIdForRemoval = new Map(effectiveMenu.map(mi => [mi.id, mi]));
          // Index-paired with cartItems (not menu_item_id-keyed) — two cart
          // lines can legitimately share a menu_item_id (e.g. two separately
          // customized orders of the same pizza), and matching back by id
          // alone would resolve both when only one was named.
          const removalCandidates: PendingCandidate[] = cartItems.map(item => {
            const ci = item as CartItem;
            return {
              menu_item_id: ci.menu_item_id,
              name: ci.name ?? "",
              category: menuByIdForRemoval.get(ci.menu_item_id)?.category ?? null,
              price_cents: ci.price_cents,
            };
          });
          const resolvedIdx = new Set(
            resolveNamedCartRemoval(capturedName, removalCandidates)
              .map(m => removalCandidates.indexOf(m)),
          );
          const matches = cartItems.filter((_, i) => resolvedIdx.has(i));

          if (matches.length === 0) {
            // Item named but not in cart — tell the customer plainly.
            const cartNames = cartItems.map(i => `"${(i as CartItem).name}"`).join(", ");
            const reply = `I don't see "${capturedName}" in your cart — you currently have: ${cartNames}. Did you mean one of those?`;
            console.log(`[chat-sms] Named remove: "${capturedName}" not found in cart (conv=${conversation.id})`);
            await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
            if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
            return jsonResponse({ reply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId });
          } else if (matches.length > 1) {
            // Ambiguous — multiple cart lines match the name, ask which one.
            const listStr = matches.map((item, i) => `${i + 1}) ${(item as CartItem).name}`).join("  ");
            const reply = `Which one did you want to remove? ${listStr}. Reply with the number.`;
            console.log(`[chat-sms] Named remove: "${capturedName}" matched ${matches.length} cart lines, asking (conv=${conversation.id})`);
            await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
            if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
            return jsonResponse({ reply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId });
          } else {
            // Exactly one match — remove that specific item.
            const target = matches[0] as CartItem;
            const mid = target.menu_item_id;
            if (mid) {
              await executeTool("remove_item", { menu_item_id: mid }, cartItems, effectiveMenu, cart.id, supabase, shop.name, cart.test_mode);
              correctionApplied = true;
              console.log(`[chat-sms] Named remove: removed "${target.name}" (matched query "${capturedName}") from cart (conv=${conversation.id})`);
            }
          }
        } else {
          // Bare removal (no name captured): remove the last item, unchanged behavior.
          const lastItem = cartItems[cartItems.length - 1];
          const mid = (lastItem as CartItem).menu_item_id;
          if (mid) {
            await executeTool("remove_item", { menu_item_id: mid }, cartItems, effectiveMenu, cart.id, supabase, shop.name, cart.test_mode);
            correctionApplied = true;
            console.log(`[chat-sms] Correction (remove): removed "${(lastItem as CartItem).name}" from cart (conv=${conversation.id})`);
          }
        }
      } else {
        // Reduce last item to quantity 1
        const lastItem = cartItems[cartItems.length - 1];
        const mid = (lastItem as CartItem).menu_item_id;
        if (mid) {
          const qty = (lastItem as CartItem).quantity;
          if (qty > 1) {
            await executeTool("modify_item", { menu_item_id: mid, quantity: 1 }, cartItems, effectiveMenu, cart.id, supabase, shop.name, cart.test_mode);
            correctionApplied = true;
            console.log(`[chat-sms] Correction (set_qty=1): set "${(lastItem as CartItem).name}" qty 1 (was ${qty}) (conv=${conversation.id})`);
          }
        }
      }
      // Reload cart from DB so the LLM sees the corrected state
      if (correctionApplied) {
        const { data: correctedCart } = await supabase.from("order_carts").select("*").eq("id", cart.id).single();
        if (correctedCart) {
          cart.cart_json = (correctedCart.cart_json as AnyCartItem[]);
          cart.phase = (correctedCart.phase as OrderPhase) || "building";
        }
      }
    }
    // Re-snapshot after any deterministic corrections so the P2 guard
    // restores the post-correction truth, not the pre-correction stale copy.
    if (correctionApplied) {
      cartItems = [...cart.cart_json];
    }
  }

  // ── C2 (2026-08-29): Pre-LLM name→submit shortcut ──────────────────────
  // When the last assistant message asked for a pickup name and the customer's
  // next message is a short name, bypass the LLM entirely and call submit_order
  // directly. This prevents LLM hallucination (re-adding items, wrong totals)
  // on the name turn. The system prompt's PICKUP NAME RULE is unreliable.
  let nameSubmitCheckoutUrl: string | undefined;
  {
    const shopGeo = shop.latitude != null && shop.longitude != null && shop.delivery_radius_mi > 0
      ? { lat: shop.latitude, lng: shop.longitude, radiusMi: Number(shop.delivery_radius_mi) }
      : null;
    if (cartItems.length > 0 && !(cart as any).pickup_name) {
      const trimmed = userMessage.trim();
      const looksLikeName = /^[A-Z][A-Za-z .'-]{0,30}$/.test(trimmed) && trimmed.split(/\s+/).length <= 3;
      const lastAssistant = [...history].reverse().find(h => h.role === "assistant");
      const askedForName = typeof lastAssistant?.content === "string" && isAskingForPickupName(lastAssistant.content);
      if (looksLikeName && askedForName) {
        const orderType = cart.order_type;
        const hasIncompleteBundle = cartItems.find(i => (i as BundleItem).type === "bundle" && !(i as BundleItem).complete);
        // C2 deadlock breaker (2026-09-01): For delivery-enabled shops, the customer
        // may reach the name turn without ever saying "pickup" or "delivery". The
        // system prompt allows defaulting to pickup after ignoring the question twice.
        // Without this, order_type stays null → C2 skips → LLM hallucinates on the
        // name turn; Guard 2b actively reverts any silently-set order_type, making
        // recovery impossible. Default to pickup here so submit_order's C1 gate passes.
        const effectiveOrderType = orderType || "pickup";
        if (!orderType) {
          console.log(`[chat-sms] C2 defaulting order_type to "pickup" (was null, conv=${conversation.id})`);
          await supabase.from("order_carts").update({ order_type: "pickup" }).eq("id", cart.id);
          cart.order_type = "pickup";
        }
        if (!hasIncompleteBundle) {
          console.log(`[chat-sms] C2 pre-LLM name→submit shortcut firing (conv=${conversation.id}, name="${trimmed}", cart=${cart.id})`);
          const submitInput: Record<string, unknown> = { pickup_name: trimmed };
          const submitResult = await executeTool("submit_order", submitInput, cartItems, effectiveMenu, cart.id, supabase, shop.name, cart.test_mode, shop.delivery_fee_cents, shopGeo);
          if (submitResult.ok && submitResult.checkoutUrl) {
            nameSubmitCheckoutUrl = submitResult.checkoutUrl;
            // Reload cart so post-turn code sees the updated state (pickup_name, phase, Stripe session)
            const { data: reloaded } = await supabase.from("order_carts").select("*").eq("id", cart.id).single();
            if (reloaded) {
              cart.cart_json = (reloaded.cart_json as AnyCartItem[]);
              cart.phase = (reloaded.phase as string) || "checkout";
              (cart as any).pickup_name = trimmed;
            }
          } else {
            console.warn(`[chat-sms] C2 submit_order failed: ${JSON.stringify(submitResult.result).slice(0, 200)}. Falling through to LLM.`);
          }
        }
      }
    }
  }

  // ── Deterministic cart-summary handler ────────────────────────────────────
  // "show me my order" / "what's in my cart" and obvious variants → call
  // renderItemizedRecap directly, no LLM. Same renderer the checkout summary
  // uses, so the numbers can never drift apart. Guard: only fires when the
  // cart has items and the phase is building (not greeting, not checkout).
  const CART_SUMMARY_RE = /^(?:show(?:\s+me)?(?:\s+my)?(?:\s+(?:full\s+)?order|\s+cart|\s+order)?|what(?:'?s|\s+is)(?:\s+in)?(?:\s+my)?(?:\s+cart|\s+order)|(?:my\s+)?(?:order|cart)(?:\s+so\s+far)?|(?:see|view|check|read)\s+(?:my\s+)?(?:order|cart)|what(?:\s+did|\s+have)\s+i(?:\s+(?:get|order|got|added))?)[\s?]*$/i;
  if (!correctionApplied && !nameSubmitCheckoutUrl && cartItems.length > 0 && cart.phase === "building" && CART_SUMMARY_RE.test(userMessage.trim())) {
    const recap = renderItemizedRecap(cartItems, cart.delivery_fee_cents ?? undefined, cart.driver_tip_cents ?? undefined);
    const summaryReply = `Here's your order so far:\n\n${recap}`;
    console.log(`[chat-sms] cart-summary shortcut fired (conv=${conversation.id})`);
    return jsonResponse({ reply: summaryReply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId });
  }

  // ── Deterministic zero-option attribute-change handler ───────────────────
  // (2026-09-08, real NJB bagel-switch self-contradiction). Two prior shapes
  // were tried and rejected after live-verifying them, both correctly: a
  // post-hoc corrector (GUARD 17, below) that can only ever produce a
  // claim-then-retraction when it fires or an unguarded false claim when it
  // doesn't — 6 revisions, never a clean single sentence — and a before-
  // composition prompt NUDGE (the hint just below this block) that changed
  // the odds but stayed probabilistic: still non-deterministic across fresh
  // runs, and GUARD 17 would occasionally mis-fire on the honest denial the
  // nudge DID produce, recreating the same self-contradiction on a message
  // that never needed correcting.
  //
  // This is the actual fix, same shape as the ask_plan slot lookup that
  // already makes "large buffalo chicken pizza" deterministic on Zio's: for
  // the UNAMBIGUOUS case (exactly one zero-option item in the cart), detect
  // the request BEFORE any LLM call for the turn and RENDER a fixed reply
  // instead of generating one — the words "switched"/"noted"/"got it"
  // attached to a change that didn't happen are never produced, because no
  // free-form generation runs for this part of the turn at all. If a real
  // alternative catalog item matches what the customer described, it's
  // offered by name and price; otherwise a plain, single decline. Either
  // way the kitchen note (when there's no alternative) is written via a
  // DIRECT tool call here, not left to the model to remember — closing the
  // separate notes-mismatch gap the nudge shape surfaced and never fixed
  // (the claim "I've noted it" and the actual note can no longer drift
  // apart, because this code writes both).
  //
  // Two or more zero-option items in the cart is a genuine ambiguity this
  // resolver isn't built to guess at ("which one do you mean") -- that
  // residual case intentionally still falls through to the hint/GUARD-17
  // fallback below. The two paths cover disjoint scenarios (exactly-one vs.
  // 2+ zero-option cart items) and never both fire for the same turn.
  if (!correctionApplied && !nameSubmitCheckoutUrl && cart.phase === "building" && cartItems.length > 0) {
    const zeroOptionMenu: ZeroOptionMenuItemFull[] = effectiveMenu.map(mi => ({
      id: mi.id, ask_plan: mi.ask_plan, category: mi.category, price_cents: mi.price_cents,
    }));
    const resolution = resolveZeroOptionAttributeChange(
      userMessage,
      cartItems.filter((i): i is CartItem => Boolean((i as CartItem).menu_item_id)),
      zeroOptionMenu,
    );
    if (resolution) {
      // Note write, when there's no alternative to offer: a DIRECT write
      // (not the generic set_note tool, which unconditionally REPLACES
      // notes and never checks the update's own error result — fine for
      // an LLM-driven turn, wrong here on both counts). Appends to any
      // existing note rather than overwriting it (a customer's earlier
      // "toasted" note must survive this), and the reply below is only
      // allowed to claim the note was passed along once this write is
      // confirmed to have actually succeeded — never assumed.
      let noteWriteSucceeded = false;
      if (!resolution.alternative) {
        const newNote = `Customer requested for "${resolution.itemDisplayName}": ${resolution.rawRequest}`;
        const combinedNotes = combineNotes(cart.notes, newNote);
        const { error: noteError } = await supabase.from("order_carts").update({ notes: combinedNotes }).eq("id", cart.id);
        if (noteError) {
          console.error(`[chat-sms] deterministic zero-option note write FAILED (conv=${conversation.id}): ${noteError.message} — reply will not claim the note was recorded`);
        } else {
          noteWriteSucceeded = true;
          cart.notes = combinedNotes;
        }
      }
      const detReply = renderZeroOptionAttributeChangeReply(resolution, noteWriteSucceeded);
      console.log(`[chat-sms] deterministic zero-option attribute-change handler fired (conv=${conversation.id}), item=${resolution.itemDisplayName}, alternative=${resolution.alternative?.name ?? "none"}, noteWriteSucceeded=${noteWriteSucceeded}`);
      return jsonResponse({ reply: detReply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId, notes: cart.notes });
    }
  }

  // ── Run ordering loop ─────────────────────────────────────────────────────
  // Rebuild system prompt with potentially corrected cart
  //
  // BEFORE-COMPOSITION honesty check (2026-09-08) — FALLBACK ONLY for the
  // ambiguous 2+-zero-option-item case the deterministic handler above
  // doesn't cover. See that block's comment and this hint function's own
  // history in zero-option-attribute-hint.ts for why it's a fallback, not
  // the primary mechanism, for the unambiguous case.
  const zeroOptionHint = buildZeroOptionAttributeChangeHint(
    userMessage,
    cartItems.filter((i): i is CartItem => Boolean((i as CartItem).menu_item_id)),
    effectiveMenu,
  );
  const systemPrompt = buildSystemPrompt(shop, cart.phase, effectiveMenu, [...cart.cart_json], currentTime, isFirstMessage, cart.notes, priorLinkExpired, soldOutNames, cart.order_type, cart.delivery_address, cart.driver_tip_cents, cart.delivery_fee_cents, shop.delivery_enabled, cart.test_mode, deliveryGeoAvailable) + (zeroOptionHint ?? "");

  const shopGeo = shop.latitude != null && shop.longitude != null && shop.delivery_radius_mi > 0
    ? { lat: shop.latitude, lng: shop.longitude, radiusMi: Number(shop.delivery_radius_mi) }
    : null;

  let reply: string;
  let checkoutUrl: string | undefined;
  let declinedBlockedItems: Array<{ category: string; name: string }> = [];
  if (nameSubmitCheckoutUrl) {
    reply = "placeholder"; // Will be overridden by the deterministic checkoutUrl handler below
    checkoutUrl = nameSubmitCheckoutUrl;
  } else {
    const loopResult = await runOrderingLoop(
      systemPrompt, history, userMessage, cartItems, effectiveMenu, cart.id, supabase, shop.name, cart.test_mode, shop.delivery_fee_cents, shopGeo, correctionApplied,
      compiledOrderingEngineEnabled, shop.phone_number_e164 ?? null,
    );
    reply = loopResult.reply;
    declinedBlockedItems = loopResult.declinedBlockedItems ?? [];
    // Defect 1 (2026-09-05): the model may still promise to "check with the
    // kitchen". It checks with nobody. Strip the promise, keep the answer.
    // Applied to model output only — guard-authored replies below are exempt.
    {
      const grounded = stripInventedActions(reply);
      if (grounded !== reply) {
        console.warn(`[chat-sms] INVENTED-ACTION scrub (conv=${conversation.id}). Reply was: ${JSON.stringify(reply).slice(0, 200)}`);
        reply = grounded;
      }
    }
    checkoutUrl = loopResult.checkoutUrl;
  }

  // Snapshot pre-loop order_type before DB reload (guard 2b uses it).
  const orderTypePreLoop = cart.order_type ?? null;

  // Reload in-memory cart from DB after ordering loop mutations.
  // Guards below use in-memory state; stale data causes false positives.
  const { data: freshCart } = await supabase.from("order_carts").select("*").eq("id", cart.id).single();
  if (freshCart) {
    cart.cart_json = (freshCart.cart_json as AnyCartItem[]);
    cart.order_type = (freshCart.order_type as string) || null;
    cart.phase = (freshCart.phase as string) || "greeting";
  }

  // ── POST-TURN DETERMINISTIC GUARDS ────────────────────────────────────────
  // These three guards intercept LLM output and apply mechanical rules so
  // checkout completion is never prompt-hoped. They run in order; each can
  // replace `reply` and stop further processing.

  // Fetch order-level metadata for guards (pickup_name, checkout session, etc).
  const { data: guardCartRow } = await supabase
    .from("order_carts").select("pickup_name, phase, stripe_checkout_session_id, order_type, delivery_fee_cents, driver_tip_cents, fee_disclosed_at")
    .eq("id", cart.id).single();
  const guardCart: AnyCartItem[] = cart.cart_json as AnyCartItem[];

  // Deterministic cart total (used by hallucinated-total guard)
  const guardCartSubtotal = guardCart.reduce((s, i) => {
    if ((i as BundleItem).type === "bundle") {
      return s + ((i as BundleItem).complete ? (i as BundleItem).price_cents : 0);
    }
    const r = i as CartItem;
    return s + (r.price_cents * (r.quantity || 1));
  }, 0);
  const guardDeliveryFee = (guardCartRow?.delivery_fee_cents as number) || 0;
  const guardDriverTip = (guardCartRow?.driver_tip_cents as number) || 0;
  const guardRealTotalCents = guardCartSubtotal + SERVICE_FEE_CENTS + guardDeliveryFee + guardDriverTip;

  // ═══ PROOF PHASE 1: DETERMINISTIC ACCEPTANCE GUARDS ════════════════════
  // These three guards are the hard gate — each has a corresponding proof case.

  // ── Proof Guard P1 (2026-08-30): Checkout finalize always writes order ──
  if (!checkoutUrl && cart.phase === "checkout" && !(guardCartRow?.stripe_checkout_session_id as string | null)) {
    const claimsConfirmation = /(?:order (?:placed|confirmed|received|is in)|all set|you're all set|thanks for (?:your )?order)/i.test(reply);
    if (claimsConfirmation) {
      console.warn(`[chat-sms] PROOF-P1 tripped (conv=${conversation.id}): phase=checkout but no stripe_checkout_session_id.`);
      const hasItems = guardCart.length > 0;
      const incompleteBundle = guardCart.find(i => (i as BundleItem).type === "bundle" && !(i as BundleItem).complete);
      const pickupName = (guardCartRow?.pickup_name as string | undefined) || undefined;
      if (hasItems && !incompleteBundle && pickupName) {
        try {
          const forced = await executeTool("submit_order", { pickup_name: pickupName }, [...guardCart], effectiveMenu, cart.id, supabase, shop.name, cart.test_mode);
          if (forced.ok && forced.checkoutUrl) {
            checkoutUrl = forced.checkoutUrl;
            console.log(`[chat-sms] PROOF-P1 recovered: forced submit_order (cart=${cart.id}).`);
          } else {
            reply = honestFallbackReply(guardCart, false, !isLifetimeFirstContact);
          }
        } catch (_e) {
          reply = honestFallbackReply(guardCart, false, !isLifetimeFirstContact);
        }
      } else {
        reply = honestFallbackReply(guardCart, !!incompleteBundle, !isLifetimeFirstContact);
      }
    }
  }

  // ── Proof Guard P2 (2026-08-30): Cart must persist across turns ────
  // FIX (2026-09-07, negative-close live bug ae7f3351): "never.?mind" and
  // "forget it" used to count as an unambiguous cancel signal here, which
  // means once the model itself decided to wipe the cart on one of those
  // phrases, this guard treated the wipe as deliberate and did NOT restore
  // it. But both phrases are the exact SAME idiom bucket 3 above already
  // documents as genuinely ambiguous ("I'm done" vs. "cancel everything") —
  // reproduced live: "nah forget it" with 2 real items wiped the cart to 0
  // and the model replied "Cart's cleared!", and this guard's own
  // isCancelSignal check let that wipe stand instead of restoring it,
  // because "forget it" matched. Bare "never mind" / "forget it" are now
  // intercepted before the LLM ever runs (bucket 3 above), but a compound
  // message ("nah forget it, that's all") doesn't match that bare-phrase
  // regex and still reaches the model — this guard is the backstop for
  // that case, so it must not treat the same ambiguous words as
  // authorization to skip restoring. Only unambiguous cancel language
  // remains: cancel/reset/start over, and "forget the whole (thing)" /
  // "forget everything" (a scope word makes those unambiguous).
  if (!checkoutUrl) {
    const userMsgLower = userMessage.toLowerCase();
    const isCancelSignal = /cancel|reset|start.?over|forget (?:the whole|everything)/i.test(userMsgLower);
    if (cartItems.length > 0 && guardCart.length === 0 && !isCancelSignal) {
      console.warn(`[chat-sms] PROOF-P2 tripped (conv=${conversation.id}): cart wiped from ${cartItems.length} items to 0 without cancel signal. Restoring.`);
      cart.cart_json = [...cartItems];
      await supabase.from("order_carts").update({ cart_json: JSON.stringify(cartItems) }).eq("id", cart.id);
      const itemList = cartItems.map(i => `${((i as CartItem).quantity || 1)}x ${(i as CartItem).name}`).join(", ");
      reply = `Your cart: ${itemList}. Anything else or ready to checkout?`;
    }
  }

  // ── Proof Guard P3 (retired 2026-08-30): Menu hallucination ──────────
  // REMOVED — the regex reply-scrubber caused false positives on normal
  // phrasing ("Your total is $8.99", "I've got 2 items", etc.). Replaced by:
  //   a) Deterministic Ledger-status rendering below (money/status lines)
  //   b) F1 guard (claimsOffMenuItem) for off-menu item claims
  //   c) Rewritten verifyHallucinationGuard in cart-ops.ts (Ledger-truth check)

  // ── Guard 1: suppress ungrounded totals when cart is empty ─────────────
  // If the model quotes a dollar amount ("$8.99 total") but the cart is
  // actually empty, replace the reply. The LLM can still add items and quote
  // prices; this just blocks the phantom-total case.
  if (guardCart.length === 0 && claimsTotal(reply)) {
    console.warn(`[chat-sms] GUARD 1 (empty-cart total) tripped (conv=${conversation.id}). Reply was: ${JSON.stringify(reply).slice(0, 200)}`);
    reply = "I don't have anything in your cart yet. What would you like to order?";
  }

  // ── Guard 1b: off-menu portion/container words ──────────────────────────
  // If the model uses a container/portion word ("tub", "pint", etc.) that
  // doesn't appear in this shop's menu, flag it and replace the reply with
  // one that uses the menu's real language. Deterministic: vocabulary is built
  // from actual menu item names.
  const menuVocab = buildMenuVocabulary(effectiveMenu);
  const portionCheck = claimsOffMenuPortion(reply, menuVocab);
  if (portionCheck.tripped) {
    console.warn(`[chat-sms] GUARD 1b (off-menu portion) tripped (conv=${conversation.id}). Word "${portionCheck.offWord}" not in menu vocab. Reply was: ${JSON.stringify(reply).slice(0, 200)}`);
    reply = "Sorry, I described that wrong. What can I get started for you? Let me know and I'll add it right away.";
  }

  // ── Guard 1e: ungrounded modifier/format upsell ─────────────────────────
  // If the reply offers an upgrade (flagel/wrap/etc.) for a named item that
  // does not list that modifier, strip the offending sentence(s) and keep the
  // rest so the item is still acknowledged. Deterministic: modifier
  // availability comes from each item's modifiers_json.
  if (!portionCheck.tripped) {
    const upgradeCheck = offersUngroundedUpgrade(reply, effectiveMenu);
    if (upgradeCheck.tripped && upgradeCheck.term) {
      console.warn(`[chat-sms] GUARD 1e (ungrounded upgrade) tripped (conv=${conversation.id}). Offered "${upgradeCheck.term}" for an item that lacks it. Reply was: ${JSON.stringify(reply).slice(0, 200)}`);
      const term = upgradeCheck.term;
      const offerSentence = new RegExp(`(upgrade to|make it|want it (?:on|as)|on a|as a|swap)[^.!?]*\\b${term}\\b`, "i");
      const kept = reply
        .split(/(?<=[.!?\n])\s+/)
        .filter(s => !offerSentence.test(s.toLowerCase()))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      reply = kept.length >= 15 ? kept : "Let me get that started for you! What else can I get you?";
    }
  }

  // ── Guard 1g (F1; 2026-08-29): Menu-item hallucination ──────────────────
  // Detects when the reply claims/offers a menu item that doesn't exist on the
  // shop's actual menu. Runs after portion/upgrade checks. Falls back to honest
  // cart summary when tripped.
  if (!portionCheck.tripped) {
    const menuItemNames = buildMenuItemNames(effectiveMenu);
    const offMenuItem = claimsOffMenuItem(reply, menuItemNames, guardCart);
    if (offMenuItem) {
      console.warn(`[chat-sms] GUARD 1g (menu-item hallucination) tripped (conv=${conversation.id}). Claimed "${offMenuItem}" not in menu. Reply was: ${JSON.stringify(reply).slice(0, 200)}`);
      reply = honestFallbackReply(guardCart, false, !isLifetimeFirstContact);
    }
  }

  // ── Guard 1c: cart-content hallucination ────────────────────────────────
  // If the model claims an item is in the cart but the authoritative cart row
  // doesn't contain that item, suppress the claim. Reuses guardCartRow already
  // fetched above — no second DB read.
  if (!portionCheck.tripped) {
    const hallucinatedItem = claimsItemInCart(reply, guardCart);
    if (hallucinatedItem) {
      console.warn(`[chat-sms] GUARD 1c (cart-content hallucination) tripped (conv=${conversation.id}). Claimed "${hallucinatedItem}" in cart but not present. Reply was: ${JSON.stringify(reply).slice(0, 200)}`);
      // CHANGE 3 (2026-09-05, Jason): the old fallback was a recital AND it did
      // not survive the pipeline — stripLlmMoneyLines() deletes "I've got N
      // items in your cart" (it exists to strip exactly that phrasing from the
      // model), so what actually reached Jason was the bare fragment "What else
      // can I add?" in answer to "why wouldn't you just tell me what's
      // available?". Say something a person would say, own the mistake, and use
      // no digits or the word "items" so the stripper leaves it alone.
      const fallback = guardCart.length > 0
        ? "Sorry, I got mixed up about your order there. What would you like to add or change?"
        : "Nothing's in your order yet. What can I get started for you?";
      reply = fallback;
    }
  }

  // ── Guard 1d: narrated add without actual cart mutation ─────────────────
  // If the model says "added X to your cart" but guardCart is identical to
  // the pre-loop cartItems, no tool was called — the add was imaginary.
  if (!portionCheck.tripped && !claimsItemInCart(reply, guardCart)) {
    if (claimsAddedWithoutMutation(reply, cartItems, guardCart)) {
      console.warn(`[chat-sms] GUARD 1d (phantom-add) tripped (conv=${conversation.id}). Reply claimed add but cart unchanged. Reply was: ${JSON.stringify(reply).slice(0, 200)}`);
      reply = "Sorry, I didn't actually add that — let me try again. What would you like?";
    }
  }

  // ── Guard 1f: narrated correction without cart mutation ────────────────
  // If the model says "fixed it, 1x" / "removed that" / "updated to just one"
  // but the cart didn't change, replace the reply with the real cart state.
  // CHANGE 2 (2026-09-04): fire ONLY when the model gave us nothing coherent to
  // send. When it wrote a reply that acknowledges the cart, that reply ships.
  if (!portionCheck.tripped && claimsCorrectedWithoutMutation(reply, cartItems, guardCart)
      && !replyAcknowledgesCart(reply, guardCart)) {
    console.warn(`[chat-sms] GUARD 1f (narrated-correction-no-mutation) tripped (conv=${conversation.id}). Reply claimed correction but cart unchanged. Reply was: ${JSON.stringify(reply).slice(0, 200)}`);
    if (guardCart.length === 0) {
      reply = "Your cart is empty. What would you like to order?";
    } else {
      const itemList = guardCart.map(i => {
        const r = i as CartItem;
        return `${(r.quantity || 1)}x ${r.name}`;
      }).join(", ");
      // BUG-2 FIX: omit the dash+total fragment entirely when the total is
      // not a real positive amount. The deterministic Ledger footer below owns
      // the numbers, so a missing fragment loses nothing.
      reply = `Your cart: ${itemList}${cartTotalFragment(guardRealTotalCents)}. What else can I add?`;
    }
  }

  // ── Guard 4 v3: Multi-item silent drop → ASK, never auto-add ───────
  // Jason's hard rule (2026-09-01): the cart must NEVER auto-add an item.
  //
  // V2 only fired on closing replies — but the LLM silently drops items
  // from multi-item ordering messages ("Shrimp Scampi and a Pierogie" →
  // only adds one) when it replies with a non-closing prompt like "What
  // else can I add?" This guard catches those drops.
  //
  // TWO DETECTION MODES:
  //   MODE A (closing reply): Same as v2 — cross-reference ALL history
  //     against the cart. Catches items referenced across multiple turns.
  //   MODE B (non-closing, multi-item current message): Scan ONLY the
  //     current message when it contains ordering conjunctions ("and",
  //     "also", "plus", "with") AND is not a question. Catches the LLM
  //     adding only 1 of N items in a single turn.
  //
  // Both modes: never call add_item, never mutate cart_json. Only append
  // an upsell ask line.
  //
  // SAFEGUARDS:
  //   a) Match is against real menu items only (buildMenuItemNames).
  //   b) Bidirectional substring cart-match.
  //   c) Negation filter — items in negated phrases suppressed.
  //   d) Narrowing-order guard — "just"/"only"/"remove" suppresses
  //      prior-history scanning.
  //   e) MODE B: Only scans single-turn ordering messages (not questions).
  //
  // HONEST LIMITS:
  //   - If the customer uses phrasing the menu-name scanner doesn't match,
  //     the guard won't fire.
  //   - Prefer under-asking to nagging.
  // NOTE: this deliberately does NOT require a non-empty cart. It used to
  // (`guardCart.length > 0`), which meant the net was silent in the worst case
  // of all — the customer asked for two things and got ZERO. On 2026-09-05 a
  // tester typed "large pepperoni and a side of garlic knots" and finished with
  // an empty cart and no mention of the knots anywhere in the reply. An
  // under-populated cart guard that only runs once something is in the cart
  // cannot catch nothing being added.
  if (!checkoutUrl) {
    const replyIsClosing = isClosingReply(reply);

    // MODE B: Non-closing multi-item current message → scan current msg only.
    const msgHasOrderConj = /\b(?:and|also|plus|with|too|as well)\b/i.test(userMessage.trim());
    const msgIsQuestion = /^(?:do you|do ya|can you|can i|could you|could i|is there|are there|what|how|where|when|who|why|tell me|do y'all|do ya'll)\b/i.test(userMessage.trim());
    const multiItemInCurrentMsg = msgHasOrderConj && !msgIsQuestion;

    if (replyIsClosing || multiItemInCurrentMsg) {
      const menuItemNames = buildMenuItemNames(effectiveMenu);
      const currentNarrowsOrder = /\b(?:just|only|that['\u2019]s it|that is it|nothing else|no(?:thing)? more|i don['\u2019]t want|i don['\u2019]t need|skip|drop|remove|actually (?:just|only)|scratch|never ?mind|narrow(?:ing)?|let['\u2019]s (?:just|only)|i['\u2019]ll (?:just|only) (?:get|have|take|do)|make it (?:just|only)|that['\u2019]s enough|that['\u2019]s fine)\b/i.test(userMessage.toLowerCase());
      // MODE B: only scan current message. MODE A (closing): scan history.
      const historyToScan = (!replyIsClosing || currentNarrowsOrder)
        ? [{ role: "user" as const, content: userMessage }]
        : [{ role: "user" as const, content: userMessage },
           ...history.filter(h => h.role === "user")];
      let referenced = extractCustomerReferencedItems(
        historyToScan,
        menuItemNames,
      );
      referenced = filterNegatedItems(referenced, userMessage);
      if (referenced.size > 0) {
        let missing = findMissingCartItems(referenced, guardCart);
        // Suppress the guard ONLY where the reply explains the item is
        // unavailable — that is a handled request, and appending "want me to
        // add it?" would contradict the sentence above it. On 2026-09-05 the
        // model correctly said "we don't have a plain pepperoni pizza" and this
        // guard appended 'Did you also want cheese - large (16"), and
        // pepperoni, or good to go?' directly underneath.
        //
        // Merely MENTIONING the item is NOT handling it. The model also said
        // "I can definitely add the garlic knots!" and added nothing; treating
        // that as handled left the customer with an empty cart and no prompt.
        // A promise is not a cart row.
        //
        // SCOPED PER SENTENCE (2026-09-05). This test used to ask whether the
        // reply ANYWHERE declared something unavailable, then drop every item
        // the reply named. One sentence about a missing item therefore
        // suppressed the guard for items in completely different sentences.
        // Measured: "We don't have a plain pepperoni pizza, but ... I can add
        // the garlic knots now though" finished with an EMPTY cart and no
        // prompt — the pepperoni sentence silenced the knots. An item counts as
        // handled only when the SAME sentence both declares an unavailability
        // and names that item.
        const UNAVAILABLE = /(?:we\s+(?:don['’]?t|do\s+not)\s+(?:have|carry|offer|make)|not\s+on\s+(?:the|our)\s+menu|don['’]?t\s+have\s+a\s+plain|isn['’]?t\s+(?:on\s+the\s+menu|something\s+we)|we\s+don['’]?t\s+do)/i;
        // Split on CLAUSES, not just sentences (2026-09-05, QA D1). The model
        // usually joins these with a comma, not a period: "We don't have a plain
        // pepperoni pizza, but I can add the garlic knots now though" is ONE
        // sentence, so the pepperoni clause still silenced the knots and the
        // cart still finished empty. Splitting on ; — and a leading but/though/
        // however/although makes the guard's effectiveness independent of the
        // model's punctuation. Over-splitting is safe: it can only make the
        // guard fire a redundant upsell, never wrongly suppress one.
        const replySentences = reply
          .split(/(?<=[.!?;])\s+|\n+|\s*[\u2014\u2013]\s*|,?\s+(?=but\b|though\b|however\b|although\b)/i)
          .map(t => t.trim())
          .filter(Boolean);
        const unavailableSentences = replySentences
          .filter(t => UNAVAILABLE.test(t))
          .map(t => t.toLowerCase());
        missing = missing.filter(n => {
          if (unavailableSentences.length === 0) return true;
          const norm = n.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
          const words = norm.split(' ').filter(w => w.length >= 4 && !GENERIC_LAST_WORDS.has(w));
          if (words.length === 0) return true;
          // Drop only when ONE sentence both declares an unavailability AND
          // names this specific item.
          return !unavailableSentences.some(t => words.every(w => t.includes(w)));
        });
        if (missing.length > 0) {
          const mode = replyIsClosing ? "v2-closing" : "v3-multi-item";
          console.warn(`[chat-sms] GUARD 4 ${mode} (under-populated cart) tripped (conv=${conversation.id}). Missing: ${missing.join(', ')}. Reply was: ${JSON.stringify(reply).slice(0, 200)}`);
          // CUSTOMER-FACING SUGGESTION REMOVED (2026-09-06, Jason, P0 incident):
          // this used to append "Did you also want X, Y, and Z, or good to
          // go?" built from fuzzy name-matches against the ENTIRE menu. It is
          // not a real upsell — it is fuzzy search results read aloud. A live
          // tester ordering "mild wings and chicken bacon ranch pizza" got
          // offered "Chicken Bacon Ranch (Flatbreads), Chicken (Quesadillas),
          // and Ranch" (near-name matches to the pizza he already ordered).
          // That unresolved offer then sat in conversation history until a
          // later bare "Looks good" was read by the model as consent to add
          // all three, doubling the cart from $37.97 to $74.95 with zero
          // customer intent. Detection + logging above stays (it still catches
          // genuinely dropped items, a real bug fixed 2026-09-05) — only the
          // customer-facing text is gone. A real upsell is a deliberate
          // feature with a deliberate design, not a side effect of name
          // matching.
        }
      }
    }
  }

  // ── Guard 7: ambiguous/upgrading match — same name, different real item ──
  // "caesar salad" silently became "Chicken Caesar" (Salads, $12.95) when
  // "Chicken Caesar" (Wraps, $9.99) is an equally valid match — the customer
  // never said "chicken", never said which. Same ask-don't-guess rule we
  // protect on typos ("prop pizza"), except here it silently charges the
  // wrong price. Deliberately NARROW: fires only when two ACTIVE menu items
  // share the exact same name — never on ordinary composability
  // ("pepperoni pizza" -> Cheese + Pepperoni topping is a correct, wanted
  // resolution the customer never spelled out either, and must not be
  // flagged; that shape has no duplicate-name item to collide with).
  //
  // DEFECT 3 (2026-09-06, live QA): "caesar salad" -> model asks "want that?
  // Also, what dressing?" without ever calling add_item (out of GUARD 7b's
  // narrow literal-name-substring scope, since the customer never typed
  // "chicken caesar"). The NEXT turn ("caesar dressing") is what actually
  // calls add_item, and the category word ("salad") the customer already
  // gave is now a turn back — checking only the CURRENT message re-asks a
  // question the customer already answered. The "already disambiguated,
  // don't second-guess" check below now also looks at the single immediately
  // preceding user turn, not just this one. Bounded to one prior turn
  // (not the whole conversation) so a category word mentioned in passing
  // several turns earlier can't silently resolve an unrelated later item —
  // that would reintroduce GUARD 7's original bug in the other direction.
  const priorUserTurn = [...history].reverse().find(h => h.role === "user");
  const guard7CategoryContext = `${typeof priorUserTurn?.content === "string" ? priorUserTurn.content : ""} ${userMessage}`;
  {
    const beforeIds = new Set(
      cartSnapshotBeforeTurn.filter(i => (i as CartItem).menu_item_id).map(i => (i as CartItem).menu_item_id),
    );
    const addedThisTurn = guardCart.filter(
      i => (i as CartItem).menu_item_id && !beforeIds.has((i as CartItem).menu_item_id),
    ) as CartItem[];

    if (addedThisTurn.length > 0) {
      const byName = new Map<string, EffectiveMenuItem[]>();
      for (const mi of effectiveMenu) {
        const key = mi.name.trim().toLowerCase();
        const arr = byName.get(key) ?? [];
        arr.push(mi);
        byName.set(key, arr);
      }

      for (const added of addedThisTurn) {
        const menuItem = effectiveMenu.find(mi => mi.id === added.menu_item_id);
        if (!menuItem) continue;
        const candidates = byName.get(menuItem.name.trim().toLowerCase()) ?? [menuItem];
        if (candidates.length < 2) continue;

        // Already disambiguated? If the customer's own words name a
        // category that matches exactly ONE candidate, the resolution was
        // correct — don't second-guess a right answer. Singular/plural
        // tolerant (docs/specs/2026-09-06-disambiguation-and-menu-gaps.md,
        // the CORRECTION section): a plain substring match against the
        // category column missed "caesar salad" against "Salads" and "the
        // wrap" against "Wraps" because neither is an exact substring.
        // Checked against guard7CategoryContext (this turn + the immediately
        // preceding user turn — DEFECT 3), not just this message alone, so a
        // category named one turn back ("caesar salad") isn't forgotten by
        // the time add_item actually runs ("caesar dressing").
        const categoryMatches = candidates.filter(c => categoryWordMatches(c.category, guard7CategoryContext));
        if (categoryMatches.length === 1) continue;

        console.warn(`[chat-sms] GUARD 7 (ambiguous same-name match) tripped (conv=${conversation.id}). "${menuItem.name}" exists as ${candidates.length} different items; customer message did not disambiguate.`);
        // An ambiguous charge must never stand silently — roll it back
        // before asking, not after.
        const idx = guardCart.indexOf(added);
        if (idx !== -1) guardCart.splice(idx, 1);
        const optionsText = candidates
          .map(c => {
            const word = categoryDisplayWord(c.category);
            return `the ${c.name}${word ? ` ${word}` : ""} — $${(c.price_cents / 100).toFixed(2)}`;
          })
          .join(" or ");
        reply = `We've got a couple options called "${menuItem.name}" — ${optionsText}. Which one?`;
        // deno-lint-ignore no-await-in-loop
        await saveCart(supabase, cart.id, guardCart, ((cart.phase as OrderPhase) || "building"));
        // BLOCKER 1: persist exactly what was offered so the NEXT message
        // can be resolved deterministically instead of falling into the LLM
        // with no memory of which two items were on the table.
        const pendingPayload: PendingDisambiguation = {
          query_name: menuItem.name,
          candidates: candidates.map((c): PendingCandidate => ({
            menu_item_id: c.id,
            name:         c.name,
            category:     c.category ?? null,
            price_cents:  c.price_cents,
          })),
        };
        // deno-lint-ignore no-await-in-loop
        await supabase.from("order_carts").update({ pending_disambiguation: pendingPayload }).eq("id", cart.id);
        break; // one clarification per turn is enough
      }
    } else {
      // FIX A (2026-09-06): the branch above only persists pending_disambiguation
      // on the ROLLBACK path (add_item was called and had to be undone). Often
      // the model recognizes the same-name collision itself and asks the
      // clarifying question in free text WITHOUT ever calling add_item — the
      // branch above never runs, nothing gets persisted, and the NEXT message
      // (an attempted answer) falls into the LLM/tool loop with no memory of
      // which two items were on the table (silent-partial-success family, see
      // RUNBOOK.md). Trigger: the customer's message names a duplicate-name
      // item that isn't already resolved by a category word, AND the model's
      // own reply is asking something (never fires on a plain factual answer
      // that doesn't require a choice).
      if (/\?/.test(reply)) {
        const byName7b = new Map<string, EffectiveMenuItem[]>();
        for (const mi of effectiveMenu) {
          const key = mi.name.trim().toLowerCase();
          const arr = byName7b.get(key) ?? [];
          arr.push(mi);
          byName7b.set(key, arr);
        }
        const userMsgLower7b = userMessage.toLowerCase();
        for (const [name, candidates] of byName7b) {
          if (candidates.length < 2) continue;
          const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
          if (!nameRe.test(userMsgLower7b)) continue;

          // DEFECT 3: same widened context as GUARD 7 above — a category
          // named on the immediately preceding turn still counts.
          const categoryMatches = candidates.filter(c => categoryWordMatches(c.category, guard7CategoryContext));
          if (categoryMatches.length === 1) continue;

          console.warn(`[chat-sms] GUARD 7b (unprompted disambiguation ask) tripped (conv=${conversation.id}). Customer named "${name}" (${candidates.length} matches); model asked in free text without calling add_item. Persisting candidates.`);
          const pendingPayload7b: PendingDisambiguation = {
            query_name: candidates[0].name,
            candidates: candidates.map((c): PendingCandidate => ({
              menu_item_id: c.id,
              name:         c.name,
              category:     c.category ?? null,
              price_cents:  c.price_cents,
            })),
          };
          // deno-lint-ignore no-await-in-loop
          await supabase.from("order_carts").update({ pending_disambiguation: pendingPayload7b }).eq("id", cart.id);
          break; // one clarification per turn is enough
        }
      }
    }
  }

  // ── Guard 11 (2026-09-07, Jason: BUG 4): named-but-unapplied optional
  // choice on an item added this turn ──────────────────────────────────────
  // Real, verified repro against live Slice option data (Zio's Buffalo
  // Chicken Pizza genuinely has an "Add Toppings" group with Pepperoni at
  // +$3.00): "buffalo chicken pizza with pepperoni" adds the item with Size
  // left pending (a required group) — pepperoni never lands in `options`
  // because add_item only ever resolves what the model explicitly passes in
  // its own tool call, and the model's free-text reply sometimes claims it
  // was applied ("I'll note pepperoni for the kitchen") without any tool
  // call carrying it at all. A topping named in the SAME message as an item
  // with another still-open required group must not be dropped just because
  // that other group isn't resolved yet.
  //
  // Deterministic backstop: for any item added THIS turn that still has an
  // open required group, scan its OTHER option groups for a choice the
  // customer's own message unambiguously names and apply it now — reusing
  // the exact same stem-overlap matcher the pending-answer resolver above
  // uses (resolveAdditionalGroupSelections -> resolvePendingOptionAnswer),
  // never a second, weaker matcher. Runs BEFORE GUARD 8 so a group resolved
  // here is no longer "missing" by the time GUARD 8 decides what to enumerate.
  {
    const beforeIds11 = new Set(
      cartSnapshotBeforeTurn.filter(i => (i as CartItem).menu_item_id).map(i => (i as CartItem).menu_item_id),
    );
    const addedThisTurn11 = guardCart.filter(
      i => (i as CartItem).menu_item_id && !beforeIds11.has((i as CartItem).menu_item_id) && (i as CartItem).pending_options?.length,
    ) as CartItem[];

    let applied11 = false;
    const appliedDesc11: string[] = [];
    for (const added of addedThisTurn11) {
      const menuItem = effectiveMenu.find(mi => mi.id === added.menu_item_id);
      if (!menuItem) continue;
      const alreadySelected = new Set(Object.keys(added.options ?? {}));
      const additional = resolveAdditionalGroupSelections(userMessage, menuItem, alreadySelected);
      for (const sel of additional) {
        added.options = { ...(added.options ?? {}), [sel.group_name]: [sel.choice.name] };
        added.price_cents += sel.choice.price_cents;
        added.pending_options = (added.pending_options ?? []).filter(p => p !== sel.group_name);
        if (added.pending_options.length === 0) added.pending_options = undefined;
        appliedDesc11.push(`${menuItem.name}: ${sel.group_name}=${sel.choice.name}`);
        applied11 = true;
      }
    }
    if (applied11) {
      console.warn(`[chat-sms] GUARD 11 (named-but-unapplied optional choice) tripped (conv=${conversation.id}). Applied: ${appliedDesc11.join(", ")}`);
      await saveCart(supabase, cart.id, guardCart, ((cart.phase as OrderPhase) || "building"));
    }
  }

  // ── Guard 12 (2026-09-07, Jason: BUG 4 hardening): reply confirms a choice
  // that isn't actually in cart_json ────────────────────────────────────────
  // Jason's own repro was worse than the pepperoni-drop GUARD 11 fixes: after
  // the pending required group resolved, the bot flatly said "Small Buffalo
  // Chicken Pizza with pepperoni - got it" with ZERO pepperoni charge. GUARD
  // 11 above now applies any choice it CAN unambiguously resolve from the
  // customer's own words — but a name that doesn't match a real choice
  // unambiguously (hallucinated, misspelled, or genuinely ambiguous between
  // two choices) is never applied, and the reply must not confirm it as if
  // it were. Same "model phrases, code decides" principle as the
  // hallucination guard: cart_json is the source of truth for what's on the
  // order, never the model's sentence.
  //
  // Deliberately APPEND-ONLY, not a sentence-removal rewrite (the riskier
  // approach invented-action-guard.ts uses elsewhere): surgically detecting
  // "which sentence is the false claim" in free text is exactly the kind of
  // fragile regex surgery that has cost real incidents in this file before.
  // Appending an honest correction after whatever the model already said is
  // strictly safer — the customer still ends up told the truth — and the ask
  // is preserved via `unverified_requests` (the same existing mechanism
  // add_item already uses for an unrecognized customer ask) so the shop
  // still sees it on the ticket instead of it silently vanishing.
  {
    const beforeById12 = new Map(
      cartSnapshotBeforeTurn.filter(i => (i as CartItem).menu_item_id).map(i => [(i as CartItem).menu_item_id, i as CartItem]),
    );
    const touchedThisTurn12 = guardCart.filter(i => {
      const ci = i as CartItem;
      if (!ci.menu_item_id) return false;
      const before = beforeById12.get(ci.menu_item_id);
      return !before || JSON.stringify(before.options ?? null) !== JSON.stringify(ci.options ?? null);
    }) as CartItem[];

    const flaggedAsks12: Array<{ item: CartItem; ask: string }> = [];
    for (const ci of touchedThisTurn12) {
      const menuItem = effectiveMenu.find(mi => mi.id === ci.menu_item_id);
      if (!menuItem) continue;
      // P0 REGRESSION FIX (2026-09-07, live on Vito's canary, cheeseburger
      // temp flow): a group still listed in pending_options is, by
      // definition, being ASKED about this turn — the reply necessarily
      // names every one of its choices ("Rare, medium rare, medium, medium
      // well, or well done?") right alongside the base item's own "added"
      // confirmation. That is not a false claim; it is the question GUARD
      // 12 exists to make sure gets asked correctly. Without this
      // exclusion, GUARD 12 fired on EVERY first-add of ANY item with a
      // still-open required group, menu-wide — not a Cheese-Burger-specific
      // bug, a structural one. Only a group that is NOT (or no longer)
      // pending — i.e. was expected to be resolved and wasn't — is real
      // grounds for "the reply confirmed something unresolved."
      const pendingGroupNames = new Set((ci.pending_options ?? []).map(g => g.toLowerCase()));
      const selectedNames = new Set(Object.values(ci.options ?? {}).flat().map(v => v.toLowerCase()));
      const unselectedChoiceNames = (menuItem.option_groups ?? [])
        .filter(g => !pendingGroupNames.has(g.name.toLowerCase()))
        .flatMap(g => g.choices.map(c => c.name))
        .filter(name => !selectedNames.has(name.toLowerCase()));
      if (unselectedChoiceNames.length === 0) continue;

      let replyLower12 = reply.toLowerCase();
      for (const w of menuItem.name.toLowerCase().split(/\s+/).filter(Boolean)) {
        replyLower12 = replyLower12.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
      }
      const claimsConfirmation12 = /\b(?:got it|note[ds]?|add(?:ed|ing)?|noting|i['’]ll)\b/i.test(replyLower12);
      if (!claimsConfirmation12) continue;
      for (const name of unselectedChoiceNames) {
        const nameRe = new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (nameRe.test(replyLower12)) flaggedAsks12.push({ item: ci, ask: name });
      }
    }

    if (flaggedAsks12.length > 0) {
      for (const { item, ask } of flaggedAsks12) {
        const existing = item.unverified_requests ?? [];
        if (!existing.includes(ask)) item.unverified_requests = [...existing, ask];
      }
      console.warn(`[chat-sms] GUARD 12 (confirmation claims unresolved choice) tripped (conv=${conversation.id}). Flagged: ${flaggedAsks12.map(f => `${f.item.name}:${f.ask}`).join(", ")}`);
      await saveCart(supabase, cart.id, guardCart, ((cart.phase as OrderPhase) || "building"));
      const asksText = [...new Set(flaggedAsks12.map(f => f.ask))].join(", ");
      reply = `${reply} Just to be clear — I couldn't confirm "${asksText}" as an option here, so it isn't priced or on the order yet; I've flagged it for the shop.`;
    }
  }

  // ── Guard 15 (2026-09-07, Jason): declined item's reply suggests another
  // BLOCKED item from the same category ────────────────────────────────────
  // "double burger" -> honest decline, correct — then the reply suggested
  // Burger/Cheese Burger/Zio's Deluxe Burger/Mamma Mia Burger/BBQ Cheese
  // Burger, every one of them bot_state='blocked' too (the whole Burgers
  // category was gated on one pending owner question). executeTool's add_item
  // case now hands the model a real orderable_alternatives list plus an
  // explicit "use only this list" instruction, but that is a prompt-level
  // constraint, not a guarantee — same reasoning as every other guard in this
  // file (GUARD 8, 12: the model's own recall of the ~17k-token system
  // prompt is not reliable enough to trust unchecked). General pattern, not
  // Burgers-specific: whenever ANY item was declined this turn for being
  // unorderable, a same-category item name that is ALSO bot_state='blocked'
  // has no business being offered as an alternative — cart_json/bot_state is
  // the source of truth for what's orderable, never the model's sentence.
  // Append-only, same as GUARD 12 — never surgically edits the model's own
  // text.
  if (declinedBlockedItems.length > 0) {
    const declinedNames15 = new Set(declinedBlockedItems.map(d => d.name.toLowerCase()));
    const declinedCategories15 = [...new Set(declinedBlockedItems.map(d => d.category))];
    // Greedy longest-name-first match+consume, same shape as duplicatedNames/
    // menuStr's own collision handling elsewhere in this file: many items in
    // one category share a trailing word ("Burger" is a suffix of "Double
    // Burger", "Cheese Burger", every burger on the menu), so a naive
    // per-name \b regex over the RAW reply flags "Burger" every time the
    // reply merely names "Double Burger" (the item honestly being declined)
    // or "Veggie Burger" (a real, orderable alternative) — neither is a false
    // suggestion. Consuming the longest names first (declined or not, any
    // bot_state) removes their text span before the shorter generic name is
    // ever tested, so only a genuinely SEPARATE mention of the shorter name
    // survives to be checked.
    const categoryItems15 = declinedCategories15
      .flatMap(category => effectiveMenu.filter(m => m.category === category))
      .sort((a, b) => b.name.length - a.name.length);
    const flaggedNames15 = new Set<string>();
    let working15 = reply.toLowerCase();
    for (const itemC of categoryItems15) {
      const nameRe = new RegExp(`\\b${itemC.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      if (!nameRe.test(working15)) continue;
      if (itemC.bot_state === "blocked" && !declinedNames15.has(itemC.name.toLowerCase())) flaggedNames15.add(itemC.name);
      working15 = working15.replace(nameRe, " ");
    }
    if (flaggedNames15.size > 0) {
      console.warn(`[chat-sms] GUARD 15 (blocked item suggested as alternative) tripped (conv=${conversation.id}). Flagged: ${[...flaggedNames15].join(", ")}`);
      const orderableSiblings = declinedCategories15.flatMap(category =>
        effectiveMenu.filter(m => m.category === category && m.bot_state === "orderable").map(m => m.name),
      );
      reply = orderableSiblings.length > 0
        ? `${reply} Correction — those aren't actually available to order by text right now either. What IS available in that category: ${[...new Set(orderableSiblings)].join(", ")}.`
        : `${reply} Correction — none of those are actually available to order by text right now; the shop can help with that one directly.`;
    }
  }

  // ── Guard 16 (2026-09-07, Jason: BUG 4 part b): compiled-path modifier
  // falsely confirmed in reply ──────────────────────────────────────────────
  // Counterpart to GUARD 12 for compiled-path items. GUARD 12 uses
  // option_groups (absent for compiled items) to find unselected choices and
  // flags any that the model claims in its reply. Compiled items store
  // selections in ask_plan_selections instead, so GUARD 12 silently skips
  // them. This guard fills that gap: for any compiled item touched this turn,
  // if the reply names a real modifier choice from the item's ask_plan but
  // that choice is NOT in ask_plan_selections, the claim is false — append
  // a correction and track it as unverified_requests (same convention as
  // GUARD 12/15, append-only, never surgically edits the model's sentence).
  {
    const beforeById16 = new Map(
      cartSnapshotBeforeTurn
        .filter(i => (i as CartItem).menu_item_id)
        .map(i => [(i as CartItem).menu_item_id, i as CartItem]),
    );
    const touchedCompiled16 = guardCart.filter(i => {
      const ci = i as CartItem;
      if (!ci.menu_item_id || !ci.ask_plan_selections) return false;
      const before = beforeById16.get(ci.menu_item_id);
      return !before?.ask_plan_selections ||
        JSON.stringify(before.ask_plan_selections) !== JSON.stringify(ci.ask_plan_selections);
    }) as CartItem[];

    const flagged16: Array<{ item: CartItem; choiceName: string }> = [];
    for (const ci of touchedCompiled16) {
      const menuItem = effectiveMenu.find(mi => mi.id === ci.menu_item_id);
      if (!menuItem?.ask_plan) continue;
      const confirmedDisplays16 = new Set<string>();
      const allModifierDisplays16: string[] = [];
      for (const step of menuItem.ask_plan.steps) {
        if (step.kind !== "modifier") continue;
        for (const c of step.choices) allModifierDisplays16.push(c.display);
        const choiceId = ci.ask_plan_selections![step.group_id];
        if (!choiceId) continue;
        const choice = step.choices.find(c => c.id === choiceId);
        if (choice) confirmedDisplays16.add(choice.display.toLowerCase());
      }
      if (allModifierDisplays16.length === 0) continue;
      // Strip the item's display name AS A PHRASE (not word-by-word) so
      // naming the item itself doesn't read as confirming a modifier choice
      // that shares a word with the item name (e.g. "Grilled Chicken" topping
      // on "Buffalo Chicken Pizza" — stripping "chicken" individually would
      // destroy the modifier's own name; stripping the full phrase "buffalo
      // chicken pizza" leaves "grilled chicken" detectable).
      let replyLower16 = reply.toLowerCase();
      const dn16 = menuItem.ask_plan.display_name.toLowerCase();
      replyLower16 = replyLower16.replace(
        new RegExp(`\\b${dn16.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
      if (!/\b(?:got it|note[ds]?|add(?:ed|ing)?|noting|i['']ll|with)\b/i.test(replyLower16)) continue;
      for (const displayName of allModifierDisplays16) {
        if (confirmedDisplays16.has(displayName.toLowerCase())) continue;
        const nameRe = new RegExp(
          `\\b${displayName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (nameRe.test(replyLower16)) flagged16.push({ item: ci, choiceName: displayName });
      }
    }
    if (flagged16.length > 0) {
      for (const { item, choiceName } of flagged16) {
        const existing = item.unverified_requests ?? [];
        if (!existing.includes(choiceName)) item.unverified_requests = [...existing, choiceName];
      }
      console.warn(`[chat-sms] GUARD 16 (compiled modifier falsely confirmed) tripped (conv=${conversation.id}). Flagged: ${flagged16.map(f => `${f.item.name}:${f.choiceName}`).join(", ")}`);
      await saveCart(supabase, cart.id, guardCart, ((cart.phase as OrderPhase) || "building"));
      const asksText16 = [...new Set(flagged16.map(f => f.choiceName))].join(", ");
      reply = `${reply} Just to be clear — I couldn't confirm "${asksText16}" as an option here, so it isn't priced or on the order yet; I've flagged it for the shop.`;
    }
  }

  // ── Guard 17 (2026-09-08, real NJB transcript): claimed attribute change
  // on a ZERO-OPTION item ──────────────────────────────────────────────────
  // GUARD 16 (above) only ever examines items whose ask_plan has at least
  // one real modifier choice (`if (allModifierDisplays16.length === 0)
  // continue`) -- it was built to catch "wrong choice among real options,"
  // not "claimed an attribute that has no options at all." Real reproduction:
  // NJB's "Bagel with Plain Cream Cheese" has `ask_plan.steps: []` -- a
  // complete item, zero groups of any kind, nowhere for a bagel TYPE to live
  // (confirmed against the live "Bagel With" category: every item is
  // generically "Bagel with X", no bagel-type variant exists as a distinct
  // item or field anywhere). Customer said "everything bagel" as a follow-up;
  // the model replied "Got it - switched to an everything bagel with cream
  // cheese" but the cart line never changed (same menu_item_id, same name,
  // no modifiers, no options field) -- GUARD 16 skipped it before ever
  // checking the reply text, since there was no modifier list to check
  // against. This is a pure honesty fix: there is no different item to
  // resolve to and no group to store a bagel type in, so the fix is not a
  // resolution path -- it's catching the false claim itself, the same way
  // GUARD 16 catches a false claim among real choices.
  //
  // Scoped narrowly to avoid over-firing on a legitimate change to a
  // DIFFERENT item in the same reply. Fires only if a change-claiming verb
  // ("switched," "changed," "swapped," "instead of," "now a/an/with,"
  // "make it a/an," "updated to" -- deliberately NOT "added"/"got it"/
  // "noted," which are honest for a zero-option item that was simply added)
  // is present ANYWHERE in the reply, AND some word immediately preceding
  // the item's head noun is neither an article/quantifier/confirmation word
  // nor a word from ANY cart item's own name (this item's or any other's).
  //
  // Revised THREE times against real deployed transcripts before landing
  // here -- every one of these bugs was only found by actually driving the
  // live endpoint, never by the hand-written unit tests alone:
  //   v1 stripped the item's exact display_name phrase from the reply, then
  //   required a single head noun (the phrase's first word) to survive.
  //   Defeated by real phrasing on the target repro ("Switched to an
  //   everything bagel with plain cream cheese!" -- the substring "bagel
  //   with plain cream cheese" IS the exact display_name, so stripping it
  //   removed the head noun along with the honest suffix; silent).
  //   v2 fixed that by checking the word before the head noun directly, but
  //   a head noun taken from just the phrase's first/last word isn't unique
  //   across items -- real NJB catalog has "Plain Bagel" AND "Bagel with
  //   Plain Cream Cheese" both in one order, and an honest recap of both
  //   ("one Plain Bagel and one Bagel with Plain Cream Cheese -- switched
  //   your drink to a large iced coffee") let "Plain"/"with" collide across
  //   the two items' shared word "bagel," wrongly flagging "Plain Bagel."
  //   v3 anchored on the item's ENTIRE display_name phrase instead of one
  //   word -- fixed the collision, but broke on the very next live run: the
  //   model dropped "plain" entirely ("Switched to an everything bagel with
  //   CREAM CHEESE" -- no "plain"), so the exact-phrase match never fired
  //   at all on its own target case, a false negative.
  //   v4 kept v2's tolerant single-head-noun check (so a dropped word like
  //   "plain" doesn't defeat it) but fixed v2's actual bug directly: the
  //   "is this word honest" check now excludes every word from EVERY cart
  //   item's own name, not just the current item's -- "with" preceding
  //   "bagel" in "...Bagel with Plain Cream Cheese" belongs to THAT item's
  //   own name, so it's honest context regardless of which zero-option
  //   item is being checked.
  //   v5: an independent adversarial review of v4 (before it shipped
  //   un-revised) found a real live-menu false positive: NJB's "One Dozen
  //   Bagels" / "Half Dozen Bagels" derive headNoun17 "one" / "half" --
  //   common enough to appear in totally unrelated conversation ("changed
  //   your pickup time to a later one") and wrongly append a confusing
  //   correction to an honest reply about something else entirely. Fixed by
  //   refusing to use an overly generic word as an anchor at all (see
  //   genericHeadNoun17 below).
  //   v6 (this version): landed alongside a NEW upstream fix (see the
  //   "BEFORE-COMPOSITION honesty check" above buildSystemPrompt) that
  //   steers the model toward an honest denial before it ever composes
  //   anything. Live-verifying THAT fix immediately surfaced a new GUARD 17
  //   bug: an honest denial ("I can't officially change the bagel type on
  //   that one, but I've noted everything bagel for the kitchen") still
  //   contains a change-verb ("change") and a foreign descriptor
  //   ("everything") before the head noun -- the exact shape this guard
  //   was built to catch -- so GUARD 17 appended its OWN correction onto a
  //   reply that was ALREADY honest, recreating the self-contradiction on a
  //   message that never needed fixing. Fixed by requiring the change-verb
  //   NOT be preceded by a negation word ("can't," "unable," "won't," ...)
  //   in the same sentence (see hasUnnegatedChangeClaim17 below) -- a
  //   denial is the behavior this whole fix exists to produce, same
  //   principle as invented-action-guard.ts's own NEGATED check.
  //
  //   KNOWN, ACCEPTED LIMITATION (same review, not fixed -- a genuine
  //   false NEGATIVE, judged lower-priority than a false positive): three
  //   or more zero-option items sharing overlapping words in one cart
  //   (real NJB catalog: "Sesame Bagel," "Poppy Bagel," "Bagel with Plain
  //   Cream Cheese," etc. -- an everyday order easily has two or more) can
  //   let an honest OTHER cart item's own name-word (e.g. "sesame")
  //   shield a genuine false claim about a DIFFERENT item that happens to
  //   reuse the same shared word ("bagel"). Consistent with every guard in
  //   this file being an accepted heuristic, not a provably complete
  //   system -- this fix's bar is "catches the real reported case and
  //   doesn't inject wrong text into honest replies," not "handles every
  //   permutation of a dense, overlapping-name multi-item cart."
  {
    const zeroOptionChangeClaimRe =
      /\b(?:switch(?:ed|ing)?|chang(?:e|ed|ing)|swap(?:ped|ping)?|instead\s+of|now\s+(?:a|an|with)|make\s+(?:it|that)\s+an?|updat(?:e|ed|ing)\s+to)\b/i;
    // Words that legitimately precede an honestly-restated item name and
    // must never themselves count as a "foreign descriptor" — articles/
    // quantifiers (a/an/one/two/...) AND common honest-confirmation words
    // (added/got/confirmed/...), since a reply with no comma before the
    // item name ("Added Bagel with Plain Cream Cheese to your order") is
    // exactly as honest as one with a comma ("Got it, Bagel with...").
    const nonDescriptorWord17 = new Set([
      "a", "an", "the", "one", "two", "three", "four", "five", "some",
      "another", "that", "this", "my", "your", "our", "their", "his", "her",
      "added", "adding", "add", "got", "confirmed", "noted", "noting",
      "plus", "also", "and", "ordered",
    ]);
    // Every word from every cart item's own real name — a word belonging
    // to ANY item currently in the cart is honest context anywhere in the
    // reply, not just when it's adjacent to that specific item's own line.
    const allCartItemWords17 = new Set<string>();
    for (const otherCi of guardCart.filter((i): i is CartItem => Boolean((i as CartItem).menu_item_id))) {
      const otherMenuItem = effectiveMenu.find(mi => mi.id === otherCi.menu_item_id);
      const otherDn = otherMenuItem?.ask_plan?.display_name;
      if (!otherDn) continue;
      for (const w of otherDn.toLowerCase().split(/\s+/)) {
        const cleaned = w.replace(/[^a-z0-9]/g, "");
        if (cleaned) allCartItemWords17.add(cleaned);
      }
    }
    const safeWord17 = new Set([...nonDescriptorWord17, ...allCartItemWords17]);
    // A head noun this generic is worthless as an anchor -- real NJB items
    // "One Dozen Bagels" / "Half Dozen Bagels" derive headNoun17 "one" /
    // "half," common enough to appear in totally unrelated conversation
    // ("changed your pickup time to a later one") and produce a false
    // positive that appends "doesn't have that kind of option" onto a reply
    // about something else entirely. Skip the item rather than risk that —
    // a missed catch on a rarely-reordered bulk item is a far smaller cost
    // than injecting a wrong, confusing correction into an honest reply.
    const genericHeadNoun17 = new Set([
      "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
      "half", "dozen", "some", "few", "several", "single", "double", "triple",
    ]);
    // v6 (2026-09-08, real deployed transcript, found while live-verifying
    // the NEW pre-composition hint above): the hint successfully steers the
    // model toward an honest denial ("I can't officially change the bagel
    // type on that one, but I've noted everything bagel for the kitchen")
    // -- but that sentence still contains a change-verb ("change") AND a
    // foreign descriptor ("everything") right before the head noun
    // ("bagel"), the exact same shape GUARD 17 was built to catch. Without
    // this check, GUARD 17 appended its OWN "doesn't have that kind of
    // option" correction onto a reply that was ALREADY honest and coherent
    // -- recreating Jason's exact self-contradiction complaint on a message
    // that never needed correcting in the first place. A negation word
    // ("can't," "won't," "unable," ...) appearing before the change-verb IN
    // THE SAME SENTENCE means the model is DENYING the change, not claiming
    // it -- the desired behavior, not the lie. Same principle as invented-
    // action-guard.ts's own NEGATED check ("a denial is the behaviour we
    // want, not the lie").
    const negation17Re = /\b(?:can(?:no|['’])?t|cannot|won['’]?t|do(?:n['’]?t| not)|isn['’]?t|am\s+not|i['’]?m\s+not|never|unable|not\s+able|no\s+way\s+to)\b/i;
    function hasUnnegatedChangeClaim17(text: string): boolean {
      const changeReGlobal = new RegExp(zeroOptionChangeClaimRe.source, "gi");
      let claimMatch: RegExpExecArray | null;
      while ((claimMatch = changeReGlobal.exec(text))) {
        const sentenceStart = Math.max(
          text.lastIndexOf(".", claimMatch.index),
          text.lastIndexOf("!", claimMatch.index),
          text.lastIndexOf("?", claimMatch.index),
        ) + 1;
        const beforeClaim = text.slice(sentenceStart, claimMatch.index);
        if (!negation17Re.test(beforeClaim)) return true;
      }
      return false;
    }
    const flagged17: Array<{ item: CartItem; menuItemName: string }> = [];
    for (const ci of guardCart.filter((i): i is CartItem => Boolean((i as CartItem).menu_item_id))) {
      const menuItem = effectiveMenu.find(mi => mi.id === ci.menu_item_id);
      if (!menuItem?.ask_plan || menuItem.ask_plan.steps.length > 0) continue;
      const dn17 = menuItem.ask_plan.display_name.toLowerCase();
      const headNoun17 = dn17.split(/\s+/)[0]?.replace(/[^a-z0-9]/g, "");
      if (!headNoun17 || genericHeadNoun17.has(headNoun17)) continue;
      const replyLower17 = reply.toLowerCase();
      if (!hasUnnegatedChangeClaim17(replyLower17)) continue;
      const precedingRe17 = new RegExp(`\\b(\\w+)\\s+${headNoun17}\\b`, "g");
      let match17: RegExpExecArray | null;
      let foundForeignDescriptor = false;
      while ((match17 = precedingRe17.exec(replyLower17))) {
        if (safeWord17.has(match17[1])) continue;
        foundForeignDescriptor = true;
        break;
      }
      if (foundForeignDescriptor) flagged17.push({ item: ci, menuItemName: menuItem.ask_plan.display_name });
    }
    if (flagged17.length > 0) {
      for (const { item, menuItemName } of flagged17) {
        const note = `claimed change not possible (no options on this item): ${menuItemName}`;
        const existing = item.unverified_requests ?? [];
        if (!existing.includes(note)) item.unverified_requests = [...existing, note];
      }
      console.warn(`[chat-sms] GUARD 17 (zero-option item false attribute-change claim) tripped (conv=${conversation.id}). Flagged: ${flagged17.map(f => f.item.name).join(", ")}`);
      await saveCart(supabase, cart.id, guardCart, ((cart.phase as OrderPhase) || "building"));
      const itemNames17 = [...new Set(flagged17.map(f => f.menuItemName))].join(", ");
      reply = `${reply} Just to be clear — ${itemNames17} doesn't have that kind of option here, so nothing was actually changed; I've flagged it for the shop.`;
    }
  }

  // ── Guard 8: pending-options reply doesn't name the actual choices ──────
  // add_item is 100% ID-based and correctly stores pending_options + the full
  // choice list in effectiveMenu/the system prompt — but surfacing "what
  // dressing would you like, choices are Ranch, Caesar, ..." to the customer
  // is otherwise left entirely to the model recalling it from a ~17k-token
  // system prompt resent every turn, and it sometimes (nondeterministically)
  // claims it doesn't have the list even though the data is right there
  // (2026-09-06, Jason's live Chicken Caesar transcript: "I don't have the
  // dressing list for this one" while the tool result held 18 real choices).
  // Deterministic fix: if an item was added this turn with unresolved
  // required groups and the model's own reply doesn't already name a real
  // choice from a group, append the actual list — pulled from effectiveMenu,
  // never from the model.
  {
    const beforeIds8 = new Set(
      cartSnapshotBeforeTurn.filter(i => (i as CartItem).menu_item_id).map(i => (i as CartItem).menu_item_id),
    );
    const addedThisTurn8 = guardCart.filter(
      i => (i as CartItem).menu_item_id && !beforeIds8.has((i as CartItem).menu_item_id) && (i as CartItem).pending_options?.length,
    ) as CartItem[];

    const missingClauses: string[] = [];
    for (const added of addedThisTurn8) {
      const menuItem = effectiveMenu.find(mi => mi.id === added.menu_item_id);
      if (!menuItem) continue;
      // Strip the item's own name before matching — "Chicken Caesar added!"
      // must not count as enumerating a "Caesar" dressing choice just
      // because the word appears in the item name.
      const replyLower = reply.toLowerCase().split(menuItem.name.toLowerCase()).join(" ");
      for (const groupName of added.pending_options ?? []) {
        const group = menuItem.option_groups?.find(g => g.name === groupName);
        if (!group || group.choices.length === 0) continue;
        const namesReplyMentions = group.choices.some(c => replyLower.includes(c.name.toLowerCase()));
        if (namesReplyMentions) continue;
        missingClauses.push(`Choices for ${displayGroupName(group.name)}: ${group.choices.map(c => c.name).join(", ")}.`);
      }
    }
    if (missingClauses.length > 0) {
      console.warn(`[chat-sms] GUARD 8 (pending-options not enumerated) tripped (conv=${conversation.id}). Reply omitted real choice names for: ${missingClauses.join(" | ")}`);
      reply = `${reply} ${missingClauses.join(" ")}`;
    }
  }

  // ── Guard 10 (2026-09-06, Jason): unconsented option selection ──────────
  // Live 5-session test, same input: "sometimes added with no dressing
  // mentioned at all, sometimes asks (correct — no default exists),
  // sometimes invents one ('with Caesar dressing - added!')." The model can
  // supply add_item/modify_item options that pass a required group's
  // validation (a real recorded choice name, e.g. "Caesar" on an item
  // literally called "Chicken Caesar") without the customer ever having
  // named it — indistinguishable from a genuine selection by add_item alone,
  // since both produce the identical `options: { Dressing: ["Caesar"] }`.
  // The only code-driven way an option may be set with no customer
  // selection is deterministic default-fill (is_default, see add_item) —
  // anything else that changed THIS TURN and wasn't customer-stated is
  // invented and reverts to pending, same shape as GUARD 9 reverting a
  // phantom cart add. Runs BEFORE GUARD 2 (below) so its pending-options
  // re-ask sees the corrected state, not the model's invented one.
  {
    const beforeById10 = new Map(
      cartSnapshotBeforeTurn.filter(i => (i as CartItem).menu_item_id).map(i => [(i as CartItem).menu_item_id, i as CartItem]),
    );
    const msgLowerBase10 = userMessage.toLowerCase();
    let reverted10 = false;
    for (const item of guardCart) {
      const ci = item as CartItem;
      if (!ci.menu_item_id || !ci.options) continue;
      const menuItem = effectiveMenu.find(mi => mi.id === ci.menu_item_id);
      if (!menuItem) continue;
      const before10 = beforeById10.get(ci.menu_item_id);
      // Strip the item's own name so naming the ITEM never counts as naming
      // a CHOICE — same trap GUARD 8 already guards against ("Chicken
      // Caesar added!" must not read as enumerating a "Caesar" dressing).
      // WORD-level, not just the exact full name: "i want a caesar salad"
      // (Jason's actual test phrase) never contains the literal substring
      // "chicken caesar", so a full-name strip is a no-op and "caesar"
      // would wrongly read as the customer having named the Caesar dressing
      // — when they were only describing the dish. Strip every individual
      // word of the item's name, whole-word, wherever it appears.
      const itemNameWords10 = menuItem.name.toLowerCase().split(/\s+/).filter(Boolean);
      let msgLower10 = msgLowerBase10;
      for (const w10 of itemNameWords10) {
        msgLower10 = msgLower10.replace(new RegExp(`\\b${w10.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
      }
      // Local non-optional handle: narrowed once here rather than per-group,
      // so reverting one group's choice this iteration can't turn the FIELD
      // undefined out from under a later group's lookup in the same item
      // (two required groups, both invented, would otherwise throw).
      const options10 = ci.options;
      for (const group of menuItem.option_groups ?? []) {
        if (!group.required) continue;
        const chosen = options10[group.name];
        if (!chosen || chosen.length === 0) continue;
        const beforeChosen = before10?.options?.[group.name];
        if (JSON.stringify(beforeChosen ?? null) === JSON.stringify(chosen)) continue; // resolved on an earlier turn — already vetted then
        const defaultChoice = group.choices.find(c => c.is_default && c.price_cents === 0);
        if (defaultChoice && chosen.length === 1 && chosen[0] === defaultChoice.name) continue; // our own deterministic default-fill
        // SOLE-CHOICE GUARD (2026-09-07, found live-testing the stated-
        // provenance gate fix against Zio's real menu data): a required
        // group with exactly ONE active choice can never have an "invented"
        // selection — there is nothing else it could ever resolve to, so
        // applying it is a fact, not a decision (same reasoning as the
        // compiled engine's auto_single ask_mode, spec §2.2). Before this,
        // any single-choice group whose sole choice wasn't ALSO flagged
        // is_default (common on Slice-imported data, e.g. Zio's "Choose an
        // option" -> "Regular") got reverted to pending here, so a newly-
        // orderable item like Cheese Burger got stuck re-asking "what option
        // would you like?" forever with no second option to offer. Reached
        // for the first time only once the provenance gate stopped
        // menu-wide-blocking these items — not a compiled-path-only fix:
        // any required single-choice group on the legacy path had the exact
        // same latent bug, just never exercised because no legacy item with
        // a non-default sole choice had reached this guard live yet.
        if (group.choices.length === 1 && chosen.length === 1 && chosen[0] === group.choices[0].name) continue;
        // BUG (2026-09-07, found while live-testing GUARD 11 against Zio's):
        // this was a literal substring check against the FULL choice name
        // ("large 18''"), which a customer never types verbatim ("large").
        // GUARD 11 above resolves that correctly via the file's real
        // stem-matcher (resolvePendingOptionAnswer) — then GUARD 10 here,
        // running later, saw no literal "large 18''" substring, decided it
        // was never customer-stated, and reverted GUARD 11's own correct
        // resolution back to pending. Fixed by using the SAME matcher GUARD
        // 11 (and the rest of this file) already relies on, instead of a
        // second, weaker check.
        if (chosen.some(v => resolvePendingOptionAnswer(msgLower10, [{ name: v, price_cents: 0 }]) !== null)) continue; // genuinely customer-stated this turn
        console.warn(`[chat-sms] GUARD 10 (unconsented option selection) tripped (conv=${conversation.id}). "${menuItem.name}" ${group.name}="${chosen.join(", ")}" was not named by the customer this turn and is not a recorded default; reverting to pending.`);
        const revertedCents = group.choices.filter(c => chosen.includes(c.name)).reduce((s, c) => s + c.price_cents, 0);
        delete options10[group.name];
        ci.price_cents -= revertedCents;
        ci.pending_options = [...new Set([...(ci.pending_options ?? []), group.name])];
        reverted10 = true;
      }
      if (ci.options && Object.keys(ci.options).length === 0) ci.options = undefined;
    }
    if (reverted10) {
      await saveCart(supabase, cart.id, guardCart, ((cart.phase as OrderPhase) || "building"));
      reply = renderMissingOptionsPrompt(
        guardCart
          .filter(i => ((i as CartItem).pending_options?.length ?? 0) > 0)
          .map(i => ({ name: (i as CartItem).name, missingGroups: (i as CartItem).pending_options! })),
      );
    }
  }

  // ── Guard 9: unconsented cart growth on a bare affirmation ──────────────
  // P0 INCIDENT (2026-09-06, Jason's tester "Luca"): GUARD 4's fuzzy-match
  // upsell line ("Did you also want Chicken Bacon Ranch (Flatbreads), Chicken
  // (Quesadillas), and Ranch, or good to go?") sat in conversation history as
  // an unresolved offer. Two turns later Luca said "Looks good" — a bare
  // affirmation — and the model read the FULL history including that stale
  // offer as consent to add all three, issuing real add_item tool calls. Cart
  // went from 2 items/$37.97 to 4 items/$74.95 with zero customer intent.
  //
  // Removing GUARD 4's upsell text (above) fixes THIS incident's trigger, but
  // Jason's rule is broader and must hold for any FUTURE mechanism that
  // leaves an open offer in history: "'Looks good', 'yes', 'yep', 'sure',
  // 'ok', 'sounds good', 'perfect', 'that works' confirm the cart as it
  // stands. They are not consent to add anything the customer never named."
  //
  // Deterministic backstop: compare TOTAL QUANTITY per menu_item_id between
  // the true pre-turn snapshot (`cartSnapshotBeforeTurn` — NOT `cartItems`,
  // which is mutated in place by executeTool's push()/splice() calls and so
  // already reflects post-turn state by the time this guard runs; see the
  // comment above cartSnapshotBeforeTurn's declaration) and the post-tool-call
  // cart (`guardCart`). Quantity growth for an item is what makes a customer
  // pay more — this is the signal to check for consent on, not a raw
  // line-level diff.
  //
  // Deliberately NOT a fingerprint (menu_item_id + options) diff: filling in
  // a pending required option group (e.g. answering "yes" to "want ranch on
  // that?") mutates an EXISTING line's `options` in place via add_item's own
  // resolvingPendingIdx merge path (same array slot, same total quantity) —
  // a fingerprint-only diff would see a "new" combination and wrongly delete
  // a line the customer never asked to remove. Total quantity per item is
  // unchanged by that resolution, so keying on quantity growth skips it
  // correctly while still catching the Luca-shape bug (brand new lines with
  // zero prior quantity for that item).
  //
  // Any growth on a turn where the customer's message is a bare affirmation
  // (`impliesOrderConfirmation`, reused — not reinvented) is unconsented
  // UNLESS the CURRENT message alone (never history — that is the whole
  // point) names the item. A genuinely named add on affirmation-adjacent
  // phrasing ("yeah also add fries") is not reverted: "fries" is in this
  // turn's message, so it was actually asked for.
  //
  // The diff/decision logic itself lives in guard9-unconsented-affirmation.ts
  // (imported above) — pure, testable against the real function, and with no
  // access to `cartItems` at all so the wiring bug above can't recur here.
  {
    const menuItemNamesG9 = buildMenuItemNames(effectiveMenu);
    const namedThisTurnG9 = extractCustomerReferencedItems(
      [{ role: "user", content: userMessage }],
      menuItemNamesG9,
    );
    const isNamedThisTurnG9 = (itemName: string): boolean => {
      const itemLower = itemName.toLowerCase();
      return [...namedThisTurnG9].some(n => {
        const n2 = n.toLowerCase();
        return n2.includes(itemLower) || itemLower.includes(n2);
      });
    };

    const guard9Result = computeGuard9(userMessage, cartSnapshotBeforeTurn, guardCart, isNamedThisTurnG9);

    if (guard9Result.tripped) {
      const revertedDesc = [
        ...guard9Result.phantomAdds.map(r => `removed ${r.name}`),
        ...guard9Result.qtyReverts.map(({ item, priorQty }) => `reverted ${item.name} qty ${(item as CartItem).quantity} -> ${priorQty}`),
      ].join(", ");
      console.warn(`[chat-sms] GUARD 9 (unconsented-add-on-affirmation) tripped (conv=${conversation.id}). Message "${userMessage}" is a bare affirmation; reverted: ${revertedDesc}`);
      // Mutate guardCart by OBJECT IDENTITY, not menu_item_id lookup —
      // executeTool's remove_item/modify_item resolve by menu_item_id
      // alone, which would delete/modify the WRONG line if the customer
      // has two lines for the same item with different options (e.g. two
      // pizzas, different toppings, one of which is the phantom add).
      // Same pattern GUARD 7 above uses (guardCart.splice by indexOf).
      for (const r of guard9Result.phantomAdds) {
        const idx = guardCart.indexOf(r);
        if (idx !== -1) guardCart.splice(idx, 1);
      }
      for (const { item, priorQty } of guard9Result.qtyReverts) {
        (item as CartItem).quantity = priorQty;
      }
      await saveCart(supabase, cart.id, guardCart, ((cart.phase as OrderPhase) || "building"));
      // Honest confirmation of the REAL (reverted) cart only. No dollar
      // figure here by design — the deterministic Ledger footer below
      // states the real total from the corrected guardCart; hand-rolling a
      // total here would risk quoting the pre-revert number.
      reply = guardCart.length > 0
        ? "Got it! Anything else, or are you all set?"
        : "Your cart is empty. What would you like to order?";
    }
  }

  // ── Guard 13 (2026-09-07, Jason: quantity-doubling on an unrelated reply
  // while a required option is still pending) ──────────────────────────────
  // CONFIRMED live against Zio's (session zios-bug3-repro-6-512ad83d...):
  // turn 1 "large buffalo chicken pizza" -> cart qty=1, $19.99; turn 2
  // "pickup" (a single, non-retried message, nothing to do with the pizza or
  // its options) -> cart qty=2, $19.99. Root cause: the system prompt tells
  // the model to call add_item immediately for an item with a pending
  // required option (correct, turn 1), but nothing forbids the model from
  // reaching for add_item AGAIN on a LATER, unrelated turn while that option
  // is still open. add_item's own phantom-add guard only engages when the
  // repeat call carries new `options` resolving the pending group — a repeat
  // call with NO options falls to the plain existing-line match (same
  // menu_item_id, options both undefined) and stacks quantity, exactly like
  // a genuine "add another one" would.
  //
  // Distinct from GUARD 9 above: GUARD 9 only evaluates on a BARE
  // AFFIRMATION (impliesOrderConfirmation — "yes", "looks good", ...); this
  // bug's trigger ("pickup") is not an affirmation at all, so GUARD 9 never
  // sees it. Deterministic backstop, mirroring GUARD 9's own before/after
  // diff shape: any line that (a) already had an open required option
  // BEFORE this turn, (b) grew in quantity this turn, (c) has IDENTICAL
  // options before and after (nothing was actually resolved), and (d) was
  // never named in the customer's own message this turn (so a genuine
  // "another one, please" — which DOES name the item — is never reverted)
  // is unconsented growth; revert the quantity to what it was before this
  // turn's tool loop ran.
  {
    const menuItemNames13 = buildMenuItemNames(effectiveMenu);
    const namedThisTurn13 = extractCustomerReferencedItems(
      [{ role: "user", content: userMessage }],
      menuItemNames13,
    );
    const isNamedThisTurn13 = (itemName: string): boolean => {
      const itemLower = itemName.toLowerCase();
      return [...namedThisTurn13].some(n => {
        const n2 = n.toLowerCase();
        return n2.includes(itemLower) || itemLower.includes(n2);
      });
    };

    const guard13Reverts = computeGuard13(cartSnapshotBeforeTurn, guardCart, isNamedThisTurn13);
    if (guard13Reverts.length > 0) {
      const revertedDesc13 = guard13Reverts.map(({ item, priorQty }) => `${(item as CartItem).name} qty ${(item as CartItem).quantity} -> ${priorQty}`).join(", ");
      console.warn(`[chat-sms] GUARD 13 (unconsented quantity growth on pending item) tripped (conv=${conversation.id}). Message "${userMessage}" never named the item(s); reverted: ${revertedDesc13}`);
      for (const { item, priorQty } of guard13Reverts) {
        (item as CartItem).quantity = priorQty;
      }
      await saveCart(supabase, cart.id, guardCart, ((cart.phase as OrderPhase) || "building"));
    }
  }

  // ── Guard (menu link): send the live menu page, don't leave it to the model ──
  // FIX (2026-09-06, Jason): "we should be able to send a link to their
  // menu" — a customer asking for the menu previously got a long category
  // dump or "I don't have a link to share." The public menu page
  // (getsprintai.com/m/<slug>, supabase/functions/public-menu) reads the
  // same rows chat-sms does, so it can never disagree with what the bot
  // sells. Deliberately narrow: only an explicit ask for "the menu" or "a
  // link" trips this — a specific question about one item/category (e.g.
  // "what wing flavors do you have?") is left to the model to answer
  // directly, per the spec (docs/specs/2026-09-06-public-menu-page.md).
  if (shop.slug && impliesMenuRequest(userMessage)) {
    console.log(`[chat-sms] GUARD (menu-link) tripped (conv=${conversation.id}). Sending menu link.`);
    reply = `Here's our full menu — take a look and let me know what you'd like: https://getsprintai.com/m/${shop.slug}`;
  }

  // ── Guard 2: order confirmation + no pickup name → ask for it ──────────
  // If the customer confirms they want to place the order AND the cart has
  // items AND no pickup name is stored, deterministically ask for the name
  // instead of hoping the LLM remembers the PICKUP NAME RULE.
  //
  // FIX (2026-09-06, Jason): unresolved required options must be caught here
  // FIRST. This guard used to ask for the name unconditionally on any
  // confirmation, so a customer who confirmed with (say) a dressing choice
  // still pending got asked their name instead of being re-asked about the
  // dressing — submit_order would reject at D1 and the real reason got
  // swallowed into a vague reassurance (see the D1 fix below).
  const hasPickupName = !!(guardCartRow?.pickup_name as string | undefined);
  const guardPendingItems = guardCart.filter(
    i => (i as CartItem).pending_options && (i as CartItem).pending_options!.length > 0,
  ) as CartItem[];
  if (!checkoutUrl && guardCart.length > 0 && guardPendingItems.length > 0 && impliesOrderConfirmation(userMessage)) {
    const asks = guardPendingItems.map(i => `${i.name} (${i.pending_options!.join(", ")})`).join("; ");
    console.log(`[chat-sms] GUARD 2-pending (confirmation with unresolved required options) tripped (conv=${conversation.id}). Re-asking: ${asks}`);
    reply = renderMissingOptionsPrompt(guardPendingItems.map(i => ({ name: i.name, missingGroups: i.pending_options! })));
  } else if (!checkoutUrl && guardCart.length > 0 && !hasPickupName && impliesOrderConfirmation(userMessage)) {
    console.log(`[chat-sms] GUARD 2 (confirmation sans pickup name) tripped (conv=${conversation.id}). Forcing name prompt.`);
    // The itemized receipt is attached below in Phase A (the single place
    // that owns this, since the model asks for the name on its own
    // initiative far more often than this guard has to force it) — keep
    // this reply plain so the receipt is never shown twice.
    reply = `Got it! ${NAME_ASK}`;
  }

  // ── Guard 2c: hallucinated total ──────────────────────────────────────
  // If the model quotes a dollar total that doesn't match the real cart
  // total (subtotal + service fee + delivery fee + tip), replace the reply
  // with one that states the actual computed total from cart_json.
  // The payment link amount IS the real total, and the bot must never
  // quote a different number.
  if (guardCart.length > 0 && !checkoutUrl) {
    const quotedCents = extractDollarCents(reply);
    // CHANGE 2 (2026-09-04, Jason): only fire when the model presents a figure
    // AS A TOTAL. Previously ANY dollar amount counted and the LAST one was
    // assumed to be the total, so a reply offering menu prices
    // ("bone-in ($16.99) or boneless ($11.99)?") or writing its own
    // "(subtotal $37.49 + $0.99 service fee)" line was judged to have
    // hallucinated a total and had its entire message discarded. Quoting a
    // price is not quoting a total.
    const claimsATotal = /\b(?:total|subtotal|comes to|that['\u2019]ll be|that will be|you owe|grand total|order total|due|to pay|adds up to|comes out to|altogether|all together)\b/i.test(reply);
    if (quotedCents.length > 0 && claimsATotal) {
      const lastQuoted = quotedCents[quotedCents.length - 1];
      // Allow ±$0.01 rounding difference
      if (Math.abs(lastQuoted - guardRealTotalCents) > 1) {
        console.warn(`[chat-sms] GUARD 2c (hallucinated-total) tripped (conv=${conversation.id}). Quoted ${lastQuoted}¢ vs real ${guardRealTotalCents}¢. Reply was: ${JSON.stringify(reply).slice(0, 200)}`);

        // CHANGE 2 (2026-09-04, Jason): do NOT replace a coherent reply with a
        // flat cart recital. This guard was the one overwriting the model mid
        // conversation — it treats the LAST dollar amount in the reply as "the
        // total", so a model that writes its own "(subtotal $37.49 + $0.99
        // service fee)" line reads as quoting 99c against a real 3947c cart and
        // gets its whole message thrown away.
        //
        // Money safety is preserved WITHOUT discarding the model's words: strip
        // the model-emitted money from its own sentence and let the
        // deterministic Ledger footer below state the real numbers. The customer
        // still never sees a wrong figure. Only if stripping leaves nothing
        // usable do we fall back to the recital.
        const stripped = repairOrphanedPunctuation(stripLlmMoneyLines(reply));
        if (replyAcknowledgesCart(stripped, guardCart)) {
          reply = stripped;
        } else {
          const itemList = guardCart.map(i => {
            const r = i as CartItem;
            return `${(r.quantity || 1)}x ${r.name}`;
          }).join(", ");
          reply = `Your cart: ${itemList}${cartTotalFragment(guardRealTotalCents)}. What else can I add?`;
        }
      }
    }
  }

  // ── D1 (2026-08-29): CHECKOUT COMPLETION DRIVER ───────────────────
  // When cart is submittable (items + no incomplete bundle + order_type known +
  // name known) AND the customer signals checkout intent, FORCE submit_order
  // to create the real Stripe session. Stops the "what else?" / pickup-
  // delivery re-ask loop after a checkout signal. Reuses submit_order's own
  // C1 gate for safety (requires pickup_name + order_type). Runs between Guards 2c and 2b.
  if (!checkoutUrl && guardCart.length > 0 && hasPickupName && orderTypePreLoop) {
    const hasIncompleteBundle = guardCart.find(i => (i as BundleItem).type === "bundle" && !(i as BundleItem).complete);
    if (!hasIncompleteBundle && impliesOrderConfirmation(userMessage)) {
      console.log(`[chat-sms] D1 checkout-completion-driver firing (conv=${conversation.id}, cart=${cart.id}, name="${guardCartRow?.pickup_name}", order_type=${orderTypePreLoop})`);
      const submitInput: Record<string, unknown> = { pickup_name: guardCartRow?.pickup_name };
      const submitResult = await executeTool("submit_order", submitInput, guardCart, effectiveMenu, cart.id, supabase, shop.name, cart.test_mode, shop.delivery_fee_cents, shopGeo);
      if (submitResult.ok && submitResult.checkoutUrl) {
        checkoutUrl = submitResult.checkoutUrl;
        reply = `All set! Here's your order:\n\n${renderItemizedRecap(guardCart, guardDeliveryFee, guardDriverTip)}\n\nPayment link — tap to finish: ` + submitResult.checkoutUrl;
      } else {
        // FIX (2026-09-06, Jason): submit_order's own error already names the
        // specific reason (pending option, missing order type, missing
        // address, missing name — see the C1 gates and the pending_options
        // check above in the submit_order case). The old fallback discarded
        // that and replaced it with a generic "one moment" reassurance —
        // which also violates the system prompt's own banned-phrase list
        // (line ~722: "one moment" is explicitly banned). Never swallow a
        // real rejection behind a friendly non-answer; surface the actual
        // reason as a natural re-ask instead.
        const errMsg = (submitResult.result as { error?: string } | undefined)?.error;
        const pending = (submitResult.result as { pending?: Array<{ name: string; missingGroups: string[] }> } | undefined)?.pending;
        console.warn(`[chat-sms] D1 submit_order failed: ${JSON.stringify(submitResult.result).slice(0, 200)}`);
        // FIX (2026-09-06, Jason — internal-name leak): use submit_order's
        // STRUCTURED pending list through the shared humanizer, never regex
        // out of the display-oriented error string — that string is worded
        // for the model ("Gyro (needs: Dressing)"), not a customer.
        if (pending && pending.length > 0) {
          reply = renderMissingOptionsPrompt(pending);
        } else if (errMsg && /pickup or delivery/i.test(errMsg)) {
          reply = "Pickup or delivery today?";
        } else if (errMsg && /delivery address/i.test(errMsg)) {
          reply = "What's the delivery address?";
        } else if (errMsg && /pickup name is required/i.test(errMsg)) {
          reply = `Got it! ${NAME_ASK}`;
        } else {
          // Unmapped/unexpected failure — stay honest rather than reassuring.
          reply = errMsg ? `I couldn't finish that — ${errMsg}` : "I couldn't finish that order — let's try again.";
        }
      }
    }
  }

  // ── Guard 2b: SILENT ORDER-TYPE REVERT ───────────────────────────────
  // 2026-09-04 (Jason): this guard NO LONGER appends "Pickup or delivery today?"
  // to the reply. Appending it ended four of six replies in a test conversation,
  // including replies that had already resolved the question, and it read like a
  // machine because it was one. The model asks about order type on its own when
  // the prompt's ORDER TYPE line tells it to (it does so unprompted). The model
  // owns that question now.
  //
  // What remains is the part the model cannot do for itself: if it silently set
  // an order_type via tool call WITHOUT asking, revert it so the prompt keeps
  // instructing it to ask on the next turn. That is a state correction, not a
  // reply rewrite.
  const guardDeliveryEnabled = shop?.delivery_enabled === true;
  const guardOrderTypeBefore = orderTypePreLoop;
  const guardOrderTypeAfter  = guardCartRow?.order_type ?? null;
  // BUG-1 FIX (2026-09-04): "already present" must also catch the exact phrase
  // we would append, and any reply that has ALREADY resolved the question —
  // e.g. one that tells the customer the shop is pickup only. Appending
  // "Pickup or delivery today?" to "we're pickup only at this time" is the
  // robotic non-sequitur Jason hit.
  const guardReplyHasExactQuestion = /Pickup or delivery today\?/i.test(reply);
  const guardReplyStatesPickupOnly = /pickup[- ]only|only (?:doing|offering|available for) pickup|we (?:do not|don['’]t) (?:offer|do) delivery|no delivery (?:option|available|right now|today|at this time)/i.test(reply);
  const guardReplyHadPickupDelivery = /pickup.*delivery|delivery.*pickup|all set for (?:pickup|delivery)|switching to (?:pickup|delivery)|(?:pickup|delivery) order/i.test(reply) ||
    guardReplyHasExactQuestion || guardReplyStatesPickupOnly;

  // Only fire when order_type was NOT already known coming into this turn.
  // If the customer already chose (e.g., "delivery") earlier, skip.
  // Also skip if the customer's message THIS turn contains pickup/delivery
  // (they're answering the question).
  const userSaidPickupDelivery = /\b(?:pickup|delivery)\b/i.test(userMessage);
  const needsDeliveryGate = guardDeliveryEnabled && !checkoutUrl &&
    guardCart.length > 0 && !guardReplyHadPickupDelivery && !guardOrderTypeBefore &&
    !userSaidPickupDelivery;

  if (needsDeliveryGate) {
    // LLM silently set order_type (pickup or delivery) via tool call
    // without asking the customer — revert so next turn still gates.
    if (guardOrderTypeAfter) {
      await supabase.from("order_carts").update({ order_type: null }).eq("id", cart.id);
      cart.order_type = null;
      console.log(`[chat-sms] GUARD 2b reverted silently-set order_type "${guardOrderTypeAfter}" (conv=${conversation.id})`);
    }
    // NO reply mutation here by design — see the block comment above.
  }

  // ── POST-TURN PHANTOM-LINK SAFETY NET (Guard 3) ───────────────────────────
  // INVARIANT: a reply that claims a payment link was sent / the order is
  // placed may ONLY go out if a real Stripe checkout session exists this turn.
  //
  // If the model wrote a payment-claim WITHOUT submit_order having created a
  // session (checkoutUrl is falsy), the reply is a lie. We do one of two things:
  //   (a) RECOVER: if the cart is submittable (has items, no incomplete bundle)
  //       and we know a pickup name, force submit_order ourselves to produce a
  //       REAL link, then send the real success copy. This is deterministic and
  //       reuses submit_order's own idempotency-friendly path.
  //   (b) HONEST FALLBACK: if we genuinely can't submit (empty cart, incomplete
  //       bundle, or no pickup name), replace the reply with a truthful message
  //       that asks for what's missing and NEVER claims a link was sent.
  if (!checkoutUrl && claimsPaymentSent(reply)) {
    console.warn(`[chat-sms] PHANTOM-LINK GUARD tripped (conv=${conversation.id}, cart=${cart.id}). Model claimed payment without submit_order. Reply was: ${JSON.stringify(reply).slice(0, 200)}`);

    const hasItems = guardCart.length > 0;
    const incompleteBundle = guardCart.find(i => (i as BundleItem).type === "bundle" && !(i as BundleItem).complete);

    // Determine a pickup name: prefer the stored one; otherwise, if the bot had
    // just asked for a name and the user's last message is a short name-like
    // token, use that (mirrors the PICKUP NAME RULE in the system prompt).
    let pickupName: string | undefined = (guardCartRow?.pickup_name as string | undefined) || undefined;
    if (!pickupName) {
      const trimmed = userMessage.trim();
      const looksLikeName = /^[A-Za-z][A-Za-z .'-]{0,30}$/.test(trimmed) && trimmed.split(/\s+/).length <= 3;
      // Only treat as a name if the prior assistant turn actually asked for one.
      const lastAssistant = [...history].reverse().find(h => h.role === "assistant");
      const askedForName = typeof lastAssistant?.content === "string"
        && /\bname\b/i.test(lastAssistant.content)
        && /pickup|pick up|under (?:what|which)|who(?:'s| is) (?:this|it) for|order for/i.test(lastAssistant.content);
      if (looksLikeName && askedForName) pickupName = trimmed;
    }

    if (checkoutAlreadyExists(guardCartRow)) {
      // A real session already exists on the row (created earlier). Do NOT make
      // a second one (idempotency). Send an honest reminder to check for the
      // existing link instead of a fresh "sent!" claim.
      reply = "Your payment link was already sent -- check your texts or email for it. Tap it to finish your order.";
      console.log(`[chat-sms] PHANTOM-LINK GUARD: session already existed (cart=${cart.id}); sent existing-link reminder, no new session.`);
    } else if (hasItems && !incompleteBundle && pickupName) {
      // RECOVER: force the real submit_order path deterministically.
      // Mirror C2's deadlock breaker: if order_type is null (delivery shop where
      // customer never said pickup/delivery), default to pickup so submit_order's
      // C1 gate passes.
      if (!guardOrderTypeAfter) {
        console.log(`[chat-sms] PHANTOM-LINK GUARD defaulting order_type to "pickup" (was null, conv=${conversation.id})`);
        await supabase.from("order_carts").update({ order_type: "pickup" }).eq("id", cart.id);
        cart.order_type = "pickup";
      }
      try {
        const forced = await executeTool(
          "submit_order",
          { pickup_name: pickupName },
          [...guardCart],
          effectiveMenu,
          cart.id,
          supabase,
          shop.name,
          cart.test_mode,
        );
        if (forced.ok && forced.checkoutUrl) {
          checkoutUrl = forced.checkoutUrl;
          console.log(`[chat-sms] PHANTOM-LINK GUARD recovered: forced submit_order created a real session (cart=${cart.id}).`);
        } else {
          reply = honestFallbackReply(guardCart, false, !isLifetimeFirstContact);
          console.warn(`[chat-sms] PHANTOM-LINK GUARD: forced submit_order did not produce a link (${JSON.stringify(forced.result).slice(0,160)}). Sent honest fallback.`);
        }
      } catch (e) {
        reply = honestFallbackReply(guardCart, false, !isLifetimeFirstContact);
        console.error(`[chat-sms] PHANTOM-LINK GUARD: forced submit_order threw. Sent honest fallback.`, e);
      }
    } else {
      // HONEST FALLBACK: cannot submit — ask for what's missing, claim nothing.
      reply = honestFallbackReply(guardCart, !!incompleteBundle, !isLifetimeFirstContact);
      console.warn(`[chat-sms] PHANTOM-LINK GUARD: cannot submit (hasItems=${hasItems}, incompleteBundle=${!!incompleteBundle}, pickupName=${!!pickupName}). Sent honest fallback.`);
    }
  }

  // ── D2 (retired 2026-09-04) ──────────────────────────────────────────
  // The pickup/delivery re-ask killer is gone. It existed only to strip the
  // question Guard 2b appended above; with nothing appending it, there is
  // nothing to strip, and leaving it would have silently deleted the model's
  // OWN order-type question mid-sentence.

  // ── Phase A: Deterministic money/status rendering ────────────────────
  // Strip LLM-emitted totals/fees/status lines, then append the Ledger footer.
  // Cart has items, not in checkout phase → deterministic footer owns the numbers.
  if (!checkoutUrl && guardCart.length > 0) {
    reply = stripLlmMoneyLines(reply);
    const driverTip = (guardCartRow as any)?.driver_tip_cents ?? undefined;
    // Fee breakdown noise fix (Jason, 2026-09-05): line 1 (item count + total)
    // every turn; line 2 (subtotal + fee breakdown) only the first turn the
    // fee applies, persisted so it never repeats after that — and again at
    // checkout (separate code path below, unconditional on this flag).
    const feeAlreadyDisclosed = !!(guardCartRow as any)?.fee_disclosed_at;
    // HARD GATE (2026-09-06, Jason — "the required-options gate is
    // intermittent... put the check where the cart is finalized, not on the
    // route the customer happened to take"): GUARD 2's re-ask only fires
    // when impliesOrderConfirmation() matches the customer's exact wording
    // (itself just fixed for "thats it" — see guard9-unconsented-affirmation.ts)
    // — any FUTURE phrasing gap, or the model independently deciding to ask
    // for the name on its own (the common path per the recap fix above),
    // has the same reachability problem the recap had. This is the
    // unconditional backstop: whatever produced this reply, if ANY cart
    // line still has an unresolved required option, the reply can never be
    // a name-ask — checkout cannot proceed while the recap it's about to
    // show has a hole in it. Checked first, ahead of the recap logic below.
    const anyPendingOptions = guardCart.some(i => ((i as CartItem).pending_options?.length ?? 0) > 0);
    if (anyPendingOptions && isAskingForPickupName(reply)) {
      const pendingForPrompt = guardCart
        .filter(i => ((i as CartItem).pending_options?.length ?? 0) > 0)
        .map(i => ({ name: (i as CartItem).name, missingGroups: (i as CartItem).pending_options! }));
      console.warn(`[chat-sms] HARD GATE (name-ask with unresolved required options) tripped (conv=${conversation.id}). Overriding reply that asked for the name while options were still pending.`);
      reply = renderMissingOptionsPrompt(pendingForPrompt);
    } else if (!hasPickupName && isAskingForPickupName(reply)) {
      // FIX (2026-09-06, Jason): the itemized recap belongs at the ONE moment
      // that matters — the customer is being asked for their pickup name,
      // which is the last step before checkout, regardless of whether GUARD 2
      // forced that ask or the model asked on its own initiative (the common
      // case; GUARD 2 is only a backstop). A count-and-total footer here is
      // exactly the gap Luca's $37 double-charge exposed: he only caught it
      // because he happened to read a number, not because the bot itemized
      // anything. This replaces the plain footer with the full receipt only
      // at this one moment; every other turn keeps the short footer as before.
      reply = `${reply}\n\n${renderItemizedRecap(guardCart, guardDeliveryFee, guardDriverTip)}`;
    } else {
      const footer = renderLedgerFooter(guardCart, guardCartRow?.phase ?? "building", guardDeliveryFee, guardDriverTip, !feeAlreadyDisclosed);
      if (footer) {
        reply = `${reply}\n\n${footer}`;
      }
    }
    if (!feeAlreadyDisclosed) {
      await supabase.from("order_carts").update({ fee_disclosed_at: new Date().toISOString() }).eq("id", cart.id);
    }
  }

  // If checkout was created, override the model's reply entirely — prevents hallucinated confirmations.
  // Deterministically state the fee-inclusive total from the authoritative cart row so the service
  // fee is always disclosed with the payment link (not left to the model, which may quote subtotal only).
  let safeReply: string;
  if (checkoutUrl) {
    const { data: checkoutCart } = await supabase
      .from("order_carts")
      .select("service_fee_cents, total_cents")
      .eq("id", cart.id).single();
    const totalCents = (checkoutCart?.total_cents as number | null) ?? null;
    const feeCents = (checkoutCart?.service_fee_cents as number | null) ?? 0;
    const totalStr = totalCents != null && totalCents > 0
      ? ` Your total is $${(totalCents / 100).toFixed(2)}${feeCents > 0 ? ` (includes a $${(feeCents / 100).toFixed(2)} service fee)` : ""}.`
      : "";
    safeReply = `Payment link sent!${totalStr} Tap it to complete your order. Check your text or email.`;
  } else {
    safeReply = reply;
  }

  await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", safeReply);

  // Reload cart for response
  const { data: updatedCart } = await supabase.from("order_carts").select("*").eq("id", cart.id).single();
  const currentCart = (updatedCart as OrderCart) ?? cart;

  // Strip markdown for clean SMS/text output
  let finalReply = stripMarkdown(safeReply);

  // ── Compliance disclosure: stripped from model output ALWAYS, then appended
  //    deterministically, last, exactly once, on first contact only.
  //
  // It used to be left to the model on first contact. The model put it wherever
  // it liked: on 2026-09-05 a public tester's first reply opened with
  // "Msg & data rates may apply. Reply HELP for help or STOP to unsubscribe."
  // before a word of content, and another opened mid-sentence at
  // "to unsubscribe." Position is not something to hope for — a legal footer
  // belongs at the end, and the code owns where it goes.
  finalReply = finalReply
    .replace(/\.?\s*Msg[& ]+data rates may apply\.?\s*/gi, " ")
    .replace(/\.?\s*Reply HELP for help(,)?( or| &) STOP to (unsubscribe|opt out|stop)\.?\s*/gi, " ")
    .replace(/\.?\s*Reply STOP to (unsubscribe|opt out|stop)\.?\s*/gi, " ")
    .replace(/\.?\s*Text HELP for help\.?\s*/gi, " ")
    .replace(/\.?\s*Text STOP to cancel\.?\s*/gi, " ")
    // A partial strip can leave a dangling fragment at the very start.
    .replace(/^\s*(?:or\s+)?(?:to\s+)?(?:unsubscribe|opt out|stop)\.?\s*/i, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // FIX C: this turn fell through with a disambiguation question still open
  // (see carriedDisambiguation above) — never silently drop it, UNLESS this
  // same turn's fall-through reached checkout (a real payment link was
  // generated, or submit_order moved the cart to phase "checkout"). A
  // customer who said "checkout"/"that's it" and got their payment link
  // does not need — and should never see — a leftover "did you want the
  // salad or wrap?" tacked onto their checkout link, and the state must not
  // ride along into the confirmed order either.
  if (carriedDisambiguation) {
    const reachedCheckout = !!checkoutUrl || currentCart.phase === "checkout";
    if (reachedCheckout) {
      await supabase.from("order_carts").update({ pending_disambiguation: null }).eq("id", cart.id);
      console.log(`[chat-sms] Pending disambiguation cleared (conv=${conversation.id}): "${carriedDisambiguation.query_name}" abandoned; customer's turn reached checkout.`);
    } else {
      const stillOpenOptions = carriedDisambiguation.candidates
        .map(c => {
          const word = categoryDisplayWord(c.category);
          return `the ${c.name}${word ? ` ${word}` : ""}`;
        })
        .join(" or ");
      finalReply = `${finalReply}\n\nStill wondering — did you want ${stillOpenOptions}?`;
    }
  }

  if (isLifetimeFirstContact) {
    finalReply = `${finalReply}\n\n${COMPLIANCE_DISCLOSURE}`;
  }

  // Append payment URL if present and not already in the reply
  if (checkoutUrl && !finalReply.includes(checkoutUrl)) {
    const combined = `${finalReply}\n\nPay here: ${checkoutUrl}`;
    finalReply = isSms
      ? (combined.length <= 1600 ? combined : `${finalReply.substring(0, 1200)}\n${checkoutUrl}`)
      : combined;
  }

  if (isSms) {
    await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, finalReply);
    return emptyTwiml();
  }
  return jsonResponse({
    reply:        finalReply,
    cart:         currentCart.cart_json,
    phase:        currentCart.phase,
    test_mode:    currentCart.test_mode ?? false,
    notes:        currentCart.notes,
    session_id:   sessionId,
    checkout_url: checkoutUrl,
    // Which model served this turn. Read by the simulator's test-transcript
    // capture so the stored corpus records what actually answered, rather than
    // a value the client guessed. Web/JSON path only — the SMS branch above
    // returns TwiML and is untouched.
    model:        CHAT_MODEL,
  });
});
