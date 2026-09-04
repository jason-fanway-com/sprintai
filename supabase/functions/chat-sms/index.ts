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
import { claimsAddedWithoutMutation } from "./phantom-add-guard.ts";

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
const COMPLIANCE_HELP = "SprintAI text ordering. Text your order to this number to order from this restaurant. Message frequency varies by order, typically 3-8 messages per order. Support: support@getsprintai.com. Msg & data rates may apply. Reply STOP to opt out.";
const COMPLIANCE_START = "Thanks for texting! You'll receive order-related messages from this restaurant. Message frequency may vary. Msg&data rates may apply. Reply HELP for help, STOP to opt out.";

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
}

interface CartItem {
  menu_item_id: string;
  name:         string;
  quantity:     number;
  price_cents:  number;
  modifiers:    string[];
  options?:     Record<string, string[]>;
  pending_options?: string[];  // option group names not yet chosen (required groups with no selection)
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

  const { data: items } = await supabase
    .from("menu_items")
    .select("id, name, description, price_cents, category, modifiers_json, prompt_for")
    .eq("menu_id", menu!.id)
    .eq("active", true)
    .order("display_order", { ascending: true });

  if (!items?.length) return { menu: [], soldOutNames: [] };

  // Load option groups and choices for these menu items
  const itemIds = items.map(i => i.id);
  const { data: optionGroupsData } = await supabase
    .from("option_groups")
    .select("id, menu_item_id, name, required, min_select, max_select, display_order")
    .in("menu_item_id", itemIds)
    .order("display_order");

  const groupIds = (optionGroupsData || []).map(g => g.id);
  const { data: optionChoicesData } = groupIds.length > 0
    ? await supabase
        .from("option_choices")
        .select("id, option_group_id, name, price_cents, is_default, display_order")
        .in("option_group_id", groupIds)
        .order("display_order")
    : { data: [] };

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
    }));

  return { menu: effectiveItems, soldOutNames };
}

