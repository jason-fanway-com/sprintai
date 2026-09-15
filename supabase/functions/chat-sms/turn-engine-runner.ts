// Turn Engine, Phase 3b (docs/specs/2026-09-14-turn-engine-oversight.md §3b,
// §4 Phase 3). The I/O adapter around the pure engine (turn-engine.ts) and
// the model adapter (propose.ts). The cart and dialogue_state for this
// conversation arrive already loaded (index.ts's one routing branch loads
// them as part of its own shared cart-load step, same row both paths read)
// — this module's own "load" is reading them off its input, never a second
// query. From there it runs ANSWER -> PROPOSE (only when ANSWER cannot
// resolve the message deterministically) -> DECIDE -> ASK -> RENDER,
// persists the result, writes the outbound message, and returns the reply
// string.
//
// Every dependency (the Supabase client, the propose call, the clock, the
// line-key minter) is injected, same DI discipline as propose.ts, so this
// module is fully unit-testable with zero network calls and zero real
// Postgres writes — see turn-engine-runner.test.ts.
//
// ── Scope notes (read before extending) ─────────────────────────────────
//
// 1. Checkout/Stripe submission is NOT wired here. turn-engine.ts's own
//    ANSWER step already produces a `confirm_yes` outcome and ASK's own
//    state machine already walks phase -> "name" -> "confirm" -> "link_sent"
//    on it, but neither that module nor this one creates a real Stripe
//    checkout session or payment link — that I/O was not part of this
//    dispatch's deliverable list. A cart that reaches "link_sent" today
//    renders without a payment link. This is a real gap before the Phase 3
//    gate (docs/specs/2026-09-14-turn-engine-oversight.md §4) can be run —
//    flagged for the PO, not improvised here with an ad hoc Stripe call
//    that the money-path rules in AGENTS.md would rightly reject unreviewed.
//
// 2. Address collection is inert, for the reason turn-engine.ts's own header
//    (note 1) already flags: ANSWER's "address" case needs a geocode/zone-
//    check result handed in via AnswerExternalInputs, and nothing in this
//    dispatch's committed dependencies performs that geocode. This module
//    always calls answer() with no external inputs, so an "address" open
//    question never resolves via ANSWER — and PROPOSE's own Proposal
//    contract (§3c) has no address field either, so it can't resolve there
//    either. Net effect: a delivery order can reach the address question
//    but nothing yet answers it. Same disposition as note 1.
//
// 3. intent === "question"'s answer_text (§3b step 3's "warmth" exception)
//    is prepended verbatim ahead of RENDER's own output, rather than routed
//    through index.ts's stripFalseMutationClaims/stripLlmMoneyLines — those
//    are unexported, guard-shaped functions local to index.ts, and this
//    module (like turn-engine.ts and propose.ts before it) is New Files
//    Only. propose.ts's own prompt already constrains answer_text to "no
//    digits, no item names, at most two sentences" (see its
//    SYSTEM_PROMPT_PREAMBLE) — the same guarantee those two strip functions
//    exist to enforce after the fact for the legacy model-authored reply.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { buildMenuPriceIndex, type MenuItemForPricing } from "./itemizer.ts";
import { computeCartSubtotalCents } from "./pricing.ts";
import { SERVICE_FEE_CENTS } from "../_shared/connect.ts";
import type { LexiconTerm } from "./resolve-item.ts";
import { proposeTurn as defaultProposeTurn, type ProposeResult } from "./propose.ts";
import { logError, type ErrorLogStage } from "../_shared/error-log.ts";
import {
  answer,
  decide,
  ask,
  render,
  type DialogueState,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type AskShopContext,
  type AskTurnEvents,
  type Decline,
} from "./turn-engine.ts";

type ProposeTurnFn = typeof defaultProposeTurn;

// Matches index.ts's own literal fallback text (runOrderingLoop's terminal
// failure reply) — not imported, since that function isn't exported, but
// deliberately kept byte-identical so the customer-facing behavior of a
// failed model call doesn't change shape between the two paths.
export const FALLBACK_REPLY = "Sorry, I ran into a problem. Please call us directly to place your order.";

