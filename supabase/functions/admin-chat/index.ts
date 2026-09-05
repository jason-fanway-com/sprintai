// @ts-nocheck — no generated Database type; all deno type errors here are false positives (works at runtime)

/**
 * SprintAI admin-chat Edge Function
 * Store-owner conversational admin: 86 items, specials, delivery controls.
 *
 * Auth: Bearer JWT (tenant-scoped).
 * Flow:  1. User sends message
 *        2. LLM returns a structured PROPOSAL (does not execute)
 *        3. Backend validates → returns confirmation_card
 *        4. User sends confirmed_action_id → backend executes and logs
 *        5. Undo reverses the last logged action
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// ─── Constants ─────────────────────────────────────────────────────────────────
const CHAT_API = "https://openrouter.ai/api/v1/messages";
const CHAT_MODEL = Deno.env.get("CHAT_MODEL") ?? "deepseek/deepseek-v4-flash";
const MAX_RETRIES = 3;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Types ─────────────────────────────────────────────────────────────────────
interface Shop {
  id: string; name: string; tenant_id: string; timezone: string;
  delivery_enabled: boolean;
  delivery_paused_until: string | null;
  delivery_pause_reason: string | null;
  email_ticket_recipient: string | null;
}

interface MenuItem {
  id: string; name: string; price_cents: number; description: string | null;
  category: string; active: boolean;
  prompt_for?: string | null; flag_review?: boolean | null; flag_reason?: string | null;
}

interface OptionGroupRow {
  id: string; menu_item_id: string; name: string; required: boolean;
  min_select: number; max_select: number;
}

interface OptionChoiceRow {
  id: string; option_group_id: string; name: string; price_cents: number;
}

interface Special {
  id: string; name: string; price_cents: number; description: string | null;
  linked_item_id: string | null; active_date: string;
}

interface OptionChoiceInput {
  choice_id?: string;
  name: string;
  price_cents: number;
}

interface OptionGroupInput {
  group_id?: string;
  name: string;
  required: boolean;
  min_select: number;
  max_select: number;
  choices: OptionChoiceInput[];
  delete_choice_ids?: string[];
}

interface DayHours {
  closed: boolean;
  open?: string;
  close?: string;
}

interface Proposal {
  intent: string;
  items?: string[];
  item_ids?: string[];
  category?: string | null;
  duration?: string;
  duration_minutes?: number | null;
  special_name?: string;
  special_price_cents?: number;
  special_description?: string;
  linked_item_id?: string | null;
  special_id?: string;
  reason?: string;
  new_email?: string;
  needs_clarification: boolean;
  clarification_question?: string | null;
  clarification_options?: string[];
  summary: string;
  // ── Menu & Settings editor ops (SET_ITEM_OPTIONS, SET_ITEM_FIELDS, SET_STORE_HOURS,
  // SET_DELIVERY_HOURS, SET_DELIVERY_ENABLED, SET_SHOP_INSTRUCTIONS, SET_WING_POLICY) ──
  item_id?: string;
  item_name?: string;
  upsert_groups?: OptionGroupInput[];
  delete_group_ids?: string[];
  item_fields?: {
    name?: string;
    price_dollars?: string;
    description?: string;
    category?: string;
    active?: boolean;
    clear_review_flag?: boolean;
  };
  new_item?: {
    name?: string;
    price_dollars?: string;
    description?: string;
    category?: string;
  };
  open_hours?: Record<string, DayHours>;
  delivery_hours?: Record<string, DayHours>;
  delivery_enabled?: boolean;
  ai_instructions?: string;
  wing_flavors_included?: number | null;
  wing_mix_extra?: boolean | null;
}

interface ConfirmationCard {
  type: "confirmation_card";
  action_id: string;
  intent: string;
  summary: string;
  details: Record<string, unknown>;
  cancel_label: string;
  confirm_label: string;
}

interface ExecutedAction {
  type: "executed";
  action_id: string;
  result: string;
  intent: string;
  undo_token: string;
  status_header: StatusHeader;
}

interface StatusHeader {
  delivery_enabled: boolean;
  items_86d_today: number;
  active_specials_count: number;
  items_86d_names: string[];
  active_specials_names: string[];
}

// ─── Tools (spec v1 — 9 intents) ──────────────────────────────────────────────
const ADMIN_TOOLS = [
  {
    name: "EIGHTYSIX_ITEM",
    description: "Mark an item sold out (86'd) for the rest of the day. Resolve against the real menu. Set needs_clarification=true if ambiguous — never guess.",
    input_schema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "Human-readable item name(s) to 86" },
        item_ids: { type: "array", items: { type: "string" }, description: "Menu item ID(s) — include when the match is unambiguous" },
        category: { type: "string", description: "Category name if 86'ing an entire category" },
        category_items: { type: "array", items: { type: "string" }, description: "All item IDs in the category if 86'ing a whole category" },
        needs_clarification: { type: "boolean", description: "Set true if the item reference is ambiguous" },
        clarification_question: { type: "string", description: "Question to ask for disambiguation" },
        clarification_options: { type: "array", items: { type: "string" }, description: "Tappable options for disambiguation" },
        summary: { type: "string", description: "Human-readable summary of what will happen, e.g. 'Mark Lox Bagel sold out until close'" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "RESTORE_ITEM",
    description: "Un-86 an item — make it available again. Resolve against the current 86 list.",
    input_schema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "Item name(s) to restore" },
        item_ids: { type: "array", items: { type: "string" }, description: "Menu item ID(s)" },
        needs_clarification: { type: "boolean" },
        clarification_question: { type: "string" },
        clarification_options: { type: "array", items: { type: "string" } },
        summary: { type: "string", description: "e.g. 'Make Lox Bagel available again'" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "ADD_SPECIAL",
    description: "Add a daily special — a temporary offering with its own name and price. Active for today only.",
    input_schema: {
      type: "object",
      properties: {
        special_name: { type: "string", description: "Name of the special" },
        special_price_cents: { type: "integer", description: "Price in cents" },
        special_description: { type: "string", description: "Short description" },
        linked_item_id: { type: "string", description: "Optional: link to an existing menu item" },
        needs_clarification: { type: "boolean", description: "Set true if name or price is missing" },
        clarification_question: { type: "string" },
        summary: { type: "string", description: "e.g. 'Add Lox Special at $11.00 for today'" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "END_SPECIAL",
    description: "End/remove a daily special.",
    input_schema: {
      type: "object",
      properties: {
        special_id: { type: "string", description: "ID of the special to end" },
        special_name: { type: "string", description: "Name of the special being ended" },
        needs_clarification: { type: "boolean" },
        clarification_question: { type: "string" },
        clarification_options: { type: "array", items: { type: "string" } },
        summary: { type: "string", description: "e.g. 'End the Lox Special'" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "PAUSE_DELIVERY",
    description: "Temporarily disable delivery. Supports timed, rest-of-day, and indefinite presets.",
    input_schema: {
      type: "object",
      properties: {
        duration: { type: "string", enum: ["30_min", "1_hour", "rest_of_day", "indefinite"], description: "How long to pause" },
        reason: { type: "string", description: "Reason for the pause" },
        needs_clarification: { type: "boolean", description: "Set true if duration is unclear" },
        clarification_question: { type: "string" },
        clarification_options: { type: "array", items: { type: "string" } },
        summary: { type: "string", description: "e.g. 'Pause delivery for 1 hour — Pickup still open'" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "RESUME_DELIVERY",
    description: "Re-enable delivery.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "e.g. 'Resume delivery'" },
        needs_clarification: { type: "boolean" },
      },
      required: ["summary", "needs_clarification"],
    },
  },
  {
    name: "QUERY_STATUS",
    description: "Report current status: what's 86'd, active specials, delivery enabled, recent actions.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Status summary" },
        needs_clarification: { type: "boolean", default: false },
      },
      required: ["summary"],
    },
  },
  {
    name: "UNDO",
    description: "Reverse the last action.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "e.g. 'Undo the last change'" },
        needs_clarification: { type: "boolean", default: false },
      },
      required: ["summary"],
    },
  },
  {
    name: "SET_TICKET_DESTINATION",
    description: "Change where the shop's order tickets are emailed (the order/receipt inbox). The Expo Screen always shows orders regardless. Use when the owner wants orders sent to a different email address.",
    input_schema: {
      type: "object",
      properties: {
        new_email: { type: "string", description: "The email address order tickets should be sent to" },
        needs_clarification: { type: "boolean", description: "Set true if no valid email was given" },
        clarification_question: { type: "string" },
        summary: { type: "string", description: "e.g. 'Send order tickets to kitchen@joes.com'" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "SET_ITEM_OPTIONS",
    description: "Add, rename, or remove option groups and choices on a menu item (e.g. wing flavors, bread choices, toppings). NEVER invent a choice the owner did not say — only write the exact names given. If the item reference is ambiguous (e.g. both a bone-in and boneless version), set needs_clarification=true and ask which.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Menu item ID — resolve unambiguously against the real menu" },
        item_name: { type: "string", description: "Human-readable item name, for the summary" },
        upsert_groups: {
          type: "array",
          description: "Option groups to create or update on this item",
          items: {
            type: "object",
            properties: {
              group_id: { type: "string", description: "Existing group ID to update; omit to create a new group" },
              name: { type: "string", description: "Group name, e.g. 'Wing Flavor'" },
              required: { type: "boolean" },
              min_select: { type: "integer" },
              max_select: { type: "integer" },
              choices: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    choice_id: { type: "string", description: "Existing choice ID to update; omit to create a new choice" },
                    name: { type: "string" },
                    price_cents: { type: "integer", description: "Extra charge in cents; 0 if free — never omit" },
                  },
                  required: ["name", "price_cents"],
                },
              },
              delete_choice_ids: { type: "array", items: { type: "string" } },
            },
            required: ["name", "required", "min_select", "max_select", "choices"],
          },
        },
        delete_group_ids: { type: "array", items: { type: "string" }, description: "Option group IDs to remove entirely" },
        needs_clarification: { type: "boolean" },
        clarification_question: { type: "string" },
        clarification_options: { type: "array", items: { type: "string" } },
        summary: { type: "string", description: "e.g. 'Add three wing flavors: Hot, Mild, BBQ'" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "SET_ITEM_FIELDS",
    description: "Edit a menu item's name, price, description, or category. To add/remove/rename option groups or choices, use SET_ITEM_OPTIONS instead.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Menu item ID — resolve unambiguously against the real menu" },
        item_fields: {
          type: "object",
          properties: {
            name: { type: "string" },
            price_dollars: { type: "string", description: "Price in dollars as a decimal string, e.g. '12.99'" },
            description: { type: "string" },
            category: { type: "string" },
            active: { type: "boolean" },
            clear_review_flag: { type: "boolean", description: "Set true when the owner confirms a low-confidence item is correct as-is ('looks right')" },
          },
        },
        needs_clarification: { type: "boolean" },
        clarification_question: { type: "string" },
        clarification_options: { type: "array", items: { type: "string" } },
        summary: { type: "string", description: "e.g. 'Rename Lox Bagel to Lox & Cream Cheese Bagel, $11.50'" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "ADD_ITEM",
    description: "Add a brand-new menu item. NEVER invent the name, price, or category — only use exactly what the owner said. If name or price is missing, set needs_clarification=true and ask for it.",
    input_schema: {
      type: "object",
      properties: {
        new_item: {
          type: "object",
          properties: {
            name: { type: "string" },
            price_dollars: { type: "string", description: "Price in dollars as a decimal string, e.g. '9.99'" },
            description: { type: "string" },
            category: { type: "string", description: "Menu category/section, e.g. 'Sandwiches'. Leave out if the owner didn't say one." },
          },
          required: ["name", "price_dollars"],
        },
        needs_clarification: { type: "boolean" },
        clarification_question: { type: "string" },
        summary: { type: "string", description: "e.g. 'Add new item: Turkey Club — $9.99'" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "REMOVE_ITEM",
    description: "Permanently remove a menu item from the menu (it stops showing to customers and to the ordering bot; its past order history is unaffected). This is NOT the same as EIGHTYSIX_ITEM, which is a same-day sold-out mark — use EIGHTYSIX_ITEM for 'we're out of X tonight'. Resolve against the real menu; if ambiguous, set needs_clarification=true.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Menu item ID — resolve unambiguously against the real menu" },
        item_name: { type: "string", description: "Human-readable item name, for the summary" },
        needs_clarification: { type: "boolean" },
        clarification_question: { type: "string" },
        clarification_options: { type: "array", items: { type: "string" } },
        summary: { type: "string", description: "e.g. 'Remove Lox Bagel from the menu'" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "SET_STORE_HOURS",
    description: "Set the shop's regular operating hours (not delivery hours — use SET_DELIVERY_HOURS for that). Must cover all seven days.",
    input_schema: {
      type: "object",
      properties: {
        open_hours: {
          type: "object",
          description: "Keys mon,tue,wed,thu,fri,sat,sun. Each value: {closed:true} or {closed:false, open:'HH:MM', close:'HH:MM'} in 24h shop-local time.",
        },
        needs_clarification: { type: "boolean" },
        clarification_question: { type: "string" },
        summary: { type: "string", description: "e.g. 'Open 11am-9pm Mon-Sat, closed Sunday'" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "SET_DELIVERY_HOURS",
    description: "Set the shop's delivery-specific hours (may differ from store hours). Must cover all seven days.",
    input_schema: {
      type: "object",
      properties: {
        delivery_hours: {
          type: "object",
          description: "Same shape as open_hours: keys mon..sun, each {closed:true} or {closed:false, open:'HH:MM', close:'HH:MM'}.",
        },
        needs_clarification: { type: "boolean" },
        clarification_question: { type: "string" },
        summary: { type: "string" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "SET_DELIVERY_ENABLED",
    description: "Permanently turn delivery on or off for this shop. This is NOT the same as PAUSE_DELIVERY/RESUME_DELIVERY, which are temporary same-day pauses — use those for 'pause delivery for an hour' style requests. Use this only for a permanent on/off change to whether the shop offers delivery at all.",
    input_schema: {
      type: "object",
      properties: {
        delivery_enabled: { type: "boolean" },
        needs_clarification: { type: "boolean" },
        summary: { type: "string", description: "e.g. 'Turn delivery off for this shop permanently'" },
      },
      required: ["delivery_enabled", "needs_clarification", "summary"],
    },
  },
  {
    name: "SET_SHOP_INSTRUCTIONS",
    description: "Update the shop's AI instructions — behavior rules for the ordering bot. Note: the menu overrides instructions on item names and prices, so instructions that contradict the menu will lose.",
    input_schema: {
      type: "object",
      properties: {
        ai_instructions: { type: "string" },
        needs_clarification: { type: "boolean" },
        summary: { type: "string" },
      },
      required: ["ai_instructions", "needs_clarification", "summary"],
    },
  },
  {
    name: "SET_WING_POLICY",
    description: "Configure how many wing flavors are included per order and whether mixing flavors costs extra. Until this is set, the ordering bot refuses to guess and will not tell customers they can or can't mix flavors.",
    input_schema: {
      type: "object",
      properties: {
        wing_flavors_included: { type: "integer", description: "How many flavors are included per order, e.g. 1 for a 10-piece order" },
        wing_mix_extra: { type: "boolean", description: "True if mixing flavors across an order costs extra or is restricted" },
        needs_clarification: { type: "boolean" },
        summary: { type: "string" },
      },
      required: ["needs_clarification", "summary"],
    },
  },
  {
    name: "UNKNOWN_OR_OUT_OF_SCOPE",
    description: "The request doesn't match any supported intent. Redirect to the right place.",
    input_schema: {
      type: "object",
      properties: {
        suggestion: { type: "string", description: "Friendly message redirecting to where this change is actually made" },
        needs_clarification: { type: "boolean", default: false },
      },
      required: ["suggestion"],
    },
  },
];

// ─── System Prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(
  shop: Shop,
  menu: MenuItem[],
  specials: Special[],
  eightySixList: MenuItem[],
  currentTime: string,
  optionGroupsByItem?: Map<string, { group: OptionGroupRow; choices: OptionChoiceRow[] }[]>,
): string {
  const menuStr = Object.entries(groupBy(menu, m => m.category))
    .map(([cat, items]) => {
      const rows = items.map(i => {
        const groups = optionGroupsByItem?.get(i.id) ?? [];
        const groupsStr = groups.length > 0
          ? " | options: " + groups.map(g => `${g.group.name} [${g.group.id}] (${g.choices.map(c => `${c.name}${c.price_cents ? ` +$${(c.price_cents / 100).toFixed(2)}` : ""}`).join(", ") || "no choices yet"})`).join("; ")
          : "";
        const flags = [
          i.prompt_for ? ` [NEEDS ANSWER: ${i.prompt_for}]` : "",
          i.flag_review ? ` [LOW CONFIDENCE: ${i.flag_reason ?? "unreviewed"}]` : "",
        ].join("");
        return `  ${i.id}: ${i.name} — $${(i.price_cents / 100).toFixed(2)}${!i.active ? " [INACTIVE]" : ""}${flags}${groupsStr}`;
      });
      return `**${cat}**\n${rows}`;
    }).join("\n\n");

  const specialsStr = specials.length > 0
    ? specials.map(s => `  ${s.id}: ${s.name} — $${(s.price_cents / 100).toFixed(2)}${s.description ? ` (${s.description})` : ""}`).join("\n")
    : "  (no specials today)";

  const eightySixStr = eightySixList.length > 0
    ? eightySixList.map(i => `  ${i.id}: ${i.name} (${i.category})`).join("\n")
    : "  (nothing 86'd today)";

  const deliveryStatus = shop.delivery_enabled && !shop.delivery_paused_until
    ? "✅ Delivery is active."
    : `🚫 Delivery is paused${shop.delivery_pause_reason ? `: ${shop.delivery_pause_reason}` : ""}`;

  const businessDate = new Date().toISOString().slice(0, 10);

  return `You are the store-management assistant for ${shop.name}. The owner texts you plain-language commands to manage same-day operational toggles AND their permanent menu/settings. You NEVER execute changes directly — you return a structured PROPOSAL that the backend validates and shows as a confirmation card.

CURRENT TIME: ${currentTime}
BUSINESS DATE: ${businessDate}
SHOP: ${shop.name}
${deliveryStatus}

LIVE MENU (${menu.length} items) — [NEEDS ANSWER] means prompt_for is set and no options exist yet; [LOW CONFIDENCE] means menu curation flagged it for owner review; "options:" lists existing option groups with their real IDs:
${menuStr}

CURRENTLY 86'D (${eightySixList.length} items):
${eightySixStr}

TODAY'S SPECIALS (${specials.length}):
${specialsStr}

CRITICAL RULES — VIOLATING ANY OF THESE IS A BUG:
1. You PROPOSE; you NEVER execute. Return exactly ONE tool call per turn with a proposal.
2. Always include a "summary" field — a human-readable sentence of what the confirmation card will show. Keep it under 80 chars.
3. For EIGHTYSIX_ITEM: match against the REAL menu IDs. If ambiguous, set needs_clarification=true and suggest options from the menu. If the customer says just a name like "lox" and it matches exactly one item, use that item_id.
4. For RESTORE_ITEM: match against the CURRENTLY 86'D list, not the full menu.
5. For ADD_SPECIAL: name AND price are required. If either is missing, set needs_clarification=true and ask for the missing field.
6. For PAUSE_DELIVERY: if the customer doesn't specify duration, set needs_clarification=true with options: ["1 hour", "Rest of today", "Until I turn it back on"].
7. For QUERY_STATUS: just return the stats; no state change.
8. For UNDO: no clarification needed — just propose it.
9. For SET_TICKET_DESTINATION: if the owner wants order tickets/emails sent to a different address, capture new_email. If no clear email address is given, set needs_clarification=true and ask for it. Never guess an address.
10. Anything outside these supported intents → UNKNOWN_OR_OUT_OF_SCOPE with a friendly redirect.
11. "summary" MUST be in plain English describing what the owner sees on the confirmation card. Examples:
    - "Mark Lox Bagel sold out until close tonight"
    - "Add 'Friday Lobster Roll' special at $18.00 for today"
    - "Pause delivery for 1 hour — pickup still open"
    - "End the Lox Special"
12. For SET_ITEM_OPTIONS: NEVER invent a choice the owner did not literally say. If the item name matches more than one menu item (e.g. "Wings (Bone-In)" AND "Wings (Boneless)" both exist), set needs_clarification=true and list both as options — do not guess. If the item already has an option group with a matching name in "options:" above, reuse that group_id to add choices to it rather than creating a duplicate group. Every choice needs an explicit price_cents (0 if free) — never omit it.
13. For SET_ITEM_FIELDS: only include the fields the owner actually mentioned; leave the rest out of item_fields entirely rather than guessing a value.
13a. For ADD_ITEM: name and price are required and must come verbatim from the owner — never invent either. If category is not given, leave it out (the backend defaults it).
13b. For REMOVE_ITEM: resolve against the REAL menu, same as EIGHTYSIX_ITEM. If the owner just wants it unavailable for tonight, that's EIGHTYSIX_ITEM, not REMOVE_ITEM — only use REMOVE_ITEM when they clearly mean permanently taking it off the menu.
14. For SET_STORE_HOURS / SET_DELIVERY_HOURS: every one of mon,tue,wed,thu,fri,sat,sun must be present, each either {"closed":true} or {"closed":false,"open":"HH:MM","close":"HH:MM"}. If the owner only gives some days, set needs_clarification=true and ask about the rest rather than guessing.
15. For SET_DELIVERY_ENABLED: this is a PERMANENT on/off switch, not a same-day pause. If the owner says something like "pause delivery" or "turn delivery back on" for today, use PAUSE_DELIVERY/RESUME_DELIVERY instead. Only use SET_DELIVERY_ENABLED for "stop offering delivery" / "start offering delivery" style permanent requests.
16. For SET_SHOP_INSTRUCTIONS: capture the owner's instructions verbatim into ai_instructions; do not summarize or rewrite their wording.
17. For SET_WING_POLICY: capture wing_flavors_included and/or wing_mix_extra only from what the owner explicitly states.
18. Whenever your reply describes the RESULT of a completed change, describe it from what was actually written — never claim a change happened if it didn't.`;
}

function groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) result[keyFn(item)] = [...(result[keyFn(item)] || []), item];
  return result;
}

// ─── Validator & Executor ──────────────────────────────────────────────────────

function getBusinessDate(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    return `${parts.find(p => p.type === "year")?.value}-${parts.find(p => p.type === "month")?.value}-${parts.find(p => p.type === "day")?.value}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function get86List(supabase: ReturnType<typeof createClient>, shopId: string, businessDate: string): Promise<{ item: MenuItem; override_id: string }[]> {
  const { data: overrides } = await supabase
    .from("availability_overrides")
    .select("id, menu_item_id")
    .eq("shop_id", shopId)
    .eq("business_date", businessDate);
  if (!overrides?.length) return [];

  const itemIds = overrides.map((o: { menu_item_id: string }) => o.menu_item_id);
  // Fetch names from menu_items
  const { data: items } = await supabase
    .from("menu_items")
    .select("id, name, price_cents, description, category, active")
    .in("id", itemIds);

  const itemMap = new Map((items ?? []).map((i: MenuItem) => [i.id, i]));
  return overrides.map((o: { id: string; menu_item_id: string }) => ({
    item: itemMap.get(o.menu_item_id) ?? { id: o.menu_item_id, name: o.menu_item_id, price_cents: 0, description: null, category: "", active: true },
    override_id: o.id,
  }));
}

async function getActiveSpecials(supabase: ReturnType<typeof createClient>, shopId: string, today: string): Promise<Special[]> {
  const { data } = await supabase
    .from("specials")
    .select("*").eq("shop_id", shopId).eq("active_date", today);
  return (data ?? []) as unknown as Special[];
}

// Option groups + choices for a set of menu items, keyed by menu_item_id. Used to give the
// LLM (and the read-back sentence builder) real group/choice IDs so it reuses an existing
// group instead of creating a duplicate, and never has to invent one.
async function getOptionGroupsForItems(
  db: ReturnType<typeof createClient>,
  itemIds: string[],
): Promise<Map<string, { group: OptionGroupRow; choices: OptionChoiceRow[] }[]>> {
  const result = new Map<string, { group: OptionGroupRow; choices: OptionChoiceRow[] }[]>();
  if (itemIds.length === 0) return result;
  const { data: groups } = await db
    .from("option_groups")
    .select("id, menu_item_id, name, required, min_select, max_select")
    .in("menu_item_id", itemIds);
  const groupRows = (groups ?? []) as OptionGroupRow[];
  if (groupRows.length === 0) return result;
  const groupIds = groupRows.map(g => g.id);
  const { data: choices } = await db
    .from("option_choices")
    .select("id, option_group_id, name, price_cents")
    .in("option_group_id", groupIds);
  const choiceRows = (choices ?? []) as OptionChoiceRow[];
  const choicesByGroup = new Map<string, OptionChoiceRow[]>();
  for (const c of choiceRows) {
    choicesByGroup.set(c.option_group_id, [...(choicesByGroup.get(c.option_group_id) ?? []), c]);
  }
  for (const g of groupRows) {
    const entry = { group: g, choices: choicesByGroup.get(g.id) ?? [] };
    result.set(g.menu_item_id, [...(result.get(g.menu_item_id) ?? []), entry]);
  }
  return result;
}

async function validateProposal(
  proposal: Proposal,
  shopId: string,
  businessDate: string,
  supabase: ReturnType<typeof createClient>,
  menu: MenuItem[],
  specials: Special[],
  eightySixList: { item: MenuItem; override_id: string }[],
): Promise<{ valid: boolean; error?: string; clarification?: ConfirmationCard }> {
  const menuMap = new Map(menu.map(m => [m.id, m]));
  const specialMap = new Map(specials.map(s => [s.id, s]));
  const eightSixMap = new Map(eightySixList.map(e => [e.item.id, e]));

  switch (proposal.intent) {
    case "EIGHTYSIX_ITEM": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      const ids = proposal.item_ids ?? [];
      // Also resolve by category
      const catItems = proposal.category
        ? menu.filter(m => m.category?.toLowerCase() === proposal.category!.toLowerCase()).map(m => m.id)
        : [];
      const allIds = [...new Set([...ids, ...catItems])];
      if (allIds.length === 0) return { valid: false, error: "No items specified to 86." };
      for (const id of allIds) {
        if (!menuMap.has(id)) return { valid: false, error: `Item "${id}" not found in your menu.` };
        if (eightSixMap.has(id)) return { valid: false, error: `"${menuMap.get(id)!.name}" is already 86'd.` };
      }
      return { valid: true };
    }
    case "RESTORE_ITEM": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      const ids = proposal.item_ids ?? [];
      if (ids.length === 0) return { valid: false, error: "No items specified to restore." };
      for (const id of ids) {
        if (!eightSixMap.has(id)) return { valid: false, error: `Item "${menuMap.get(id)?.name ?? id}" is not currently 86'd.` };
      }
      return { valid: true };
    }
    case "ADD_SPECIAL": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      if (!proposal.special_name?.trim()) return { valid: false, error: "A special needs a name." };
      if (!proposal.special_price_cents || proposal.special_price_cents <= 0) {
        return { valid: false, error: "A special needs a price greater than $0.00." };
      }
      return { valid: true };
    }
    case "END_SPECIAL": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      const sid = proposal.special_id;
      if (!sid || !specialMap.has(sid)) return { valid: false, error: "Special not found — it may have already ended." };
      return { valid: true };
    }
    case "PAUSE_DELIVERY": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      if (!proposal.duration) return { valid: false, error: "Please choose a duration." };
      return { valid: true };
    }
    case "SET_TICKET_DESTINATION": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      const email = (proposal.new_email ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { valid: false, error: "That doesn't look like a valid email address. Try again with the full address." };
      }
      return { valid: true };
    }
    case "SET_ITEM_OPTIONS": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      const itemId = proposal.item_id;
      if (!itemId || !menuMap.has(itemId)) return { valid: false, error: "Item not found on this shop's menu." };
      const upserts = proposal.upsert_groups ?? [];
      const deleteGroupIds = proposal.delete_group_ids ?? [];
      if (upserts.length === 0 && deleteGroupIds.length === 0) {
        return { valid: false, error: "Nothing to change — no option groups or choices given." };
      }
      for (const g of upserts) {
        if (!g.name?.trim()) return { valid: false, error: "An option group needs a name." };
        if (typeof g.min_select !== "number" || typeof g.max_select !== "number" || g.min_select < 0 || g.max_select < 1 || g.min_select > g.max_select) {
          return { valid: false, error: `"${g.name}" has an invalid min/max select.` };
        }
        if (g.group_id) {
          const { data: existing } = await supabase.from("option_groups").select("id, menu_item_id").eq("id", g.group_id).single();
          if (!existing || existing.menu_item_id !== itemId) return { valid: false, error: "That option group wasn't found on this item." };
        }
        const choices = g.choices ?? [];
        for (const c of choices) {
          if (!c.name?.trim()) return { valid: false, error: "A choice needs a name — never leave one blank." };
          if (typeof c.price_cents !== "number" || c.price_cents < 0 || !Number.isFinite(c.price_cents)) {
            return { valid: false, error: `"${c.name}" needs a price of $0.00 or more.` };
          }
          if (c.choice_id) {
            const { data: existingChoice } = await supabase.from("option_choices").select("id, option_group_id").eq("id", c.choice_id).single();
            if (!existingChoice || (g.group_id && existingChoice.option_group_id !== g.group_id)) {
              return { valid: false, error: "That choice wasn't found in that group." };
            }
          }
        }
      }
      for (const gid of deleteGroupIds) {
        const { data: existing } = await supabase.from("option_groups").select("id, menu_item_id").eq("id", gid).single();
        if (!existing || existing.menu_item_id !== itemId) return { valid: false, error: "That option group wasn't found on this item." };
      }
      return { valid: true };
    }
    case "SET_ITEM_FIELDS": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      const itemId = proposal.item_id;
      if (!itemId || !menuMap.has(itemId)) return { valid: false, error: "Item not found on this shop's menu." };
      const f = proposal.item_fields ?? {};
      if (Object.keys(f).length === 0) return { valid: false, error: "No fields to change." };
      if (f.name !== undefined && !f.name.trim()) return { valid: false, error: "Name can't be blank." };
      if (f.price_dollars !== undefined) {
        const cents = Math.round(parseFloat(f.price_dollars) * 100);
        if (!Number.isFinite(cents) || cents < 0) return { valid: false, error: "That doesn't look like a valid price." };
      }
      return { valid: true };
    }
    case "ADD_ITEM": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      const n = proposal.new_item ?? {};
      if (!n.name?.trim()) return { valid: false, error: "New item needs a name." };
      if (n.price_dollars === undefined || n.price_dollars === "") return { valid: false, error: "New item needs a price." };
      const cents = Math.round(parseFloat(n.price_dollars) * 100);
      if (!Number.isFinite(cents) || cents < 0) return { valid: false, error: "That doesn't look like a valid price." };
      return { valid: true };
    }
    case "REMOVE_ITEM": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      const itemId = proposal.item_id;
      if (!itemId || !menuMap.has(itemId)) return { valid: false, error: "Item not found on this shop's menu." };
      return { valid: true };
    }
    case "SET_STORE_HOURS": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      const err = validateHoursShape(proposal.open_hours);
      if (err) return { valid: false, error: err };
      return { valid: true };
    }
    case "SET_DELIVERY_HOURS": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      const err = validateHoursShape(proposal.delivery_hours);
      if (err) return { valid: false, error: err };
      return { valid: true };
    }
    case "SET_DELIVERY_ENABLED": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      if (typeof proposal.delivery_enabled !== "boolean") {
        return { valid: false, error: "Specify whether delivery should be permanently on or off." };
      }
      return { valid: true };
    }
    case "SET_SHOP_INSTRUCTIONS": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      if (proposal.ai_instructions === undefined) return { valid: false, error: "No instructions given." };
      return { valid: true };
    }
    case "SET_WING_POLICY": {
      if (proposal.needs_clarification) {
        return { valid: true, clarification: makeClarificationCard(proposal) };
      }
      if (proposal.wing_flavors_included == null && proposal.wing_mix_extra == null) {
        return { valid: false, error: "Specify flavors included and/or the mix policy." };
      }
      if (proposal.wing_flavors_included != null && (!Number.isInteger(proposal.wing_flavors_included) || proposal.wing_flavors_included < 1)) {
        return { valid: false, error: "Flavors included must be a whole number of at least 1." };
      }
      return { valid: true };
    }
    case "RESUME_DELIVERY":
    case "QUERY_STATUS":
    case "UNDO":
      return { valid: true };
    case "UNKNOWN_OR_OUT_OF_SCOPE":
      return { valid: true };
    default:
      return { valid: false, error: `Unknown intent: ${proposal.intent}` };
  }
}

const HOUR_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function validateHoursShape(hours: Record<string, DayHours> | undefined): string | null {
  if (!hours || typeof hours !== "object") return "Hours are required for all seven days.";
  for (const d of HOUR_DAY_KEYS) {
    const v = hours[d];
    if (!v || typeof v !== "object") return `Missing hours for ${d}.`;
    if (v.closed === true) continue;
    if (v.closed === false) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.open ?? "") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.close ?? "")) {
        return `${d}: open/close must be 24h "HH:MM".`;
      }
      continue;
    }
    return `${d}: "closed" must be true or false.`;
  }
  return null;
}

function summarizeHours(hours: Record<string, DayHours> | null | undefined): string {
  if (!hours) return "not set";
  const labels: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  return HOUR_DAY_KEYS.map(d => {
    const v = hours[d];
    if (!v || v.closed) return `${labels[d]} closed`;
    return `${labels[d]} ${v.open}-${v.close}`;
  }).join(", ");
}

function makeClarificationCard(proposal: Proposal): ConfirmationCard {
  return {
    type: "confirmation_card",
    action_id: crypto.randomUUID(),
    intent: proposal.intent,
    summary: proposal.clarification_question ?? proposal.summary,
    details: { options: proposal.clarification_options ?? [], needs_clarification: true },
    cancel_label: "Cancel",
    confirm_label: "Skip",
  };
}

async function executeAction(
  proposal: Proposal,
  actionId: string,
  shopId: string,
  userId: string,
  rawMessage: string,
  businessDate: string,
  shopTimezone: string,
  supabase: ReturnType<typeof createClient>,
  menu: MenuItem[],
  eightySixList: { item: MenuItem; override_id: string }[],
  specials: Special[],
  tenantId: string,
  svc: ReturnType<typeof createClient>,
  actorLabel: "chat" | "form" = "chat",
): Promise<ExecutedAction> {
  const menuMap = new Map(menu.map(m => [m.id, m]));
  const eightySixMap = new Map(eightySixList.map(e => [e.item.id, e]));
  let resultMsg = "";
  let beforeSnapshot: Record<string, unknown> = {};
  let afterSnapshot: Record<string, unknown> = {};

  // Fire-and-forget audit trail — never blocks the response, never throws into the caller.
  // Both the chat path and the form path call this same executeAction(), so both produce
  // an identical menu_edit_log shape; actorLabel is the only thing that tells them apart.
  const logEdit = (params: { table_name: string; row_id: string | null; before: unknown; after: unknown }) => {
    svc.from("menu_edit_log").insert({
      shop_id: shopId,
      tenant_id: tenantId,
      actor: userId,
      actor_label: actorLabel,
      op_id: proposal.intent,
      table_name: params.table_name,
      row_id: params.row_id,
      before: params.before ?? null,
      after: params.after ?? null,
    }).then(() => {}, (err: unknown) => console.error("[admin-chat] menu_edit_log insert error:", err));
  };

  switch (proposal.intent) {
    case "EIGHTYSIX_ITEM": {
      const ids = proposal.item_ids ?? [];
      const catItems = proposal.category
        ? menu.filter(m => m.category?.toLowerCase() === proposal.category!.toLowerCase()).map(m => m.id)
        : [];
      const allIds = [...new Set([...ids, ...catItems])];
      beforeSnapshot = { type: "eightysix", eighty_six_before: eightySixList.map(e => e.item.id) };

      const inserts = allIds.map(itemId => ({
        shop_id: shopId,
        menu_item_id: itemId,
        business_date: businessDate,
        set_by: userId,
        source: "admin-chat",
        notes: `86'd via admin chat: "${rawMessage}"`,
      }));
      await supabase.from("availability_overrides").insert(inserts);

      const names = allIds.map(id => menuMap.get(id)?.name ?? id).join(", ");
      resultMsg = `Done — ${names} marked sold out until close.`;
      const fresh86 = await get86List(supabase, shopId, businessDate);
      afterSnapshot = { type: "eightysix", eighty_six_after: fresh86.map(e => e.item.id) };
      break;
    }
    case "RESTORE_ITEM": {
      const ids = proposal.item_ids ?? [];
      beforeSnapshot = { type: "restore", eighty_six_before: eightySixList.map(e => e.item.id) };

      const overrideIds = ids.map(id => eightySixMap.get(id)?.override_id).filter(Boolean) as string[];
      await supabase.from("availability_overrides").delete().in("id", overrideIds);

      const names = ids.map(id => menuMap.get(id)?.name ?? id).join(", ");
      resultMsg = `Done — ${names} is back on the menu.`;
      const fresh86 = await get86List(supabase, shopId, businessDate);
      afterSnapshot = { type: "restore", eighty_six_after: fresh86.map(e => e.item.id) };
      break;
    }
    case "ADD_SPECIAL": {
      beforeSnapshot = { type: "special_add", specials_before: specials.map(s => s.id) };
      const { data: created } = await supabase
        .from("specials")
        .insert({
          shop_id: shopId,
          name: proposal.special_name,
          price_cents: proposal.special_price_cents,
          description: proposal.special_description ?? null,
          linked_item_id: proposal.linked_item_id ?? null,
          active_date: businessDate,
          created_by: userId,
        })
        .select("id").single();
      resultMsg = `Done — "${proposal.special_name}" at $${((proposal.special_price_cents ?? 0) / 100).toFixed(2)} is live for today.`;
      const freshSpecials = await getActiveSpecials(supabase, shopId, businessDate);
      afterSnapshot = { type: "special_add", specials_after: freshSpecials.map(s => s.id) };
      break;
    }
    case "END_SPECIAL": {
      const sid = proposal.special_id!;
      beforeSnapshot = { type: "special_end", specials_before: specials.map(s => s.id), ending_special_id: sid };
      await supabase.from("specials").delete().eq("id", sid);
      resultMsg = `Done — "${proposal.special_name ?? sid}" has been ended.`;
      const freshSpecials = await getActiveSpecials(supabase, shopId, businessDate);
      afterSnapshot = { type: "special_end", specials_after: freshSpecials.map(s => s.id) };
      break;
    }
    case "PAUSE_DELIVERY": {
      const duration = proposal.duration ?? "rest_of_day";
      let until: string | null = null;
      let durationMinutes: number | null = null;
      if (duration === "30_min") durationMinutes = 30;
      else if (duration === "1_hour") durationMinutes = 60;
      else if (duration === "rest_of_day") durationMinutes = null; // resets next day
      else if (duration === "indefinite") durationMinutes = null; // until turned back on

      if (durationMinutes) {
        until = new Date(Date.now() + durationMinutes * 60_000).toISOString();
      }

      beforeSnapshot = {
        type: "delivery_pause",
        delivery_enabled_before: true,
        delivery_paused_until_before: null,
      };

      await supabase.from("shops").update({
        delivery_paused_until: until,
        delivery_pause_reason: proposal.reason ?? null,
      }).eq("id", shopId);

      const durationLabel = duration === "30_min" ? "30 minutes" : duration === "1_hour" ? "1 hour" : duration === "rest_of_day" ? "the rest of today" : "until you turn it back on";
      resultMsg = `Done — delivery paused for ${durationLabel}${proposal.reason ? ` (${proposal.reason})` : ""}. Pickup is still open.`;

      afterSnapshot = {
        type: "delivery_pause",
        delivery_enabled_after: true,
        delivery_paused_until_after: until,
      };
      break;
    }
    case "RESUME_DELIVERY": {
      beforeSnapshot = {
        type: "delivery_resume",
        delivery_enabled_before: true,
        delivery_paused_until_before: null,
      };
      await supabase.from("shops").update({
        delivery_paused_until: null,
        delivery_pause_reason: null,
        delivery_enabled: true,
      }).eq("id", shopId);
      resultMsg = "Done — delivery is back on.";
      afterSnapshot = {
        type: "delivery_resume",
        delivery_enabled_after: true,
        delivery_paused_until_after: null,
      };
      break;
    }
    case "UNDO": {
      // Find most recent non-undone action for this shop
      const { data: lastAction } = await supabase
        .from("admin_action_log")
        .select("*")
        .eq("shop_id", shopId)
        .eq("undone", false)
        .not("action_taken", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!lastAction || !lastAction.before_snapshot) {
        resultMsg = "Nothing to undo — I don't have a previous action logged for today.";
        break;
      }

      // Reverse using before_snapshot
      const snap = lastAction.before_snapshot as Record<string, unknown>;
      const snapType = snap.type as string;

      if (snapType === "eightysix" || snapType === "restore") {
        const beforeIds: string[] = (snap.eighty_six_before ?? snap.eightysix_before ?? []) as string[];
        const current86 = await get86List(supabase, shopId, businessDate);
        const currentIds = current86.map(e => e.item.id);

        // Determine what to add/remove to match before_snapshot
        const toAdd = beforeIds.filter(id => !currentIds.includes(id));
        const toRemove = current86.filter(e => !beforeIds.includes(e.item.id)).map(e => e.override_id);

        if (toRemove.length > 0) await supabase.from("availability_overrides").delete().in("id", toRemove);
        if (toAdd.length > 0) {
          const inserts = toAdd.map(itemId => ({
            shop_id: shopId, menu_item_id: itemId, business_date: businessDate,
            set_by: userId, source: "admin-chat-undo",
            notes: `Undo: restored by reversing action ${lastAction.id}`,
          }));
          await supabase.from("availability_overrides").insert(inserts);
        }
      } else if (snapType === "special_add") {
        const beforeIds: string[] = (snap.specials_before ?? []) as string[];
        // Delete any specials not in before
        const currentSpecials = await getActiveSpecials(supabase, shopId, businessDate);
        const toDelete = currentSpecials.filter(s => !beforeIds.includes(s.id));
        for (const s of toDelete) {
          await supabase.from("specials").delete().eq("id", s.id);
        }
      } else if (snapType === "special_end") {
        // We can't fully recreate a deleted special, but we can restore the state
        const beforeIds: string[] = (snap.specials_before ?? []) as string[];
        const currentSpecials = await getActiveSpecials(supabase, shopId, businessDate);
        const currentIds = currentSpecials.map(s => s.id);
        const missing = beforeIds.filter(id => !currentIds.includes(id));
        if (missing.length > 0) {
          resultMsg = "That special was deleted — I can't recreate it automatically. Add it again manually.";
          break;
        }
      } else if (snapType === "delivery_pause") {
        const enabledBefore = snap.delivery_enabled_before ?? true;
        const untilBefore = snap.delivery_paused_until_before ?? null;
        await supabase.from("shops").update({
          delivery_enabled: enabledBefore,
          delivery_paused_until: untilBefore,
          delivery_pause_reason: null,
        }).eq("id", shopId);
      } else if (snapType === "delivery_resume") {
        const enabledBefore = snap.delivery_enabled_before ?? true;
        const untilBefore = snap.delivery_paused_until_before ?? null;
        await supabase.from("shops").update({
          delivery_enabled: enabledBefore,
          delivery_paused_until: untilBefore,
          delivery_pause_reason: null,
        }).eq("id", shopId);
      } else if (snapType === "ticket_destination") {
        const emailBefore = (snap.email_ticket_recipient_before ?? null) as string | null;
        await supabase.from("shops").update({
          email_ticket_recipient: emailBefore,
        }).eq("id", shopId);
      } else if (snapType === "item_fields") {
        const before = snap.before as Record<string, unknown> | null;
        if (before) {
          await supabase.from("menu_items").update({
            name: before.name, price_cents: before.price_cents, description: before.description,
            category: before.category, active: before.active,
          }).eq("id", snap.item_id as string);
        }
      } else if (snapType === "store_hours") {
        await supabase.from("shops").update({ open_hours: snap.open_hours_before ?? {} }).eq("id", shopId);
      } else if (snapType === "delivery_hours") {
        await supabase.from("shops").update({ delivery_hours: snap.delivery_hours_before ?? {} }).eq("id", shopId);
      } else if (snapType === "delivery_enabled_permanent") {
        await supabase.from("shops").update({ delivery_enabled: snap.delivery_enabled_before ?? true }).eq("id", shopId);
      } else if (snapType === "shop_instructions") {
        await supabase.from("shops").update({ ai_instructions: snap.ai_instructions_before ?? null }).eq("id", shopId);
      } else if (snapType === "wing_policy") {
        const before = snap.before as Record<string, unknown> | null;
        await supabase.from("shops").update({
          wing_flavors_included: before?.wing_flavors_included ?? null,
          wing_mix_extra: before?.wing_mix_extra ?? null,
        }).eq("id", shopId);
      } else if (snapType === "item_options") {
        resultMsg = "Option group changes can't be auto-undone yet — edit the item directly to revert.";
        break;
      } else if (snapType === "item_add") {
        await supabase.from("menu_items").delete().eq("id", snap.item_id as string);
      } else if (snapType === "item_remove") {
        const before = snap.before as Record<string, unknown> | null;
        await supabase.from("menu_items").update({ active: (before?.active as boolean | undefined) ?? true }).eq("id", snap.item_id as string);
      }

      // Mark the undone action
      await supabase.from("admin_action_log").update({ undone: true }).eq("id", lastAction.id);

      resultMsg = `Undone — reversed "${lastAction.action_taken?.slice(0, 80) ?? 'previous action'}".`;

      beforeSnapshot = { undo_source: lastAction.id, undo_type: snapType, undo_before_snapshot: lastAction.before_snapshot };
      afterSnapshot = { undo_source: lastAction.id, undo_type: snapType, undo_applied: true };
      break;
    }
    case "SET_ITEM_OPTIONS": {
      const itemId = proposal.item_id!;
      const item = menuMap.get(itemId);
      const upserts = proposal.upsert_groups ?? [];
      const deleteGroupIds = proposal.delete_group_ids ?? [];

      const beforeGroups = (await getOptionGroupsForItems(supabase, [itemId])).get(itemId) ?? [];
      beforeSnapshot = { type: "item_options", item_id: itemId, groups_before: beforeGroups };

      for (const gid of deleteGroupIds) {
        await supabase.from("option_groups").delete().eq("id", gid);
        logEdit({ table_name: "option_groups", row_id: gid, before: beforeGroups.find(g => g.group.id === gid) ?? null, after: null });
      }

      let anyChoiceWritten = false;
      for (const g of upserts) {
        let groupId = g.group_id ?? null;
        if (groupId) {
          await supabase.from("option_groups").update({
            name: g.name, required: g.required, min_select: g.min_select, max_select: g.max_select, owner_edited: true,
          }).eq("id", groupId);
        } else {
          const { data: created, error: gErr } = await supabase.from("option_groups").insert({
            menu_item_id: itemId, name: g.name, required: g.required, min_select: g.min_select, max_select: g.max_select, owner_edited: true,
          }).select("id").single();
          if (gErr || !created) throw new Error(gErr?.message ?? "Failed to create option group");
          groupId = created.id as string;
        }
        logEdit({ table_name: "option_groups", row_id: groupId, before: null, after: { name: g.name, required: g.required, min_select: g.min_select, max_select: g.max_select } });

        for (const cid of g.delete_choice_ids ?? []) {
          await supabase.from("option_choices").delete().eq("id", cid);
          logEdit({ table_name: "option_choices", row_id: cid, before: null, after: null });
        }
        for (const c of g.choices ?? []) {
          if (c.choice_id) {
            await supabase.from("option_choices").update({ name: c.name, price_cents: c.price_cents, owner_edited: true }).eq("id", c.choice_id);
            logEdit({ table_name: "option_choices", row_id: c.choice_id, before: null, after: { name: c.name, price_cents: c.price_cents } });
          } else {
            const { data: createdChoice, error: cErr } = await supabase.from("option_choices").insert({
              option_group_id: groupId, name: c.name, price_cents: c.price_cents, owner_edited: true,
            }).select("id").single();
            if (cErr) throw new Error(cErr.message);
            logEdit({ table_name: "option_choices", row_id: (createdChoice?.id as string) ?? null, before: null, after: { name: c.name, price_cents: c.price_cents } });
          }
          anyChoiceWritten = true;
        }
      }

      // Never invent an answer: prompt_for clears ONLY when this submission actually supplied
      // a choice, never as a side effect of an empty or clarification-only turn.
      if (anyChoiceWritten && item?.prompt_for) {
        await supabase.from("menu_items").update({ prompt_for: null, owner_edited: true }).eq("id", itemId);
        logEdit({ table_name: "menu_items", row_id: itemId, before: { prompt_for: item.prompt_for }, after: { prompt_for: null } });
      }

      // Read back from the DB — the result sentence is built from what was actually written,
      // never from the proposal.
      const afterGroups = (await getOptionGroupsForItems(supabase, [itemId])).get(itemId) ?? [];
      afterSnapshot = { type: "item_options", item_id: itemId, groups_after: afterGroups };
      const groupDescs = afterGroups
        .map(g => `${g.group.name}: ${g.choices.map(c => c.name).join(", ") || "no choices yet"}`)
        .join("; ");
      resultMsg = afterGroups.length > 0
        ? `${item?.name ?? "This item"} now has ${afterGroups.length} option group${afterGroups.length === 1 ? "" : "s"} — ${groupDescs}.`
        : `${item?.name ?? "This item"} has no option groups.`;
      break;
    }
    case "SET_ITEM_FIELDS": {
      const itemId = proposal.item_id!;
      const before = menuMap.get(itemId) ?? null;
      const f = proposal.item_fields ?? {};
      beforeSnapshot = { type: "item_fields", item_id: itemId, before };
      const update: Record<string, unknown> = { owner_edited: true };
      if (f.name !== undefined) update.name = f.name;
      if (f.price_dollars !== undefined) update.price_cents = Math.round(parseFloat(f.price_dollars) * 100);
      if (f.description !== undefined) update.description = f.description || null;
      if (f.category !== undefined) update.category = f.category;
      if (f.active !== undefined) update.active = f.active;
      if (f.clear_review_flag) { update.flag_review = false; update.flag_reason = null; }
      await supabase.from("menu_items").update(update).eq("id", itemId);
      logEdit({ table_name: "menu_items", row_id: itemId, before, after: update });
      const { data: fresh } = await supabase.from("menu_items")
        .select("name, price_cents, description, category, active, flag_review").eq("id", itemId).single();
      afterSnapshot = { type: "item_fields", item_id: itemId, after: fresh ?? null };
      resultMsg = fresh
        ? `${fresh.name} is now $${(fresh.price_cents / 100).toFixed(2)}${fresh.active ? "" : " (marked unavailable)"}${f.clear_review_flag ? " — confirmed correct" : ""}.`
        : "Updated.";
      break;
    }
    case "ADD_ITEM": {
      const n = proposal.new_item ?? {};
      const cents = Math.round(parseFloat(n.price_dollars ?? "0") * 100);
      const { data: menuRow } = await supabase
        .from("menus").select("id").eq("shop_id", shopId)
        .or(`effective_until.is.null,effective_until.gte.${new Date().toISOString()}`)
        .order("created_at", { ascending: false }).limit(1).single();
      if (!menuRow) throw new Error("No active menu found for this shop.");
      const { data: maxRow } = await supabase
        .from("menu_items").select("display_order")
        .eq("menu_id", menuRow.id)
        .order("display_order", { ascending: false })
        .limit(1).maybeSingle();
      const nextOrder = ((maxRow?.display_order as number | null) ?? menu.length) + 1;
      const { data: created, error: insErr } = await supabase.from("menu_items").insert({
        menu_id: menuRow.id,
        name: n.name!.trim(),
        price_cents: cents,
        description: n.description?.trim() || null,
        category: n.category?.trim() || "Other",
        display_order: nextOrder,
        active: true,
        owner_edited: true,
      }).select("id, name, price_cents, description, category, active").single();
      if (insErr || !created) throw new Error(insErr?.message ?? "Failed to add item");
      beforeSnapshot = { type: "item_add", item_id: created.id };
      logEdit({ table_name: "menu_items", row_id: created.id as string, before: null, after: created });
      afterSnapshot = { type: "item_add", item_id: created.id, after: created };
      resultMsg = `Added "${created.name}" — $${((created.price_cents as number) / 100).toFixed(2)} to ${created.category}.`;
      break;
    }
    case "REMOVE_ITEM": {
      const itemId = proposal.item_id!;
      const item = menuMap.get(itemId);
      const { data: curItem } = await supabase
        .from("menu_items").select("id, name, price_cents, description, category, active")
        .eq("id", itemId).single();
      const before = curItem ?? item ?? null;
      beforeSnapshot = { type: "item_remove", item_id: itemId, before };
      await supabase.from("menu_items").update({ active: false, owner_edited: true }).eq("id", itemId);
      logEdit({ table_name: "menu_items", row_id: itemId, before, after: { active: false } });
      afterSnapshot = { type: "item_remove", item_id: itemId, after: { active: false } };
      resultMsg = `Removed "${item?.name ?? curItem?.name ?? "item"}" from the menu.`;
      break;
    }
    case "SET_STORE_HOURS": {
      const { data: curShop } = await supabase.from("shops").select("open_hours").eq("id", shopId).single();
      beforeSnapshot = { type: "store_hours", open_hours_before: curShop?.open_hours ?? null };
      await supabase.from("shops").update({ open_hours: proposal.open_hours }).eq("id", shopId);
      logEdit({ table_name: "shops", row_id: shopId, before: { open_hours: curShop?.open_hours ?? null }, after: { open_hours: proposal.open_hours } });
      const { data: fresh } = await supabase.from("shops").select("open_hours").eq("id", shopId).single();
      afterSnapshot = { type: "store_hours", open_hours_after: fresh?.open_hours ?? null };
      resultMsg = `Store hours updated — ${summarizeHours(fresh?.open_hours)}.`;
      break;
    }
    case "SET_DELIVERY_HOURS": {
      const { data: curShop } = await supabase.from("shops").select("delivery_hours").eq("id", shopId).single();
      beforeSnapshot = { type: "delivery_hours", delivery_hours_before: curShop?.delivery_hours ?? null };
      await supabase.from("shops").update({ delivery_hours: proposal.delivery_hours }).eq("id", shopId);
      logEdit({ table_name: "shops", row_id: shopId, before: { delivery_hours: curShop?.delivery_hours ?? null }, after: { delivery_hours: proposal.delivery_hours } });
      const { data: fresh } = await supabase.from("shops").select("delivery_hours").eq("id", shopId).single();
      afterSnapshot = { type: "delivery_hours", delivery_hours_after: fresh?.delivery_hours ?? null };
      resultMsg = `Delivery hours updated — ${summarizeHours(fresh?.delivery_hours)}.`;
      break;
    }
    case "SET_DELIVERY_ENABLED": {
      const { data: curShop } = await supabase.from("shops").select("delivery_enabled").eq("id", shopId).single();
      beforeSnapshot = { type: "delivery_enabled_permanent", delivery_enabled_before: curShop?.delivery_enabled ?? null };
      await supabase.from("shops").update({ delivery_enabled: proposal.delivery_enabled }).eq("id", shopId);
      logEdit({ table_name: "shops", row_id: shopId, before: { delivery_enabled: curShop?.delivery_enabled ?? null }, after: { delivery_enabled: proposal.delivery_enabled } });
      afterSnapshot = { type: "delivery_enabled_permanent", delivery_enabled_after: proposal.delivery_enabled };
      resultMsg = proposal.delivery_enabled
        ? "Delivery is now enabled for this shop."
        : "Delivery is now turned off for this shop — the bot will refuse delivery orders.";
      break;
    }
    case "SET_SHOP_INSTRUCTIONS": {
      const { data: curShop } = await supabase.from("shops").select("ai_instructions").eq("id", shopId).single();
      beforeSnapshot = { type: "shop_instructions", ai_instructions_before: curShop?.ai_instructions ?? null };
      await supabase.from("shops").update({ ai_instructions: proposal.ai_instructions }).eq("id", shopId);
      logEdit({ table_name: "shops", row_id: shopId, before: { ai_instructions: curShop?.ai_instructions ?? null }, after: { ai_instructions: proposal.ai_instructions } });
      afterSnapshot = { type: "shop_instructions", ai_instructions_after: proposal.ai_instructions };
      resultMsg = "Shop instructions updated.";
      break;
    }
    case "SET_WING_POLICY": {
      const { data: curShop } = await supabase.from("shops").select("wing_flavors_included, wing_mix_extra").eq("id", shopId).single();
      beforeSnapshot = { type: "wing_policy", before: curShop ?? null };
      const update: Record<string, unknown> = {};
      if (proposal.wing_flavors_included !== undefined) update.wing_flavors_included = proposal.wing_flavors_included;
      if (proposal.wing_mix_extra !== undefined) update.wing_mix_extra = proposal.wing_mix_extra;
      await supabase.from("shops").update(update).eq("id", shopId);
      logEdit({ table_name: "shops", row_id: shopId, before: curShop ?? null, after: update });
      const { data: fresh } = await supabase.from("shops").select("wing_flavors_included, wing_mix_extra").eq("id", shopId).single();
      afterSnapshot = { type: "wing_policy", after: fresh ?? null };
      resultMsg = `Wing policy: ${fresh?.wing_flavors_included ?? "not set"} flavor(s) included${fresh?.wing_mix_extra ? ", mixing flavors costs extra" : fresh?.wing_mix_extra === false ? ", mixing flavors is included" : ""}.`;
      break;
    }
    case "SET_TICKET_DESTINATION": {
      const newEmail = (proposal.new_email ?? "").trim();
      const { data: curShop } = await supabase
        .from("shops").select("email_ticket_recipient").eq("id", shopId).single();
      const prevEmail = (curShop?.email_ticket_recipient ?? null) as string | null;
      beforeSnapshot = { type: "ticket_destination", email_ticket_recipient_before: prevEmail };
      // A dedicated mailbox is what they actually want — mirror the onboarding answer.
      await supabase.from("shops").update({
        email_ticket_recipient: newEmail,
        ticket_destination_type: "mailbox",
        ticket_destination_detail: newEmail,
      }).eq("id", shopId);
      resultMsg = `Done — order tickets will now go to ${newEmail}. Your Expo Screen still shows every order.`;
      afterSnapshot = { type: "ticket_destination", email_ticket_recipient_after: newEmail };
      break;
    }
    case "QUERY_STATUS": {
      resultMsg = proposal.summary;
      break;
    }
    case "UNKNOWN_OR_OUT_OF_SCOPE": {
      resultMsg = proposal.summary;
      break;
    }
    default:
      resultMsg = "Unknown action.";
  }

  // Log to admin_action_log
  const undoToken = crypto.randomUUID();
  await supabase.from("admin_action_log").insert({
    shop_id: shopId,
    user_id: userId,
    raw_message: rawMessage,
    parsed_intent: proposal,
    action_taken: resultMsg,
    before_snapshot: beforeSnapshot,
    after_snapshot: afterSnapshot,
    undo_token: undoToken,
  });

  // Build status header
  const fresh86 = await get86List(supabase, shopId, businessDate);
  const freshSpecials = await getActiveSpecials(supabase, shopId, businessDate);
  const { data: freshShop } = await supabase.from("shops").select("delivery_enabled, delivery_paused_until").eq("id", shopId).single();
  const deliveryOn = !!(freshShop?.delivery_enabled) && !freshShop?.delivery_paused_until;

  return {
    type: "executed",
    action_id: actionId,
    result: resultMsg,
    intent: proposal.intent,
    undo_token: undoToken,
    status_header: {
      delivery_enabled: deliveryOn,
      items_86d_today: fresh86.length,
      active_specials_count: freshSpecials.length,
      items_86d_names: fresh86.map(e => e.item.name),
      active_specials_names: freshSpecials.map(s => s.name),
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// ─── Observability: turn transcript logging ────────────────────────────────────
// Fire-and-forget — never blocks the response, never throws.
function logTranscript(
  supabase: ReturnType<typeof createClient>,
  requestStart: number,
  params: {
    shop_id?: string;
    user_id?: string;
    session_id?: string;
    turn_type: string;
    raw_message?: string;
    message_history?: unknown;
    llm_raw_response?: unknown;
    parsed_intent?: string;
    parsed_proposal?: unknown;
    outcome: string;
    response_sent: unknown;
    error_message?: string;
  },
) {
  const row: Record<string, unknown> = {
    shop_id: params.shop_id ?? null,
    user_id: params.user_id ?? null,
    session_id: params.session_id ?? null,
    turn_type: params.turn_type,
    raw_message: params.raw_message ?? null,
    message_history: params.message_history ?? null,
    llm_raw_response: params.llm_raw_response ?? null,
    parsed_intent: params.parsed_intent ?? null,
    parsed_proposal: params.parsed_proposal ?? null,
    outcome: params.outcome,
    response_sent: params.response_sent,
    error_message: params.error_message ?? null,
    latency_ms: Date.now() - requestStart,
  };
  // Fire and forget — don't await, don't let failures break the chat
  supabase.from("admin_chat_transcripts").insert(row).then(
    () => {},
    (err: unknown) => console.error("[admin-chat] transcript insert error:", err),
  );
}

// ─── Main Handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const requestStart = Date.now();

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/admin-chat/, "").replace(/^\/admin-chat/, "");

  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return jsonResponse({ status: "ok", service: "admin-chat" });
  }

  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  // Auth
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);
  const token = authHeader.replace("Bearer ", "");

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  // Service-role client — bypasses RLS, used for auth validation, logging, and super_admin ops.
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  // User-JWT client — honors RLS, used for shop_owner data access (step 3: owner path avoids service-role).
  const supabaseRls = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!userRes.ok) {
    logTranscript(supabase, requestStart, {
      turn_type: "message", outcome: "error",
      response_sent: { error: "Invalid auth token" },
      error_message: "Auth token validation failed",
    });
    return jsonResponse({ error: "Invalid auth token" }, 401);
  }
  const { id: userId, user_metadata, app_metadata } = await userRes.json() as {
    id: string;
    user_metadata?: { tenant_id?: string; is_admin?: boolean };
    app_metadata?: { tenant_id?: string; role?: string };
  };
  // Read role from app_metadata first (server-controlled), user_metadata fallback for transition
  const appRole = app_metadata?.role;
  const isAdmin = appRole === 'super_admin'
    || (!appRole && user_metadata?.is_admin === true);
  // tenant_id: app_metadata first, user_metadata fallback. super_admin may not have tenant.
  const tenantId = app_metadata?.tenant_id || user_metadata?.tenant_id || null;
  if (!tenantId && !isAdmin) {
    logTranscript(supabase, requestStart, {
      turn_type: "message", outcome: "error", user_id: userId,
      response_sent: { error: "No tenant_id in app_metadata and not admin" },
      error_message: "Missing tenant_id and not admin",
    });
    return jsonResponse({ error: "No tenant_id in app_metadata and not admin" }, 403);
  }

  // db: shop_owners go through RLS (supabaseRls using user JWT).
  // super_admins keep service-role client (bypasses RLS, full access).
  const db = isAdmin ? supabase : supabaseRls;

  // Parse request
  let body: {
    message?: string; message_history?: { role: string; content: string }[]; shop_id?: string;
    confirmed_action_id?: string;
    // Menu & Settings editor form path — an array of ops built directly from clicks/edits,
    // bypassing the LLM entirely. See the FORM FLOW branch below.
    form_ops?: Array<Partial<Proposal> & { intent: string }>;
  };
  try { body = await req.json(); } catch {
    logTranscript(supabase, requestStart, {
      turn_type: "message", outcome: "error", user_id: userId,
      response_sent: { error: "Invalid JSON" },
      error_message: "Failed to parse request body as JSON",
    });
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const { message, message_history = [], shop_id, confirmed_action_id, form_ops } = body;

  const requestSessionId = crypto.randomUUID();

  if (!shop_id) {
    logTranscript(supabase, requestStart, {
      turn_type: "message", outcome: "error", user_id: userId,
      session_id: requestSessionId, raw_message: message,
      response_sent: { error: "shop_id is required" },
      error_message: "Missing shop_id",
    });
    return jsonResponse({ error: "shop_id is required" }, 400);
  }

  // Load shop (through RLS when shop_owner)
  const { data: shopData } = await db.from("shops").select("*").eq("id", shop_id).single();
  if (!shopData) {
    logTranscript(supabase, requestStart, {
      shop_id, user_id: userId, session_id: requestSessionId,
      turn_type: "message", outcome: "error", raw_message: message,
      response_sent: { error: "Shop not found" },
      error_message: `Shop ${shop_id} not found`,
    });
    return jsonResponse({ error: "Shop not found" }, 404);
  }
  const shop = shopData as unknown as Shop;
  if (shop.tenant_id !== tenantId && !isAdmin) {
    logTranscript(supabase, requestStart, {
      shop_id, user_id: userId, session_id: requestSessionId,
      turn_type: "message", outcome: "error", raw_message: message,
      response_sent: { error: "Forbidden: shop does not belong to your tenant" },
      error_message: "Tenant mismatch",
    });
    return jsonResponse({ error: "Forbidden: shop does not belong to your tenant" }, 403);
  }

  const businessDate = getBusinessDate(shop.timezone ?? "America/New_York");

  // ─── FORM FLOW: the structured Menu & Settings editor builds ops directly from clicks/
  // edits and sends them here, skipping the LLM entirely. This calls the exact same
  // validateProposal()/executeAction() the chat path calls below — there is exactly one
  // apply() per operation, so chat and form cannot diverge into two writers. The client
  // already showed its own plain-language diff and got an explicit Save before this fires.
  if (Array.isArray(form_ops) && form_ops.length > 0) {
    const { data: menuData } = await db
      .from("menus").select("id").eq("shop_id", shop_id)
      .or(`effective_until.is.null,effective_until.gte.${new Date().toISOString()}`)
      .order("created_at", { ascending: false }).limit(1).single();

    let menuItems: MenuItem[] = [];
    if (menuData) {
      const { data: items } = await db
        .from("menu_items")
        .select("id, name, price_cents, description, category, active, prompt_for, flag_review, flag_reason")
        .eq("menu_id", menuData.id)
        .order("display_order", { ascending: true });
      menuItems = items ?? [];
    }
    const eightySixList = await get86List(db, shop_id, businessDate);
    const specials = await getActiveSpecials(db, shop_id, businessDate);

    const results: Array<{ ok: boolean; intent: string; result?: string; error?: string }> = [];
    for (const raw of form_ops) {
      const proposal: Proposal = { needs_clarification: false, summary: "", ...raw, intent: raw.intent };

      const validation = await validateProposal(proposal, shop_id, businessDate, supabase, menuItems, specials, eightySixList);
      if (!validation.valid) {
        results.push({ ok: false, intent: proposal.intent, error: validation.error ?? "Invalid operation" });
        continue;
      }
      if (validation.clarification) {
        results.push({ ok: false, intent: proposal.intent, error: validation.clarification.summary });
        continue;
      }
      try {
        const actionId = crypto.randomUUID();
        const executed = await executeAction(
          proposal, actionId, shop_id, userId, `[form: ${proposal.intent}]`,
          businessDate, shop.timezone, db, menuItems, eightySixList, specials,
          shop.tenant_id, supabase, "form",
        );
        results.push({ ok: true, intent: proposal.intent, result: executed.result });
      } catch (err) {
        // Honest failure beats a false confirmation — never claim a write succeeded that didn't.
        results.push({ ok: false, intent: proposal.intent, error: err instanceof Error ? err.message : "Write failed" });
      }
    }

    const responseBody = { type: "form_batch_result", results, all_ok: results.every(r => r.ok) };
    logTranscript(supabase, requestStart, {
      shop_id, user_id: userId, session_id: requestSessionId,
      turn_type: "form_ops", outcome: responseBody.all_ok ? "executed" : "partial_error",
      raw_message: JSON.stringify(form_ops).slice(0, 2000),
      response_sent: responseBody,
    });
    return jsonResponse(responseBody);
  }

  // ─── CONFIRMATION FLOW: if confirmed_action_id is present, execute ────────────
  if (confirmed_action_id && message) {
    // Re-parse the confirming message — it should be a JSON proposal + action_id
    let proposal: Proposal;
    try {
      proposal = JSON.parse(message);
    } catch {
      logTranscript(supabase, requestStart, {
        shop_id, user_id: userId, session_id: requestSessionId,
        turn_type: "confirmation", outcome: "error", raw_message: message,
        response_sent: { error: "Invalid confirmation payload" },
        error_message: "Failed to parse confirmation payload as JSON",
      });
      return jsonResponse({ error: "Invalid confirmation payload" }, 400);
    }

    // Load current state (through RLS when shop_owner)
    const { data: menuData } = await db
      .from("menus").select("id").eq("shop_id", shop_id)
      .or(`effective_until.is.null,effective_until.gte.${new Date().toISOString()}`)
      .order("created_at", { ascending: false }).limit(1).single();

    let menuItems: MenuItem[] = [];
    if (menuData) {
      const { data: items } = await db
        .from("menu_items")
        .select("id, name, price_cents, description, category, active, prompt_for, flag_review, flag_reason")
        .eq("menu_id", menuData.id)
        .order("display_order", { ascending: true });
      menuItems = items ?? [];
    }

    const eightySixList = await get86List(db, shop_id, businessDate);
    const specials = await getActiveSpecials(db, shop_id, businessDate);

    const executed = await executeAction(
      proposal, confirmed_action_id, shop_id, userId, `[confirmed: ${confirmed_action_id}]`,
      businessDate, shop.timezone, db, menuItems, eightySixList, specials,
      shop.tenant_id, supabase, "chat",
    );
    logTranscript(supabase, requestStart, {
      shop_id, user_id: userId, session_id: requestSessionId,
      turn_type: "confirmation", outcome: "executed",
      raw_message: message, parsed_intent: proposal.intent,
      parsed_proposal: proposal, response_sent: executed,
    });
    return jsonResponse(executed);
  }

  // ─── NORMAL FLOW: parse message, return proposal ──────────────────────────────
  if (!message?.trim()) {
    logTranscript(supabase, requestStart, {
      shop_id, user_id: userId, session_id: requestSessionId,
      turn_type: "message", outcome: "error",
      response_sent: { error: "message is required" },
      error_message: "Empty message",
    });
    return jsonResponse({ error: "message is required" }, 400);
  }

  // Load current menu (through RLS when shop_owner)
  const { data: menuData } = await db
    .from("menus").select("id").eq("shop_id", shop_id)
    .or(`effective_until.is.null,effective_until.gte.${new Date().toISOString()}`)
    .order("created_at", { ascending: false }).limit(1).single();

  let menuItems: MenuItem[] = [];
  if (menuData) {
    const { data: items } = await db
      .from("menu_items")
      .select("id, name, price_cents, description, category, active, prompt_for, flag_review, flag_reason")
      .eq("menu_id", menuData.id)
      .order("display_order", { ascending: true });
    menuItems = items ?? [];
  }

  const eightySixList = await get86List(db, shop_id, businessDate);
  const specials = await getActiveSpecials(db, shop_id, businessDate);
  const optionGroupsByItem = await getOptionGroupsForItems(db, menuItems.map(m => m.id));

  const currentTime = new Date().toLocaleString("en-US", { timeZone: shop.timezone ?? "America/New_York" });
  const systemPrompt = buildSystemPrompt(shop, menuItems, specials, eightySixList.map(e => e.item), currentTime, optionGroupsByItem);

  // Anthropic API
  const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
  if (!apiKey) {
    logTranscript(supabase, requestStart, {
      shop_id, user_id: userId, session_id: requestSessionId,
      turn_type: "message", outcome: "api_error", raw_message: message,
      message_history: message_history,
      response_sent: { error: "OPENROUTER_API_KEY not configured" },
      error_message: "Missing OPENROUTER_API_KEY env var",
    });
    return jsonResponse({ error: "OPENROUTER_API_KEY not configured" }, 500);
  }

  const messages: Array<{ role: string; content: string }> = [
    ...message_history,
    { role: "user", content: message },
  ];

  let proposal: Proposal | null = null;
  let clarificationReply = "";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(CHAT_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://getsprintai.com",
        "X-Title": "SprintAI Admin",
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages,
        tools: ADMIN_TOOLS,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[admin-chat] API error:", res.status, errText);
      logTranscript(supabase, requestStart, {
        shop_id, user_id: userId, session_id: requestSessionId,
        turn_type: "message", outcome: "api_error", raw_message: message,
        message_history: message_history,
        response_sent: { reply: "Sorry, I had trouble connecting. Try again in a moment." },
        error_message: `OpenRouter API returned ${res.status}: ${errText.slice(0, 500)}`,
      });
      return jsonResponse({ reply: "Sorry, I had trouble connecting. Try again in a moment." });
    }

    const data = await res.json();
    const content = data.content ?? [];
    const toolBlocks = content.filter((b: { type: string }) => b.type === "tool_use");
    const textBlocks = content.filter((b: { type: string }) => b.type === "text");
    const assistantText = textBlocks.map((b: { text?: string }) => b.text ?? "").join("").trim();

    if (toolBlocks.length === 0) {
      // No tool call — might be a text reply. Try to use it as clarification.
      logTranscript(supabase, requestStart, {
        shop_id, user_id: userId, session_id: requestSessionId,
        turn_type: "message", outcome: "no_tool_call", raw_message: message,
        message_history: message_history, llm_raw_response: data,
        response_sent: { reply: assistantText || "I didn't understand that. Can you rephrase?" },
      });
      return jsonResponse({ reply: assistantText || "I didn't understand that. Can you rephrase?" });
    }

    // Extract the first tool call as the proposal
    const tool = toolBlocks[0];
    const input = (tool.input ?? {}) as Record<string, unknown>;
    const intent = tool.name as string;

    if (intent === "UNKNOWN_OR_OUT_OF_SCOPE") {
      const suggestion = (input.suggestion as string) ?? "I can only handle same-day operational changes like 86'ing items, adding specials, or pausing delivery.";
      logTranscript(supabase, requestStart, {
        shop_id, user_id: userId, session_id: requestSessionId,
        turn_type: "message", outcome: "out_of_scope", raw_message: message,
        message_history: message_history, llm_raw_response: data,
        parsed_intent: intent, parsed_proposal: input,
        response_sent: { reply: suggestion },
      });
      return jsonResponse({ reply: suggestion });
    }

    proposal = {
      intent,
      items: input.items as string[] | undefined,
      item_ids: input.item_ids as string[] | undefined,
      category: (input.category as string) ?? null,
      category_items: input.category_items as string[] | undefined,
      duration: input.duration as string | undefined,
      duration_minutes: input.duration_minutes as number | null | undefined,
      special_name: input.special_name as string | undefined,
      special_price_cents: input.special_price_cents as number | undefined,
      special_description: input.special_description as string | undefined,
      linked_item_id: (input.linked_item_id as string) ?? null,
      special_id: input.special_id as string | undefined,
      reason: input.reason as string | undefined,
      new_email: input.new_email as string | undefined,
      needs_clarification: (input.needs_clarification as boolean) ?? false,
      clarification_question: input.clarification_question as string | null | undefined,
      clarification_options: (input.clarification_options ?? input.options) as string[] | undefined,
      summary: (input.summary as string) ?? assistantText,
      item_id: input.item_id as string | undefined,
      item_name: input.item_name as string | undefined,
      upsert_groups: input.upsert_groups as OptionGroupInput[] | undefined,
      delete_group_ids: input.delete_group_ids as string[] | undefined,
      item_fields: input.item_fields as Proposal["item_fields"] | undefined,
      new_item: input.new_item as Proposal["new_item"] | undefined,
      open_hours: input.open_hours as Record<string, DayHours> | undefined,
      delivery_hours: input.delivery_hours as Record<string, DayHours> | undefined,
      delivery_enabled: input.delivery_enabled as boolean | undefined,
      ai_instructions: input.ai_instructions as string | undefined,
      wing_flavors_included: (input.wing_flavors_included as number | null) ?? undefined,
      wing_mix_extra: (input.wing_mix_extra as boolean | null) ?? undefined,
    };

    // For QUERY_STATUS, just return the reply directly
    if (intent === "QUERY_STATUS") {
      const fresh86 = await get86List(db, shop_id, businessDate);
      const freshSpecials = await getActiveSpecials(db, shop_id, businessDate);
      const deliveryOn = !!(shop.delivery_enabled) && !shop.delivery_paused_until;
      const statusHeader: StatusHeader = {
        delivery_enabled: deliveryOn,
        items_86d_today: fresh86.length,
        active_specials_count: freshSpecials.length,
        items_86d_names: fresh86.map(e => e.item.name),
        active_specials_names: freshSpecials.map(s => s.name),
      };
      const responseBody = { reply: proposal.summary, status_header: statusHeader };
      logTranscript(supabase, requestStart, {
        shop_id, user_id: userId, session_id: requestSessionId,
        turn_type: "message", outcome: "query_status", raw_message: message,
        message_history: message_history, llm_raw_response: data,
        parsed_intent: intent, parsed_proposal: proposal,
        response_sent: responseBody,
      });
      return jsonResponse(responseBody);
    }

    // For UNDO, execute immediately (no confirmation needed)
    if (intent === "UNDO") {
      const actionId = crypto.randomUUID();
      const executed = await executeAction(
        proposal, actionId, shop_id, userId, message,
        businessDate, shop.timezone, db, menuItems, eightySixList, specials,
        shop.tenant_id, supabase, "chat",
      );
      logTranscript(supabase, requestStart, {
        shop_id, user_id: userId, session_id: requestSessionId,
        turn_type: "undo", outcome: "executed", raw_message: message,
        message_history: message_history, llm_raw_response: data,
        parsed_intent: intent, parsed_proposal: proposal,
        response_sent: executed,
      });
      return jsonResponse(executed);
    }

    // Validate the proposal
    const validation = await validateProposal(
      proposal, shop_id, businessDate, supabase, menuItems, specials, eightySixList,
    );

    if (!validation.valid) {
      logTranscript(supabase, requestStart, {
        shop_id, user_id: userId, session_id: requestSessionId,
        turn_type: "message", outcome: "validation_error", raw_message: message,
        message_history: message_history, llm_raw_response: data,
        parsed_intent: intent, parsed_proposal: proposal,
        response_sent: { reply: validation.error ?? "Invalid proposal", needs_correction: true },
        error_message: validation.error ?? "Invalid proposal",
      });
      return jsonResponse({ reply: validation.error ?? "Invalid proposal", needs_correction: true });
    }

    if (validation.clarification) {
      logTranscript(supabase, requestStart, {
        shop_id, user_id: userId, session_id: requestSessionId,
        turn_type: "message", outcome: "clarification", raw_message: message,
        message_history: message_history, llm_raw_response: data,
        parsed_intent: intent, parsed_proposal: proposal,
        response_sent: validation.clarification,
      });
      return jsonResponse(validation.clarification);
    }

    // Return confirmation card
    const actionId = crypto.randomUUID();
    const confirmationResponse = {
      type: "confirmation_card",
      action_id: actionId,
      intent: proposal.intent,
      summary: proposal.summary,
      details: proposal,
      cancel_label: "Cancel",
      confirm_label: "Confirm",
    };
    logTranscript(supabase, requestStart, {
      shop_id, user_id: userId, session_id: requestSessionId,
      turn_type: "message", outcome: "confirmation_card", raw_message: message,
      message_history: message_history, llm_raw_response: data,
      parsed_intent: intent, parsed_proposal: proposal,
      response_sent: confirmationResponse,
    });
    return jsonResponse(confirmationResponse);
  }

  // Retries exhausted
  logTranscript(supabase, requestStart, {
    shop_id, user_id: userId, session_id: requestSessionId,
    turn_type: "message", outcome: "error", raw_message: message,
    message_history: message_history,
    response_sent: { reply: "I couldn't process that. Can you try again?" },
    error_message: "All LLM retry attempts exhausted",
  });
  return jsonResponse({ reply: "I couldn't process that. Can you try again?" });
});