// ─── System prompt builder ────────────────────────────────────────────────────

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
        return `${qty}x ${r.name}${mods}${opts} - $${((r.price_cents * qty) / 100).toFixed(2)}`;
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
            const reqLabel = g.required ? `required, pick ${g.max_select > 1 ? g.min_select + '-' + g.max_select : '1'}` : `optional${g.max_select > 1 ? ', pick up to ' + g.max_select : ''}`;
            return `    → ${g.name} (${reqLabel}): ${g.choices.map(c => c.name + (c.price_cents > 0 ? ` +$${(c.price_cents/100).toFixed(2)}` : '')).join(', ')}`;
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

  const complianceNote = isFirstMessage
    ? "\n\nCOMPLIANCE NOTE: Append this sentence to your very first message (after your greeting): \"Msg & data rates may apply. Reply HELP for help or STOP to unsubscribe.\""
    : "";

  // SYNCHRONOUS expired-link nudge (lead directive 2026-06-22). This is added
  // to the prompt ONLY because the customer just texted us again (a fresh
  // inbound). We never PUSH an expired notice; we only mention it inline in a
  // reply the customer's own message triggered.
  const expiredNote = priorLinkExpired
    ? "\n\nEXPIRED LINK CONTEXT: The customer's previous payment link expired. Since they just messaged again, gently let them know that link expired and ask if they want to reorder, then help them start fresh."
    : "";

  const orderTypeInfo = orderTypeStr === "delivery"
    ? `\nORDER TYPE: Delivery`
    : orderTypeStr === "pickup"
      ? `\nORDER TYPE: Pickup`
      : `\nORDER TYPE: Not chosen. REQUIRED: In your response, ask the customer \"pickup or delivery?\" Do NOT proceed without asking.`;

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
      return `\nWING POLICY: NOT CONFIGURED for this shop. You do NOT know how many flavors are included, or whether an order can be split across flavors. Do NOT tell the customer they can mix and match, and do NOT tell them they cannot. Ask, or say you will check with the kitchen.`;
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
- MONEY/SCOPE RULE (CRITICAL): NEVER state a total, subtotal, service fee, delivery fee, tip amount, item count, or dollar figure in your response. The system appends the correct numbers from the Ledger automatically. If you need to summarize the cart, say "I've got your items" without listing how many. When asking for pickup name, say "What name for pickup?" without quoting a total. When confirming before submit_order, say "All good — confirm?" without restating the price. The numbers BELOW in the CURRENT CART section are for YOUR reference only — do NOT quote them in your reply.
- Only use item IDs exactly as shown in the menu (the ID: prefix is part of the ID)
- Never add items not in the available menu
- SOLD OUT ITEMS: If a customer asks for an item that is listed as SOLD OUT TODAY, tell them we're temporarily out of it today (e.g., "We're actually out of Everything bagels today — sorry about that!"). Do NOT say the item doesn't exist or isn't on the menu. Suggest alternatives if available.
- Never use em dashes in responses
- When cart has items and customer says they are done or asks to check out, ask for pickup name. Do NOT restate every item in the cart — they just built it, they know what's in it. Do NOT quote a total (the system adds it). Example: "What name should I put this under for pickup?"
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
- WHEN YOU DO NOT KNOW THE CHOICES: say so plainly and ask, or offer to check - never guess and never imply a list exists. Do NOT offer "examples" of what the options might be either ("like buffalo, BBQ, something else?"); to a customer an example reads as availability, and it is the same invented promise in softer words. Ask an open question instead. Good: "What flavor would you like on those?" or "Let me check which dressings we have - what were you thinking?" Never: "We've got Hot, Mild, BBQ, and Sweet & Spicy", and never "like buffalo or BBQ", when the menu entry does not list them.
- NEVER STATE SHOP POLICY YOU WERE NOT TOLD: whether flavors can be mixed or split across an order, whether substitutions are allowed, whether extras cost more, minimums, or timing. If a policy is not given to you above, do not assert it in either direction. Say you will check. "You can mix and match!" is a promise the kitchen may not be able to keep.
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

      for (const group of itemGroups) {
        const selections = inputOptions[group.name] || [];
        if (group.required && selections.length === 0) {
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
      // Match on menu_item_id + options; merge pending_options when stacking quantity
      const existing = cart.findIndex(i =>
        (i as CartItem).menu_item_id === menu_item_id &&
        JSON.stringify((i as CartItem).options ?? undefined) === JSON.stringify(normalizedOptions)
      );
      if (existing >= 0) {
        (cart[existing] as CartItem).quantity += (quantity as number);
        (cart[existing] as CartItem).modifiers = inputMods;
        (cart[existing] as CartItem).price_cents = menuItem.price_cents + extraCents + modPriceCents;
        // Merge pending_options — resolve any that now have selections
        const existingPending = (cart[existing] as CartItem).pending_options || [];
        const mergedPending = [...new Set([...existingPending, ...pending])].filter(
          p => !(inputOptions[p] && inputOptions[p].length > 0)
        );
        (cart[existing] as CartItem).pending_options = mergedPending.length > 0 ? mergedPending : undefined;
      } else {
        cart.push({ menu_item_id, name: menuItem.name, quantity: quantity as number, price_cents: menuItem.price_cents + extraCents + modPriceCents, modifiers: inputMods, options: normalizedOptions, pending_options: pending.length > 0 ? pending : undefined });
      }
      await saveCart(supabase, cartId, cart, "building");
      const total = cart.reduce((s, i) => s + (i as CartItem).price_cents * (i as CartItem).quantity, 0);
      return { ok: true, result: { added: menuItem.name, quantity, cart_total: `$${(total / 100).toFixed(2)}` }, newPhase: "building" };
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
      if (options !== undefined) {
        const groupNames = new Set((menuItem?.option_groups || []).map(g => g.name));
        const cleaned: Record<string, string[]> = {};
        for (const [key, vals] of Object.entries(options)) {
          if (modifierNames.has(key) && !groupNames.has(key)) {
            for (const v of vals) {
              if (modifierNames.has(v) && !newModifiers.includes(v)) newModifiers.push(v);
            }
          } else {
            cleaned[key] = vals;
          }
        }
        newOptions = Object.keys(cleaned).length > 0 ? cleaned : undefined;
      }
      const invalidMods = newModifiers.filter(m => !validMods.includes(m));
      if (invalidMods.length > 0) return { ok: false, result: { error: `Invalid modifiers: ${invalidMods.join(", ")}` } };
      (cart[idx] as CartItem).modifiers = newModifiers;
      if (newOptions !== undefined) (cart[idx] as CartItem).options = newOptions;
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
      return { ok: true, result: { modified: (cart[idx] as CartItem).name, quantity: (cart[idx] as CartItem).quantity, price: (cart[idx] as CartItem).price_cents } };
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
      const itemsWithPending = cart
        .filter(i => (i as CartItem).pending_options && (i as CartItem).pending_options!.length > 0)
        .map(i => {
          const r = i as CartItem;
          const missing = r.pending_options!.join(', ');
          return `${r.name} (needs: ${missing})`;
        });
      if (itemsWithPending.length > 0) {
        return { ok: false, result: { error: `Cannot submit yet — these items still need options chosen: ${itemsWithPending.join('; ')}. Ask the customer for each missing option, then use modify_item to set them.` } };
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
): Promise<{ reply: string; checkoutUrl?: string; finalPhase?: OrderPhase }> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");

  const messages: Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }> = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let checkoutUrl: string | undefined;
  let finalPhase:  OrderPhase | undefined;

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
          return { reply: `Got it — $${tipArg.toFixed(2)} driver tip added. Let me confirm your order. What name for pickup?`, finalPhase: "building" };
        }
        console.warn(`[chat-sms] Tip shortcut: set_driver_tip failed, falling through to LLM`);
      } else {
        // User declined tip — proceed without calling tool (tip already $0)
        return { reply: "No problem — no tip added. Let me confirm your order. What name for pickup?", finalPhase: "building" };
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
      if (reply) return { reply, checkoutUrl, finalPhase };
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
          console.warn(`[chat-sms] E1 GUARD: suppressed clear_cart — additive user intent (conv=${conversation.id}, cart has ${cart.length} items). Message: ${JSON.stringify(userMessage).slice(0, 120)}`);
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
      );
      if (result.checkoutUrl) checkoutUrl = result.checkoutUrl;
      if (result.newPhase)    finalPhase  = result.newPhase;
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
function honestFallbackReply(cart: AnyCartItem[], incompleteBundle = false): string {
  if (!cart || cart.length === 0) {
    return "What can I get started for you? Let me know your items and I'll get your order going.";
  }
  if (incompleteBundle) {
    return "Almost there! Your bundle still needs a few more picks before I can send your payment link. What else would you like in it?";
  }
  // Has items, just missing the pickup name to submit.
  return "Got your order! What name should I put it under for pickup? Once I have that I'll send your payment link.";
}

