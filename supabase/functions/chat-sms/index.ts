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

interface EffectiveMenuItem {
  id:            string;
  name:          string;
  description:   string | null;
  price_cents:   number;
  category:      string;
  modifiers_json: Array<{ name: string; price_cents: number }> | null;
}

interface CartItem {
  menu_item_id: string;
  name:         string;
  quantity:     number;
  price_cents:  number;
  modifiers:    string[];
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
  subtotal_cents:             number | null;
  total_cents:                number | null;
  stripe_checkout_session_id: string | null;
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
): string {
  const dayMap: Record<number, string> = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };
  const today = dayMap[new Date().getDay()];
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
        return `${r.quantity}x ${r.name}${mods} - $${((r.price_cents * r.quantity) / 100).toFixed(2)}`;
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
        const mods  = item.modifiers_json?.map(m => m.name).join(", ") ?? "";
        const desc  = item.description ? ` - ${item.description}` : "";
        return `  ID:${item.id} | ${item.name} ${price}${desc}${mods ? ` | Options: ${mods}` : ""}`;
      }).join("\n");
      return `${cat}:\n${rows}`;
    })
    .join("\n\n");

  const complianceNote = isFirstMessage
    ? "\n\nCOMPLIANCE NOTE: Append this sentence to your very first message (after your greeting): \"Msg & data rates may apply. Reply HELP for help or STOP to unsubscribe.\""
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

RULES:
- Keep ALL responses under 300 characters for SMS
- Only use item IDs exactly as shown in the menu (the ID: prefix is part of the ID)
- Never add items not in the available menu
- Never use em dashes in responses
- When cart has items and customer says they are done or asks to check out, show a brief summary and ask for confirmation
- Only call submit_order after the customer explicitly confirms (e.g., "yes", "confirm", "that's it", "place order")
- Be friendly but concise
- Process the ENTIRE customer message. If they mention multiple items (e.g. "a dozen bagels and some cream cheese"), acknowledge ALL items and work through each one. Do not ignore part of the request.
- When you ask for a pickup name and the customer gives a name, call submit_order with that name immediately. A short response like a first name ("Jason", "Mike") after you asked for a name is ALWAYS the pickup name, not a new conversation.
- When a customer orders a bundle (e.g. Dozen Bagels, Half Dozen Bagels, or any item with multiple flavor slots), use start_bundle to begin. Then use add_to_bundle for each flavor. The system tracks the count. Keep asking for flavors until the system says the bundle is complete. Show the running count after each selection. Example: "Got it, 4 Everything so far. That is 4 of 14. What else would you like?"
- While a bundle is active, you may ONLY use add_to_bundle, cancel_bundle, or clear_cart. Do not call add_item or submit_order until the bundle is complete or cancelled.
- COMBO ITEMS: Items in the "Bagel With" category (e.g. "Bagel with Plain Cream Cheese", "Bagel with Flavored Cream Cheese") ALREADY INCLUDE the bagel. Do NOT add a standalone bagel AND a "Bagel With" item separately. When a customer says "cinnamon raisin bagel with cream cheese", add ONE item from "Bagel With" (e.g. "Bagel with Plain Cream Cheese" at $3.50) and note the bagel flavor choice. NEVER double-charge by adding a standalone bagel plus a spread item.

