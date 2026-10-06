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
import { logError } from "../_shared/error-log.ts";
import { SERVICE_FEE_CENTS } from "../_shared/connect.ts";
import { getTestModeStripeKey } from "../_shared/test-mode.ts";
import { classifyTelnyxSendError } from "../_shared/telnyx-error.ts";
import { toGsm7 } from "../_shared/gsm7.ts";
import { dayWindows } from "../_shared/hours.ts";

// A proposal-worthy event detected mechanically (detectUnitCompletionEvent),
// before the "was this actually asked for" grounding judgment is applied.
// See turn-reconciler.ts's CartUnitProposal doc — `grounded` is added later,
// once, in the outer handler.
interface RawUnitProposal {
  menu_item_id: string;
  options?: Record<string, string[]>;
  source_phrase: string;
}
import { computeDeliveryOffer, isDeliveryOfferEligible, type DeliveryOffer } from "./delivery-memory-offer.ts";
import { lookupCustomerContext, regularEligibility, upsertOrderFulfillmentMemory, type CustomerRow } from "../_shared/customer-profile.ts";
import type { AskPlan } from "../_shared/compile-menu.ts";
import { normalizeSlashShorthand } from "./slash-shorthand-normalize-20260916.ts";
import { cartTotalFragment, claimsTotal, computeCartSubtotalCents, extractDollarCents } from "./pricing.ts";
import { runEngineTurn as runCleanEngineTurn } from "./engine/runner.ts";
import type { OrderForm as EngineOrderForm } from "./engine/form.ts";
import { googleGeocoder, localityOf } from "./engine/address.ts";
import { createCheckoutSession, buildEngineCheckoutSessionInput, appendCheckoutLink, type CheckoutLineItemInput } from "./checkout-session.ts";
import { claimDeliveryNotice, deliveryForCart, NOTICE_STATUSES, type DeliveryRow } from "../_shared/delivery-store.ts";
import { T } from "./engine/templates.ts";
import { providerFor } from "../_shared/delivery-providers.ts";
import { e164OrNull, isQuoteError } from "../_shared/delivery.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const CHAT_MODEL = Deno.env.get("CHAT_MODEL") ?? "deepseek/deepseek-v4-flash";
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
// Turn-engine path's append of COMPLIANCE_DISCLOSURE (turn-engine-runner.ts
// has no visibility into isLifetimeFirstContact, computed in this file).
// Exported so the append itself — not just the constant — is regression-
// tested; the legacy path's own append near isLifetimeFirstContact below
// stays untouched and does not call this.
export function appendComplianceDisclosureIfFirstContact(reply: string, isLifetimeFirstContact: boolean): string {
  return isLifetimeFirstContact ? `${reply}\n\n${COMPLIANCE_DISCLOSURE}` : reply;
}

// ── Turn Engine checkout wiring (Phase 3c, docs/specs/2026-09-14-turn-
// engine-oversight.md §4 Phase 3) ──────────────────────────────────────────
//
// turn-engine-runner.ts's own header (see its Scope note 1) flags the exact
// gap this closes: dialogue_state.phase can walk all the way to "link_sent"
// on the engine path, but nothing on that path ever called Stripe — a cart
// that got there rendered with no payment link. This function is called
// from the turn-engine routing branch below, right after runTurnEngineTurn
// returns, and is the ONLY place on that path a checkout session gets
// created — createCheckoutSession itself (checkout-session.ts) is the one
// shared Stripe-call site, used by this function AND by the legacy
// submit_order case (executeTool, unchanged).
//
// Exported (same rationale as appendComplianceDisclosureIfFirstContact
// above) so it's unit-testable in isolation, with every dependency injected
// — no Deno.env / new Stripe(...) buried inside checkout-session.ts, so
// those two calls live here instead, at the one real call site, mirroring
// the exact three-line test/live hard-gate the legacy submit_order case has
// always had (search "HARD-GATE: test mode MUST use test Stripe" in
// executeTool) rather than duplicating that gate's logic a second time.
const COMPLIANCE_HELP = "OrderFare text ordering. Text your order to this number to order from this restaurant. Message frequency varies by order, typically 3-8 messages per order. Support: support@getsprintai.com. Msg & data rates may apply. Reply STOP to opt out.";
const COMPLIANCE_START = "Thanks for texting! You'll receive order-related messages from this restaurant. Message frequency may vary. Msg&data rates may apply. Reply HELP for help, STOP to opt out.";

// ─── Customer-facing name ask (ONE wording, both order types) ───────────────
// Jason 2026-09-05: no pickup/delivery variant. "pickup" is wrong on a delivery
// order and branching was overruled. Field stays `pickup_name` internally.
// Straight apostrophe on purpose: U+2019 is not in GSM-7 and would push every
// SMS containing it to UCS-2 (67 chars/segment instead of 153).
// NOTE: C2's askedForName detector (below) must keep matching this string.
const NAME_ASK = "What's your name for the order?";

// Returning-customer delivery memory (docs/specs/2026-09-12-returning-
// customer-delivery-memory.md, addendum). A known customer is CONFIRMED, not
// asked — "why should it ask me for my name again if it already knows my
// name?" (Jason, live-test verbatim). Second sanctioned form alongside
// NAME_ASK, never a replacement for it — an unknown customer still gets the
// plain ask unchanged. isConfirmingPickupName's detector (below) must keep
// matching this exact wording.
const nameConfirm = (name: string) => `Putting this in for ${name}, right?`;