// ─── Phase A: Deterministic Ledger-status rendering ─────────────────────────

/**
 * Render the authoritative money/status footer from Ledger truth.
 * The LLM owns the conversational framing; the Ledger owns the numbers.
 * This is appended to every non-checkout reply that has cart items.
 */
function renderLedgerFooter(
  cart: AnyCartItem[],
  phase: string,
  deliveryFeeCents?: number,
  driverTipCents?: number,
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
  lines.push(`(subtotal $${(subtotal / 100).toFixed(2)} + $${(SERVICE_FEE_CENTS / 100).toFixed(2)} service fee${deliveryFeeCents ? ` + $${(deliveryFeeCents / 100).toFixed(2)} delivery` : ""}${driverTipCents ? ` + $${(driverTipCents / 100).toFixed(2)} tip` : ""})`);

  return lines.join("\n");
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

    const parts = full.split(' ').filter(w => w.length >= 3);
    if (parts.length > 1) {
      const lastName = parts[parts.length - 1];
      if (!names.has(lastName)) names.set(lastName, item.name);
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
  const patterns = [
    /(?:one\s+)?(["']?[A-Za-z][\w\s&'-]{1,40}?)(?:\s+is\s+)?(?:already\s+)?in\s+(?:your|the)\s+cart/i,
    /you\s+(?:already\s+)?have\s+(?:a\s+)?(["']?[A-Za-z][\w\s&'-]{1,40}?)(?:\s+in\s+(?:your|the)\s+cart)?/i,
    /i['"]?(?:ve|\s+have)\s+(?:already\s+)?(?:got\s+)?(?:a\s+)?(["']?[A-Za-z][\w\s&'-]{1,40}?)\s+(?:in\s+(?:your|the)\s+cart|already)/i,
  ];

  for (const re of patterns) {
    const m = reply.match(re);
    if (!m) continue;
    const claimed = m[1].replace(/["']/g, '').trim();
    if (claimed.length < 2) continue;
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

// Guard 2 helper: detects customer intent to confirm / place the order.
function impliesOrderConfirmation(text: string): boolean {
  if (!text) return false;
  const norm = text.toLowerCase().trim();
  return /\b(?:yes|yeah|yep|yup|confirm|sure|place (?:the |my |an )?order|check out|checkout|that[' ]s it|that is it|looks good|all good|go ahead|proceed|go for it|do it|send it|pay|ready|done|that[' ]s all|that is all|all set|i'?m ready|i'?m done|good to go|let'?s go|let'?s do it|place it|ring it up|finalize|submit)\b/i.test(norm) ||
    /^(?:ok|okay|k|kk|fine|perfect|great|awesome|excellent|fantastic|sounds good|good|yes please|do it|let's do this)[.!]?$/i.test(norm);
}

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
  const cartLower = new Set(
    cart.map(i => {
      if ((i as BundleItem).type === "bundle") return (i as BundleItem).name.toLowerCase();
      return (i as CartItem).name.toLowerCase();
    })
  );

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
  return new Response(JSON.stringify(data), {
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

// Normalize open_hours for a day into an array of {open,close} windows.
// Handles both the new flat-object shape (Phase 5) and the legacy array shape.
function dayWindows(dayHours: { closed?: boolean; open?: string; close?: string } | Array<{ open: string; close: string }> | undefined | null): Array<{ open: string; close: string }> {
  if (!dayHours) return [];
  if (Array.isArray(dayHours)) return dayHours;
  // Flat-object shape: { closed, open, close }
  if (dayHours.closed || !dayHours.open || !dayHours.close) return [];
  return [{ open: dayHours.open, close: dayHours.close }];
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
  if (provider === "telnyx") {
    await sendSmsViaTelnyx(supabase, shopId, ctx, fromNumber, toNumber, message);
  } else {
    await sendSmsViaTwilio(ctx, fromNumber, toNumber, message);
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
          return `<tr><td style="padding:6px 8px;">${h(r.name)}${detailSub}</td><td style="padding:6px 8px;text-align:center;">${r.quantity || 1}</td><td style="padding:6px 8px;text-align:right;">${linePrice}</td></tr>`;
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
  if (isSms && customerPhone) {
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

  // RESET keyword — expire current cart so next message gets a clean one
  if (userMessage.trim().toUpperCase() === "RESET") {
    await supabase.from("order_carts").update({ phase: "expired", test_mode: false }).eq("id", cart.id);
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
      await supabase.from("order_carts").update({ cart_json: [], phase: "greeting", stripe_checkout_session_id: null, subtotal_cents: 0, total_cents: 0 }).eq("id", cart.id);
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
  const deliveryGeoAvailable = shop.delivery_enabled === true
    ? (shop.latitude != null && shop.longitude != null)
    : false;

  // ── Deterministic correction handler (Fix 2: Corrections must write back) ──
  // Before the LLM ever runs, detect correction intent in the user message
  // and directly mutate the cart. "just want one" / "make it one" / "remove one"
  // must update cart_json AND persist BEFORE any summary is shown.
  let cartItems    = [...cart.cart_json];
  let correctionApplied = false;
  {
    const norm = userMessage.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const isCorrection = cartItems.length > 0 && (
      /^(just want one|make it one|just one|only one|one is fine|just 1|make it 1|one of those|one of them|just the one|actually just one|actually one)$/i.test(norm) ||
      /^(i just want|i only want|i want just|ill take just|ill take one|ill have just|i just need|i wanted just|i meant just|give me just|let me get just)\s+(one|1)$/i.test(norm) ||
      /^(remove one|remove that|remove it|take it off|take that off|no thanks|never mind|nevermind|scratch that|forget that)$/i.test(norm) ||
      /^(remove the|remove my|drop the|drop my|take off the|take off my)\s+.+$/i.test(norm)
    );
    if (isCorrection) {
      const isRemove = /^(remove|drop|take off|scratch|forget|no thanks|never ?mind)\b/i.test(norm);
      if (isRemove && cartItems.length > 0) {
        // Remove the last item from the cart
        const lastItem = cartItems[cartItems.length - 1];
        const mid = (lastItem as CartItem).menu_item_id;
        if (mid) {
          await executeTool("remove_item", { menu_item_id: mid }, cartItems, effectiveMenu, cart.id, supabase, shop.name, cart.test_mode);
          correctionApplied = true;
          console.log(`[chat-sms] Correction (remove): removed "${(lastItem as CartItem).name}" from cart (conv=${conversation.id})`);
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
      const askedForName = typeof lastAssistant?.content === "string"
        && /\bname\b/i.test(lastAssistant.content)
        && /pickup|pick up|under (?:what|which)|who(?:'s| is) (?:this|it) for|order for/i.test(lastAssistant.content);
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

  // ── Run ordering loop ─────────────────────────────────────────────────────
  // Rebuild system prompt with potentially corrected cart
  const systemPrompt = buildSystemPrompt(shop, cart.phase, effectiveMenu, [...cart.cart_json], currentTime, isFirstMessage, cart.notes, priorLinkExpired, soldOutNames, cart.order_type, cart.delivery_address, cart.driver_tip_cents, cart.delivery_fee_cents, shop.delivery_enabled, cart.test_mode, deliveryGeoAvailable);

  const shopGeo = shop.latitude != null && shop.longitude != null && shop.delivery_radius_mi > 0
    ? { lat: shop.latitude, lng: shop.longitude, radiusMi: Number(shop.delivery_radius_mi) }
    : null;

  let reply: string;
  let checkoutUrl: string | undefined;
  if (nameSubmitCheckoutUrl) {
    reply = "placeholder"; // Will be overridden by the deterministic checkoutUrl handler below
    checkoutUrl = nameSubmitCheckoutUrl;
  } else {
    const loopResult = await runOrderingLoop(
      systemPrompt, history, userMessage, cartItems, effectiveMenu, cart.id, supabase, shop.name, cart.test_mode, shop.delivery_fee_cents, shopGeo, correctionApplied,
    );
    reply = loopResult.reply;
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
    .from("order_carts").select("pickup_name, phase, stripe_checkout_session_id, order_type, delivery_fee_cents, driver_tip_cents")
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
            reply = honestFallbackReply(guardCart);
          }
        } catch (_e) {
          reply = honestFallbackReply(guardCart);
        }
      } else {
        reply = honestFallbackReply(guardCart, !!incompleteBundle);
      }
    }
  }

  // ── Proof Guard P2 (2026-08-30): Cart must persist across turns ────
  if (!checkoutUrl) {
    const userMsgLower = userMessage.toLowerCase();
    const isCancelSignal = /cancel|reset|never.?mind|start.?over|forget (?:it|the whole|everything)/i.test(userMsgLower);
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
      reply = honestFallbackReply(guardCart);
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
      const fallback = guardCart.length > 0
        ? `I've got ${guardCart.length} item${guardCart.length === 1 ? "" : "s"} in your cart. What else can I add?`
        : "Your cart is empty. What would you like to order?";
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
  if (!checkoutUrl && guardCart.length > 0) {
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
        const missing = findMissingCartItems(referenced, guardCart);
        if (missing.length > 0) {
          const mode = replyIsClosing ? "v2-closing" : "v3-multi-item";
          console.warn(`[chat-sms] GUARD 4 ${mode} (under-populated cart) tripped (conv=${conversation.id}). Missing: ${missing.join(', ')}. Reply was: ${JSON.stringify(reply).slice(0, 200)}`);
          let upsellLine: string;
          if (missing.length === 1) {
            upsellLine = `Want me to add the ${missing[0].toLowerCase()} too, or are you all set?`;
          } else {
            const list = missing.map((n, i) => i === missing.length - 1 ? `and ${n.toLowerCase()}` : n.toLowerCase()).join(', ');
            upsellLine = `Did you also want ${list}, or good to go?`;
          }
          reply = `${reply}\n\n${upsellLine}`;
        }
      }
    }
  }

  // ── Guard 2: order confirmation + no pickup name → ask for it ──────────
  // If the customer confirms they want to place the order AND the cart has
  // items AND no pickup name is stored, deterministically ask for the name
  // instead of hoping the LLM remembers the PICKUP NAME RULE.
  const hasPickupName = !!(guardCartRow?.pickup_name as string | undefined);
  if (!checkoutUrl && guardCart.length > 0 && !hasPickupName && impliesOrderConfirmation(userMessage)) {
    console.log(`[chat-sms] GUARD 2 (confirmation sans pickup name) tripped (conv=${conversation.id}). Forcing name prompt.`);
    reply = "Got it! What name should I put this order under for pickup?";
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
        reply = "All set! Here's your payment link — tap to finish your order: " + submitResult.checkoutUrl;
      } else {
        console.warn(`[chat-sms] D1 submit_order failed: ${JSON.stringify(submitResult.result).slice(0, 200)}`);
        reply = "Almost there — let me just confirm your order details first. One moment!";
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
          reply = honestFallbackReply(guardCart);
          console.warn(`[chat-sms] PHANTOM-LINK GUARD: forced submit_order did not produce a link (${JSON.stringify(forced.result).slice(0,160)}). Sent honest fallback.`);
        }
      } catch (e) {
        reply = honestFallbackReply(guardCart);
        console.error(`[chat-sms] PHANTOM-LINK GUARD: forced submit_order threw. Sent honest fallback.`, e);
      }
    } else {
      // HONEST FALLBACK: cannot submit — ask for what's missing, claim nothing.
      reply = honestFallbackReply(guardCart, !!incompleteBundle);
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
    const footer = renderLedgerFooter(guardCart, guardCartRow?.phase ?? "building", guardDeliveryFee, guardDriverTip);
    if (footer && !reply.includes("total") && !reply.match(/\$\d+[.,]\d{2}/)) {
      // Only append if the reply doesn't already have numbers (belt + suspenders).
      // The stripper should have removed them, but if the LLM re-injects them
      // in a way we didn't cover, the footer still goes in.
    }
    if (footer) {
      reply = `${reply}\n\n${footer}`;
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

  // Strip the compliance footer on all but the lifetime first contact.
  // The disclosure ("Msg & data rates...") is REQUIRED on the first outbound
  // reply ever to this (consumer, shop) pair. On subsequent contacts it is
  // dead weight — it costs segments and adds nothing for a returning customer.
  if (!isLifetimeFirstContact) {
    finalReply = finalReply
      .replace(/\.?\s*Msg[& ]+data rates may apply\.?\s*/gi, "")
      .replace(/\.?\s*Reply HELP for help(,)?( or| &) STOP to (unsubscribe|opt out|stop)\.?\s*/gi, "")
      .replace(/\.?\s*Reply STOP to (unsubscribe|opt out|stop)\.?\s*/gi, "")
      .replace(/\.?\s*Text HELP for help\.?\s*/gi, "")
      .replace(/\.?\s*Text STOP to cancel\.?\s*/gi, "")
      .replace(/\n{2,}/g, "\n")  // collapse double newlines
      .trim();
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
  });
});