export const INITIAL_DIALOGUE_STATE: DialogueState = {
  phase: "ordering",
  open: null,
  upsell_offered: false,
  asked_message_id: null,
};

export interface RunTurnShopContext {
  deliveryEnabled: boolean;
  orderType: "pickup" | "delivery" | null;
  deliveryAddressKnown: boolean;
  driverTipCents: number | null;
  pickupName: string | null;
  deliveryFeeCents: number | null;
}

export interface RunTurnInput {
  conversationId: string;
  shopId: string;
  tenantId: string;
  cartId: string;
  message: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  menu: TurnEngineMenuItem[];
  cart: TurnEngineCartLine[];
  dialogueState: DialogueState | null;
  shopContext: RunTurnShopContext;
}

export interface RunTurnDeps {
  supabase: SupabaseClient;
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  model?: string;
  chatApiUrl?: string;
  timeoutMs?: number;
  // Mints a stable line_key for a genuinely new cart line (decide()'s own
  // param — see turn-engine.ts). Defaults to crypto.randomUUID(); tests pass
  // a counter for deterministic assertions.
  newLineKey?: () => string;
  // DI seam for tests — defaults to the real proposeTurn (propose.ts). Never
  // re-implemented here; see this file's header note 3 and propose.ts's own
  // header for why the PROPOSE call and its error_log write live in exactly
  // one place.
  proposeTurnFn?: ProposeTurnFn;
}

export interface RunTurnResult {
  reply: string;
  cart: TurnEngineCartLine[];
  dialogueState: DialogueState;
}

interface CartSideEffects {
  order_type?: "pickup" | "delivery";
  driver_tip_cents?: number;
  pickup_name?: string;
}

async function loadUpsellEnabled(supabase: SupabaseClient, shopId: string): Promise<boolean> {
  const { data } = await supabase
    .from("shop_settings").select("upsell_enabled").eq("shop_id", shopId).maybeSingle();
  return (data as { upsell_enabled?: boolean } | null)?.upsell_enabled ?? true;
}

// PostgREST silently caps an unbounded select at 1000 rows — no error, no
// truncation flag, just fewer rows than the table actually has (same failure
// shape index.ts's own fetchAllRows exists to close for option_choices, see
// its header comment). Vito's crossed this exact cliff live on its own item
// lexicon (1298 active terms, turn_engine_enabled flip 2026-09-15): the
// silently-dropped 298 rows included "cheeseburger", so PROPOSE/DECIDE never
// had a chance to resolve it, no matter how correct resolve-item.ts is.
// Page with .range() until a page comes back short of the page size — never
// a bigger fixed cap, which just moves the same cliff to the next shop.
const ITEM_LEXICON_PAGE_SIZE = 1000;

// "lexicon_load" is a real error_log.stage value (migration 142), added
// because none of the five values error-log.ts's ErrorLogStage union
// already allows ('tool_loop', 'render', 'outbound_send', 'guard_deny',
// 'propose_call') honestly describes a lexicon-load failure — same
// reasoning migration 140 used to add 'propose_call'. error-log.ts itself
// is out of this dispatch's scope (only this file and its test file may
// change), so ErrorLogStage hasn't been widened to include it yet; this
// cast is the documented seam until it is.
const LEXICON_LOAD_STAGE = "lexicon_load" as unknown as ErrorLogStage;

interface LexiconLoadResult {
  // false means the fetch did NOT complete trustworthily — `rows` is an
  // arbitrary partial list (however many pages loaded before the error),
  // never a stand-in for "the whole lexicon". Callers must not treat it
  // as one, same discipline as propose.ts's ProposeResult.ok.
  ok: boolean;
  rows: LexiconTerm[];
}