// ─── Provider resolution ─────────────────────────────────────────────────────
function resolveSmsProvider(shop?: { sms_provider?: string | null } | null): "telnyx" | "twilio" {
  // Per-shop wins. A shop's number is provisioned on exactly ONE provider, so a
  // deployment-wide switch would send from a number the other carrier doesn't own.
  // shops.sms_provider is NOT NULL DEFAULT 'twilio', so this is set for every shop.
  const perShop = (shop?.sms_provider ?? "").trim().toLowerCase();
  if (perShop === "telnyx" || perShop === "twilio") return perShop;
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

// Single source of truth for "what modifiers/options does this cart line
// carry" — deduped list of raw strings, unescaped. Every place that renders
// a cart item to a human (kitchen ticket email, payment-confirmed SMS
// receipt, etc.) must read the modifiers/options off a line through THIS
// function rather than re-deriving its own subset, so a line can never show
// correctly in one render and drop its modifier in another (the order #5/#6
// "two identical cheese pizzas, pepperoni named on neither" defect).
function cartItemModifierParts(r: CartItem): string[] {
  const mods = r.modifiers?.length ? r.modifiers : [];
  const opts = r.options ? Object.values(r.options).flat() : [];
  return [...new Set([...mods, ...opts])];
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

export interface EffectiveMenuItem {
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
  // docs/specs/2026-09-13-checkout-insulation.md: menu_items.upsell (migration
  // 050) is populated for real shops ("Shrimp +6.00; Black Diamond Steak
  // +8.00") but was never read anywhere in this file — the model was told to
  // upsell (UPSELL RESTRAINT) with zero grounded data to reference, so it
  // either stayed silent or would have had to invent an item, which the
  // UPSELL GUARD rule explicitly forbids. Surfaced inline per item in the
  // AVAILABLE MENU block below so the model has something real to offer.
  upsell?:          string | null;
}

interface CartItem {
  menu_item_id: string;
  name:         string;
  quantity:     number;
  price_cents:  number;
  modifiers:    string[];
  options?:     Record<string, string[]>;
  pending_options?: string[];  // option group names not yet chosen (required groups with no selection)
  // C1 fix (2026-09-12, docs/DEFECT-CLASSES.md): name->id snapshot of this
  // item's option groups, taken every time add_item/modify_item touches
  // them. `options`/`pending_options` above are still keyed by group NAME
  // (every other guard/matcher/render path in this file depends on that),
  // but a name is not stable across an owner rename — this snapshot lets
  // resolveOptionGroupByStoredKey recover a renamed group by the id it had
  // when the name was recorded, instead of silently losing the selection
  // (or the still-open required question) the instant the name diverges.
  option_group_ids?: Record<string, string>;
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
  // shop flag is set — see ask-plan-engine.ts). Value is an array ONLY when
  // a modifier group's option group allows more than one selection and more
  // than one was resolved (P0 fix 2026-09-10, see ask-plan-engine.ts's
  // CompiledCartLine.ask_plan_selections doc) — a bare string otherwise.
  ask_plan_selections?: Record<string, string | string[]>;
  // See ask-plan-engine.ts's CompiledCartLine.sourcePhraseIndex doc — same
  // field, mirrored here since index.ts's real cart uses this interface.
  sourcePhraseIndex?: number;
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
  sms_provider:            string | null;
  reply_from_e164:         string | null;
  open_hours:              Record<string, { closed?: boolean; open?: string; close?: string } | Array<{ open: string; close: string }>>;
  // Delivery-specific hours (migration 060/061), same shape as open_hours.
  // Empty/unset ({}) means "no narrower delivery window configured" — treat
  // delivery as available whenever open_hours says so, unchanged from before
  // this column existed. Only a non-empty value narrows delivery further.
  delivery_hours?:         Record<string, { closed?: boolean; open?: string; close?: string } | Array<{ open: string; close: string }>>;
  timezone:                string;
  email_ticket_recipient:  string | null;
  is_paused:               boolean;
  pause_message:           string | null;
  paused_until?:           string | null;
  delivery_enabled:         boolean;
  delivery_paused_until:    string | null;
  delivery_pause_reason:    string | null;
  delivery_fee_cents:       number | null;
  shop_context:            string | null;
  ai_instructions:         string | null;
  latitude:                 number | null;
  longitude:                number | null;
  delivery_radius_mi:       number | null;
  // Item 8 (spec §7/§11 item 8). Default false in the DB (migration 118).
  // Vito's was flipped to true on 2026-09-11 (commit a1b89793 root-caused the
  // P0 money defect — disambiguation resolution was never enabling the compiled
  // engine). All three real shops (Not Just Bagels, Vito's Pizza, Zio's Pizzeria)
  // now run the compiled engine; the legacy path is being deprecated.
  compiled_ordering_engine_enabled?: boolean;
  // Customer CRM (docs/specs/2026-09-03-customer-crm.md) — owner-level kill
  // switch for personalization. Default true (migration 121).
  customer_personalization_enabled?: boolean;
  // Instruction-layer renderer (docs/specs/2026-09-09-prompt-line-
  // classification.md, migration 124). NULL = legacy buildSystemPrompt,
  // unchanged. Non-null = buildSystemPromptV2, sourced from shop_settings/
  // shop_voice/shop_notes instead of the shared hardcoded template. See the
  // gate at the buildSystemPrompt(...) call site.
  prompt_version?: number | null;
  // Turn Engine (docs/specs/2026-09-14-turn-engine-oversight.md §4 Phase 3,
  // migration 141). Gates the routing branch below. NOT NULL DEFAULT false
  // for every shop — this field being undefined/false means the legacy
  // path (unchanged, below) runs exactly as it always has.
  turn_engine_enabled?: boolean;
  // Clean-sheet engine (supabase/functions/chat-sms/engine/, migration 147).
  // Routes the ordering turn to engine/runner.ts. Default false per shop.
  clean_engine_enabled?: boolean;
  tax_rate_bps?: number | null;
}

// Instruction-layer rows (migration 124) — read-only inputs to
// buildSystemPromptV2. Kept minimal/local to this file rather than a shared
// type module: only the renderer touches these fields today.
interface ShopSettingsRow {
  hours_line:            string | null;
  fulfilment_modes:      string[];
  delivery_radius_miles: number | null;
  quantity_words:        Record<string, number>;
  upsell_enabled:        boolean;
}
interface ShopVoiceRow {
  greeting: string | null;
  sign_off: string | null;
  persona:  string | null;
}
interface ShopNoteRow {
  text: string;
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
  delivery_offer_made_at:     string | null;
  // docs/specs/2026-09-13-checkout-mode-insulation.md, migration 138. Cart
  // item subtotal (cents) at the moment the pickup-name ask/confirm was last
  // issued for this cart. NULL = not yet asked (or moot — pickup_name set).
  name_confirm_pending_total_cents: number | null;
  // docs/specs/2026-09-13-checkout-insulation.md, migration 139. Timestamp
  // checkout intent was first established for this cart (see
  // shouldRedirectNameAskToCheckoutGate in checkout-intent-gate-20260913.ts).
  // NULL means not yet established — a name-ask/name-confirm reply is not
  // yet allowed to go out.
  checkout_intent_confirmed_at: string | null;
  // BLOCKER 1 (docs/specs/2026-09-06-disambiguation-and-menu-gaps.md): the
  // candidates GUARD 7 offered, so the NEXT inbound message can be resolved
  // deterministically before the LLM ever runs. Null once resolved, reset,
  // or expired.
  // Turn Engine (docs/specs/2026-09-14-turn-engine-oversight.md §3a,
  // migration 141). Code-owned dialogue state, read/written only by
  // turn-engine-runner.ts on the routing branch below. NULL means "fresh
  // conversation" (the runner treats that as the initial state) — never
  // read or written by the legacy path.
  // Clean-sheet engine form (migration 147). Read/written only by engine/runner.ts.
  engine_form:                EngineOrderForm | null;
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
 * Item C2 fix (2026-09-14): the driver-tip ask (index.ts's DRIVER TIP prompt
 * rule) is a standing instruction the model is free to act on almost any
 * turn once a delivery address is known — including the SAME turn
 * REPLY-INVERSION (~line 7599) just code-rendered an item-add fact. Two
 * "asks" landing in one reply is exactly the prompt-rule-vs-code-render race
 * this burn-down exists to close: confirmed live (see
 * scripts/conversation-quality-test.sh's "offers a FOOD upsell, not a tip"
 * check, ~44% failure before this fix) that the tip question sometimes
 * displaces or rides alongside the code-rendered upsell offer on an item-add
 * turn. Fix is structural, not a reword: on any turn where code has already
 * claimed the reply with a mutation fact, the model's own tip-ask sentence
 * is dropped from what survives into `warmthTail` — never appended, no
 * matter how the model phrased it. The tip is still asked, just never on an
 * item-add turn — the model's standing prompt rule fires it on the next
 * quiet turn instead, same as it already does for every other "ask once"
 * rule that isn't in play this particular turn. Requires BOTH "tip" and
 * "driver" in the same sentence (the prompt's own required phrasing always
 * includes both) so this can't misfire on an unrelated sentence that merely
 * mentions a tip or a driver on its own.
 */
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
async function smsReply(supabase: SupabaseClient, ctx: OutboundContext, shop: Shop, toNumber: string, message: string): Promise<Response> {
  const replyFrom = shop.reply_from_e164 || shop.phone_number_e164;
  if (!replyFrom) {
    console.error("[chat-sms] No reply number configured for shop");
    return emptyTwiml();
  }
  await sendSmsViaTwilio(supabase, ctx, replyFrom, toNumber, message);
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

/** Text ordering is paused while is_paused, until paused_until passes (null: until turned back on). */
function shopPausedNow(shop: { is_paused: boolean; paused_until?: string | null }): boolean {
  return shop.is_paused === true && (!shop.paused_until || new Date(shop.paused_until) > new Date());
}

const PAID_CANCEL = new Set(["cancel", "cancel order", "cancel my order", "cancel the order", "cancel it", "cancel that", "please cancel", "please cancel my order", "i want to cancel", "i want to cancel my order", "i need to cancel", "i need to cancel my order", "can i cancel", "can i cancel my order", "cancel please", "cancel my order please", "nevermind cancel", "never mind cancel"]);

function getBusinessDate(timezone: string): string {
  return getBusinessDateAt(new Date(), timezone);
}

// Same as getBusinessDate but for an arbitrary instant, not just "now" --
// used by the D1 conversation-timeout shop-close-boundary check to compare
// the shop's local calendar date of a conversation's last message against
// today's.
function getBusinessDateAt(when: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(when);
    const y = parts.find(p => p.type === "year")?.value  ?? "";
    const m = parts.find(p => p.type === "month")?.value ?? "";
    const d = parts.find(p => p.type === "day")?.value   ?? "";
    return `${y}-${m}-${d}`;
  } catch {
    return when.toISOString().split("T")[0];
  }
}

// Default conversation timeout, in hours, when app_config has no row (or an
// unusable one) for 'conversation_timeout_hours'. Overridable per deploy
// without a code change — see migration 128.
const DEFAULT_CONVERSATION_TIMEOUT_HOURS = 2;

type ActiveConversationRow = { id: string; last_message_at?: string };

// Pure decision function, exported so the required test cases (2h vs 20min
// vs shop-close-boundary vs the exact c5a038f6 real repro) can assert against
// it directly instead of needing a live DB and real elapsed time. Two
// independent boundaries end a conversation, either fires first:
//   1. INACTIVITY -- no message for `timeoutHours` (app_config
//      'conversation_timeout_hours', default 2h). Long enough that a
//      customer stepping away mid-order comes back to a live cart; short
//      enough a session never survives a full daypart shift.
//   2. SHOP CLOSE -- the shop's local calendar day (shopTimezone) has rolled
//      over since the conversation's last message. Independent of elapsed
//      time: 11:50pm -> 12:10am is only 20 minutes but still ends the
//      conversation, because a session must never carry one day's
//      hours/prices/context into the next.
export function isConversationExpired(
  lastMessageAt: string | null | undefined,
  now: Date,
  shopTimezone: string,
  timeoutHours: number,
): { expired: boolean; reason: "inactivity" | "shop_close" | null } {
  const lastMsgDate = lastMessageAt ? new Date(lastMessageAt) : null;
  const timeoutMs = timeoutHours * 60 * 60 * 1000;
  const inactiveTooLong = !lastMsgDate || (now.getTime() - lastMsgDate.getTime()) > timeoutMs;
  const crossedShopDay = lastMsgDate
    ? getBusinessDateAt(lastMsgDate, shopTimezone) !== getBusinessDateAt(now, shopTimezone)
    : false;
  if (!inactiveTooLong && !crossedShopDay) return { expired: false, reason: null };
  return { expired: true, reason: inactiveTooLong ? "inactivity" : "shop_close" };
}

// The single place that reads "the active conversation for this (shop,
// channel, session/phone)" — expiry is a property of THIS lookup (via
// isConversationExpired above), not a separate check callers must remember
// to run. On expiry the OLD conversation is marked `resolved` (same
// mechanism the RESET keyword uses) and this function returns null for it --
// so every caller, present and future, gets a fresh conversation on the next
// message without having to know expiry exists. Nothing is deleted; the old
// row stays as audit trail. Returns `justExpired: true` only when an
// existing conversation was ended here (never on a true first-ever contact),
// so callers can surface a brief "starting fresh" note instead of silently
// resuming.
async function findActiveConversation(
  supabase: SupabaseClient,
  shop: Shop,
  channel: "web" | "sms",
  sessionId: string | undefined,
  customerPhone: string | null,
): Promise<{ conversation: ActiveConversationRow | null; justExpired: boolean }> {
  let conversation: ActiveConversationRow | null;
  if (channel === "web") {
    const { data } = await supabase
      .from("conversations").select("id, last_message_at")
      .eq("tenant_id", shop.tenant_id)
      .eq("session_id", sessionId).eq("channel", "web")
      .eq("status", "active")
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    conversation = data;
  } else {
    const { data } = await supabase
      .from("conversations").select("id, last_message_at")
      .eq("tenant_id", shop.tenant_id).eq("customer_phone", customerPhone)
      .eq("channel", "sms").eq("status", "active")
      .order("started_at", { ascending: false }).limit(1).single();
    conversation = data;
  }

  if (!conversation) return { conversation: null, justExpired: false };

  const { data: cfgRow } = await supabase
    .from("app_config").select("value").eq("key", "conversation_timeout_hours").maybeSingle();
  const timeoutHours = typeof cfgRow?.value === "number" && cfgRow.value > 0
    ? cfgRow.value
    : DEFAULT_CONVERSATION_TIMEOUT_HOURS;

  const { expired, reason } = isConversationExpired(conversation.last_message_at, new Date(), shop.timezone, timeoutHours);
  if (!expired) return { conversation, justExpired: false };

  console.log(`[chat-sms] conversation timeout: resolving ${conversation.id} (reason=${reason}, timeoutHours=${timeoutHours}, lastMsgAt=${conversation.last_message_at ?? "null"})`);
  await supabase.from("conversations").update({ status: "resolved" }).eq("id", conversation.id);
  return { conversation: null, justExpired: true };
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
// `now` defaults to real wall-clock time at every existing call site
// (all call unchanged as `getBusinessDayKey(shop.timezone)`); exported and
// made injectable so the TODAY'S HOURS fix (2026-09-12) is testable at a
// specific day-of-week without depending on when the test happens to run —
// same isConversationExpired(now: Date, ...) precedent already used above.
export function getBusinessDayKey(timezone: string, now: Date = new Date()): string {
  const dayMap: Record<string, string> = {
    Sun: "sun", Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat",
  };
  try {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now);
    return dayMap[wd] ?? wd.slice(0, 3).toLowerCase();
  } catch {
    const fallback = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    return fallback[now.getDay()];
  }
}

// Current minutes-since-midnight in the shop's local timezone (0–1439).
// Computed from formatted local parts so it is correct regardless of where the
// function runs (no reliance on server timezone or Date parsing quirks).
// `now` defaults to real wall-clock time at every existing call site; made
// injectable (same precedent as getBusinessDayKey above) so delivery-hours
// tests can assert behavior at a specific timestamp.
function getLocalMinutes(timezone: string, now: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const h = Number(parts.find(p => p.type === "hour")?.value ?? "0") % 24;
    const m = Number(parts.find(p => p.type === "minute")?.value ?? "0");
    return h * 60 + m;
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

// Whether `nowMins` (minutes-since-midnight) falls inside any of the given
// open windows. Exported so the RESET handler and the greeting-phase hours
// gate share one check instead of each re-deriving it.
export function isWithinAnyWindow(
  windows: Array<{ open: string; close: string }>,
  nowMins: number,
): boolean {
  return windows.some((window) => {
    const [openH, openM] = window.open.split(":").map(Number);
    const [closeH, closeM] = window.close.split(":").map(Number);
    const openMins = openH * 60 + openM;
    const closeMins = closeH * 60 + closeM;
    return nowMins >= openMins && nowMins < closeMins;
  });
}

// The RESET reply must reflect whether the kitchen is actually open right
// now — telling an open-shop customer to "come back when we're open" was a
// real defect (2026-09-12). Exported so the fix is directly testable.
export function buildResetReply(effectiveOpen: boolean): string {
  return effectiveOpen
    ? "Session reset. Text anything to start a new order, or TESTMODE to test again."
    : "Session reset. Text when the kitchen is open, or TESTMODE to test again.";
}

async function saveMessage(
  supabase:       SupabaseClient,
  conversationId: string,
  tenantId:       string,
  role:           "customer" | "assistant" | "system",
  content:        string,
  messageSid?:    string,
): Promise<{ inserted: boolean; id: string | null }> {
  // P0 fix (2026-09-19): `id` is selected back so an assistant-role save can
  // hand its own row's primary key to sendSms, which writes the carrier's
  // message id onto THIS row once the send actually succeeds — see
  // sendSmsViaTwilio/sendSmsViaTelnyx's own "carrier id" comments for why
  // that's the only way NULL on an assistant row comes to mean "unsent"
  // instead of "we didn't bother recording it."
  const { data, error } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    tenant_id: tenantId,
    role,
    content,
    ...(messageSid ? { message_sid: messageSid } : {}),
  }).select("id").single();
  if (error) {
    // 23505 = unique_violation → duplicate message_sid, already processed
    if (error.code === "23505") return { inserted: false, id: null };
    console.error("[chat-sms] Failed to save message:", error.message);
    return { inserted: true, id: null };
  }
  return { inserted: true, id: (data as { id: string } | null)?.id ?? null };
}

// ─── System event handler ────────────────────────────────────────────────────

// STRUCTURAL OUTBOUND WATCHDOG: every customer-facing SMS send goes through
// the guard. The signature REQUIRES an OutboundContext as its first argument,
// so a call site cannot reach Twilio without declaring a valid reason. The real
// network call lives inside guardedSend's `deliver` closure and runs ONLY on
// ALLOW; on DENY the guard logs CRITICAL and nothing leaves the system.
async function sendSmsViaTwilio(
  supabase:   SupabaseClient,
  ctx:        OutboundContext,
  fromNumber: string,
  toNumber:   string,
  message:    string,
  messageId?: string | null,
): Promise<void> {
  message = toGsm7(message); // one non-GSM character doubles the segments
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
      // P0 fix (2026-09-19): a non-2xx from the carrier used to only hit
      // console.error, which Supabase edge-function logs discard after
      // ~1 minute — the PO had no durable way to find a silently-dropped
      // reply after the fact. message_sid is never set on this row either
      // way (saveMessage's assistant-role call sites never pass one), so a
      // failed send and a successful one are otherwise indistinguishable in
      // the messages table; this row is what makes the failure findable.
      await logError(supabase, {
        conversationId: ctx.conversationId,
        shopId: ctx.shopId,
        tenantId: ctx.tenantId,
        phase: "chat-sms",
        stage: "outbound_send",
        customerMessage: message,
        error: new Error(`Twilio send failed: ${res.status}`),
        metadata: { provider: "twilio", status: res.status, responseBody: errText, to: toNumber },
      });
    } else {
      console.log(`[chat-sms] SMS sent to ${toNumber}`);
      // P0 fix (2026-09-19): write Twilio's own message id back onto the
      // assistant `messages` row that was saved before this send ran — see
      // saveMessage's own comment. Without this, NULL on that row meant
      // nothing (every successful send left it NULL too); this is what
      // makes NULL reliably mean "never confirmed sent by the carrier."
      if (messageId) {
        try {
          const body = await res.json();
          const carrierSid = body?.sid as string | undefined;
          if (carrierSid) {
            const { error: updateErr } = await supabase.from("messages").update({ message_sid: carrierSid }).eq("id", messageId);
            if (updateErr) console.error(`[chat-sms] Failed to record Twilio sid on message ${messageId}:`, updateErr.message);
          }
        } catch (e) {
          console.error(`[chat-sms] Failed to parse Twilio response for sid (message ${messageId}):`, e);
        }
      }
    }
  }, { supabase, phase: "chat-sms", customerMessage: message });

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
  messageId?: string | null,
): Promise<void> {
  message = toGsm7(message); // one non-GSM character doubles the segments
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
      // P0 fix (2026-09-19): same rationale as the Twilio success branch —
      // write Telnyx's own message id back onto the assistant row saved
      // before this send ran, so NULL there reliably means "never confirmed
      // sent," not "we didn't bother recording it."
      if (messageId) {
        try {
          const body = await res.json();
          const carrierId = body?.data?.id as string | undefined;
          if (carrierId) {
            const { error: updateErr } = await supabase.from("messages").update({ message_sid: carrierId }).eq("id", messageId);
            if (updateErr) console.error(`[chat-sms] Failed to record Telnyx id on message ${messageId}:`, updateErr.message);
          }
        } catch (e) {
          console.error(`[chat-sms] Failed to parse Telnyx response for id (message ${messageId}):`, e);
        }
      }
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

    // P0 fix (2026-09-19): every non-2xx from Telnyx gets a durable row here,
    // regardless of which sub-case (transient/opt-out/other) the existing
    // classification below routes it to — same rationale as the Twilio
    // branch above. message_sid is never set on the corresponding `messages`
    // row either way, so this error_log row is the only durable trace of a
    // reply the customer's phone never received.
    await logError(supabase, {
      conversationId: ctx.conversationId,
      shopId: ctx.shopId,
      tenantId: ctx.tenantId,
      phase: "chat-sms",
      stage: "outbound_send",
      customerMessage: message,
      error: new Error(`Telnyx send failed: ${res.status}${errCode ? ` code=${errCode}` : ""}`),
      metadata: { provider: "telnyx", status: res.status, responseBody: errText, errorCode: errCode ?? null, to: toNumber },
    });

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
  }, { supabase, phase: "chat-sms", customerMessage: message });

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
          phone_number:     phone, // legacy column, still NOT NULL — see migration 122
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

