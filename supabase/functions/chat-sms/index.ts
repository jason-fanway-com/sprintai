/**
 * SprintAI chat-sms Edge Function — Ordering State Machine
 *
 * Supports two channels:
 *   a) Twilio SMS webhook  (application/x-www-form-urlencoded)
 *   b) Web chat test       (application/json { shop_id, message, session_id })
 *
 * Uses Claude Haiku for the conversation engine.
 * Persists messages to the messages table and cart state to order_carts.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { guardedSend, type OutboundContext } from "../_shared/outbound-guard.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const HAIKU_MODEL = "claude-haiku-4-5";
const CLAUDE_API  = "https://api.anthropic.com/v1/messages";
const MAX_RETRIES = 8;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
  option_groups?: OptionGroup[];
}

interface CartItem {
  menu_item_id: string;
  name:         string;
  quantity:     number;
  price_cents:  number;
  modifiers:    string[];
  options?:     Record<string, string[]>;
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
  tenant_id:               string;
  phone_number_e164:       string | null;
  reply_from_e164:         string | null;
  open_hours:              Record<string, Array<{ open: string; close: string }>>;
  timezone:                string;
  email_ticket_recipient:  string | null;
  is_paused:               boolean;
  pause_message:           string | null;
  shop_context:            string | null;
  ai_instructions:         string | null;
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
}

interface ClaudeContentBlock {
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
    description: "Change the quantity or modifiers of a cart item.",
    input_schema: {
      type: "object",
      properties: {
        menu_item_id: { type: "string" },
        quantity:     { type: "integer", minimum: 1 },
        modifiers:    { type: "array", items: { type: "string" } },
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
];

// ─── Effective menu builder ───────────────────────────────────────────────────

async function buildEffectiveMenu(
  supabase:     ReturnType<typeof createClient>,
  shopId:       string,
  businessDate: string,
): Promise<EffectiveMenuItem[]> {
  const { data: menu } = await supabase
    .from("menus")
    .select("id")
    .eq("shop_id", shopId)
    .or(`effective_until.is.null,effective_until.gte.${new Date().toISOString()}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!menu) return [];

  const { data: items } = await supabase
    .from("menu_items")
    .select("id, name, description, price_cents, category, modifiers_json")
    .eq("menu_id", menu.id)
    .eq("active", true)
    .order("display_order", { ascending: true });

  if (!items?.length) return [];

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

  return items
    .filter((item: { id: string }) => !soldOutIds.has(item.id))
    .map((item: EffectiveMenuItem) => ({
      id:             item.id,
      name:           item.name,
      description:    item.description,
      price_cents:    item.price_cents,
      category:       item.category,
      modifiers_json: item.modifiers_json,
      option_groups:  groupsByItem[item.id] || [],
    }));
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
): string {
  const today = getBusinessDayKey(shop.timezone);
  const hours = shop.open_hours?.[today] ?? [];
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
        return `${r.quantity}x ${r.name}${mods}${opts} - $${((r.price_cents * r.quantity) / 100).toFixed(2)}`;
      }).join("\n");
  const subtotal = cart.reduce((s, i) => {
    if ((i as BundleItem).type === "bundle") {
      return s + ((i as BundleItem).complete ? (i as BundleItem).price_cents : 0);
    }
    const r = i as CartItem;
    return s + r.price_cents * r.quantity;
  }, 0);

  const menuByCategory: Record<string, EffectiveMenuItem[]> = {};
  for (const item of menu) {
    const cat = item.category ?? "Other";
    if (!menuByCategory[cat]) menuByCategory[cat] = [];
    menuByCategory[cat].push(item);
  }
  const menuStr = Object.entries(menuByCategory)
    .map(([cat, items]) => {
      const rows = items.map(item => {
        const price = `$${(item.price_cents / 100).toFixed(2)}`;
        const desc  = item.description ? ` - ${item.description}` : "";
        const groups = item.option_groups || [];
        if (groups.length > 0) {
          const groupLines = groups.map(g => {
            const reqLabel = g.required ? `required, pick ${g.max_select > 1 ? g.min_select + '-' + g.max_select : '1'}` : `optional${g.max_select > 1 ? ', pick up to ' + g.max_select : ''}`;
            return `    → ${g.name} (${reqLabel}): ${g.choices.map(c => c.name + (c.price_cents > 0 ? ` +$${(c.price_cents/100).toFixed(2)}` : '')).join(', ')}`;
          }).join('\n');
          return `  ID:${item.id} | ${item.name} ${price}${desc}\n${groupLines}`;
        } else {
          const mods = item.modifiers_json?.map(m => m.name).join(", ") ?? "";
          return `  ID:${item.id} | ${item.name} ${price}${desc}${mods ? ` | Options: ${mods}` : ""}`;
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

  return `You are the ordering assistant for ${shop.name}. Help customers order for pickup via text.

CURRENT PHASE: ${phase}
CURRENT TIME: ${currentTime}
TODAY'S HOURS: ${hoursStr}

AVAILABLE MENU:
${menuStr}
${shop.ai_instructions ? `\nSPECIAL INSTRUCTIONS (HIGHEST PRIORITY, follow these exactly):\n${shop.ai_instructions}\n` : ""}
${shop.shop_context ? `\nBackground information about this shop (use to answer customer questions about the business, NOT for ordering): ${shop.shop_context}\n` : ""}
CURRENT CART:
${cartStr}${cart.length > 0 ? `\nSubtotal: $${(subtotal / 100).toFixed(2)}` : ""}
${notes ? `\nORDER NOTES: ${notes}` : ""}

RULES:
- Keep ALL responses under 300 characters for SMS
- Only use item IDs exactly as shown in the menu (the ID: prefix is part of the ID)
- Never add items not in the available menu
- Never use em dashes in responses
- When cart has items and customer says they are done or asks to check out, show a brief summary and ask for confirmation
- Only call submit_order after the customer explicitly confirms (e.g., "yes", "confirm", "that's it", "place order")
- Be friendly but concise
- Process the ENTIRE customer message. If they mention multiple items (e.g. "a dozen bagels and some cream cheese"), acknowledge ALL items and work through each one. Do not ignore part of the request.
- PICKUP NAME RULE (CRITICAL): When you ask for a pickup name and the customer's VERY NEXT message is a name ("Jason", "Mike", "Sarah"), call submit_order with that name IMMEDIATELY. Do NOT ask "is that your name?" Do NOT ask for confirmation. A single word or short name after asking for a pickup name is ALWAYS the pickup name. Just submit the order.
- SANDWICH MAPPING: "Bacon egg and cheese" = BOBO Sandwich (Bacon). "Sausage egg and cheese" = SOBO Sandwich. "Ham egg and cheese" = HOBO Sandwich. "Pork roll egg and cheese" = PROBO Sandwich. "Turkey bacon egg and cheese" = TBOBO Sandwich. These all come on a bagel by default. If a customer asks for one of these, add the matching item immediately. Do NOT say "I don't see that on the menu."
- MULTI-ITEM FOCUS: When a customer asks for multiple items in sequence, process EACH one fully before moving on. If you said you're adding something, USE THE TOOL to actually add it. Never claim you added something without calling add_item. If add_item fails, tell the customer the specific error.
- CRITICAL BUNDLE RULE: When a customer says "a dozen", "I'll take a dozen", "dozen bagels", "half dozen", etc., you MUST call start_bundle IMMEDIATELY in that same turn. Do NOT just acknowledge it in text. You MUST use the tool. "I'll take a dozen" = call start_bundle with bundle_item_name="One Dozen Bagels", bundle_size=14, bundle_price_cents=1500. "half dozen" = call start_bundle with bundle_item_name="Half Dozen Bagels", bundle_size=6, bundle_price_cents=750.
- If the customer also provides flavors in the same message, call start_bundle THEN add_to_bundle for each flavor -- all in one turn. If they just say "a dozen" without flavors, call start_bundle and then ask for flavors.
- Example 1: "I'll take a dozen" → call start_bundle(bundle_item_name="One Dozen Bagels", bundle_size=14, bundle_price_cents=1500), then reply asking for flavors.
- Example 2: "I want a dozen bagels -- 6 plain, 3 everything, 2 jalapeno, 3 sesame" → call start_bundle, then add_to_bundle for each flavor. All in one turn.
- When a bundle is active and the customer provides flavors, call add_to_bundle for EACH flavor immediately. Do NOT ask for clarification. If they say "7 sesame and 7 plain" and a dozen bundle is active, that is 14 bagels which completes the dozen. Just add them.
- While a bundle is active, you may ONLY use add_to_bundle, cancel_bundle, or clear_cart. Do not call add_item or submit_order until the bundle is complete or cancelled.
- Never state the number of available flavors or menu items. If asked what flavors are available, just list them without counting.
- NEVER suggest switching from a larger bundle to a smaller one. If the count does not match, tell the customer how many slots remain.
- NEVER ask "are you ordering individual bagels or a bundle?" If the customer already said "a dozen" or you started a bundle, they are ordering a bundle. Period.
- REQUIRED OPTIONS: When adding an item that has REQUIRED option groups (marked "required" in the menu above), you MUST ask the customer for their choices BEFORE calling add_item. Example: "What kind of bread -- roll, bagel, or english muffin?" Keep it casual like a real deli counter. If the customer already specified their choice in the same message (e.g. "bacon egg and cheese on a roll"), include it in the add_item call without asking.
- OPTIONAL OPTIONS: For optional groups (like condiments), ask AFTER the required choices are settled. Keep it brief: "Salt, pepper, or ketchup?" If the customer says "nothing" or moves on, skip it.
- OPTIONS IN add_item: When calling add_item for an item with option groups, pass the selections in the "options" parameter as an object like {"Bread Type": ["Roll"], "Condiments": ["Salt", "Pepper"]}. Keys must match the option group names exactly as shown in the menu.
- COMBO ITEMS: Items in the "Bagel With" category (e.g. "Bagel with Plain Cream Cheese", "Bagel with Flavored Cream Cheese") ALREADY INCLUDE the bagel. Do NOT add a standalone bagel AND a "Bagel With" item separately. When a customer says "cinnamon raisin bagel with cream cheese", add ONE item from "Bagel With" (e.g. "Bagel with Plain Cream Cheese" at $3.50) and note the bagel flavor choice. NEVER double-charge by adding a standalone bagel plus a spread item.
- CREAM CHEESE DISAMBIGUATION: This menu has TWO types of cream cheese products. (1) "Bagel With" items -- a single bagel WITH cream cheese already on it. (2) "Cream Cheese Spread (per pound)" -- a full pound of cream cheese to take home. If a customer just says "cream cheese" after ordering bagels, ask ONE time: "Do you want cream cheese on a bagel ($3.50-$4.95) or a pound of cream cheese spread to go ($10.95-$13.95)?" Then REMEMBER their answer. NEVER ask again. If they say "by the pound" or "a pound" at ANY point, they want the Spread. Use add_item immediately.
- CONTEXT MEMORY: Pay close attention to what the customer said in previous messages. If they already told you what type/flavor they want, do NOT ask again. If they said "jalapeno cheddar" two messages ago, you KNOW the flavor. Do not lose track.
- TOASTED PROMPT: After adding a "Bagel With" item (cream cheese bagel) or a breakfast sandwich, if the customer has NOT already mentioned toasting preference, ask: "Want that toasted?" Keep it casual and brief, just like a real bagel shop counter. If they already said "toasted" or "not toasted" in their message, do NOT ask -- just note it. Only ask ONCE per order, not for every item. Do NOT ask about toasting for bundle orders (dozen, half dozen, baker's dozen) or standalone plain bagels -- those are take-home items.
- PREP INSTRUCTIONS: When a customer says "toasted", "scooped", "extra toasted", "lightly toasted", "cut in half", "extra cream cheese", "light butter", or any other preparation preference, call set_note to save it. These instructions go directly to the kitchen. NEVER tell the customer to "let the shop know" -- YOU are the shop. Capture it and confirm: "Got it, noted toasted." If they mention prep preferences along with items, add the items AND set the note in the same turn.

PHASE BEHAVIOR:
- greeting/building: Help build the order, answer menu questions
- checkout: Payment link was sent. Remind them to check their text or email for the payment link.
- confirmed: Order is confirmed and paid. Thank them and give pickup info.
- expired: Their payment link expired. Ask if they want to restart.${expiredNote}${complianceNote}`;
}

// ─── Tool executor ────────────────────────────────────────────────────────────

async function executeTool(
  toolName:  string,
  input:     Record<string, unknown>,
  cart:      AnyCartItem[],
  menu:      EffectiveMenuItem[],
  cartId:    string,
  supabase:  ReturnType<typeof createClient>,
  shopName:  string,
  testMode:  boolean = false,
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
      const inputMods    = (modifiers as string[]);
      const invalidMods  = inputMods.filter(m => !validMods.includes(m));
      if (invalidMods.length > 0) {
        return { ok: false, result: { error: `Invalid modifiers: ${invalidMods.join(", ")}. Valid options for ${menuItem.name}: ${validMods.join(", ") || "none"}` } };
      }

      // Validate option groups
      const itemGroups = menuItem.option_groups || [];
      const inputOptions = ((input as any).options || {}) as Record<string, string[]>;
      let extraCents = 0;

      for (const group of itemGroups) {
        const selections = inputOptions[group.name] || [];
        if (group.required && selections.length === 0) {
          const choiceNames = group.choices.map(c => c.name).join(', ');
          return { ok: false, result: { error: `"${group.name}" is required for ${menuItem.name}. Options: ${choiceNames}. Ask the customer which they want.` } };
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

      const existing = cart.findIndex(i => i.menu_item_id === menu_item_id && JSON.stringify(i.options) === JSON.stringify(inputOptions));
      if (existing >= 0) {
        cart[existing].quantity += (quantity as number);
        cart[existing].modifiers = inputMods;
      } else {
        cart.push({ menu_item_id, name: menuItem.name, quantity: quantity as number, price_cents: menuItem.price_cents + extraCents, modifiers: inputMods, options: Object.keys(inputOptions).length > 0 ? inputOptions : undefined });
      }
      await saveCart(supabase, cartId, cart, "building");
      const total = cart.reduce((s, i) => s + i.price_cents * i.quantity, 0);
      return { ok: true, result: { added: menuItem.name, quantity, cart_total: `$${(total / 100).toFixed(2)}` }, newPhase: "building" };
    }

    case "remove_item": {
      const { menu_item_id } = input as { menu_item_id: string };
      const idx = cart.findIndex(i => i.menu_item_id === menu_item_id);
      if (idx < 0) return { ok: false, result: { error: "Item not found in cart." } };
      const removed = cart[idx].name;
      cart.splice(idx, 1);
      await saveCart(supabase, cartId, cart, "building");
      return { ok: true, result: { removed } };
    }

    case "modify_item": {
      const { menu_item_id, quantity, modifiers } = input as {
        menu_item_id: string; quantity?: number; modifiers?: string[];
      };
      const idx = cart.findIndex(i => i.menu_item_id === menu_item_id);
      if (idx < 0) return { ok: false, result: { error: "Item not in cart." } };
      if (quantity !== undefined) cart[idx].quantity = quantity;
      if (modifiers !== undefined) {
        const menuItem   = menuMap.get(menu_item_id);
        const validMods  = menuItem?.modifiers_json?.map(m => m.name) ?? [];
        const invalidMods = modifiers.filter(m => !validMods.includes(m));
        if (invalidMods.length > 0) return { ok: false, result: { error: `Invalid modifiers: ${invalidMods.join(", ")}` } };
        cart[idx].modifiers = modifiers;
      }
      await saveCart(supabase, cartId, cart, "building");
      return { ok: true, result: { modified: cart[idx].name, quantity: cart[idx].quantity } };
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
      const { pickup_name } = input as { pickup_name?: string };
      await saveCart(supabase, cartId, cart, "review");
      if (pickup_name) {
        await supabase.from("order_carts").update({ pickup_name }).eq("id", cartId);
      }
      const subtotal = cart.reduce((s, i) => {
        if ((i as BundleItem).type === "bundle") return s + (i as BundleItem).price_cents;
        const r = i as CartItem;
        return s + r.price_cents * r.quantity;
      }, 0);
      await supabase.from("order_carts").update({ subtotal_cents: subtotal, total_cents: subtotal }).eq("id", cartId);

      const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
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
          quantity: r.quantity,
        };
      });

      // Fetch notes for Stripe metadata
      const { data: cartRow } = await supabase.from("order_carts").select("notes").eq("id", cartId).single();
      const orderNotes = cartRow?.notes || "";

      // Add notes as a $0 line item so the shop sees them on the receipt
      if (orderNotes) {
        lineItems.push({
          price_data: {
            currency:     "usd",
            unit_amount:  0,
            product_data: { name: `Prep Notes: ${orderNotes}` },
          },
          quantity: 1,
        });
      }

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

      return {
        ok:          true,
        result:      { checkout_url: session.url, message: "Payment link created. Tell the customer there's one last step: they need to tap the payment link to pay and confirm their order. Do NOT say the order is confirmed or ready. Do NOT say thank you or goodbye yet. Payment is still pending." },
        checkoutUrl: session.url ?? undefined,
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

    default:
      return { ok: false, result: { error: `Unknown tool: ${toolName}` } };
  }
}

async function saveCart(
  supabase: ReturnType<typeof createClient>,
  cartId:   string,
  cart:     AnyCartItem[],
  phase:    OrderPhase,
): Promise<void> {
  const subtotal = cart.reduce((s, i) => {
    if ((i as BundleItem).type === "bundle") {
      return s + ((i as BundleItem).complete ? (i as BundleItem).price_cents : 0);
    }
    const r = i as CartItem;
    return s + r.price_cents * r.quantity;
  }, 0);
  await supabase.from("order_carts")
    .update({ cart_json: cart, phase, subtotal_cents: subtotal, total_cents: subtotal })
    .eq("id", cartId);
}

// ─── Ordering LLM loop ────────────────────────────────────────────────────────

async function runOrderingLoop(
  systemPrompt: string,
  history:      Array<{ role: "user" | "assistant"; content: string | ClaudeContentBlock[] }>,
  userMessage:  string,
  cart:         AnyCartItem[],
  menu:         EffectiveMenuItem[],
  cartId:       string,
  supabase:     ReturnType<typeof createClient>,
  shopName:     string,
  testMode:     boolean = false,
): Promise<{ reply: string; checkoutUrl?: string; finalPhase?: OrderPhase }> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const messages: Array<{ role: "user" | "assistant"; content: string | ClaudeContentBlock[] }> = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let checkoutUrl: string | undefined;
  let finalPhase:  OrderPhase | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(CLAUDE_API, {
      method:  "POST",
      headers: {
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model:      HAIKU_MODEL,
        max_tokens: 512,
        system:     systemPrompt,
        messages,
        tools:      ORDERING_TOOLS,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[chat-sms] Claude API error:", res.status, errText);
      break;
    }

    const data: { stop_reason: string; content: ClaudeContentBlock[] } = await res.json();
    const content    = data.content ?? [];
    const toolBlocks = content.filter(b => b.type === "tool_use");
    const textBlocks = content.filter(b => b.type === "text");

    if (data.stop_reason === "end_turn" || toolBlocks.length === 0) {
      const reply = textBlocks.map(b => b.text ?? "").join("").trim();
      return { reply: reply || "I'm sorry, I couldn't process that. Please try again.", checkoutUrl, finalPhase };
    }

    messages.push({ role: "assistant", content });

    const toolResults: ClaudeContentBlock[] = [];
    for (const toolBlock of toolBlocks) {
      const result = await executeTool(
        toolBlock.name!,
        toolBlock.input! as Record<string, unknown>,
        cart,
        menu,
        cartId,
        supabase,
        shopName,
        testMode,
      );
      if (result.checkoutUrl) checkoutUrl = result.checkoutUrl;
      if (result.newPhase)    finalPhase  = result.newPhase;
      toolResults.push({
        type:        "tool_result",
        tool_use_id: toolBlock.id!,
        content:     JSON.stringify(result.result),
      });
      // Stop immediately after checkout is created — don't let Claude generate
      // another turn that could hallucinate a confirmation message
      if (toolBlock.name === "create_checkout" && checkoutUrl) {
        return {
          reply:      "Payment link sent! Tap it to complete your order. Check your text or email.",
          checkoutUrl,
          finalPhase,
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
  supabase:       ReturnType<typeof createClient>,
  conversationId: string,
  tenantId:       string,
  role:           "customer" | "assistant" | "system",
  content:        string,
): Promise<void> {
  const { error } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    tenant_id: tenantId,
    role,
    content,
  });
  if (error) console.error("[chat-sms] Failed to save message:", error.message);
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
          MessagingServiceSid: Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") ?? fromNumber,
          To: toNumber,
          Body: message,
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

async function handleSystemEvent(
  supabase:    ReturnType<typeof createClient>,
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
    .select("id, channel, customer_phone, tenant_id")
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
      return `${r.quantity}x ${r.name}`;
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
    const hours    = shop.open_hours?.[today] ?? [];
    const fmt12Confirm = (t: string) => { const [h, m] = t.split(":").map(Number); const ampm = h >= 12 ? "p.m." : "a.m."; const h12 = h % 12 || 12; return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2,"0")} ${ampm}`; };
    const hoursStr = hours.length > 0
      ? hours.map((h: { open: string; close: string }) => `${fmt12Confirm(h.open)}-${fmt12Confirm(h.close)}`).join(", ")
      : "see our hours for details";

    const closeTime = hours.length > 0 ? fmt12Confirm(hours[hours.length - 1].close) : null;
    const closePart  = closeTime ? ` (we're open til ${closeTime})` : "";
    message = `Payment confirmed! Order${pickup}: ${items}. Total: $${total}${feeLine}. Give us about 10 - 15 minutes for pick up${closePart}. Thank you for your business!!`;
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

  // Send order ticket email on payment confirmed
  if (system_event === "payment_confirmed" && shop.email_ticket_recipient) {
    try {
      const resendApiKey = Deno.env.get("RESEND_API_KEY");
      if (!resendApiKey) {
        console.warn("[chat-sms] RESEND_API_KEY not set — skipping order ticket email");
      } else {
        const emailTotal = ((cartRow.total_cents ?? 0) / 100).toFixed(2);
        const emailPickup = cartRow.pickup_name ?? "Unknown";
        const now = new Date();
        const etTime = now.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "long", timeStyle: "short" });
        const cartItems = (cartRow.cart_json as AnyCartItem[]).map((i: AnyCartItem) => {
          if ((i as BundleItem).type === "bundle") {
            const b = i as BundleItem;
            const bPrice = b.price_cents != null ? `$${(b.price_cents / 100).toFixed(2)}` : "";
            return `<tr><td style="padding:6px 8px;">${b.name}</td><td style="padding:6px 8px;text-align:center;">1</td><td style="padding:6px 8px;text-align:right;">${bPrice}</td></tr>`;
          }
          const r = i as CartItem;
          const linePrice = r.price_cents != null ? `$${((r.price_cents * r.quantity) / 100).toFixed(2)}` : "";
          return `<tr><td style="padding:6px 8px;">${r.name}</td><td style="padding:6px 8px;text-align:center;">${r.quantity}</td><td style="padding:6px 8px;text-align:right;">${linePrice}</td></tr>`;
        }).join("");
        const emailHtml = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f4f4f4;">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#1a1a2e;padding:24px 32px;">
      <h1 style="margin:0;color:#fff;font-size:20px;">${shop.name}</h1>
      <p style="margin:4px 0 0;color:#aaa;font-size:14px;">New Order Received</p>
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
        <p style="margin:0 0 6px;"><strong>Pickup Name:</strong> ${emailPickup}</p>
        <p style="margin:0;"><strong>Time Received:</strong> ${etTime}</p>
      </div>
    </div>
    <div style="padding:16px 32px;background:#f4f4f4;text-align:center;">
      <p style="margin:0;font-size:12px;color:#999;">Powered by SprintAI</p>
    </div>
  </div>
</body>
</html>`;
        const emailResp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "SprintAI Orders <orders@getsprintai.com>",
            to: [shop.email_ticket_recipient],
            subject: `New Order \u2014 ${emailPickup} \u2014 $${emailTotal} \u2014 ${shop.name}`,
            html: emailHtml,
          }),
        });
        if (!emailResp.ok) {
          const errText = await emailResp.text();
          console.error(`[chat-sms] Resend email failed (${emailResp.status}): ${errText}`);
        } else {
          console.log(`[chat-sms] Order ticket email sent to ${shop.email_ticket_recipient}`);
        }
      }
    } catch (emailErr) {
      console.error("[chat-sms] Non-fatal: order ticket email threw:", emailErr);
    }
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
    // Direct Twilio SMS delivery
    if (!shop.phone_number_e164) {
      console.error("[chat-sms] Shop has no phone number configured for SMS confirmation");
    } else {
      await sendSmsViaTwilio(txnCtx, shop.phone_number_e164, conversation.customer_phone, message);
    }
  } else if (conversation.customer_phone?.startsWith("web:imsg-")) {
    // iMessage bridge: extract real phone from "web:imsg-p{digits}-{sessionid}"
    // Format: web:imsg-p16102565023-1781561505 → +16102565023
    const match = conversation.customer_phone.match(/web:imsg-p(\d+)-/);
    if (match) {
      const realPhone = "+" + match[1];
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
    }
  }

  return jsonResponse({ ok: true, message });
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
  const isSms       = contentType.includes("application/x-www-form-urlencoded");

  let shop:          Shop;
  let customerPhone: string;
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
  // STRUCTURAL OUTBOUND WATCHDOG: ctx for every synchronous SMS reply in this
  // request. Set for the SMS channel below; web channel never calls Twilio.
  let inboundReplyCtx: OutboundContext = { reason: "inbound_reply", inboundAtMs: Date.now() };

  // ── Parse channel ─────────────────────────────────────────────────────────
  if (isSms) {
    const body   = await req.text();
    const params = new URLSearchParams(body);
    const toNumber   = params.get("To")   ?? "";
    const fromNumber = params.get("From") ?? "";
    userMessage  = (params.get("Body") ?? "").trim();

    // ── STRUCTURAL OUTBOUND WATCHDOG: synchronous inbound-reply context ──────
    // Every SMS send in this handler is a SYNCHRONOUS reply to THIS inbound
    // webhook. The triggering inbound is the request we're handling right now:
    // its id is the Twilio MessageSid (fallback synthesized) and its timestamp
    // is now (we are processing it live, so it is by definition fresh). This
    // single ctx is passed to every sendSmsViaTwilio call below so the guard can
    // prove freshness; if it were ever invoked outside a live inbound the
    // evidence would be absent and the guard would DENY.
    inboundReplyCtx = {
      reason: "inbound_reply",
      to: fromNumber,
      inboundMessageId:
        params.get("MessageSid") ?? params.get("SmsMessageSid") ?? `inbound-${crypto.randomUUID()}`,
      inboundAtMs: Date.now(),
    };

    const upper      = userMessage.toUpperCase().trim();
    const STOP_WORDS = new Set(["STOP","STOPALL","UNSUBSCRIBE","CANCEL","END","QUIT"]);
    if (STOP_WORDS.has(upper)) {
      await sendSmsViaTwilio(inboundReplyCtx, toNumber, fromNumber, "You have been unsubscribed and will receive no further messages. Reply START to resubscribe.");
      return emptyTwiml();
    }
    if (upper === "HELP") {
      await sendSmsViaTwilio(inboundReplyCtx, toNumber, fromNumber, "For help with your order, reply with your question. Msg & data rates may apply. Reply STOP to unsubscribe.");
      return emptyTwiml();
    }
    if (upper === "START") {
      await sendSmsViaTwilio(inboundReplyCtx, toNumber, fromNumber, "You are now subscribed. Text us to start an order!");
      return emptyTwiml();
    }

    const { data: shopData } = await supabase
      .from("shops").select("*")
      .eq("phone_number_e164", toNumber)
      .single();
    if (!shopData) {
      console.error("[chat-sms] Shop not found for Twilio number:", toNumber);
      await sendSmsViaTwilio(inboundReplyCtx, toNumber, fromNumber, "Sorry, this number is not configured for ordering.");
      return emptyTwiml();
    }
    shop = shopData as Shop;
    if (shop.is_paused) {
      await sendSmsViaTwilio(inboundReplyCtx, toNumber, fromNumber, shop.pause_message ?? "We are not accepting orders right now. Please try again later.");
      return emptyTwiml();
    }
    customerPhone = fromNumber;
    sessionId     = `sms:${fromNumber}`;
    channel       = "sms";
  } else {
    let body: { shop_id?: string; message?: string; session_id?: string; system_event?: string; conversation_id?: string; order_cart_id?: string; test?: boolean };
    try { body = await req.json(); } catch { return jsonError("Invalid JSON body"); }

    if (body.system_event) {
      return await handleSystemEvent(supabase, body);
    }

    const { shop_id, message, session_id } = body;
    if (!shop_id || !message) return jsonError("shop_id and message are required");
    userMessage = message.trim();
    sessionId   = session_id ?? crypto.randomUUID();
    channel     = "web";
    // GATED test-mode signal: only the WEB JSON path can carry `test: true`,
    // and only an explicit boolean true counts. The normal diner flow never
    // sends this. Also accept ?test=1 on the function URL as an equivalent
    // affordance (whichever the web client can send). SMS path leaves
    // requestTestMode=false. See test-mode activation in the greeting block.
    {
      const url = new URL(req.url);
      requestTestMode = body.test === true || url.searchParams.get("test") === "1";
    }
    const { data: shopData } = await supabase
      .from("shops").select("*").eq("id", shop_id).single();
    if (!shopData) return jsonError("Shop not found", 404);
    shop = shopData as Shop;
    if (shop.is_paused) {
      return jsonResponse({ reply: shop.pause_message ?? "We are not accepting orders right now.", cart: [], phase: "greeting", session_id: sessionId });
    }
    customerPhone = `web:${sessionId}`;
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

  if (!conversation) {
    const { data: newConv, error: convErr } = await supabase
      .from("conversations")
      .insert({
        tenant_id:      shop.tenant_id,
        customer_phone: customerPhone,
        channel,
        session_id:     channel === "web" ? sessionId : null,
        status:         "active",
      })
      .select("id").single();
    if (convErr || !newConv) {
      console.error("[chat-sms] Failed to create conversation:", convErr);
      const errMsg = "Sorry, we had a problem starting your order. Please try again.";
      if (isSms) { await sendSmsViaTwilio(inboundReplyCtx, shop.phone_number_e164!, customerPhone, errMsg); return emptyTwiml(); }
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
      .insert({ shop_id: shop.id, conversation_id: conversation.id, phase: "greeting", cart_json: [] })
      .select("*").single();
    if (cartErr || !newCart) {
      console.error("[chat-sms] Failed to create cart:", cartErr);
      const errMsg = "Sorry, we had a problem starting your order. Please try again.";
      if (isSms) { await sendSmsViaTwilio(inboundReplyCtx, shop.phone_number_e164!, customerPhone, errMsg); return emptyTwiml(); }
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
    if (isSms) { await sendSmsViaTwilio(inboundReplyCtx, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
    return jsonResponse({ reply, cart: [], phase: "expired", session_id: sessionId });
  }

  // Short-circuit on terminal phases
  if (cart.phase === "confirmed") {
    const reply = "Your order is confirmed and paid. Thank you!";
    await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
    await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
    if (isSms) { await sendSmsViaTwilio(inboundReplyCtx, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
    return jsonResponse({ reply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId });
  }
  if (cart.phase === "checkout") {
    const upper = userMessage.toUpperCase().trim();
    const wantsRestart = /\b(RESTART|START OVER|CANCEL|NEW ORDER)\b/.test(upper);
    const wantsChange = /\b(WAIT|CHANGE|WRONG|FIX|MODIFY|UPDATE|REMOVE|NOT RIGHT|THAT'S NOT|THATS NOT|CHARGED.*WRONG|ONLY ORDERED|DIDN'T ORDER|DIDNT ORDER)\b/.test(upper);

    if (wantsRestart) {
      // Clear cart and start fresh
      cart.cart_json = [];
      await supabase.from("order_carts").update({ cart_json: [], phase: "greeting", stripe_checkout_session_id: null, subtotal_cents: 0, total_cents: 0 }).eq("id", cart.id);
      const reply = "No problem! Your order has been cancelled. What would you like to order?";
      await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
      await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
      if (isSms) { await sendSmsViaTwilio(inboundReplyCtx, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
      return jsonResponse({ reply, cart: [], phase: "greeting", session_id: sessionId });
    }

    if (wantsChange) {
      // Go back to building phase so the LLM can handle modifications
      await supabase.from("order_carts").update({ phase: "building", stripe_checkout_session_id: null }).eq("id", cart.id);
      cart.phase = "building" as OrderPhase;
      // Fall through to the LLM loop below so it can process the change request
    } else {
      // Default: remind about payment but offer options
      const reply = "Your payment link was sent -- check your texts for it. If something looks wrong, say \"change my order\" to make edits, or \"restart\" to start over.";
      await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
      await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
      if (isSms) { await sendSmsViaTwilio(inboundReplyCtx, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
      return jsonResponse({ reply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId });
    }
  }

  // ── Build effective menu ──────────────────────────────────────────────────
  const businessDate  = getBusinessDate(shop.timezone);
  const currentTime   = getCurrentTime(shop.timezone);
  const effectiveMenu = await buildEffectiveMenu(supabase, shop.id, businessDate);

  if (effectiveMenu.length === 0 && cart.phase === "greeting") {
    const reply = "Sorry, our menu is not available right now. Please call us to place an order.";
    await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
    await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
    if (isSms) { await sendSmsViaTwilio(inboundReplyCtx, shop.phone_number_e164!, customerPhone, reply); return emptyTwiml(); }
    return jsonResponse({ reply, cart: [], phase: "greeting", session_id: sessionId });
  }

  // ── Business hours check ────────────────────────────────────────────────
  if (cart.phase === "greeting") {
    // Day-of-week and current time are both computed in the SHOP'S timezone so
    // the lookup is correct near midnight (see getBusinessDayKey/getLocalMinutes).
    const todayKey = getBusinessDayKey(shop.timezone);
    const todayHours = shop.open_hours?.[todayKey] ?? [];
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
    const keywordTestMode = userMessage.trim().toUpperCase() === "TESTMODE";
    const activatingTestMode = keywordTestMode || (requestTestMode && !cart.test_mode);
    if (activatingTestMode) {
      // Always reset cart state on TESTMODE — clear stale items, set test flag, back to greeting
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
    if (!isOpen && todayHours.length > 0 && !cart.test_mode) {
      const fmt12 = (t: string) => { const [h, m] = t.split(":").map(Number); const ampm = h >= 12 ? "p.m." : "a.m."; const h12 = h % 12 || 12; return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2,"0")} ${ampm}`; };
      const hoursDisplay = todayHours.map((h: { open: string; close: string }) => `${fmt12(h.open)}-${fmt12(h.close)}`).join(", ");
      const closedMsg = `Hey! The kitchen is closed right now. Today's hours are ${hoursDisplay}. Come back during business hours — you'll be happy you did!

Testing? Reply TESTMODE to try out the ordering experience.`;
      await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
      await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", closedMsg);
      if (isSms) { await sendSmsViaTwilio(inboundReplyCtx, shop.phone_number_e164!, customerPhone, closedMsg); return emptyTwiml(); }
      return jsonResponse({ reply: closedMsg, cart: [], phase: "greeting", session_id: sessionId });
    }
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

  // Save user message
  await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);

  // ── Run ordering loop ─────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(shop, cart.phase, effectiveMenu, [...cart.cart_json], currentTime, isFirstMessage, cart.notes, priorLinkExpired);
  const cartItems    = [...cart.cart_json];

  const loopResult = await runOrderingLoop(
    systemPrompt, history, userMessage, cartItems, effectiveMenu, cart.id, supabase, shop.name, cart.test_mode,
  );
  let reply       = loopResult.reply;
  let checkoutUrl = loopResult.checkoutUrl;

  // ── POST-TURN PHANTOM-LINK SAFETY NET ────────────────────────────────────
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

    // Re-read authoritative cart state (cartItems was mutated in-loop; pickup_name lives on the row).
    const { data: guardCartRow } = await supabase
      .from("order_carts").select("cart_json, pickup_name, phase, stripe_checkout_session_id")
      .eq("id", cart.id).single();
    const guardCart = (guardCartRow?.cart_json as AnyCartItem[]) ?? cartItems;
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

  // If checkout was created, override Claude's reply entirely — prevents hallucinated confirmations
  const safeReply = checkoutUrl
    ? "Payment link sent! Tap it to complete your order. Check your text or email."
    : reply;

  await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", safeReply);

  // Reload cart for response
  const { data: updatedCart } = await supabase.from("order_carts").select("*").eq("id", cart.id).single();
  const currentCart = (updatedCart as OrderCart) ?? cart;

  // Strip markdown for clean SMS/text output
  let finalReply = stripMarkdown(safeReply);

  // Append payment URL if present and not already in the reply
  if (checkoutUrl && !finalReply.includes(checkoutUrl)) {
    const combined = `${finalReply}\n\nPay here: ${checkoutUrl}`;
    finalReply = isSms
      ? (combined.length <= 1600 ? combined : `${finalReply.substring(0, 1200)}\n${checkoutUrl}`)
      : combined;
  }

  if (isSms) {
    await sendSmsViaTwilio(inboundReplyCtx, shop.phone_number_e164!, customerPhone, finalReply);
    return emptyTwiml();
  }
  return jsonResponse({
    reply:        finalReply,
    cart:         currentCart.cart_json,
    phase:        currentCart.phase,
    notes:        currentCart.notes,
    session_id:   sessionId,
    checkout_url: checkoutUrl,
  });
});