async function loadItemLexicon(supabase: SupabaseClient, shopId: string): Promise<LexiconLoadResult> {
  const rows: LexiconTerm[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("lexicon").select("term, target_id")
      .eq("shop_id", shopId).eq("target_type", "item").eq("active", true)
      .order("id", { ascending: true })
      .range(from, from + ITEM_LEXICON_PAGE_SIZE - 1);
    if (error) {
      // A real PostgREST error on this page is NOT the same thing as a
      // short/empty page — that's a normal, expected finish. This is a
      // failed fetch: `rows` holds whatever pages loaded before it, an
      // arbitrary partial list, not a complete lexicon. Must not be
      // silently treated as done (the exact failure class b2440886 closed
      // one level down, just moved up to this loop).
      await logError(supabase, {
        shopId,
        phase: "chat-sms",
        stage: LEXICON_LOAD_STAGE,
        error,
        metadata: { offset: from, rows_loaded_before_error: rows.length },
      });
      return { ok: false, rows };
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as LexiconTerm[]));
    if (data.length < ITEM_LEXICON_PAGE_SIZE) break;
    from += ITEM_LEXICON_PAGE_SIZE;
  }

  // Pagination finishing with no error (ending on a short/empty page) does
  // not by itself prove `rows` holds every active row — an independent
  // count-only query against the exact same three filters is the only way
  // to catch a paginated fetch that "completed" but still disagrees with
  // the table (stale read, concurrent write, off-by-one in the paging
  // bounds, etc.). This never blocks the turn — it's an observability
  // guard, not a second failure path — it only logs the disagreement.
  const { count, error: countError } = await supabase
    .from("lexicon")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId).eq("target_type", "item").eq("active", true);
  if (!countError && count != null && count !== rows.length) {
    await logError(supabase, {
      shopId,
      phase: "chat-sms",
      stage: LEXICON_LOAD_STAGE,
      error: new Error(`lexicon count mismatch: expected ${count}, loaded ${rows.length}`),
      metadata: { expected_count: count, loaded_count: rows.length },
    });
  }

  return { ok: true, rows };
}

function buildAskShopContext(shopContext: RunTurnShopContext, upsellEnabled: boolean): AskShopContext {
  return {
    deliveryEnabled: shopContext.deliveryEnabled,
    upsellEnabled,
    orderTypeKnown: shopContext.orderType != null,
    orderTypeIsDelivery: shopContext.orderType === "delivery",
    deliveryAddressKnown: shopContext.deliveryAddressKnown,
    driverTipKnown: shopContext.driverTipCents != null,
    pickupNameKnown: !!shopContext.pickupName,
  };
}

async function persistOutboundOnly(
  supabase: SupabaseClient,
  input: RunTurnInput,
  reply: string,
): Promise<void> {
  await supabase.from("messages").insert({
    conversation_id: input.conversationId,
    tenant_id: input.tenantId,
    role: "assistant",
    content: reply,
  });
}

async function persistTurn(
  supabase: SupabaseClient,
  input: RunTurnInput,
  cart: TurnEngineCartLine[],
  dialogueState: DialogueState,
  sideEffects: CartSideEffects,
  reply: string,
  deliveryFeeCents: number,
  driverTipCents: number,
): Promise<void> {
  // Same source of truth as the reply footer (RENDER's renderItemizedRecap/
  // renderLedgerFooter, itemizer.ts) and the Stripe checkout total
  // (createCheckoutSession, checkout-session.ts) — computeCartSubtotalCents
  // is pricing.ts's own single tested source for this sum, never
  // reimplemented here. Without this write, anything reading the DB row
  // directly (acceptance canary, admin dashboard, Expo app, analytics) saw
  // subtotal_cents = 0 even on a cart/reply that were themselves correct.
  const subtotalCents = computeCartSubtotalCents(cart);
  const totalCents = subtotalCents + SERVICE_FEE_CENTS + deliveryFeeCents + driverTipCents;

  await supabase.from("order_carts").update({
    cart_json: cart, // single-writer:blessed — persistTurn is THE engine-path persister; saveCart (index.ts) is its legacy-path counterpart
    dialogue_state: dialogueState,
    phase: cart.length > 0 ? "building" : "greeting",
    subtotal_cents: subtotalCents,
    total_cents: totalCents,
    ...sideEffects,
  }).eq("id", input.cartId);

  await supabase.from("messages").insert({
    conversation_id: input.conversationId,
    tenant_id: input.tenantId,
    role: "assistant",
    content: reply,
  });
}