// ── Outbound SMS segment counting (measurement only — mirrors the exact
// math in _shared/test-suite/persist.ts so these numbers agree with the
// test harness's own segment counting) ─────────────────────────────────────
const OUTBOUND_GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
    .split(""),
);
const OUTBOUND_GSM7_EXTENDED = new Set("|^{}[]~\\€");

function outboundIsGsm7(text: string): boolean {
  for (const ch of text) {
    if (!OUTBOUND_GSM7_BASIC.has(ch) && !OUTBOUND_GSM7_EXTENDED.has(ch)) return false;
  }
  return true;
}

function outboundGsm7CharCount(text: string): number {
  let count = 0;
  for (const ch of text) {
    count += OUTBOUND_GSM7_EXTENDED.has(ch) ? 2 : 1;
  }
  return count;
}

function outboundSegmentCount(text: string): number {
  if (text.length === 0) return 0;
  if (outboundIsGsm7(text)) {
    const chars = outboundGsm7CharCount(text);
    return chars <= 160 ? 1 : 1 + Math.ceil((chars - 160) / 153);
  }
  return text.length <= 70 ? 1 : 1 + Math.ceil((text.length - 70) / 67);
}

// P0 fix (2026-09-19, live conv b685494d-62e9-4a2d-b5c1-f761cd6d6c5b): a
// reply over ~10 SMS segments (roughly 1,530 GSM-7 chars) used to be sent
// to the carrier as ONE oversized message, which Telnyx/Twilio silently
// rejected — nothing recorded the failure and the customer's phone got
// nothing. Splitting into carrier-safe parts, sent in order, means a long
// reply (an oversized narrowing question, a big recap, an enumerated
// options list) always actually reaches the phone instead of risking a
// silent carrier-side rejection on the raw length alone.
const MAX_SMS_CHARS = 1500;