PHASE BEHAVIOR:
- greeting/building: Help build the order, answer menu questions
- checkout: Payment link was sent. Remind them to check their text or email for the payment link.
- confirmed: Order is confirmed and paid. Thank them and give pickup info.
- expired: Their payment link expired. Ask if they want to restart.${complianceNote}`;
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
      const existing = cart.findIndex(i => i.menu_item_id === menu_item_id);
      if (existing >= 0) {
        cart[existing].quantity += (quantity as number);
        cart[existing].modifiers = inputMods;
      } else {
        cart.push({ menu_item_id, name: menuItem.name, quantity: quantity as number, price_cents: menuItem.price_cents, modifiers: inputMods });
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
              description: r.modifiers?.length > 0 ? r.modifiers.join(", ") : undefined,
            },
          },
          quantity: r.quantity,
        };
      });

      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://your-project.supabase.co";
      const session = await stripe.checkout.sessions.create({
        mode:                 "payment",
        payment_method_types: ["card"],
        line_items:           lineItems,
        metadata:             { order_cart_id: cartId },
        custom_text:          { submit: { message: `Your order from ${shopName}` } },
        success_url:          `${supabaseUrl}/order-success?cart=${cartId}`,
        cancel_url:           `${supabaseUrl}/order-cancel?cart=${cartId}`,
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
      );
      if (result.checkoutUrl) checkoutUrl = result.checkoutUrl;
      if (result.newPhase)    finalPhase  = result.newPhase;
      toolResults.push({
        type:        "tool_result",
        tool_use_id: toolBlock.id!,
        content:     JSON.stringify(result.result),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { reply: "Sorry, I ran into a problem. Please call us directly to place your order.", checkoutUrl, finalPhase };
}

// ─── Response helpers ─────────────────────────────────────────────────────────

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

async function smsReply(shop: Shop, toNumber: string, message: string): Promise<Response> {
  const replyFrom = shop.reply_from_e164 || shop.phone_number_e164;
  if (!replyFrom) {
    console.error("[chat-sms] No reply number configured for shop");
    return emptyTwiml();
  }
  await sendSmsViaTwilio(replyFrom, toNumber, message);
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

async function saveMessage(
  supabase:       ReturnType<typeof createClient>,
  conversationId: string,
  tenantId:       string,
  role:           "customer" | "assistant" | "system",
  content:        string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    tenant_id: tenantId,
    role,
    content,
    topic: "ordering",
    extension: "chat-sms",
    updated_at: now,
    inserted_at: now,
  });
  if (error) console.error("[chat-sms] Failed to save message:", error.message);
}

// ─── System event handler ────────────────────────────────────────────────────

async function sendSmsViaTwilio(
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

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method:  "POST",
      headers: {
        "Authorization": `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        "Content-Type":  "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: fromNumber, To: toNumber, Body: message }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[chat-sms] Twilio send failed: ${res.status} ${errText}`);
  } else {
    console.log(`[chat-sms] SMS sent to ${toNumber}`);
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

  if (system_event === "payment_confirmed") {
    const items = (cartRow.cart_json as AnyCartItem[]).map((i: AnyCartItem) => {
      if ((i as BundleItem).type === "bundle") return (i as BundleItem).name;
      const r = i as CartItem;
      return `${r.quantity}x ${r.name}`;
    }).join(", ");
    const total  = ((cartRow.total_cents ?? 0) / 100).toFixed(2);
    const pickup = cartRow.pickup_name ? ` for ${cartRow.pickup_name}` : "";

    const dayMap: Record<number, string> = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };
    const today    = dayMap[new Date().getDay()];
    const hours    = shop.open_hours?.[today] ?? [];
    const hoursStr = hours.length > 0
      ? hours.map((h: { open: string; close: string }) => `${h.open}-${h.close}`).join(", ")
      : "see our hours for details";

    message = `Payment confirmed! Order${pickup}: ${items}. Total: $${total}. Pickup hours: ${hoursStr}. Thank you!`;
  } else if (system_event === "payment_expired") {
    message = `Your payment link expired. Reply "restart" to start a new order.`;
  } else {
    return jsonError(`Unknown system event: ${system_event}`);
  }

  await saveMessage(supabase, conversation_id, conversation.tenant_id, "assistant", message);

  if (conversation.channel === "sms" && conversation.customer_phone) {
    if (!shop.phone_number_e164) {
      console.error("[chat-sms] Shop has no phone number configured for SMS confirmation");
    } else {
      await sendSmsViaTwilio(shop.phone_number_e164, conversation.customer_phone, message);
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

  // ── Parse channel ─────────────────────────────────────────────────────────
  if (isSms) {
    const body   = await req.text();
    const params = new URLSearchParams(body);
    const toNumber   = params.get("To")   ?? "";
    const fromNumber = params.get("From") ?? "";
    userMessage  = (params.get("Body") ?? "").trim();

    const upper      = userMessage.toUpperCase().trim();
    const STOP_WORDS = new Set(["STOP","STOPALL","UNSUBSCRIBE","CANCEL","END","QUIT"]);
    if (STOP_WORDS.has(upper)) {
      return twimlResponse("You have been unsubscribed and will receive no further messages. Reply START to resubscribe.");
    }
    if (upper === "HELP") {
      return twimlResponse("For help with your order, reply with your question. Msg & data rates may apply. Reply STOP to unsubscribe.");
    }
    if (upper === "START") {
      return twimlResponse("You are now subscribed. Text us to start an order!");
    }

    const { data: shopData } = await supabase
      .from("shops").select("*")
      .or(`phone_number_e164.eq.${toNumber},reply_from_e164.eq.${toNumber}`)
      .single();
    if (!shopData) {
      console.error("[chat-sms] Shop not found for Twilio number:", toNumber);
      return twimlResponse("Sorry, this number is not configured for ordering.");
    }
    shop = shopData as Shop;
    if (shop.is_paused) {
      return twimlResponse(shop.pause_message ?? "We are not accepting orders right now. Please try again later.");
    }
    customerPhone = fromNumber;
    sessionId     = `sms:${fromNumber}`;
    channel       = "sms";
  } else {
    let body: { shop_id?: string; message?: string; session_id?: string; system_event?: string; conversation_id?: string; order_cart_id?: string };
    try { body = await req.json(); } catch { return jsonError("Invalid JSON body"); }

    if (body.system_event) {
      return await handleSystemEvent(supabase, body);
    }

    const { shop_id, message, session_id } = body;
    if (!shop_id || !message) return jsonError("shop_id and message are required");
    userMessage = message.trim();
    sessionId   = session_id ?? crypto.randomUUID();
    channel     = "web";
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
    const { data } = await supabase
      .from("conversations").select("id").eq("session_id", sessionId).eq("channel", "web").single();
    conversation = data;
  } else {
    const { data } = await supabase
      .from("conversations").select("id")
      .eq("tenant_id", shop.tenant_id).eq("customer_phone", customerPhone)
      .eq("channel", "sms").eq("status", "active")
      .gte("created_at", windowStart)
      .order("created_at", { ascending: false }).limit(1).single();
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
      return isSms ? twimlResponse(errMsg) : jsonError(errMsg, 500);
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
  if (existingCart) {
    cart = existingCart as OrderCart;
  } else {
    const { data: newCart, error: cartErr } = await supabase
      .from("order_carts")
      .insert({ shop_id: shop.id, conversation_id: conversation.id, phase: "greeting", cart_json: [] })
      .select("*").single();
    if (cartErr || !newCart) {
      console.error("[chat-sms] Failed to create cart:", cartErr);
      const errMsg = "Sorry, we had a problem starting your order. Please try again.";
      return isSms ? twimlResponse(errMsg) : jsonError(errMsg, 500);
    }
    cart = newCart as OrderCart;
  }

  // Short-circuit on terminal phases
  if (cart.phase === "confirmed") {
    const reply = "Your order is confirmed and paid. Thank you!";
    await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
    await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
    return isSms ? twimlResponse(reply) : jsonResponse({ reply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId });
  }
  if (cart.phase === "checkout") {
    const reply = "Your payment link was sent. Please complete payment to confirm your order. Say \"restart\" to start over.";
    await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
    await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
    return isSms ? twimlResponse(reply) : jsonResponse({ reply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId });
  }

  // ── Build effective menu ──────────────────────────────────────────────────
  const businessDate  = getBusinessDate(shop.timezone);
  const currentTime   = getCurrentTime(shop.timezone);
  const effectiveMenu = await buildEffectiveMenu(supabase, shop.id, businessDate);

  if (effectiveMenu.length === 0 && cart.phase === "greeting") {
    const reply = "Sorry, our menu is not available right now. Please call us to place an order.";
    await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
    await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);
    return isSms ? twimlResponse(reply) : jsonResponse({ reply, cart: [], phase: "greeting", session_id: sessionId });
  }

  // ── Load conversation history ─────────────────────────────────────────────
  const { data: historyRows } = await supabase
    .from("messages").select("role, content")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: true }).limit(20);

  const history = (historyRows ?? [])
    .filter((m: { role: string }) => m.role === "customer" || m.role === "assistant")
    .map((m: { role: string; content: string }) => ({
      role:    m.role === "customer" ? "user" as const : "assistant" as const,
      content: m.content,
    }));

  // Save user message
  await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);

  // ── Run ordering loop ─────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(shop, cart.phase, effectiveMenu, [...cart.cart_json], currentTime, isFirstMessage);
  const cartItems    = [...cart.cart_json];

  const { reply, checkoutUrl } = await runOrderingLoop(
    systemPrompt, history, userMessage, cartItems, effectiveMenu, cart.id, supabase, shop.name,
  );

  await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply);

  // Reload cart for response
  const { data: updatedCart } = await supabase.from("order_carts").select("*").eq("id", cart.id).single();
  const currentCart = (updatedCart as OrderCart) ?? cart;

  // Append payment URL to SMS if present
  let finalReply = reply;
  if (checkoutUrl) {
    // Always append the payment URL to the reply so the customer can see it
    const combined = `${reply}\n\nPay here: ${checkoutUrl}`;
    finalReply = isSms
      ? (combined.length <= 1600 ? combined : `${reply.substring(0, 1200)}\n${checkoutUrl}`)
      : combined;
  }

  if (isSms) return twimlResponse(finalReply);
  return jsonResponse({
    reply:        finalReply,
    cart:         currentCart.cart_json,
    phase:        currentCart.phase,
    session_id:   sessionId,
    checkout_url: checkoutUrl,
  });
});