export async function runTurnEngineTurn(input: RunTurnInput, deps: RunTurnDeps): Promise<RunTurnResult> {
  const priorState = input.dialogueState ?? INITIAL_DIALOGUE_STATE;
  const cartBefore = input.cart.map(l => ({ ...l }));
  // answer() mutates its cart argument in place (turn-engine.ts's own
  // contract); decide() below never does (it returns a new array) — this
  // single mutable working copy is correct for both call shapes.
  const workingCart: TurnEngineCartLine[] = input.cart.map(l => ({ ...l }));

  const upsellEnabled = await loadUpsellEnabled(deps.supabase, input.shopId);

  let declines: Decline[] = [];
  let turnEvents: AskTurnEvents = {
    qualifyingAddMenuItemId: null,
    disambiguationCandidateIds: null,
    carriedDisambiguationCandidateIds: [],
    disambiguationSettledThisTurn: false,
    checkoutIntentThisTurn: false,
    confirmYes: false,
    confirmNo: false,
  };
  let sideEffects: CartSideEffects = {};
  let answerText: string | undefined;

  // ── STEP 2: ANSWER ───────────────────────────────────────────────────────
  const answerResult = answer(priorState, workingCart, input.message, input.menu);
  // priorState.open can ONLY be resolved through the "disambiguation" case
  // of answer()'s own switch (turn-engine.ts) when it was already that kind
  // -- so `resolved: true` here can only mean THAT disambiguation was just
  // settled (a candidate resolved, or the customer declined it), never a
  // coincidental resolution of something else. See turn-engine.ts's ask(),
  // priority 2b, for what this unlocks.
  const priorOpenWasDisambiguation = priorState.open?.kind === "disambiguation";

  if (answerResult.resolved) {
    turnEvents = { ...turnEvents, disambiguationSettledThisTurn: priorOpenWasDisambiguation };
    const outcome = answerResult.outcome;
    switch (outcome.kind) {
      case "order_type_resolved":
        sideEffects = { ...sideEffects, order_type: outcome.orderType };
        break;
      case "tip_resolved":
        sideEffects = { ...sideEffects, driver_tip_cents: outcome.tipCents };
        break;
      case "name_resolved":
        sideEffects = { ...sideEffects, pickup_name: outcome.name };
        break;
      case "checkout_intent":
        turnEvents = { ...turnEvents, checkoutIntentThisTurn: true };
        break;
      case "confirm_yes":
        turnEvents = { ...turnEvents, confirmYes: true };
        break;
      case "confirm_no":
        turnEvents = { ...turnEvents, confirmNo: true };
        break;
      case "disambiguation_resolved":
        // Same "unit added" event decide()'s own qualifyingAddMenuItemId
        // documents — an ANSWER-resolved disambiguation add qualifies for
        // the upsell step exactly the same way a DECIDE-resolved one does.
        if (answerResult.cartChanged) {
          turnEvents = { ...turnEvents, qualifyingAddMenuItemId: outcome.menuItemId };
        }
        break;
      // slot_resolved / address_resolved / address_declined / upsell_accepted /
      // upsell_declined / closure: cart already mutated in place by answer()
      // where relevant, nothing else to persist or feed into ASK.
      default:
        break;
    }
  } else {
    // ── STEP 3: PROPOSE (only reached when ANSWER cannot resolve this
    // message deterministically — no model call otherwise) ────────────────
    const lexiconResult = await loadItemLexicon(deps.supabase, input.shopId);
    if (!lexiconResult.ok) {
      // Same terminal-failure shape as a PROPOSE failure below: nothing
      // changed this turn, only the fallback reply is written to messages.
      // loadItemLexicon has already persisted its own error_log row.
      await persistOutboundOnly(deps.supabase, input, FALLBACK_REPLY);
      return { reply: FALLBACK_REPLY, cart: input.cart, dialogueState: priorState };
    }
    const lexicon = lexiconResult.rows;
    const proposeFn: ProposeTurnFn = deps.proposeTurnFn ?? defaultProposeTurn;
    const proposeResult: ProposeResult = await proposeFn(
      {
        cart: workingCart,
        open: priorState.open,
        menu: input.menu,
        lexicon,
        history: input.history,
        message: input.message,
      },
      {
        supabase: deps.supabase,
        apiKey: deps.apiKey,
        fetchImpl: deps.fetchImpl,
        now: deps.now,
        model: deps.model,
        chatApiUrl: deps.chatApiUrl,
        timeoutMs: deps.timeoutMs,
        conversationId: input.conversationId,
        shopId: input.shopId,
        tenantId: input.tenantId,
      },
    );

    if (!proposeResult.ok) {
      // proposeTurn() has already persisted the error_log row itself (stage:
      // "propose_call", raw response attached) — see propose.ts. Nothing
      // changed this turn: cart and dialogue_state are left exactly as they
      // were, and only the fallback reply is written to messages.
      await persistOutboundOnly(deps.supabase, input, FALLBACK_REPLY);
      return { reply: FALLBACK_REPLY, cart: input.cart, dialogueState: priorState };
    }

    // ── STEP 4: DECIDE ─────────────────────────────────────────────────────
    const proposal = proposeResult.proposal;
    const decideResult = decide(
      proposal,
      workingCart,
      input.menu,
      lexicon,
      deps.newLineKey ?? (() => crypto.randomUUID()),
    );
    workingCart.splice(0, workingCart.length, ...decideResult.cart);
    declines = decideResult.declines;
    turnEvents = {
      ...turnEvents,
      qualifyingAddMenuItemId: decideResult.qualifyingAddMenuItemId,
      disambiguationCandidateIds: decideResult.disambiguationCandidateIds,
      carriedDisambiguationCandidateIds: decideResult.carriedDisambiguationCandidateIds,
      checkoutIntentThisTurn: proposal.intent === "checkout",
    };
    if (proposal.intent === "question" && proposal.answer_text) {
      answerText = proposal.answer_text;
    }
  }

  // ── STEP 5: ASK ───────────────────────────────────────────────────────────
  const shopContext = buildAskShopContext(input.shopContext, upsellEnabled);
  const nextState = ask(workingCart, priorState, turnEvents, shopContext, input.menu);

  // ── STEP 6: RENDER ─────────────────────────────────────────────────────────
  // Same values feed persistTurn's total_cents below — one computation, not
  // a second copy that could drift from what the reply footer shows.
  const deliveryFeeCents = input.shopContext.deliveryFeeCents ?? 0;
  const driverTipCents = sideEffects.driver_tip_cents ?? input.shopContext.driverTipCents ?? 0;
  const rendered = render(cartBefore, workingCart, nextState, declines, input.menu, {
    deliveryFeeCents: deliveryFeeCents || undefined,
    driverTipCents: driverTipCents || undefined,
    // TurnEngineMenuItem's option_groups/ask_plan shape is a superset of what
    // buildMenuPriceIndex needs (id-based compiled option groups vs. its
    // legacy name/choices shape) — only the ask_plan.steps branch is ever
    // populated on a compiled item, which is exactly what this path prices.
    priceIndexByMenuItemId: buildMenuPriceIndex(input.menu as unknown as MenuItemForPricing[]),
  });
  const reply = answerText ? `${answerText}\n\n${rendered}` : rendered;

  // ── STEP 7: PERSIST ────────────────────────────────────────────────────────
  await persistTurn(deps.supabase, input, workingCart, nextState, sideEffects, reply, deliveryFeeCents, driverTipCents);

  return { reply, cart: workingCart, dialogueState: nextState };
}