// Prefers a whitespace boundary near the limit so a part never ends mid-
// word; falls back to a hard cut at the limit if no whitespace is found in
// range (a single "word" of pathological length). Every returned part is
// guaranteed <= maxLen.
export function splitForSms(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen;
    const part = remaining.slice(0, cut).trim();
    if (part) parts.push(part);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

/**
 * Single routing function for all outbound SMS. Routes to Telnyx or Twilio
 * based on the provider argument. Always wraps in guardedSend (via the
 * per-provider send functions). A reply over MAX_SMS_CHARS is split into
 * multiple carrier-safe parts and sent in order — see splitForSms's own doc.
 */
async function sendSms(
  supabase:  SupabaseClient,
  shopId:    string,
  ctx:       OutboundContext,
  provider:  SmsProvider,
  fromNumber: string,
  toNumber:   string,
  message:    string,
  messageId?: string | null,
): Promise<void> {
  const cleaned = stripEmDashes(message);
  const segCount = outboundSegmentCount(cleaned);
  console.log(`[chat-sms] outbound-segments (shop=${shopId}): chars=${cleaned.length} segments=${segCount}`);

  const parts = splitForSms(cleaned, MAX_SMS_CHARS);
  if (parts.length > 1) {
    console.warn(`[chat-sms] SMS OVERFLOW (shop=${shopId}): chars=${cleaned.length} segments=${segCount} — splitting into ${parts.length} carrier-safe parts, sent in order`);
  }
  // P0 fix (2026-09-19): the carrier id is recorded on the ONE `messages`
  // row this whole reply was saved as, so only the FIRST part carries
  // messageId through — a multi-part reply is still one logical message,
  // and the row is already "confirmed sent" once its first part lands.
  // Later parts pass no messageId, so a failure on part 2+ never re-marks
  // an already-confirmed row back toward "unsent."
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partMessageId = i === 0 ? messageId : undefined;
    if (provider === "telnyx") {
      await sendSmsViaTelnyx(supabase, shopId, ctx, fromNumber, toNumber, part, partMessageId);
    } else {
      await sendSmsViaTwilio(supabase, ctx, fromNumber, toNumber, part, partMessageId);
    }
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
  // courier delivery (Uber Direct / DoorDash Drive), booked by stripe-webhook before this receipt; null for own-driver shops
  const courier: DeliveryRow | null = system_event === "payment_confirmed" && cartRow.order_type === "delivery"
    ? await deliveryForCart(supabase, order_cart_id).catch(() => null) : null;
  const shop = cartRow.shops as Shop;

  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, channel, customer_phone, tenant_id, metadata")
    .eq("id", conversation_id)
    .single();

  if (!conversation) return jsonError("Conversation not found", 404);

  let message: string;
  let deliveryNotice: string | null = null; // delivery_update: the status this text announces (guard evidence)

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
      const detail = cartItemModifierParts(r).join(", ");
      return `${(r.quantity || 1)}x ${r.name}${detail ? ` (${detail})` : ""}`;
    }).join(", ");
    const subtotal   = ((cartRow.subtotal_cents ?? 0) / 100).toFixed(2);
    const serviceFee  = ((cartRow.service_fee_cents ?? 0) / 100).toFixed(2);
    const total  = ((cartRow.total_cents ?? 0) / 100).toFixed(2);
    const pickup = cartRow.pickup_name ? ` for ${cartRow.pickup_name}` : "";
    // Reconciliation line shown only when a service fee was charged (new orders).
    // Trimmed 2026-09-11: the subtotal/fee split was already disclosed in the
    // payment-link message and again at checkout, and repeating it here pushed
    // every confirmation past 160 chars — a second billed SMS segment on every
    // order. Kept only when no fee was charged is meaningless, so it is dropped
    // outright; the total remains, which is the number that matters on a receipt.
    const feeLine = "";
    void subtotal; void serviceFee;

    const today    = getBusinessDayKey(shop.timezone);
    const hours    = dayWindows(shop.open_hours?.[today]);
    const fmt12Confirm = (t: string) => { const [h, m] = t.split(":").map(Number); const ampm = h >= 12 ? "p.m." : "a.m."; const h12 = h % 12 || 12; return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2,"0")} ${ampm}`; };
    const hoursStr = hours.length > 0
      ? hours.map((h: { open: string; close: string }) => `${fmt12Confirm(h.open)}-${fmt12Confirm(h.close)}`).join(", ")
      : "see our hours for details";

    const orderNum = cartRow.order_number ? ` ORDER #${cartRow.order_number} ` : " ";
    const closeTime = hours.length > 0 ? fmt12Confirm(hours[hours.length - 1].close) : null;
    const closePart  = closeTime ? ` (we're open til ${closeTime})` : "";
    // Fulfilment wording must follow the order, not assume pickup: a delivery
    // order previously read "come pick it up", sending the customer to the shop
    // for food that was on its way to them (observed live, orders #11/#12).
    // a booked courier: the tracking link is the only delivery update the customer gets (no third text)
    const readyPart = cartRow.order_type === "delivery"
      ? (courier?.tracking_url ? `A courier is booked. Track it or add drop-off notes here: ${courier.tracking_url}` : "On its way in about 30-45 min")
      : `Ready for pickup in about 10-15 min${closePart}`;
    message = `Payment confirmed!${orderNum}Order${pickup}: ${items}. Total: $${total}. ${readyPart}.`;
  } else if (system_event === "delivery_update") {
    // ALLOWED EXCEPTION #3: courier progress on this paid delivery, sent by delivery-webhook on a forward move.
    // The status is read here, never taken from the caller, and each status is announced once (claimDeliveryNotice).
    const d = await deliveryForCart(supabase, order_cart_id).catch(() => null);
    if (!d || !NOTICE_STATUSES.has(d.status)) return jsonResponse({ ok: true, silent: true, skipped: "no announceable delivery status" });
    if (!(await claimDeliveryNotice(supabase, d, d.status))) return jsonResponse({ ok: true, silent: true, skipped: "already announced" });
    deliveryNotice = d.status;
    const who = d.courier_name ? d.courier_name.split(" ")[0] : "your driver";
    const callAt = shop.phone_number_e164 ? ` at ${shop.phone_number_e164.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3")}` : "";
    message = d.status === "picked_up"
      ? `Your ${shop.name} order is on its way with ${who}.${d.tracking_url ? ` Track it: ${d.tracking_url}` : ""}`
      : d.status === "dropped_off"
      ? `Your ${shop.name} order was delivered. Enjoy!`
      : `Sorry, the courier canceled your delivery. Please call ${shop.name}${callAt} about your order.`;
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
    const note = (cartRow.refund_note as string | null) ?? "";
    message = `A refund of $${refunded} has been issued for your order from ${shop.name}.${note ? ` ${note}` : ""} It may take a few business days to appear on your statement.`;
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

  const savedSystemMsgId = (await saveMessage(supabase, conversation_id, conversation.tenant_id, "assistant", message)).id;

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
          const detail = cartItemModifierParts(r).map(d => h(d)).join(", ");
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
        ${courier ? (courier.delivery_id
          ? `<p style="margin:0 0 6px;"><strong>Courier:</strong> ${h(courier.provider === "uber" ? "Uber" : "DoorDash")} pickup about ${h(new Date(courier.pickup_ready_at ?? Date.now()).toLocaleTimeString("en-US", { timeZone: shop.timezone || "America/New_York", hour: "numeric", minute: "2-digit" }))}${courier.courier_name ? `, ${h(courier.courier_name)}` : ""}${courier.tracking_url ? ` (<a href="${h(courier.tracking_url)}">track</a>)` : ""}</p>`
          : `<p style="margin:0 0 6px;color:#b91c1c;"><strong>Courier NOT booked.</strong> Deliver it yourself or call OrderFare.</p>`) : ""}
        <p style="margin:0;"><strong>Time Received:</strong> ${etTime}</p>
      </div>
    </div>
    <div style="padding:16px 32px;background:#f4f4f4;text-align:center;">
      <p style="margin:0;font-size:12px;color:#999;">Powered by OrderFare</p>
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
                  from: "OrderFare Orders <orders@getsprintai.com>",
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
    deliveryStatus: deliveryNotice,
    deliveryNoticeClaimed: deliveryNotice !== null,
  };

  if (conversation.channel === "sms" && conversation.customer_phone) {
    // Direct SMS delivery via the active provider
    if (!shop.phone_number_e164) {
      console.error("[chat-sms] Shop has no phone number configured for SMS confirmation");
    } else {
      await sendSms(supabase, shop.tenant_id, txnCtx, resolveSmsProvider(shop), shop.phone_number_e164, conversation.customer_phone, message, savedSystemMsgId);
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
      }, { supabase, phase: "chat-sms", customerMessage: message });
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

