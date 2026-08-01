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
}

interface MenuItem {
  id: string; name: string; price_cents: number; description: string | null;
  category: string; active: boolean;
}

interface Special {
  id: string; name: string; price_cents: number; description: string | null;
  linked_item_id: string | null; active_date: string;
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
  needs_clarification: boolean;
  clarification_question?: string | null;
  clarification_options?: string[];
  summary: string;
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
): string {
  const menuStr = Object.entries(groupBy(menu, m => m.category))
    .map(([cat, items]) => {
      const rows = items.map(i => `  ${i.id}: ${i.name} — $${(i.price_cents / 100).toFixed(2)}${!i.active ? " [INACTIVE]" : ""}`);
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

  return `You are the store-management assistant for ${shop.name}. The owner texts you plain-language commands to manage same-day operational toggles. You NEVER execute changes directly — you return a structured PROPOSAL that the backend validates and shows as a confirmation card.

CURRENT TIME: ${currentTime}
BUSINESS DATE: ${businessDate}
SHOP: ${shop.name}
${deliveryStatus}

LIVE MENU (${menu.length} items):
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
9. Anything outside these 9 intents → UNKNOWN_OR_OUT_OF_SCOPE with a friendly redirect.
10. "summary" MUST be in plain English describing what the owner sees on the confirmation card. Examples:
    - "Mark Lox Bagel sold out until close tonight"
    - "Add 'Friday Lobster Roll' special at $18.00 for today"
    - "Pause delivery for 1 hour — pickup still open"
    - "End the Lox Special"`;
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
): Promise<ExecutedAction> {
  const menuMap = new Map(menu.map(m => [m.id, m]));
  const eightySixMap = new Map(eightySixList.map(e => [e.item.id, e]));
  let resultMsg = "";
  let beforeSnapshot: Record<string, unknown> = {};
  let afterSnapshot: Record<string, unknown> = {};

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
      }

      // Mark the undone action
      await supabase.from("admin_action_log").update({ undone: true }).eq("id", lastAction.id);

      resultMsg = `Undone — reversed "${lastAction.action_taken?.slice(0, 80) ?? 'previous action'}".`;

      beforeSnapshot = { undo_source: lastAction.id, undo_type: snapType, undo_before_snapshot: lastAction.before_snapshot };
      afterSnapshot = { undo_source: lastAction.id, undo_type: snapType, undo_applied: true };
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

// ─── Main Handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
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
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
  });
  if (!userRes.ok) return jsonResponse({ error: "Invalid auth token" }, 401);
  const { id: userId, user_metadata } = await userRes.json() as {
    id: string; user_metadata: { tenant_id?: string; is_admin?: boolean };
  };
  const tenantId = user_metadata?.tenant_id;
  if (!tenantId) return jsonResponse({ error: "No tenant_id in user_metadata" }, 403);

  // Parse request
  let body: { message?: string; message_history?: { role: string; content: string }[]; shop_id?: string; confirmed_action_id?: string };
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
  const { message, message_history = [], shop_id, confirmed_action_id } = body;

  if (!shop_id) return jsonResponse({ error: "shop_id is required" }, 400);

  // Load shop
  const { data: shopData } = await supabase.from("shops").select("*").eq("id", shop_id).single();
  if (!shopData) return jsonResponse({ error: "Shop not found" }, 404);
  const shop = shopData as unknown as Shop;
  if (shop.tenant_id !== tenantId && !user_metadata?.is_admin) {
    return jsonResponse({ error: "Forbidden: shop does not belong to your tenant" }, 403);
  }

  const businessDate = getBusinessDate(shop.timezone ?? "America/New_York");

  // ─── CONFIRMATION FLOW: if confirmed_action_id is present, execute ────────────
  if (confirmed_action_id && message) {
    // Re-parse the confirming message — it should be a JSON proposal + action_id
    let proposal: Proposal;
    try {
      proposal = JSON.parse(message);
    } catch {
      return jsonResponse({ error: "Invalid confirmation payload" }, 400);
    }

    // Load current state
    const { data: menuData } = await supabase
      .from("menus").select("id").eq("shop_id", shop_id)
      .or(`effective_until.is.null,effective_until.gte.${new Date().toISOString()}`)
      .order("created_at", { ascending: false }).limit(1).single();

    let menuItems: MenuItem[] = [];
    if (menuData) {
      const { data: items } = await supabase
        .from("menu_items")
        .select("id, name, price_cents, description, category, active")
        .eq("menu_id", menuData.id)
        .order("display_order", { ascending: true });
      menuItems = items ?? [];
    }

    const eightySixList = await get86List(supabase, shop_id, businessDate);
    const specials = await getActiveSpecials(supabase, shop_id, businessDate);

    const executed = await executeAction(
      proposal, confirmed_action_id, shop_id, userId, `[confirmed: ${confirmed_action_id}]`,
      businessDate, shop.timezone, supabase, menuItems, eightySixList, specials,
    );
    return jsonResponse(executed);
  }

  // ─── NORMAL FLOW: parse message, return proposal ──────────────────────────────
  if (!message?.trim()) return jsonResponse({ error: "message is required" }, 400);

  // Load current menu
  const { data: menuData } = await supabase
    .from("menus").select("id").eq("shop_id", shop_id)
    .or(`effective_until.is.null,effective_until.gte.${new Date().toISOString()}`)
    .order("created_at", { ascending: false }).limit(1).single();

  let menuItems: MenuItem[] = [];
  if (menuData) {
    const { data: items } = await supabase
      .from("menu_items")
      .select("id, name, price_cents, description, category, active")
      .eq("menu_id", menuData.id)
      .order("display_order", { ascending: true });
    menuItems = items ?? [];
  }

  const eightySixList = await get86List(supabase, shop_id, businessDate);
  const specials = await getActiveSpecials(supabase, shop_id, businessDate);

  const currentTime = new Date().toLocaleString("en-US", { timeZone: shop.timezone ?? "America/New_York" });
  const systemPrompt = buildSystemPrompt(shop, menuItems, specials, eightySixList.map(e => e.item), currentTime);

  // Anthropic API
  const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
  if (!apiKey) return jsonResponse({ error: "OPENROUTER_API_KEY not configured" }, 500);

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
      return jsonResponse({ reply: "Sorry, I had trouble connecting. Try again in a moment." });
    }

    const data = await res.json();
    const content = data.content ?? [];
    const toolBlocks = content.filter((b: { type: string }) => b.type === "tool_use");
    const textBlocks = content.filter((b: { type: string }) => b.type === "text");
    const assistantText = textBlocks.map((b: { text?: string }) => b.text ?? "").join("").trim();

    if (toolBlocks.length === 0) {
      // No tool call — might be a text reply. Try to use it as clarification.
      return jsonResponse({ reply: assistantText || "I didn't understand that. Can you rephrase?" });
    }

    // Extract the first tool call as the proposal
    const tool = toolBlocks[0];
    const input = (tool.input ?? {}) as Record<string, unknown>;
    const intent = tool.name as string;

    if (intent === "UNKNOWN_OR_OUT_OF_SCOPE") {
      return jsonResponse({ reply: (input.suggestion as string) ?? "I can only handle same-day operational changes like 86'ing items, adding specials, or pausing delivery." });
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
      needs_clarification: (input.needs_clarification as boolean) ?? false,
      clarification_question: input.clarification_question as string | null | undefined,
      clarification_options: (input.clarification_options ?? input.options) as string[] | undefined,
      summary: (input.summary as string) ?? assistantText,
    };

    // For QUERY_STATUS, just return the reply directly
    if (intent === "QUERY_STATUS") {
      const fresh86 = await get86List(supabase, shop_id, businessDate);
      const freshSpecials = await getActiveSpecials(supabase, shop_id, businessDate);
      const deliveryOn = !!(shop.delivery_enabled) && !shop.delivery_paused_until;
      const statusHeader: StatusHeader = {
        delivery_enabled: deliveryOn,
        items_86d_today: fresh86.length,
        active_specials_count: freshSpecials.length,
        items_86d_names: fresh86.map(e => e.item.name),
        active_specials_names: freshSpecials.map(s => s.name),
      };
      return jsonResponse({
        reply: proposal.summary,
        status_header: statusHeader,
      });
    }

    // For UNDO, execute immediately (no confirmation needed)
    if (intent === "UNDO") {
      const actionId = crypto.randomUUID();
      const executed = await executeAction(
        proposal, actionId, shop_id, userId, message,
        businessDate, shop.timezone, supabase, menuItems, eightySixList, specials,
      );
      return jsonResponse(executed);
    }

    // Validate the proposal
    const validation = await validateProposal(
      proposal, shop_id, businessDate, supabase, menuItems, specials, eightySixList,
    );

    if (!validation.valid) {
      return jsonResponse({ reply: validation.error ?? "Invalid proposal", needs_correction: true });
    }

    if (validation.clarification) {
      return jsonResponse(validation.clarification);
    }

    // Return confirmation card
    const actionId = crypto.randomUUID();
    return jsonResponse({
      type: "confirmation_card",
      action_id: actionId,
      intent: proposal.intent,
      summary: proposal.summary,
      details: proposal,
      cancel_label: "Cancel",
      confirm_label: "Confirm",
    });
  }

  return jsonResponse({ reply: "I couldn't process that. Can you try again?" });
});