// Item 2 (2026-09-09, module extraction): named + exported so index.ts is
// importable for tests without booting a listener — Deno.serve only runs
// when this file is the entry point (`import.meta.main`), not when a test
// file imports it to reach the pure modules above.
export async function handleChatSmsRequest(req: Request): Promise<Response> {
  // PERF DIAGNOSTIC (2026-09-09, Zio's 4-pizza latency) — see BLOCKED.txt.
  const debugReqT0 = performance.now();
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
    if (shopPausedNow(shop)) {
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
      if (shopPausedNow(shop)) {
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
    if (shopPausedNow(shop)) {
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

  // Bug fix (2026-09-16, slash-shorthand silent order loss): normalize
  // BEFORE any downstream use -- the model call, phrase-split.ts, guard19,
  // resolve-item.ts all see the same text a comma-delimited message would
  // produce. See slash-shorthand-normalize-20260916.ts for the live-tested
  // rationale (this is a model-reliability fix, not a swallowed tool call).
  //
  // Follow-up (2026-09-17): pass the shop's live menu item names so the
  // normalizer can leave alone a slash that's actually part of a real menu
  // item's name (e.g. Vito's "Cheesesteak / Chicken Cheesesteak") rather
  // than shorthand for "and". See slash-shorthand-normalize-20260916.ts.
  // Latency/scale fix (2026-09-17, live QA): the overwhelming majority of
  // turns contain no slash at all, so fetchLiveMenuItemNames' two DB round
  // trips were running on every single customer message, on every shop,
  // forever -- pure tax. normalizeSlashShorthand already no-ops with no
  // protected names when there's no spaced slash, so skip the fetch (and
  // its latency) whenever the raw text can't possibly match.
  const liveMenuItemNamesForNormalize: string[] = [];
  userMessage = normalizeSlashShorthand(userMessage, liveMenuItemNamesForNormalize);

  // ── Find or create conversation ───────────────────────────────────────────
  // Conversation-timeout fix (2026-09-09, revised to final spec same day):
  // a conversation used to be reused for up to 24h from its CREATION
  // (`started_at >= windowStart`), which bounds age, not inactivity.
  // Confirmed live (conversation c5a038f6): a session begun 10:11pm, resumed
  // 7:12am and again 5:48pm -- 19.6h span, three sittings, all still "within
  // 24h of started_at" -- welded each later message onto an earlier sitting's
  // cart/context. Same root-cause class as the 2026-09-08 P0 phantom-cart
  // incident (stale state carried forward across sittings).
  //
  // findActiveConversation() (above) now OWNS expiry: it is the only place
  // that reads "the active conversation for this (shop, channel,
  // session/phone)", and it silently resolves a stale one and returns null
  // before ever handing a conversation back — so nothing downstream (this
  // handler, any future caller) can accidentally operate on stale state by
  // forgetting to check. The window itself is configurable via app_config
  // ('conversation_timeout_hours', default 2h) rather than hardcoded, and a
  // shop-close boundary ends a conversation independent of elapsed time,
  // exactly per the finalized spec.
  //
  // CRITICAL FIX (2026-09-08, P0 Zio's investigation), preserved here: the
  // web-channel lookup is scoped by tenant_id, not just session_id + channel
  // + status. `shop_id` and `session_id` are independent, client-supplied
  // values in the request body with no server-side binding between them (see
  // shop_id/sessionId destructure above). Any client that ever sent the same
  // session_id against a different shop_id (a shared widget, a buggy
  // integration, a test harness reusing a fixed session_id, the
  // web:imsg-* bridge) would otherwise hand back a DIFFERENT TENANT'S
  // conversation row -- and, transitively via conversation_id, that tenant's
  // full message history and cart. This function runs on
  // SUPABASE_SERVICE_ROLE_KEY, so Postgres RLS provides no protection.
  const { conversation: lookedUpConversation, justExpired: conversationJustExpired } =
    await findActiveConversation(supabase, shop, channel, sessionId, customerPhone);
  let conversation: ActiveConversationRow | null = lookedUpConversation;

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

  // ── Customer CRM lookup (docs/specs/2026-09-03-customer-crm.md) ─────────
  // AC7: exactly ONE indexed query on (tenant_id, customer_phone) against
  // `customers` — see lookupCustomerContext, which selects nothing else.
  // AC2 (tenant isolation): scoped by shop.tenant_id, same key every other
  // tenant-scoped table in this file uses — a phone that ordered at another
  // shop can never surface here. AC3 (opt-out): an opted-out (tenant_id,
  // phone) gets customerContext = null below, same as first-ever contact —
  // no name, no regular offer, nothing distinguishes it from a cold start.
  // The web channel's synthetic customerPhone (`web:<sessionId>`) simply
  // never matches a row — harmless cold start, not a special case.
  let customerRow: CustomerRow | null = null;
  let regularItem: ReturnType<typeof regularEligibility> | null = null;
  if (shop.customer_personalization_enabled !== false && customerPhone) {
    const optedOut = await isOptedOut(supabase, shop.tenant_id, customerPhone);
    if (!optedOut) {
      customerRow = await lookupCustomerContext(supabase, shop.tenant_id, customerPhone);
      if (customerRow) regularItem = regularEligibility(customerRow.favorite_items ?? []);
    }
  }
  // Real order history on the customer row means we've heard from this
  // customer before, regardless of whether a `conversations` row happens to
  // exist for this phone (e.g. history seeded/migrated directly into
  // `customers`) — the conversations-count check above can't see that.
  if (customerRow && ((customerRow.order_count ?? 0) > 0 || customerRow.last_order_type)) {
    isLifetimeFirstContact = false;
  }
  // Returning-customer delivery memory (docs/specs/2026-09-12-returning-
  // customer-delivery-memory.md). Gated on the SAME customer_personalization_
  // enabled flag as the rest of this block (spec item 5 — no second flag).
  // Cheap re-validation only (spec item 3): reuses shop fields already
  // loaded this turn, never a live geocode — see delivery-memory-offer.ts's
  // header for why.
  const deliveryOffer = (customerRow && shop.customer_personalization_enabled !== false)
    ? computeDeliveryOffer(customerRow.last_order_type ?? null, customerRow.last_delivery_address ?? null, {
        deliveryEnabled: shop.delivery_enabled === true,
        deliveryPausedNow: !!(shop.delivery_paused_until && new Date(shop.delivery_paused_until) > new Date()),
        deliveryRadiusMi: shop.delivery_radius_mi ?? null,
      })
    : null;
  // customerContext itself (AC4 name-greeting rule included) is assembled
  // further below, once `cart` is loaded — the delivery-offer eligibility
  // check needs cart.order_type and cart.delivery_offer_made_at, neither of
  // which exists yet at this point in the request (see FIX A, 2026-09-12).

  // ITEM 1 (2026-09-08, PO live verification): menu_item_id -> option-group
  // names whose real choices have already reached the customer this turn via
  // the compiled path's own canonical wording (populated once runOrderingLoop
  // returns, below). GUARD 8 (and, defensively, GUARD 7c) reads this to
  // decide whether its own "Choices for X" clause would be a duplicate — "did
  // we already say this," not "is the group's display name generic." Declared
  // here (empty) so both guards see the same variable regardless of which
  // runs first in the turn.
  const compiledRenderedGroups = new Map<string, Set<string>>();

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

  // ── D3 fix (2026-09-09, real SMS double-text race — order #6): nothing
  // previously serialized two inbound messages for the SAME conversation.
  // Each inbound SMS is its own independent invocation of this function, so
  // a customer double-texting quickly can have both invocations run
  // concurrently against the same starting cart/conversation state — e.g. a
  // name-ask reply landing AFTER the customer's next message had already
  // answered it. Same short-lived claim-with-staleness idiom as
  // order_carts.ticket_send_attempt_at below: a single atomic UPDATE...WHERE
  // guards the claim, so two concurrent callers cannot both win.
  //
  // Two DIFFERENT time horizons, deliberately not the same number:
  //   - STALE_MS (60s) is crash detection — how long a claim can sit before
  //     a NEW caller is allowed to steal it outright. Measured turns in this
  //     system run anywhere from ~1s to 35s+ (compiled multi-item orders are
  //     the slow end — see BLOCKED.txt's Zio's 4-pizza latency entry), so
  //     this must comfortably exceed real processing time or a live-but-slow
  //     first caller would have its lock stolen mid-turn — two callers
  //     "holding" it at once, defeating the whole point.
  //   - the poll loop below (~15s) is how long a LOSING caller waits before
  //     giving up and proceeding unlocked. Deliberately shorter than
  //     STALE_MS and kept under typical inbound-SMS-webhook timeouts (~15s
  //     for Twilio) — blocking the HTTP response past that risks the
  //     provider treating the webhook itself as failed and retrying it,
  //     which would manufacture a THIRD concurrent invocation on top of the
  //     customer's own double-text. A turn that legitimately runs past this
  //     window still proceeds (favors availability over a stuck customer
  //     text) but is no longer guaranteed serialized — logged so real
  //     contention past the bound is visible rather than silently accepted.
  const STALE_MS = 60_000;
  let turnLockAcquired = false;
  for (let lockAttempt = 0; lockAttempt < 30; lockAttempt++) {
    const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
    const { data: claimedTurn } = await supabase
      .from("conversations")
      .update({ processing_claimed_at: new Date().toISOString() })
      .eq("id", conversation.id)
      .or(`processing_claimed_at.is.null,processing_claimed_at.lte.${staleBefore}`)
      .select("id");
    if (claimedTurn && claimedTurn.length > 0) { turnLockAcquired = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!turnLockAcquired) {
    // Still locked after ~15s of polling and the claim isn't stale yet (the
    // first caller is genuinely still working, not crashed) — proceed
    // unlocked rather than leave the customer's message unanswered or risk
    // a provider webhook retry. Logged so real contention is visible.
    console.warn(`[chat-sms] turn lock contention for conversation ${conversation.id} — proceeding without lock`);
  }

  try {

  // ── "Cancel" after paying ─────────────────────────────────────────────────
  // A paid order is the shop's: a new message starts a new cart, so "cancel my order" would otherwise cancel that empty
  // cart and sound like it worked. Point the customer to the shop instead (Jason 2026-10-06). "reset" still resets.
  if (PAID_CANCEL.has(userMessage.trim().toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " "))) {
    const { data: paid } = await supabase.from("order_carts").select("id, order_number, order_type, delivery_fee_cents")
      .eq("conversation_id", conversation.id).eq("payment_status", "paid").gte("created_at", new Date(Date.now() - 6 * 3600_000).toISOString())
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (paid) {
      const d = (paid as { order_type?: string }).order_type === "delivery" ? await deliveryForCart(supabase, (paid as { id: string }).id).catch(() => null) : null;
      const enRoute = !!d && (d.status === "courier_assigned" || d.status === "picked_up");
      const fee = (paid as { delivery_fee_cents?: number }).delivery_fee_cents ?? 0;
      const phone = shop.phone_number_e164 ? shop.phone_number_e164.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3") : null;
      const reply = T.paidCancel(shop.name, phone, (paid as { order_number?: number | null }).order_number ?? null, enRoute, fee > 0 ? `$${(fee / 100).toFixed(2)}` : null);
      await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
      const savedMsgId = (await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply)).id;
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply, savedMsgId); return emptyTwiml(); }
      return jsonResponse({ reply, cart: [], phase: "confirmed", session_id: sessionId });
    }
  }

  // ── Find or create order cart ─────────────────────────────────────────────
  const { data: existingCart } = await supabase
    .from("order_carts").select("*")
    .eq("conversation_id", conversation.id)
    .not("phase", "in", "(confirmed,expired)")
    .order("created_at", { ascending: false }).limit(1).single();
  console.log(`[chat-sms] TMPDIAG cart load conv=${conversation.id} msg=${JSON.stringify(userMessage)} found=${!!existingCart} id=${existingCart?.id} phase=${existingCart?.phase} test_mode=${existingCart?.test_mode} cart_len=${(existingCart?.cart_json as unknown[] | undefined)?.length} updated_at=${existingCart?.updated_at} conv_last_msg_at=${(conversation as ActiveConversationRow).last_message_at}`);

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
      .insert({ shop_id: shop.id, conversation_id: conversation.id, phase: "greeting", cart_json: [], test_mode: (shop as { is_test?: boolean }).is_test === true, order_type: shop.delivery_enabled ? null : "pickup" })
      .select("*").single();
    if (cartErr || !newCart) {
      console.error("[chat-sms] Failed to create cart:", cartErr);
      const errMsg = "Sorry, we had a problem starting your order. Please try again.";
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, errMsg); return emptyTwiml(); }
      return jsonError(errMsg, 500);
    }
    cart = newCart as OrderCart;
  }

  // FIX A (2026-09-12, docs/specs/2026-09-12-returning-customer-delivery-
  // memory.md follow-up): the returning-customer delivery/pickup-again offer
  // used to be gated on isFirstMessage (the literal first message of the
  // conversation), which closes the offer window the instant a customer
  // opens with ANYTHING other than the order itself ("hi", "you open?",
  // "menu?") — the common case, not an edge case. The offer must instead
  // fire on whichever turn order_type is still unset (i.e. the turn the
  // ordering flow is about to ask pickup-or-delivery), and must fire only
  // ONCE per conversation regardless of how many turns that takes. Cart state
  // (delivery_offer_made_at, same one-shot-flag pattern as fee_disclosed_at
  // above) is the only durable signal for "once" here — isFirstMessage can't
  // be reused for it since it's true on exactly one turn no matter what.
  //
  // Persisted the moment eligibility is computed true (this turn), not the
  // moment the customer answers: this mirrors the old isFirstMessage
  // semantics (the clause was only ever injected once, whether or not the
  // LLM actually surfaced it, whether or not the customer replied to it) and
  // keeps the offer from being re-injected turn after turn if the customer
  // ignores it or answers something else. Never re-fires if order_type is
  // later nulled out again (GUARD 2b reverting a silent set, etc.) because
  // delivery_offer_made_at is never cleared once set.
  const deliveryOfferEligible = isDeliveryOfferEligible(deliveryOffer, cart.order_type, cart.delivery_offer_made_at);
  if (deliveryOfferEligible) {
    const madeAt = new Date().toISOString();
    await supabase.from("order_carts").update({ delivery_offer_made_at: madeAt }).eq("id", cart.id);
    cart.delivery_offer_made_at = madeAt;
  }
  // AC4: only greet by name on a genuinely returning customer (a stored
  // name AND not their first-ever contact) — never on a first-ever
  // conversation, even if a name were somehow already on file.
  const customerContext = (customerRow && !isLifetimeFirstContact)
    ? { name: customerRow.name, regularItem, isFirstMessage, deliveryOffer, deliveryOfferEligible }
    : null;

  // TRUE pre-turn snapshot, captured before any tool execution can mutate
  // cart_json. Guard 7 (ambiguous same-name match, below) needs to know what
  // was added THIS turn — `cartItems` (used elsewhere for the same purpose)
  // is mutated IN PLACE by executeTool's push()/splice() calls, since it's
  // the same array object by reference, so it cannot answer "what changed".
  // Deep-cloned because cart_json is a nested object graph, not flat.
  const cartSnapshotBeforeTurn: AnyCartItem[] = JSON.parse(JSON.stringify(cart.cart_json ?? []));

  // Business hours check — computed once here (rather than only where the
  // greeting-phase gate needed it, further below) because the RESET reply
  // below also needs to know whether the kitchen is currently open. Day-of-week
  // and current time are both computed in the SHOP'S timezone so the lookup
  // is correct near midnight (see getBusinessDayKey/getLocalMinutes).
  const todayKey    = getBusinessDayKey(shop.timezone);
  const todayHours  = dayWindows(shop.open_hours?.[todayKey]);
  const nowMins     = getLocalMinutes(shop.timezone);
  // Check if current time falls within any open window (handles multi-window
  // days, e.g. lunch + dinner, since open_hours[day] is an array).
  const isOpen = isWithinAnyWindow(todayHours, nowMins);
  const effectiveOpen = forceClosed ? false : isOpen;

  // RESET keyword — expire current cart AND close out the conversation, so
  // the next message starts a brand-new conversation with zero history.
  //
  // P0 INCIDENT (2026-09-08, Jason live on Zio's): RESET used to expire only
  // the order_carts row. The conversation row (and every `messages` row in
  // it) was left untouched, and the LLM's context on every turn is built
  // from the last 40 `messages` rows filtered ONLY by conversation_id (see
  // "Load conversation history" below) — no cutoff at a reset boundary. So
  // "reset" then "I want four large pizzas" (naming zero types) let the
  // model read this SAME conversation's own turns from hours earlier and
  // silently add four specific pizzas the customer never named this turn,
  // while replying "Cart is cleared - fresh start" — false, since the cart
  // had just been filled. Real money: if confirmed, the customer pays for
  // pizzas they never chose.
  //
  // Fix: mark the conversation `resolved` (not just the cart `expired`).
  // Every conversation-lookup query in this file (SMS and web) filters on
  // `status = 'active'`, so the very next message from this customer/session
  // fails to find this conversation and takes the existing isFirstMessage
  // path (~line 4380) to create a brand-new conversation row — which has
  // zero `messages` rows, so the history load below is genuinely empty.
  // Nothing is deleted (audit trail of the old conversation and its messages
  // is untouched); the customer just can no longer weld onto it.
  if (userMessage.trim().toUpperCase() === "RESET") {
    await supabase.from("order_carts").update({ phase: "expired", test_mode: false, pending_disambiguation: null }).eq("id", cart.id);
    await supabase.from("conversations").update({ status: "resolved" }).eq("id", conversation.id);
    const reply = buildResetReply(effectiveOpen);
    await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
    {
      const savedMsgId = (await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply)).id;
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply, savedMsgId); return emptyTwiml(); }
    }
    return jsonResponse({ reply, cart: [], phase: "expired", session_id: sessionId });
  }

  // Short-circuit on terminal phases
  if (cart.phase === "confirmed") {
    const reply = "Your order is confirmed and paid. Thank you!";
    await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
    {
      const savedMsgId = (await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", reply)).id;
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, reply, savedMsgId); return emptyTwiml(); }
    }
    return jsonResponse({ reply, cart: cart.cart_json, phase: cart.phase, session_id: sessionId });
  }
  let checkoutWantsChangeFired = false;

  // ── Build effective menu ──────────────────────────────────────────────────
  const businessDate  = getBusinessDate(shop.timezone);
  const currentTime   = getCurrentTime(shop.timezone);
  // A test shop (is_test: Vito's) takes only test orders: test Stripe, the courier's sandbox, no hours gate.
  // Nobody types TESTMODE there; RESET starts a fresh test.
  if ((shop as { is_test?: boolean }).is_test === true && !cart.test_mode) {
    await supabase.from("order_carts").update({ test_mode: true }).eq("id", cart.id);
    cart.test_mode = true;
  }
  // ── Business hours check ────────────────────────────────────────────────
  // todayKey/todayHours/nowMins/isOpen/effectiveOpen are computed once, above,
  // before the RESET handler (which also needs to know if the kitchen is open).
  if (cart.phase === "greeting") {
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
        delivery_offer_made_at: null,
        name_confirm_pending_total_cents: null,
        checkout_intent_confirmed_at: null,
      }).eq("id", cart.id);
      cart.test_mode = true;
      cart.cart_json = [];
      cart.phase = "greeting";
      cart.notes = null;
      cart.delivery_offer_made_at = null;
      const ack = "Test mode: order just like it's real. At checkout you'll use a test card and won't be charged a cent.";
      await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
      {
        const savedMsgId = (await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", ack)).id;
        if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, ack, savedMsgId); return emptyTwiml(); }
      }
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
        delivery_offer_made_at: null,
        name_confirm_pending_total_cents: null,
        checkout_intent_confirmed_at: null,
      }).eq("id", cart.id);
      cart.test_mode = true;
      cart.cart_json = [];
      cart.phase = "greeting";
      cart.notes = null;
      cart.delivery_offer_made_at = null;
    }
    if (!effectiveOpen && !cart.test_mode) {
      const fmt12 = (t: string) => { const [h, m] = t.split(":").map(Number); const ampm = h >= 12 ? "p.m." : "a.m."; const h12 = h % 12 || 12; return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2,"0")} ${ampm}`; };
      const dayConf = shop.open_hours?.[todayKey];
      // Distinguish: explicitly closed (closed:true) vs. outside windows vs. unconfigured
      const isClosedAllDay = dayConf && typeof dayConf === "object" && !Array.isArray(dayConf) && dayConf.closed === true;
      if (isClosedAllDay) {
        const closedMsg = `Hey! The kitchen is closed today. We'll be back during regular hours — check back soon!`;
        await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
        {
          const savedMsgId = (await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", closedMsg)).id;
          if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, closedMsg, savedMsgId); return emptyTwiml(); }
        }
        return jsonResponse({ reply: closedMsg, cart: [], phase: "greeting", session_id: sessionId });
      }
      if (todayHours.length > 0) {
        const hoursDisplay = todayHours.map((h: { open: string; close: string }) => `${fmt12(h.open)}-${fmt12(h.close)}`).join(", ");
        const closedMsg = `Hey! The kitchen is closed right now. Today's hours are ${hoursDisplay}. Come back during business hours — you'll be happy you did!`;
        await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
        {
          const savedMsgId = (await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", closedMsg)).id;
          if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, closedMsg, savedMsgId); return emptyTwiml(); }
        }
        return jsonResponse({ reply: closedMsg, cart: [], phase: "greeting", session_id: sessionId });
      }
      else {
        const closedMsg = `Hey! We're not taking orders right now — check back soon!`;
        await saveMessage(supabase, conversation.id, shop.tenant_id, "customer", userMessage);
        {
          const savedMsgId = (await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", closedMsg)).id;
          if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, closedMsg, savedMsgId); return emptyTwiml(); }
        }
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
    {
      const savedMsgId = (await saveMessage(supabase, conversation.id, shop.tenant_id, "assistant", pauseMsg)).id;
      if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, pauseMsg, savedMsgId); return emptyTwiml(); }
    }
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
  if (checkoutWantsChangeFired) {
    // Context bridge: prevents the LLM from seeing "Payment link sent!" as the
    // last assistant turn and concluding the order is finalized. Injected into
    // the in-memory history only (never saved to DB) so it's invisible to
    // customers but visible to the LLM for this request, letting it correctly
    // process "add fries" / "change X" as a building-phase modification.
    history.push({ role: "assistant" as const, content: "No problem — I've cancelled that payment link. What would you like to change?" });
  }

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

  // ── Turn Engine routing (docs/specs/2026-09-14-turn-engine-oversight.md
  // §4 Phase 3) ──────────────────────────────────────────────────────────
  // The ONE branch that sends this turn to the code-owned engine
  // (turn-engine-runner.ts) instead of everything below. On this path,
  // runOrderingLoop, the turn-reconciler, and every guard from this point on
  // are bypassed — not modified, not deleted, just skipped. Off for every
  // shop today (shops.turn_engine_enabled defaults false, migration 141);
  // this branch does not run in production until the PO flips a shop's flag.
  // ── Clean-sheet engine routing (migration 147, engine/runner.ts) ─────────
  // One branch. Everything below it (turn engine, legacy loop, guards) is
  // bypassed for a shop with clean_engine_enabled = true.
  {
    const lastBot = [...history].reverse().find(h => h.role === "assistant")?.content ?? null;
    const engineModel = Deno.env.get("ENGINE_MODEL") ?? "claude-haiku-4-5";
    const engineProvider = (Deno.env.get("ENGINE_PROVIDER") ?? "anthropic") as "anthropic" | "openrouter";
    const engineKey = engineProvider === "anthropic" ? (Deno.env.get("ANTHROPIC_API_KEY") ?? "") : (Deno.env.get("OPENROUTER_API_KEY") ?? "");
    const courierShop = shop as { delivery_provider?: string | null; formatted_address?: string | null; courier_pickup_phone?: string | null };
    // items the shop marked sold out (86) today: the engine says so instead of selling them (admin-chat writes these)
    const { data: eightySix } = await supabase.from("availability_overrides").select("menu_item_id").eq("shop_id", shop.id).eq("business_date", getBusinessDate(shop.timezone ?? "America/New_York"));
    const engineOut = await runCleanEngineTurn(
      {
        shop: { id: shop.id, tenant_id: shop.tenant_id, name: shop.name, delivery_enabled: shop.delivery_enabled === true && !(shop.delivery_paused_until && new Date(shop.delivery_paused_until) > new Date()), delivery_fee_cents: shop.delivery_fee_cents, tax_rate_bps: shop.tax_rate_bps ?? 0, phone_number_e164: shop.phone_number_e164, latitude: shop.latitude, longitude: shop.longitude, delivery_radius_mi: shop.delivery_radius_mi, delivery_provider: courierShop.delivery_provider ?? "own", sold_out: ((eightySix ?? []) as Array<{ menu_item_id: string }>).map((r) => r.menu_item_id) },
        conversationId: conversation.id as string,
        cart: { id: cart.id, engine_form: cart.engine_form ?? null, test_mode: cart.test_mode, stripe_checkout_session_id: cart.stripe_checkout_session_id, notes: cart.notes },
        message: userMessage,
        lastBotMessage: lastBot,
        isFirstContact: isLifetimeFirstContact,
      },
      {
        supabase,
        model: { provider: engineProvider, model: engineModel, apiKey: engineKey, timeoutMs: 20000 },
        geocoder: googleGeocoder(Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "", { lat: shop.latitude, lng: shop.longitude, radius_mi: shop.delivery_radius_mi, ...localityOf((shop as { formatted_address?: string | null }).formatted_address) }),
        serviceFeeCents: SERVICE_FEE_CENTS,
        // courier shops (migration 148): the provider prices each address; the shop's own fee otherwise
        quoteDelivery: async (req) => {
          const p = providerFor(courierShop.delivery_provider, req.test || (shop as { is_test?: boolean }).is_test === true); // a test shop never quotes live
          if (!p || !courierShop.formatted_address) return { ok: false, code: "provider", error: !p ? `${courierShop.delivery_provider} credentials not configured` : "shop has no formatted_address" };
          try {
            const q = await p.quote({
              pickup: { name: shop.name, address: courierShop.formatted_address, lat: shop.latitude, lng: shop.longitude, phone: courierShop.courier_pickup_phone ?? shop.phone_number_e164 ?? "", notes: null },
              dropoff: { name: "Customer", address: req.formatted, lat: null, lng: null, phone: e164OrNull(customerPhone) ?? "", notes: null },
              order_value_cents: req.order_value_cents, external_id: req.cart_id,
            });
            return isQuoteError(q) ? { ok: false, code: q.code, error: q.error } : { ok: true, fee_cents: q.fee_cents, quote_id: q.quote_id };
          } catch (e) { return { ok: false, code: "unavailable", error: e instanceof Error ? e.message : String(e) }; }
        },
        createCheckout: async (req) => {
          const key = req.testMode ? (getTestModeStripeKey() ?? "") : (Deno.env.get("STRIPE_SECRET_KEY") ?? "");
          if (!key) return { ok: false, error: "payment system not configured" };
          const stripe = new Stripe(key, { apiVersion: "2023-10-16", httpClient: Stripe.createFetchHttpClient() });
          const sessionInput = buildEngineCheckoutSessionInput({
            cartId: req.cartId, shopName: req.shopName, testMode: req.testMode,
            cartLines: req.cartLines, notes: req.notes,
            orderType: req.orderType, deliveryFeeCents: req.deliveryFeeCents, tipCents: req.tipCents, taxCents: req.taxCents,
            connectedAccountId: (shop as { charges_enabled?: boolean; stripe_connected_account_id?: string | null }).charges_enabled ? (shop as { stripe_connected_account_id?: string | null }).stripe_connected_account_id ?? null : null,
            courierDelivery: req.courier,
            liveMoney: /^(sk|rk)_live_/.test(key),
            balanceOwedCents: (shop as { balance_owed_cents?: number }).balance_owed_cents ?? 0,
          });
          const r = await createCheckoutSession(sessionInput, { supabase, stripe });
          return r.ok ? { ok: true, sessionId: r.sessionId, url: r.checkoutUrl } : { ok: false, error: r.error };
        },
        expireCheckout: async (sessionId) => {
          const key = cart.test_mode ? (getTestModeStripeKey() ?? "") : (Deno.env.get("STRIPE_SECRET_KEY") ?? "");
          if (!key) return;
          const stripe = new Stripe(key, { apiVersion: "2023-10-16", httpClient: Stripe.createFetchHttpClient() });
          try { await stripe.checkout.sessions.expire(sessionId); } catch (e) { console.error("[chat-sms] expire session failed", e); }
        },
      },
    );
    const cleanReply = appendComplianceDisclosureIfFirstContact(engineOut.reply, isLifetimeFirstContact);
    if (isSms) { await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!, customerPhone, cleanReply, engineOut.assistantMessageId); return emptyTwiml(); }
    return jsonResponse({ reply: cleanReply, cart: (cart.cart_json ?? []), phase: cart.phase, session_id: sessionId, engine: "clean", ms: engineOut.ms });
  }

  } catch (turnErr) {
    // Catch-all for this turn. The tool-calling loop above logs its own
    // failures as stage "tool_loop" (and outbound sends log "outbound_send"
    // via guardedSend) and tags the error so it isn't double-logged here —
    // anything else that throws in this block (guards, rendering, cart
    // finalization) is genuinely a rendering-path failure.
    if (!(turnErr && typeof turnErr === "object" && (turnErr as { __errorLogged?: boolean }).__errorLogged)) {
      await logError(supabase, {
        conversationId: conversation.id as string,
        shopId: shop.id,
        tenantId: shop.tenant_id,
        phase: "chat-sms",
        stage: "render",
        customerMessage: userMessage,
        error: turnErr,
      });
    }
    throw turnErr;
  } finally {
    // Release the D3 turn lock (see acquire above) on every exit path —
    // every early return in the block above is inside this try, so this
    // always runs before the next inbound message for this conversation
    // can acquire it.
    if (turnLockAcquired) {
      await supabase.from("conversations").update({ processing_claimed_at: null }).eq("id", conversation.id);
    }
  }
}

if (import.meta.main) {
  Deno.serve(handleChatSmsRequest);
}
