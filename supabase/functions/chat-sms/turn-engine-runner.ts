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
// 2. FIXED (2026-09-16, dispatch 00-AH — address slot never resolves, three
//    shops rolled back to the legacy engine pending this fix). Address
//    collection used to be permanently inert: ANSWER's "address" case
//    (turn-engine.ts) needs a geocode/zone-check result handed in via
//    AnswerExternalInputs, and this module never attempted that geocode —
//    so the address question re-asked forever, and free text answered while
//    it was open (e.g. a customer's name) fell through to PROPOSE with no
//    guard, letting the model mutate the cart in response to text that was
//    never an order. Deliberately NOT fixed by having the model parse the
//    address (propose.ts's Proposal contract §3c has no address field, and
//    an LLM call is not a deterministic resolver) — geocodeAddress below
//    sends the customer's raw message straight to Google's geocoder exactly
//    as index.ts's own set_delivery_address tool does (same qualification
//    rule: non-partial ROOFTOP/RANGE_INTERPOLATED, same haversine zone
//    check), and its result is what answer() consumes. This also means a
//    message that ISN'T an address (a name, "thats it", garbled text)
//    geocodes to no qualified match and resolves deterministically to
//    address_declined — never reaching PROPOSE, never touching the cart.
//    See loadShopGeo/geocodeAddress and the ANSWER step below.
//
//    EXTENDED (2026-09-16, dispatch 00-AP — address embedded in a sentence,
//    or stated on a turn where a DIFFERENT question was open, never
//    resolved). The fix above only ever geocoded the message when it was
//    the entire address AND the open question was already "address" — a
//    real customer routinely states the address inside a longer sentence
//    ("delivery to X", "it's X please") and/or in the same breath as
//    answering whatever else is open (a Temp slot, in the live report), so
//    neither condition reliably held. extractAddressSpan finds the
//    candidate number+street(+city/state/zip) substring deterministically;
//    geocodeFn is the exact same resolver as above either way — this never
//    added a second geocode mechanism, only a span to feed the existing one
//    and a second call SITE (opportunistic, independent of what's open) that
//    shares it. See extractAddressSpan and the ANSWER step's
//    addressOpen/opportunisticAddress below.
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
import { extractCustomerName } from "./dialogue-signals.ts";   // 00-BL
import { SERVICE_FEE_CENTS } from "../_shared/connect.ts";
import type { LexiconTerm } from "./resolve-item.ts";
import { proposeTurn as defaultProposeTurn, type ProposeResult } from "./propose.ts";
import { logError, type ErrorLogStage } from "../_shared/error-log.ts";
import { isDisambiguationOptionsRequest, isDisambiguationListDropSignal, categoryDisplayWord } from "./pending-disambiguation.ts";
import {
  answer,
  decide,
  ask,
  render,
  extractSlotChoiceWords,
  orderShapedMessageQuantity,
  disambiguationDeclineNamesOutsideItem,
  readOrderTypeReply,
  type AnswerExternalInputs,
  type DialogueState,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type AskShopContext,
  type AskTurnEvents,
  type Decline,
  type Proposal,
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
  // DI seam for tests — defaults to defaultGeocodeAddress (a real Google
  // Maps Geocoding API call). See this file's header note 2.
  geocodeAddressFn?: GeocodeAddressFn;
  // Defaults to Deno.env.get("GOOGLE_MAPS_API_KEY") — same env var
  // index.ts's own set_delivery_address tool reads.
  googleMapsApiKey?: string;
}

export interface RunTurnResult {
  reply: string;
  cart: TurnEngineCartLine[];
  dialogueState: DialogueState;
  // P0 fix (2026-09-19): the `messages` row id this turn's assistant reply
  // was saved under — index.ts's turn_engine_enabled branch hands this to
  // sendSms so the carrier's own message id can be written back onto THIS
  // row once the send actually succeeds. See persistTurn/persistOutboundOnly
  // below and saveMessage's own comment in index.ts for why NULL otherwise
  // means nothing (every successful send left it NULL too).
  messageId: string | null;
}

interface CartSideEffects {
  order_type?: "pickup" | "delivery";
  driver_tip_cents?: number;
  pickup_name?: string;
  // Dispatch 00-AH: the shape consumers elsewhere read off order_carts.
  // delivery_address (e.g. delivery-memory-offer.ts's ".formatted" reads) —
  // no street/city/state/zip breakdown, since geocodeAddress never parses
  // those out of the raw text (see this file's header note 2).
  delivery_address?: { formatted: string };
}

async function loadUpsellEnabled(supabase: SupabaseClient, shopId: string): Promise<boolean> {
  const { data } = await supabase
    .from("shop_settings").select("upsell_enabled").eq("shop_id", shopId).maybeSingle();
  return (data as { upsell_enabled?: boolean } | null)?.upsell_enabled ?? true;
}

// Round 3, item 2c(ii): shop_settings.hours_line is already formatted
// human-readable text (never assembled here from the raw open_hours JSON) —
// read ONLY when a confirm-stage question actually needs it (see the
// "confirm" open branch below), same lazy-load discipline as
// loadItemLexicon's disambiguation-only load above.
async function loadHoursLine(supabase: SupabaseClient, shopId: string): Promise<string | null> {
  const { data } = await supabase
    .from("shop_settings").select("hours_line").eq("shop_id", shopId).maybeSingle();
  return (data as { hours_line?: string | null } | null)?.hours_line ?? null;
}

// ── Address geocode (dispatch 00-AH) ────────────────────────────────────────
// See this file's header note 2. shopGeo is read directly off `shops` here
// (own query, same DI-free-read pattern as loadUpsellEnabled above) rather
// than threaded through RunTurnShopContext, so wiring this up never requires
// touching index.ts's call site.

export interface ShopGeo { lat: number; lng: number; radiusMi: number }

async function loadShopGeo(supabase: SupabaseClient, shopId: string): Promise<ShopGeo | null> {
  const { data } = await supabase
    .from("shops").select("latitude, longitude, delivery_radius_mi").eq("id", shopId).maybeSingle();
  const row = data as { latitude?: number | null; longitude?: number | null; delivery_radius_mi?: number | null } | null;
  if (!row || row.latitude == null || row.longitude == null || !row.delivery_radius_mi || row.delivery_radius_mi <= 0) {
    return null;
  }
  return { lat: row.latitude, lng: row.longitude, radiusMi: row.delivery_radius_mi };
}

// Same formula as index.ts's own haversineMiles (set_delivery_address's zone
// check) — duplicated rather than imported since index.ts's copy is a local,
// unexported function and this module is New Files Only (see header).
function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// The deterministic, non-LLM resolver turn-engine.ts's own header (note 1)
// names as the intended mechanism for the "address" ANSWER case: send the
// customer's raw text to Google's geocoder and let ITS qualification
// decide, never a model guess at street/city/state/zip fields. Same
// qualification rule as index.ts's set_delivery_address tool (non-partial
// match, ROOFTOP/RANGE_INTERPOLATED precision, within the shop's own
// haversine radius) — a message that isn't a real, in-zone address (a
// customer's name, "thats it", garbled text) simply fails to qualify and
// this returns null, which answer() reads as address_declined: resolved,
// deterministic, and it never touches the cart.
export type GeocodeAddressFn = (
  address: string,
  shopGeo: ShopGeo | null,
  io: { fetchImpl: typeof fetch; apiKey: string },
) => Promise<{ formatted: string; withinZone: boolean } | null>;

const defaultGeocodeAddress: GeocodeAddressFn = async (address, shopGeo, { fetchImpl, apiKey }) => {
  if (!shopGeo || !apiKey) return null;
  type GeoResult = {
    status: string;
    results: Array<{
      formatted_address?: string;
      geometry: { location: { lat: number; lng: number }; location_type?: string };
      partial_match?: boolean;
    }>;
  };
  const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  let geoJson: GeoResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetchImpl(geoUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status >= 500) throw new Error(`geocode HTTP ${res.status}`);
      geoJson = await res.json() as GeoResult;
      break;
    } catch (_err) {
      if (attempt === 0) continue;
      return null;
    }
  }
  if (!geoJson) return null;
  const top = geoJson.results[0];
  const qualified = geoJson.status === "OK" && geoJson.results.length > 0 && top.partial_match !== true &&
    (top.geometry.location_type === "ROOFTOP" || top.geometry.location_type === "RANGE_INTERPOLATED");
  if (!qualified) return null;
  const loc = top.geometry.location;
  const distance = haversineMiles(shopGeo.lat, shopGeo.lng, loc.lat, loc.lng);
  if (distance > shopGeo.radiusMi) return null;
  return { formatted: top.formatted_address ?? address, withinZone: true };
};

// ── Address span extraction (dispatch 00-AP) ────────────────────────────────
// 00-AH wired defaultGeocodeAddress in but only ever called it with the
// customer's ENTIRE trimmed message — fine when the message IS the address
// verbatim, but a real customer embeds it in a sentence ("deliver to X",
// "it's X please", a leading "yeah" or a trailing "thanks") far more often
// than not, and a full sentence handed to Google's geocoder routinely comes
// back without ROOFTOP/RANGE_INTERPOLATED precision (or partial_match=true),
// which defaultGeocodeAddress correctly refuses to qualify — so the address
// silently never resolved even though the customer typed it correctly, three
// turns running (dispatch 00-AP report). This extracts the number+street(
// +city/state/zip) substring deterministically (no LLM, no second geocode
// resolver) so THAT substring — not the raw message — is what actually gets
// geocoded; qualification is still decided entirely by geocodeAddressFn
// itself, unchanged. Returns null when nothing address-shaped is present —
// callers must keep treating that as "no candidate this turn", never as a
// hallucinated match.
const STREET_SUFFIX_ALTERNATION =
  "(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Dr(?:ive)?|Ln|Lane|Blvd|Boulevard|Ct|Court|Pl(?:ace)?|Way|Ter(?:race)?|Cir(?:cle)?|Pkwy|Parkway|Hwy|Highway|Sq(?:uare)?|Trl|Trail|Loop)";
const STREET_CORE_RE = new RegExp(
  // \b after the suffix alternation is load-bearing: without it, a greedy
  // backtrack of the {0,4} filler-word group can land the suffix match on a
  // partial word instead — e.g. "...18106 please" matching "Pl" (from the
  // "Pl(?:ace)?" alternative) as if "please" were "Place", extending the
  // captured span into the next word entirely. Caught by the phrasing
  // matrix's "X please" case, RED before this \b was added.
  `\\d{1,6}\\s+[A-Za-z0-9.'-]+(?:\\s+[A-Za-z0-9.'-]+){0,4}\\s+${STREET_SUFFIX_ALTERNATION}\\b\\.?`,
  "i",
);
// A city/state/zip immediately trailing the street core — ", Allentown PA
// 18106", " Allentown, PA 18106", etc. Optional: a bare street core with no
// trailing city/state/zip is still a legitimate candidate to hand to
// Google's own geocoder (which applies its own locality bias).
const TRAILING_CITY_STATE_ZIP_RE =
  /^[,\s]+([A-Za-z][A-Za-z .'-]*?)[,\s]+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\b/;

export function extractAddressSpan(message: string): string | null {
  const core = STREET_CORE_RE.exec(message);
  if (!core) return null;
  let end = core.index + core[0].length;
  const tail = TRAILING_CITY_STATE_ZIP_RE.exec(message.slice(end));
  if (tail) end += tail[0].length;
  return message.slice(core.index, end).trim().replace(/[.,]+$/, "");
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

// resolveItem's category/size_label narrowing (resolve-item.ts, 2026-09-18
// PO dispatch) is dead weight on the live path unless the lexicon rows it
// receives actually carry those two fields — the `lexicon` table itself has
// neither, only `term`/`target_id`, so they have to be joined in from
// `menu_items` (keyed by target_id) on the same load. There is no foreign
// key from lexicon.target_id (TEXT) to menu_items.id (UUID), so PostgREST
// cannot embed this in the primary select — a second, explicit query is the
// only option, per this dispatch's own instructions.
//
// Batched the same way index.ts's buildEffectiveMenu already had to batch
// option_groups/option_choices lookups: an `.in("id", ids)` filter whose
// value list scales with the page (up to 1000 distinct target_ids) can make
// the request URL long enough to fail outright (TypeError: fetch failed),
// not a graceful PostgREST error — see index.ts's own IN_BATCH_SIZE comment
// for the live incident this exact failure class caused on Zio's. index.ts
// is frozen and out of this dispatch's scope, so the batching constant is
// duplicated here rather than imported.
const LEXICON_ITEM_METADATA_BATCH_SIZE = 150;

// lexicon.target_id is TEXT with no FK to menu_items.id (see comment above):
// live data (Vito's) has non-UUID target_ids like "derived:<uuid>:0:0" mixed
// in among real menu_items.id values. Sending even one non-UUID string into
// `.in("id", batch)` against menu_items.id (a UUID column) fails the ENTIRE
// batch with Postgres error 22P02 ("invalid input syntax for type uuid") —
// not just the offending row — silently dropping category/size_label for
// every other, valid target_id that happened to share its batch. Filtering
// non-UUID-shaped ids out before the query keeps them (correctly) unmatched
// without poisoning the real ids around them.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LexiconItemMetadata {
  category: string | null;
  size_label: string | null;
  bot_state: string | null;
}

// Best-effort: a failure here must never fail the lexicon load itself (the
// loud count assertion below still protects term/target_id completeness).
// Losing narrowing metadata for some targets only means resolveItem falls
// back to its pre-existing (pre-narrowing) behavior for those terms, per its
// own documented contract for when category/size_label are absent — never a
// reason to drop or fail the whole turn.
// PO dispatch (2026-09-19, dangling-lexicon-terms P0, required fix item 3):
// returns the count of non-UUID target_ids this call filtered out alongside
// the metadata map, so the caller (loadItemLexicon) can log a real,
// permanent trip-wire instead of silently discarding them the way a9978826
// did — that silence is exactly what let months of dangling derived-row
// lexicon terms hide in production. This never blocks or fails the turn on
// its own; it's an observability signal, same discipline as the count-
// mismatch check loadItemLexicon already runs after pagination.
async function loadLexiconItemMetadata(
  supabase: SupabaseClient,
  shopId: string,
  targetIds: string[],
): Promise<{ metaByTargetId: Map<string, LexiconItemMetadata>; droppedNonUuidCount: number }> {
  const metaByTargetId = new Map<string, LexiconItemMetadata>();
  const uuidTargetIds = targetIds.filter((id) => UUID_RE.test(id));
  const droppedNonUuidCount = targetIds.length - uuidTargetIds.length;
  for (let i = 0; i < uuidTargetIds.length; i += LEXICON_ITEM_METADATA_BATCH_SIZE) {
    const batch = uuidTargetIds.slice(i, i + LEXICON_ITEM_METADATA_BATCH_SIZE);
    try {
      const { data, error } = await supabase
        .from("menu_items")
        .select("id, category, size_label, bot_state")
        .in("id", batch);
      if (error) {
        await logError(supabase, {
          shopId,
          phase: "chat-sms",
          stage: LEXICON_LOAD_STAGE,
          error,
          metadata: { step: "lexicon_item_metadata", batch_size: batch.length },
        });
        continue;
      }
      for (const row of (data ?? []) as Array<{ id: string; category: string | null; size_label: string | null; bot_state: string | null }>) {
        metaByTargetId.set(row.id, { category: row.category, size_label: row.size_label, bot_state: row.bot_state });
      }
    } catch (thrown) {
      await logError(supabase, {
        shopId,
        phase: "chat-sms",
        stage: LEXICON_LOAD_STAGE,
        error: thrown instanceof Error ? thrown : new Error(String(thrown)),
        metadata: { step: "lexicon_item_metadata", batch_size: batch.length },
      });
    }
  }
  return { metaByTargetId, droppedNonUuidCount };
}

async function loadItemLexicon(supabase: SupabaseClient, shopId: string): Promise<LexiconLoadResult> {
  const rows: LexiconTerm[] = [];
  let totalDroppedNonUuid = 0;
  // Defensive, belt-and-suspenders drop: the compiler (compile-menu.ts) no
  // longer emits a lexicon term for a non-orderable row (display_only,
  // blocked, ...) going forward, but an already-compiled shop can still
  // carry stale terms from before that fix until it's recompiled — see
  // this dispatch's own header. Dropping them here too means a live shop
  // never has to wait on a recompile to stop offering a non-sellable row
  // (e.g. Vito's $0.00 "Ranch [Pizza Finish]") as a resolver candidate.
  let totalDroppedNonOrderable = 0;
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
    const page = data as Array<{ term: string; target_id: string }>;
    const pageTargetIds = [...new Set(page.map(r => r.target_id))];
    const { metaByTargetId, droppedNonUuidCount } = await loadLexiconItemMetadata(supabase, shopId, pageTargetIds);
    totalDroppedNonUuid += droppedNonUuidCount;
    for (const r of page) {
      const meta = metaByTargetId.get(r.target_id);
      // Only drop when the row's bot_state is POSITIVELY known and
      // non-orderable — a lookup miss (metadata query failed, or the
      // target_id is non-UUID) must fall through to the pre-existing
      // behavior, same discipline as the category/size_label fallback
      // above it, never a reason to drop an otherwise-valid term.
      if (meta && meta.bot_state !== null && meta.bot_state !== "orderable") {
        totalDroppedNonOrderable++;
        continue;
      }
      rows.push({
        term: r.term,
        target_id: r.target_id,
        category: meta?.category ?? null,
        size_label: meta?.size_label ?? null,
      });
    }
    if (data.length < ITEM_LEXICON_PAGE_SIZE) break;
    from += ITEM_LEXICON_PAGE_SIZE;
  }

  // PO dispatch (2026-09-19, dangling-lexicon-terms P0, required fix item 3):
  // a9978826's UUID filter above silently dropped every non-UUID target_id
  // (exactly what every derived-row term carried before that dispatch's own
  // compiler fix) with no signal anywhere that it had happened — months of
  // dead derived rows hid behind that silence. Logged once per turn (total
  // across every page of this load), never blocking: this is a trip-wire,
  // not a new failure path. A shop with a clean lexicon logs nothing here.
  if (totalDroppedNonUuid > 0) {
    await logError(supabase, {
      shopId,
      phase: "chat-sms",
      stage: LEXICON_LOAD_STAGE,
      error: new Error(`lexicon load dropped ${totalDroppedNonUuid} non-UUID target_id(s) before menu_items lookup`),
      metadata: { dropped_non_uuid_count: totalDroppedNonUuid },
    });
  }

  // Pagination finishing with no error (ending on a short/empty page) does
  // not by itself prove `rows` holds every active row — an independent
  // count-only query against the exact same three filters is the only way
  // to catch a paginated fetch that "completed" but still disagrees with
  // the table (stale read, concurrent write, off-by-one in the paging
  // bounds, etc.). This never blocks the turn — it's an observability
  // guard, not a second failure path — it only logs the disagreement.
  // Expected count is reduced by totalDroppedNonOrderable: those rows were
  // deliberately excluded above, not lost — counting them as missing would
  // make every shop with a stale non-orderable lexicon term (until its next
  // recompile) log a permanent false-positive mismatch every single turn.
  const { count, error: countError } = await supabase
    .from("lexicon")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId).eq("target_type", "item").eq("active", true);
  if (!countError && count != null && count - totalDroppedNonOrderable !== rows.length) {
    await logError(supabase, {
      shopId,
      phase: "chat-sms",
      stage: LEXICON_LOAD_STAGE,
      error: new Error(`lexicon count mismatch: expected ${count - totalDroppedNonOrderable}, loaded ${rows.length}`),
      metadata: { expected_count: count, dropped_non_orderable_count: totalDroppedNonOrderable, loaded_count: rows.length },
    });
  }

  // Trip-wire, same discipline as the non-UUID drop above: a shop whose
  // lexicon is clean (already recompiled since this fix) logs nothing here.
  if (totalDroppedNonOrderable > 0) {
    await logError(supabase, {
      shopId,
      phase: "chat-sms",
      stage: LEXICON_LOAD_STAGE,
      error: new Error(`lexicon load dropped ${totalDroppedNonOrderable} non-orderable target_id(s) — stale term(s) from before a shop-level recompile`),
      metadata: { dropped_non_orderable_count: totalDroppedNonOrderable },
    });
  }

  return { ok: true, rows };
}

// DEFECT 3 (2026-09-19 live QA, conv 009de656): loadItemLexicon above
// deliberately excludes an inactive lexicon row (or one whose target has
// gone non-orderable) from `rows` — correct, since neither should ever be a
// resolver candidate. But resolve-item.ts's resolveItem had no way to tell
// "no term at all names this" apart from "a term names it exactly, and was
// correctly excluded" — so once the shop's own longer, more specific,
// correctly-targeted term for a phrase was dropped, resolution silently
// fell back to a SHORTER, unrelated term instead ("bleu cheese" -> the
// single word "cheese" -> three Cheese pizzas, real live bug). This loads
// exactly those excluded rows — term/target_id only, no category/size_label
// join, since resolveItem's own use of this list (longerInactiveTermExists)
// never resolves anything from it, only vetoes a guess when a real answer
// was found and correctly excluded. Best-effort: a failure here degrades to
// today's pre-existing behavior (the veto simply never fires), never fails
// the turn — same discipline as loadLexiconItemMetadata's own category/
// size_label join.
async function loadExcludedItemLexicon(supabase: SupabaseClient, shopId: string): Promise<LexiconTerm[]> {
  const rows: LexiconTerm[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("lexicon").select("term, target_id")
      .eq("shop_id", shopId).eq("target_type", "item").eq("active", false)
      .order("id", { ascending: true })
      .range(from, from + ITEM_LEXICON_PAGE_SIZE - 1);
    if (error || !data) break;
    for (const r of data as Array<{ term: string; target_id: string }>) {
      rows.push({ term: r.term, target_id: r.target_id });
    }
    if (data.length < ITEM_LEXICON_PAGE_SIZE) break;
    from += ITEM_LEXICON_PAGE_SIZE;
  }
  return rows;
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
): Promise<{ id: string | null }> {
  const { data, error } = await supabase.from("messages").insert({
    conversation_id: input.conversationId,
    tenant_id: input.tenantId,
    role: "assistant",
    content: reply,
  }).select("id").single();
  if (error) return { id: null };
  return { id: (data as { id: string } | null)?.id ?? null };
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
): Promise<{ id: string | null }> {
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
    // 00-BA: the fee was being ADDED to total_cents (line above) and never
    // written to its own column, so every reader of the row -- the acceptance
    // canary, the admin dashboard, the Expo app, analytics, and every sim run
    // -- saw a 99c fee recorded as 0 while the customer was correctly charged
    // it. Exactly the same defect this block's own comment describes for
    // subtotal_cents, one field over. 100 of 100 conversations failed the
    // totals check on this alone.
    service_fee_cents: SERVICE_FEE_CENTS,
    total_cents: totalCents,
    ...sideEffects,
  }).eq("id", input.cartId);

  const { data, error } = await supabase.from("messages").insert({
    conversation_id: input.conversationId,
    tenant_id: input.tenantId,
    role: "assistant",
    content: reply,
  }).select("id").single();
  if (error) return { id: null };
  return { id: (data as { id: string } | null)?.id ?? null };
}

// 00-BI: the closed vocabulary code will accept as an answer to each open
// question. The model translates the customer's message into one of these; it
// never invents one, and code decides what to DO about it. Only questions that
// were observed looping are listed -- a question absent from here behaves
// exactly as it does today.
function answerVocabularyFor(
  open: DialogueState["open"],
  menu: TurnEngineMenuItem[],
  cart: TurnEngineCartLine[],
): { question: string; options: Array<{ id: string; describes: string }> } | null {
  if (!open) return null;
  switch (open.kind) {
    case "ordering":
      return {
        question: "Anything else?",
        options: [
          { id: "closure", describes: "they are finished ordering and want nothing more" },
          { id: "read_back", describes: "they are asking what is currently in their order, or asking you to confirm or repeat it back" },
          { id: "confused", describes: "they are confused or upset about what happened to their order and are not asking for a new item" },
        ],
      };
    case "confirm":
      return {
        question: "All good - confirm?",
        options: [
          { id: "confirm_yes", describes: "they agree and want to place the order" },
          { id: "confirm_no", describes: "they do NOT agree, or want to change something first" },
        ],
      };
    case "slot": {
      const line = cart.find(l => typeof l.menu_item_id === "string" && effectiveLineKeyFor(l) === open.line_key);
      const mi = line ? menu.find(m => m.id === line.menu_item_id) : undefined;
      const step = mi?.ask_plan?.steps.find(s => s.group_id === open.group_id);
      if (!step || step.choices.length === 0) return null;
      return {
        question: `Which ${step.slot_key ?? "option"} for the ${mi?.name ?? "item"}?`,
        options: step.choices.map(c => ({ id: c.id, describes: `they chose "${c.display}"` })),
      };
    }
    case "disambiguation": {
      const opts = open.candidates
        .map(id => menu.find(m => m.id === id))
        .filter((m): m is TurnEngineMenuItem => !!m)
        .map(m => ({ id: m.id, describes: `they meant "${m.name}"` }));
      if (opts.length === 0) return null;
      return { question: "Which one would you like?", options: opts };
    }
    default:
      return null;
  }
}

function effectiveLineKeyFor(line: TurnEngineCartLine): string {
  return line.line_key ?? "";
}

// 2026-09-18 PO dispatch ("answer + new item in one message"): the largest
// remaining reason an item never reaches the cart. ANSWER resolves the ONE
// open question deterministically off the customer's own message (a slot
// choice, a disambiguation pick, order_type, name, address, tip, confirm),
// but a resolved answer short-circuits this whole turn -- PROPOSE only ever
// runs from the `else` branch below, which a resolved answer never reaches.
// Real transcripts today: "Oh, wheat bread for the Garlic Cheesesteak,
// please! Also, can I get an order of 10 boneless wings?" -> bread set,
// wings never mentioned again. "I'll do pickup. Also, can I get a Coke with
// that?" -> pickup set, Coke gone.
//
// The fix is NOT to widen ANSWER itself (it must stay a closed, deterministic
// resolver for exactly one question) -- it's to notice, AFTER a resolved
// answer, that the customer said more than the answer, and run PROPOSE on
// just the remainder. A sentence boundary ALONE is not the signal -- a
// second sentence that's just closing chatter ("It's Alex! Can we finalize
// this order now?") must not trigger a model call every time a name/slot
// answer happens to end with an exclamation point (RED case, live test
// fixture 00-AV). The real signal is one of a small set of phrases a
// customer uses to append a fresh request onto the same message: "also",
// "and a", "plus", "can I get", "can I add", "add", "oh and" -- every one of
// today's real transcripts (see above) contains at least one. The remainder
// starts AT the matched marker (kept, not stripped -- "add chicken fingers?"
// reads naturally to PROPOSE) and runs to the end of the message. A message
// that is nothing but the answer plus filler ("Wheat bread, please.",
// "Thanks!", "Can we finalize this order now?") matches no marker and
// returns null -- today's behavior, unchanged.
const REMAINDER_MARKERS: RegExp[] = [
  /\balso\b/i,
  /\band a\b/i,
  /\bplus\b/i,
  /\bcan i get\b/i,
  /\bcan i add\b/i,
  /\badd\b/i,
  /\boh and\b/i,
];

function extractRemainderAfterAnswer(message: string): string | null {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return null;
  let cutStart: number | null = null;

  for (const marker of REMAINDER_MARKERS) {
    const m = trimmed.match(marker);
    if (m && m.index !== undefined && (cutStart === null || m.index < cutStart)) {
      cutStart = m.index;
    }
  }

  if (cutStart === null) return null;
  const remainder = trimmed.slice(cutStart).trim();
  return remainder.length > 0 ? remainder : null;
}

// The seven open-question kinds a real ANSWER shape fully anticipates (see
// turn-engine.ts's own ANSWER switch) -- the only ones where a RESOLVED
// outcome can safely be followed by a remainder-only PROPOSE call. Every
// other outcome (checkout_intent, closure, address_declined, upsell_*) is
// either already a closing/declining signal or already fully consumes the
// message on its own; none of them named in this dispatch.
const REMAINDER_ELIGIBLE_OUTCOME_KINDS = new Set([
  "slot_resolved",
  "disambiguation_resolved",
  "order_type_resolved",
  "name_resolved",
  "address_resolved",
  "tip_resolved",
  "confirm_yes",
  "confirm_no",
]);

export async function runTurnEngineTurn(input: RunTurnInput, deps: RunTurnDeps): Promise<RunTurnResult> {
  const priorState = input.dialogueState ?? INITIAL_DIALOGUE_STATE;
  const cartBefore = input.cart.map(l => ({ ...l }));
  // answer() mutates its cart argument in place (turn-engine.ts's own
  // contract); decide() below never does (it returns a new array) — this
  // single mutable working copy is correct for both call shapes.
  const workingCart: TurnEngineCartLine[] = input.cart.map(l => ({ ...l }));

  const upsellEnabled = await loadUpsellEnabled(deps.supabase, input.shopId);

  let declines: Decline[] = [];
  // 00-BI: an answer the MODEL read out of the customer's message, once the
  // deterministic detectors have all missed. Only ever one of the meanings
  // code offered; see answerVocabularyFor.
  let answerOutcomeFromModel: { kind: "closure" | "confirm_yes" | "confirm_no" } | null = null;
  const answerVocab = answerVocabularyFor(priorState.open, input.menu, input.cart);
  // 00-BL: the name question wants a VALUE, not a choice. It is now the top
  // repeater: extractCustomerName handles "my name is Alex" and "it's Alex",
  // but customers also write "under the name Alex" and "the name for the order
  // is Alex" -- a seventh phrasing nobody predicted, which is the argument
  // against predicting them.
  const answerValueWanted =
    priorState.open?.kind === "name"
      ? "The customer was asked for the name to put the order under. Report just that name."
      : priorState.open?.kind === "address"
      ? "The customer was asked for the delivery address. Report just the street address, as they gave it."
      : undefined;
  // 00-BB: an address the customer clearly gave that we could not verify.
  let addressNotVerified: string | null = null;
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
  // 00-AU: set when a slot question was already open and this turn's ANSWER
  // couldn't resolve it — a genuine repeat, or the customer asking what the
  // options are (both land here: applyCompiledModifyItem's own resolver, and
  // before that closureOrAffirmationFallback, already had first crack at the
  // message and both missed — see the dispatch-00-AT comment below for why
  // that's conclusive). Threaded into render() so the next question lists
  // the real choices instead of re-asking the identical short one forever.
  let enumerateSlotChoices = false;
  // P0 fix (2026-09-19, docs/specs/2026-09-15-narrowing-questions.md): set
  // ONLY when this turn's message explicitly asked what the options are
  // while a disambiguation was open — see the flag's own doc on
  // RenderContext (turn-engine.ts) for why this is deliberately narrower
  // than enumerateSlotChoices's "any failed answer" trigger.
  let enumerateDisambiguationCandidates = false;
  // 2026-09-18 PO dispatch (named choice not on the list): the customer's
  // raw text, set ONLY at the exact moment a slot answer genuinely fails to
  // match any real choice THIS turn (never for a re-render driven purely by
  // openRepeatCount with no fresh attempt) — see the call site below and
  // RenderContext.unmatchedSlotChoiceText's own doc for why this is kept
  // separate from enumerateSlotChoices rather than folded into it.
  let unmatchedSlotChoiceText: string | undefined;
  // 2026-09-18 PO dispatch (echo regression follow-up): what to persist as
  // DialogueState.lastSlotEchoText for NEXT turn's anti-repeat comparison.
  // Deliberately a SEPARATE variable from unmatchedSlotChoiceText, even
  // though they're equal whenever this turn actually echoes: the slot/
  // disambiguation branch below also needs to explicitly CLEAR the prior
  // turn's stored value when this turn's would-be echo was suppressed as a
  // repeat (unmatchedSlotChoiceText undefined there for a different reason
  // than "the slot resolved," which also leaves it undefined but must NOT
  // clear anything since there's a real new state to move to instead).
  let nextLastSlotEchoText: string | undefined;

  // ── STEP 2: ANSWER ───────────────────────────────────────────────────────
  // Dispatch 00-AH: when address is the open question, geocode THIS turn's
  // message before calling answer() — that's the only case answer() needs
  // an external input for (AnswerExternalInputs). Every other open kind
  // resolves purely off `message` and needs nothing here.
  //
  // Dispatch 00-AP: the address is frequently embedded in a sentence
  // alongside an answer to whatever else IS open (a Temp slot, in the live
  // report) rather than being its own turn — so a candidate span is looked
  // for regardless of what's open, and geocoded opportunistically
  // (`opportunisticAddress` below) whenever delivery is enabled and the
  // address isn't already known. This never competes with or duplicates the
  // "address is open" geocode call above — extractAddressSpan/geocodeFn are
  // the exact same extraction+resolver pair either way, just fed into
  // answer()'s own switch when address is the open question, and folded into
  // sideEffects directly (bypassing answer(), which only ever resolves the
  // ONE open question) when it isn't.
  const addressOpen = priorState.open?.kind === "address";
  const addressSpan = extractAddressSpan(input.message);
  const shouldAttemptGeocode = addressOpen ||
    (addressSpan != null && input.shopContext.deliveryEnabled && !input.shopContext.deliveryAddressKnown);
  let externalInputs: AnswerExternalInputs = {};
  let opportunisticAddress: { formatted: string; withinZone: boolean } | null = null;
  // Round 3, item 2b (2026-09-19, live repro, conv e893e129): an order-type
  // statement can arrive embedded in a message answering something else
  // entirely — "Delivery to 5620 Cetronia Rd..." while a fries
  // disambiguation was still open, in the repro — the exact same shape
  // opportunisticAddress below already handles for addresses. Without this,
  // order_type was only ever captured when it was ITSELF the open question
  // (answer()'s "order_type" case), so a message like this silently lost
  // the order type forever, and ask()'s tip gate (which requires
  // orderTypeIsDelivery) could never fire either. Skipped when order_type
  // is ALREADY the open question — that path owns this resolution and must
  // not be raced/duplicated — and once order type is already known, since
  // there's nothing left to opportunistically capture.
  const opportunisticOrderType = priorState.open?.kind !== "order_type" && input.shopContext.orderType == null
    ? readOrderTypeReply(input.message)
    : null;
  // PO fix (2026-09-19, round 2 addendum): a "what kind?" disambiguation
  // answer is now resolved through the shop's own lexicon first (see
  // turn-engine.ts's resolveKindClauseViaLexicon) — loaded here, ONLY when a
  // disambiguation is actually open, and reused below for the remainder-
  // PROPOSE call rather than fetched twice. A load failure here is
  // non-fatal: `answerLexicon` stays undefined, and answer()'s own fallback
  // to the pre-existing name-facet matcher runs exactly as it did before
  // this fix — the lexicon is a strictly-better first attempt, never a new
  // way for this turn to fail.
  let answerLexicon: LexiconTerm[] | undefined;
  if (priorState.open?.kind === "disambiguation") {
    const disambiguationLexiconResult = await loadItemLexicon(deps.supabase, input.shopId);
    if (disambiguationLexiconResult.ok) answerLexicon = disambiguationLexiconResult.rows;
    externalInputs = { lexicon: answerLexicon };
  }
  // Round 3, item 2c(ii): loaded while confirm is the open question — see
  // AnswerExternalInputs.confirmShopFacts's own doc. deliveryFeeCents is
  // already on hand (input.shopContext, no extra query); hoursLine needs its
  // own shop_settings read.
  // Round 3, item 2b: also loaded while tip is open — a shop-data question
  // ("So delivery is free?") can arrive before the customer ever answers
  // tip, and answer()'s "tip" case now answers it the same way confirm's
  // does (see answerConfirmShopFactsQuestion's own doc in turn-engine.ts).
  if (priorState.open?.kind === "confirm" || priorState.open?.kind === "tip") {
    const hoursLine = await loadHoursLine(deps.supabase, input.shopId);
    externalInputs = { ...externalInputs, confirmShopFacts: { deliveryFeeCents: input.shopContext.deliveryFeeCents, hoursLine } };
  }
  if (shouldAttemptGeocode) {
    const shopGeo = await loadShopGeo(deps.supabase, input.shopId);
    const geocodeFn = deps.geocodeAddressFn ?? defaultGeocodeAddress;
    // addressOpen with no extracted span (e.g. a name, "thats it") still
    // geocodes the raw trimmed message — same as 00-AH's original behavior —
    // so a non-address answer to an open address question still gets a real
    // (failing) geocode attempt and resolves deterministically to
    // address_declined rather than falling through to PROPOSE.
    const geocoded = await geocodeFn(addressSpan ?? input.message.trim(), shopGeo, {
      fetchImpl: deps.fetchImpl ?? fetch,
      apiKey: deps.googleMapsApiKey ?? Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "",
    });
    if (addressOpen) externalInputs = { geocodedAddress: geocoded };
    else opportunisticAddress = geocoded;
    // 00-BB: a geocode that comes back with nothing is NOT the customer
    // failing to answer, and must not be reported to them as if it were.
    // Live in the 2026-09-17 run: a customer answered "123 Main St" -- a
    // perfectly formed address -- and was asked "What's the delivery address?"
    // four more times, then "I already said, it's 123 Main St." The address
    // question was re-asked 14 times in one conversation. Same disease as the
    // name loop: a lookup failure is indistinguishable from silence, and
    // nothing caps the repeat.
    //
    // We deliberately do NOT accept an address we could not verify -- that
    // decides where food gets driven. We only stop pretending they said
    // nothing, and name what we could not verify so they can correct it.
    if (addressOpen && addressSpan != null && !geocoded) {
      addressNotVerified = addressSpan;
    }
  }
  const answerResult = answer(priorState, workingCart, input.message, input.menu, externalInputs);
  // priorState.open can ONLY be resolved through the "disambiguation" case
  // of answer()'s own switch (turn-engine.ts) when it was already that kind
  // -- so `resolved: true` here can only mean THAT disambiguation was just
  // settled (a candidate resolved, or the customer declined it), never a
  // coincidental resolution of something else. See turn-engine.ts's ask(),
  // priority 2b, for what this unlocks.
  const priorOpenWasDisambiguation = priorState.open?.kind === "disambiguation";
  // Round 2 addendum item A, rule 2 (2026-09-19): the SAME numbered list
  // has already missed at least once (`openRepeatCount` — ask()'s own
  // carry(), tracked generically for every open kind, not just this one;
  // see turn-engine.ts's render() disambiguation case for the matching
  // escalation-wording read of the same field) and this reply abandons the
  // list outright — see isDisambiguationListDropSignal's own doc. Read
  // once, used below both to skip the re-carry-forward branch (which would
  // otherwise re-open the identical dead list forever) and to keep PROPOSE
  // from being told about a question we're dropping.
  // Round 2 (2026-09-19, TOP item, real phantom charge): a decline of the
  // open list that ALSO names a real, specific item outside it ("oh no,
  // just salad rn! ... house salad w/ steak, salmon n creamy italian only")
  // — see turn-engine.ts's disambiguationDeclineNamesOutsideItem and the
  // "disambiguation" case's own header for the full reasoning. Unlike the
  // list-drop signal above, this fires on the FIRST answer (no openRepeatCount
  // gate) — the customer never has to get ignored once before being heard.
  const disambiguationDeclineNamesOutside = priorState.open?.kind === "disambiguation" &&
    disambiguationDeclineNamesOutsideItem(input.message.trim(), priorState.open.candidates, input.menu, answerLexicon);
  // Round 3, item 2b (2026-09-19, live repro, conv e893e129): "Delivery to
  // 5620 Cetronia Rd, Allentown PA 18106" arrived while a fries
  // disambiguation was still open — answer()'s disambiguation case
  // correctly finds no candidate match (nothing here names a kind of
  // fries) and returns UNRESOLVED, but without this, the short-circuit
  // branch just below re-asks the identical "what kind?" forever, and the
  // order-type/address this message actually carries (already captured
  // opportunistically into sideEffects above) never gets a chance to move
  // the conversation forward — tip, and eventually confirm, can never be
  // reached. Same family as disambiguationDeclineNamesOutside above (fires
  // on the FIRST occurrence, no openRepeatCount gate): a message that
  // plainly states an order type or a deliverable address is never a
  // legitimate attempt at answering "what kind?", so there's nothing to
  // wait out.
  const disambiguationMessageIsOrderLogistics = priorState.open?.kind === "disambiguation" &&
    (opportunisticOrderType != null || addressSpan != null);
  const dropDisambiguationList = priorState.open?.kind === "disambiguation" &&
    (
      ((priorState.openRepeatCount ?? 0) >= 1 && isDisambiguationListDropSignal(input.message)) ||
      disambiguationDeclineNamesOutside ||
      disambiguationMessageIsOrderLogistics
    );
  // "Okay, no Italian." — spanText is the customer's own words for the span
  // that opened THIS disambiguation (turn-engine.ts's DialogueState.open.
  // spanText doc); falls back to the shared category of the offered
  // candidates when a persisted row predates that field. Prepended ahead of
  // whatever the fresh PROPOSE call below decides, same answerText mechanism
  // disambiguation_category_rejected already uses.
  if (disambiguationDeclineNamesOutside && priorState.open?.kind === "disambiguation") {
    const declinedLabel = (priorState.open.spanText ?? "").trim() ||
      categoryDisplayWord(
        priorState.open.candidates.map(id => input.menu.find(m => m.id === id)?.category).find(Boolean) ?? null,
      );
    if (declinedLabel) {
      answerText = `Okay, no ${declinedLabel.charAt(0).toUpperCase()}${declinedLabel.slice(1)}.`;
    }
  }

  if (answerResult.resolved) {
    turnEvents = { ...turnEvents, disambiguationSettledThisTurn: priorOpenWasDisambiguation };
    const outcome = answerResult.outcome;
    switch (outcome.kind) {
      case "order_type_resolved":
        sideEffects = { ...sideEffects, order_type: outcome.orderType };
        // P0 (2026-09-19, live money bug, deploy v528): a pickup order
        // never carries a driver tip (turn-engine.ts's "tip" case rule 4) —
        // zero out any tip that was set before order type resolved to
        // pickup (a tip stated/misparsed while order type was still
        // assumed delivery, or a customer switching from delivery to
        // pickup after already answering the tip question). Without this,
        // computeCartSubtotalCents's total_cents math (turn-engine-
        // runner.ts's own persistTurn) adds driverTipCents unconditionally,
        // regardless of order type, so a stale tip survived the switch and
        // still got charged on a pickup order.
        if (outcome.orderType === "pickup") {
          sideEffects = { ...sideEffects, driver_tip_cents: 0 };
          turnEvents = { ...turnEvents, tipResolvedThisTurn: true };
        }
        break;
      case "tip_resolved":
        sideEffects = { ...sideEffects, driver_tip_cents: outcome.tipCents };
        // Round 3, item 2b: mark the tip question genuinely resolved this
        // turn (amount OR decline, outcome.tipCents is 0 either way) — see
        // DialogueState.driverTipResolved's own doc for why ask()'s
        // priority-5 tip gate can no longer trust driver_tip_cents alone.
        turnEvents = { ...turnEvents, tipResolvedThisTurn: true };
        // Round 3, item 2c(i): a tip stated WHILE confirm was already open
        // (priorState.open.kind === "confirm" — see the "confirm" case's
        // own tip-amount check in turn-engine.ts) needs ASK to reopen
        // confirm with a fresh read-back, not the short re-ask a genuine
        // same-cart repeat gets — see AskTurnEvents.tipStatedAtConfirmThisTurn's
        // own doc. The ordinary "tip" open-question flow (priorState.open.kind
        // === "tip") never sets this: that path already gets a fresh confirm
        // naturally, since `open` changes shape from "tip" to "confirm".
        if (priorState.open?.kind === "confirm") {
          turnEvents = { ...turnEvents, tipStatedAtConfirmThisTurn: true };
        }
        break;
      case "confirm_info_answered":
        // Round 3, item 2c(ii): the shop-data answer rides ahead of
        // whatever confirm re-ask this turn produces — same answerText hook
        // replacement_unavailable already uses just below.
        answerText = outcome.infoText;
        break;
      case "name_resolved":
        sideEffects = { ...sideEffects, pickup_name: outcome.name };
        break;
      case "address_resolved":
        sideEffects = { ...sideEffects, delivery_address: { formatted: outcome.address } };
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
      // 2026-09-19 PO dispatch (Commit 3): same "unit added" qualification as
      // disambiguation_resolved; answerText carries the "We only have X as a Y.
      // Keep it, or take it off?" wording rendered before the normal turn reply.
      case "disambiguation_category_rejected":
        if (answerResult.cartChanged) {
          turnEvents = { ...turnEvents, qualifyingAddMenuItemId: outcome.menuItemId };
        }
        answerText = outcome.message;
        break;
      // PO amendment (2026-09-19, narrowing questions): a facet answer that
      // still leaves more than one candidate reopens a SMALLER disambiguation
      // for the remainder — fed through the exact same
      // disambiguationCandidateIds/disambiguationQuantity channel ask()'s
      // priority-2 branch already consumes for a fresh span, with
      // disambiguationSpanText deliberately left unset (the original span's
      // stated size is already consumed) and disambiguationOtherOneFollowUp
      // set only when this reopening is specifically "the other one"'s size
      // (see AnswerOutcome's own doc on this outcome kind).
      // disambiguationFacetNarrowed is unconditionally true for EITHER shape
      // of this outcome — a same-kind, multi-size remainder is very
      // frequently <=5 candidates on a real menu (Small/Medium/Large), which
      // would otherwise fall through render()'s own <=5-candidate carve-out
      // and enumerate a priced list instead of asking "What size?".
      case "disambiguation_narrowed":
        if (answerResult.cartChanged && outcome.resolvedMenuItemId) {
          turnEvents = { ...turnEvents, qualifyingAddMenuItemId: outcome.resolvedMenuItemId };
        }
        turnEvents = {
          ...turnEvents,
          disambiguationCandidateIds: outcome.remainingCandidates,
          disambiguationQuantity: outcome.remainingQuantity,
          disambiguationSpanText: undefined,
          disambiguationOtherOneFollowUp: outcome.otherOneFollowUp,
          disambiguationFacetNarrowed: true,
          // 2026-09-19 PO dispatch (replacement, ambiguous target hole):
          // Y's own narrowing wasn't fully settled by this facet answer —
          // still-held X rides forward onto the reopened, smaller
          // disambiguation exactly like every other field in this object.
          replacementSourceLineKey: outcome.replacementSourceLineKey,
        };
        break;
      // P0 (2026-09-19, multi-kind-answer): one or more clauses of a
      // list-shaped "what kind?" answer resolved outright — cart already
      // mutated in place by answer() for each, same convention as
      // disambiguation_resolved. The LAST resolved clause qualifies for the
      // upsell step (same one-qualifying-add-per-turn convention every
      // other outcome here uses). `clarifyMessage`, when present, is pushed
      // as a single combined decline — reuses the exact rendering slot
      // decide()'s own "Sorry, I didn't catch X" wording already uses (shown
      // ahead of the cart recap), so a partially-resolved list gets ONE
      // clarifying line, never a stack (see turn-engine.ts's ADDENDUM A doc
      // on itemSpanNamedInMessage for the sibling fix to the same "no
      // stacked apologies" rule on the DECIDE side).
      case "disambiguation_multi_resolved":
        if (answerResult.cartChanged && outcome.resolvedMenuItemIds.length > 0) {
          turnEvents = {
            ...turnEvents,
            qualifyingAddMenuItemId: outcome.resolvedMenuItemIds[outcome.resolvedMenuItemIds.length - 1],
          };
        }
        if (outcome.clarifyMessage) {
          declines = [...declines, { reason: outcome.clarifyMessage }];
        }
        break;
      // Round 2, item 1 (2026-09-19, live v511): the shared "What size?"
      // question over two or more same-kind groups — see AnswerOutcome's own
      // doc and turn-engine.ts's DialogueState "multi_size" open kind.
      // `disambiguationMultiSizeGroups` is what ask()'s own priority-1b
      // branch consumes to open (or re-open, on a still-unresolved partial
      // answer) that question next. Same "last resolved clause qualifies
      // for upsell" and "clarifyMessage rides along as one combined decline"
      // conventions as disambiguation_multi_resolved immediately above.
      case "disambiguation_multi_size_narrowed":
        if (answerResult.cartChanged && outcome.resolvedMenuItemIds.length > 0) {
          turnEvents = {
            ...turnEvents,
            qualifyingAddMenuItemId: outcome.resolvedMenuItemIds[outcome.resolvedMenuItemIds.length - 1],
          };
        }
        turnEvents = { ...turnEvents, disambiguationMultiSizeGroups: outcome.groups };
        if (outcome.clarifyMessage) {
          declines = [...declines, { reason: outcome.clarifyMessage }];
        }
        break;
      // Round 2, item 3 (2026-09-19, live repro): the customer's answer to
      // "which one?" named a totally different, real item — added on its
      // own (cart already mutated in place by answer()), and the ORIGINAL
      // disambiguation is still unresolved. Mirrors the exact "no model
      // call, re-ask the same question" carry-forward the unresolved-answer
      // branch below already does for `priorState.open.kind === "disambiguation"`
      // — this outcome just reaches it from the RESOLVED side instead (the
      // turn genuinely did something, so `answerResult.resolved` is true),
      // so the fields have to be set here rather than falling into that
      // branch naturally.
      case "disambiguation_new_item_added":
        turnEvents = { ...turnEvents, qualifyingAddMenuItemId: outcome.menuItemId };
        if (priorState.open?.kind === "disambiguation") {
          turnEvents = {
            ...turnEvents,
            disambiguationCandidateIds: priorState.open.candidates,
            disambiguationQuantity: priorState.open.quantity,
            disambiguationSpanText: priorState.open.spanText,
            disambiguationOtherOneFollowUp: priorState.open.otherOneFollowUp,
            disambiguationFacetNarrowed: priorState.open.facetNarrowed,
            heldModifierText: priorState.open.heldModifierText,
            replacementSourceLineKey: priorState.open.replacementSourceLineKey,
          };
        }
        break;
      // 00-BJ: a closure over a NON-EMPTY cart is a commitment to close, and
      // must advance exactly as an explicit checkout phrase does. It did not.
      // "thats it" matched the explicit-checkout phrase and moved on to the
      // name question; "nothing else" resolved as `closure`, which ASK treats
      // as a no-op -- it resolved the turn and left "Anything else?" open, so
      // the customer was asked it again. That is why loosening the closure
      // detector barely moved the repeat number: more messages resolved, into
      // an outcome that goes nowhere.
      //
      // Gated on a non-empty cart deliberately: closure over an EMPTY cart is
      // 00-AK's dead end ("Anything else?" presupposing a first item), which
      // must keep its own handling.
      case "closure":
        if (workingCart.some(l => typeof l.menu_item_id === "string")) {
          turnEvents = { ...turnEvents, checkoutIntentThisTurn: true };
        }
        break;
      case "cart_cancelled":
        // 2026-09-18 PO dispatch (address loop, rule 2): the cart itself was
        // already cleared in place by answer() (turn-engine.ts's "address"
        // case). This flag is what stops ask()'s priorities 4/5
        // (address/tip) from immediately re-opening either question on the
        // now-empty cart THIS SAME turn — see AskTurnEvents.cartCancelledThisTurn's
        // own doc for why it's turn-scoped rather than a general cart-
        // emptiness check.
        turnEvents = { ...turnEvents, cartCancelledThisTurn: true };
        break;
      case "quantity_corrected":
        // 2026-09-18 PO dispatch (read-back corrections, mechanism 1): the
        // line's quantity was already mutated in place by answer()
        // (turn-engine.ts's "confirm" case). This flag is what makes ask()
        // reopen confirm with a fresh read-back instead of the short
        // re-confirm prompt — see AskTurnEvents.quantityCorrectedThisTurn's
        // own doc.
        turnEvents = { ...turnEvents, quantityCorrectedThisTurn: true };
        break;
      case "line_replaced":
        // 2026-09-18 PO dispatch (read-back corrections, mechanism 2): the
        // wrong line was already removed and the right one added in place
        // by answer() (turn-engine.ts's "confirm" case). Same fresh-
        // read-back handling as quantity_corrected — see
        // AskTurnEvents.lineReplacedThisTurn's own doc.
        turnEvents = { ...turnEvents, lineReplacedThisTurn: true };
        break;
      case "replacement_unavailable":
        // 2026-09-18 PO dispatch (read-back corrections, mechanism 2): X
        // isn't its own menu item — nothing was touched. The explanation
        // rides ahead of the normal re-ask via the SAME answerText hook
        // intent:"question"'s answer_text already uses below, never a
        // second reply-building path.
        answerText = outcome.message;
        break;
      // slot_resolved / address_declined / upsell_accepted / upsell_declined:
      // cart already mutated in place by answer() where relevant, nothing
      // else to persist or feed into ASK.
      default:
        break;
    }

    // 2026-09-18 PO dispatch: a resolved answer that was NOT the whole
    // message. See extractRemainderAfterAnswer's own header for why this is
    // scoped to exactly these seven outcome kinds and how the boundary is
    // found. Runs a SECOND, remainder-only PROPOSE call -- `open: null`, no
    // answerQuestion/answerOptions -- so the model has nothing to re-answer
    // (00-AT's "never re-answer the slot that was just answered", satisfied
    // structurally rather than by convention). Only `adds` from that
    // proposal are ever applied (removes/modifies stripped before DECIDE
    // sees it) -- a bonus item is additive, never a license to also mutate
    // or remove the line the primary answer just resolved.
    if (REMAINDER_ELIGIBLE_OUTCOME_KINDS.has(outcome.kind)) {
      const remainderMessage = extractRemainderAfterAnswer(input.message);
      if (remainderMessage) {
        // Reuse the lexicon already loaded above for answer()'s disambiguation
        // path when present — same shop, same turn, no reason to fetch it
        // twice. Falls back to a fresh load otherwise (unchanged behavior).
        const lexiconResult = answerLexicon !== undefined
          ? { ok: true, rows: answerLexicon }
          : await loadItemLexicon(deps.supabase, input.shopId);
        if (lexiconResult.ok) {
          const proposeFn: ProposeTurnFn = deps.proposeTurnFn ?? defaultProposeTurn;
          const remainderShopContext: RunTurnShopContext = {
            ...input.shopContext,
            orderType: sideEffects.order_type ?? input.shopContext.orderType,
            deliveryAddressKnown: sideEffects.delivery_address != null ? true : input.shopContext.deliveryAddressKnown,
            driverTipCents: sideEffects.driver_tip_cents ?? input.shopContext.driverTipCents,
            pickupName: sideEffects.pickup_name ?? input.shopContext.pickupName,
          };
          const remainderResult: ProposeResult = await proposeFn(
            {
              cart: workingCart,
              open: null,
              menu: input.menu,
              lexicon: lexiconResult.rows,
              history: input.history,
              message: remainderMessage,
              orderContext: {
                orderType: remainderShopContext.orderType ?? null,
                pickupName: remainderShopContext.pickupName ?? null,
                deliveryAddressKnown: remainderShopContext.deliveryAddressKnown,
                driverTipCents: remainderShopContext.driverTipCents ?? null,
                deliveryEnabled: remainderShopContext.deliveryEnabled,
              },
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
          // A remainder PROPOSE failure is non-fatal: the primary answer
          // already resolved and must not be discarded just because the
          // bonus item couldn't be parsed. Fall through with only the
          // primary answer applied -- same as remainderMessage being null.
          if (remainderResult.ok && remainderResult.proposal.adds.length > 0) {
            const sanitizedProposal: Proposal = { ...remainderResult.proposal, removes: [], modifies: [] };
            const remainderInactiveLexicon = await loadExcludedItemLexicon(deps.supabase, input.shopId);
            const remainderDecide = decide(
              sanitizedProposal,
              workingCart,
              input.menu,
              lexiconResult.rows,
              deps.newLineKey ?? (() => crypto.randomUUID()),
              remainderMessage,
              remainderInactiveLexicon,
            );
            workingCart.splice(0, workingCart.length, ...remainderDecide.cart);
            declines = [...declines, ...remainderDecide.declines];
            turnEvents = {
              ...turnEvents,
              qualifyingAddMenuItemId: remainderDecide.qualifyingAddMenuItemId ?? turnEvents.qualifyingAddMenuItemId,
              disambiguationCandidateIds: turnEvents.disambiguationCandidateIds ?? remainderDecide.disambiguationCandidateIds,
              disambiguationQuantity: turnEvents.disambiguationCandidateIds ? turnEvents.disambiguationQuantity : remainderDecide.disambiguationQuantity,
              disambiguationSpanText: turnEvents.disambiguationCandidateIds ? turnEvents.disambiguationSpanText : remainderDecide.disambiguationSpanText,
              carriedDisambiguationCandidateIds: [
                ...(turnEvents.carriedDisambiguationCandidateIds ?? []),
                ...remainderDecide.carriedDisambiguationCandidateIds,
              ],
              heldModifierText: turnEvents.heldModifierText ?? remainderDecide.heldModifierText,
              categoryMismatchPending: turnEvents.categoryMismatchPending ?? remainderDecide.categoryMismatchPending,
            };
            // 00-BJ-adjacent: a "yes" is not final the instant it's also
            // carrying a brand-new item -- the order just changed, so
            // confirm must be asked again, never silently finalized this
            // same turn. Ambiguous/unresolved remainder adds don't need
            // this override: ASK's own priority order (disambiguation is
            // priority 2, an unresolved required slot is priority 1) already
            // outranks confirm/link (priority 8) regardless of confirmYes.
            if (outcome.kind === "confirm_yes") {
              turnEvents = { ...turnEvents, confirmYes: false };
            }
          }
        }
      }
    }
  } else if (
    priorState.open?.kind === "slot" || priorState.open?.kind === "multi_size" ||
    (priorState.open?.kind === "disambiguation" && !dropDisambiguationList)
  ) {
    // Dispatch 00-AT (conv 8b9636c9: "every message is re-read as a fresh
    // order while a question is open"). ANSWER's own resolver for this
    // exact open kind — and, after that, closureOrAffirmationFallback —
    // already had first crack at this message and both missed. Falling
    // through to PROPOSE from here is exactly the defect: PROPOSE's own
    // prompt hands the model the full cart (already containing California
    // Cheesesteak, fully resolved) alongside the customer's message, but
    // nothing about the contract forces it to recognize "the customer is
    // naming/restating the SAME order, not asking for more" — it re-added
    // Cheesesteak (2 -> 4 -> 6 -> 12) on repeated turns while the item the
    // open question was actually about (Jack's Special) never entered the
    // cart, because the model kept re-surfacing it as ambiguous rather than
    // the disambiguation resolver settling it once, deterministically, up
    // front. `slot` and `disambiguation` are the two kinds a real answer
    // shape always fully anticipates (a slot has a concrete choice list;
    // a disambiguation names its own candidates) — a message that fails to
    // read as either can only be noise or a protest, never legitimate new
    // information PROPOSE needs to interpret. No cart mutation, no model
    // call: the SAME question is re-asked next, exactly once.
    if (priorState.open.kind === "disambiguation") {
      // ASK's pendingAmbiguous queue only ever holds a disambiguation
      // BEFORE it wins priority — once one is `open`, its candidates live
      // on `open` itself and nowhere else (see turn-engine.ts's own doc on
      // DialogueState.pendingAmbiguous), so a no-op turn has to hand them
      // back explicitly or ASK has nothing left to recompute the question
      // from and silently drops it — the exact "item asked for and never
      // added, never even mentioned again" failure this dispatch closes.
      // heldModifierText rides along the same way, for the same reason —
      // see AskTurnEvents.heldModifierText's own doc.
      if (isDisambiguationOptionsRequest(input.message)) enumerateDisambiguationCandidates = true;
      turnEvents = {
        ...turnEvents,
        disambiguationCandidateIds: priorState.open.candidates,
        disambiguationQuantity: priorState.open.quantity,
        disambiguationSpanText: priorState.open.spanText,
        disambiguationOtherOneFollowUp: priorState.open.otherOneFollowUp,
        disambiguationFacetNarrowed: priorState.open.facetNarrowed,
        heldModifierText: priorState.open.heldModifierText,
        replacementSourceLineKey: priorState.open.replacementSourceLineKey,
      };
    } else if (priorState.open.kind === "multi_size") {
      // Round 2, item 1 (2026-09-19): same "hand the open question's own
      // state back explicitly or ASK has nothing left to recompute it from"
      // reasoning as the disambiguation branch just above — a size answer
      // that genuinely failed to resolve ANY group (answer()'s own "multi_size"
      // case returns UNRESOLVED there) must re-open the identical shared
      // question, never fall through to a model call.
      turnEvents = { ...turnEvents, disambiguationMultiSizeGroups: priorState.open.groups };
    } else {
      // 00-AU: the slot case of this same dispatch — see the flag's own doc
      // above. No cart mutation happened above (this branch never mutates
      // the cart), so ASK's priority-1 check below will reopen this exact
      // same slot; enumerating it here is always the right slot's choices.
      enumerateSlotChoices = true;
      // 2026-09-18 PO dispatch (named choice not on the list, then echo-
      // regression follow-up): this exact branch is the ONLY place a slot
      // answer is known to have genuinely failed to match THIS turn (see
      // the flag's own doc) — turn-engine.ts's own "slot" case already
      // tried BOTH applyCompiledModifyItem and a direct matchChoiceInText
      // fallback before returning unresolved, so a real match was never
      // missed here; this is a genuine miss. extractSlotChoiceWords trims
      // the raw message down to the choice-shaped fragment (never the
      // whole run-on sentence — see its own doc). Never echoed twice in a
      // row with the SAME quoted words: falls back to the plain enumerate
      // wording instead, and clears lastSlotEchoText so a LATER attempt
      // with genuinely different words can still echo fresh.
      const candidateEcho = extractSlotChoiceWords(input.message) || undefined;
      const repeatedEcho = priorState.open?.kind === "slot" &&
        priorState.lastSlotEchoText !== undefined &&
        priorState.lastSlotEchoText === candidateEcho;
      unmatchedSlotChoiceText = repeatedEcho ? undefined : candidateEcho;
      // Cleared (left undefined) on a suppressed repeat, exactly like a
      // resolved turn would clear it — so a LATER attempt with the same
      // original words is judged fresh, not "still repeating."
      nextLastSlotEchoText = repeatedEcho ? undefined : candidateEcho;
    }
  } else {
    // ── STEP 3: PROPOSE (only reached when ANSWER cannot resolve this
    // message deterministically — no model call otherwise) ────────────────
    const lexiconResult = await loadItemLexicon(deps.supabase, input.shopId);
    if (!lexiconResult.ok) {
      // Same terminal-failure shape as a PROPOSE failure below: nothing
      // changed this turn, only the fallback reply is written to messages.
      // loadItemLexicon has already persisted its own error_log row.
      const saved = await persistOutboundOnly(deps.supabase, input, FALLBACK_REPLY);
      return { reply: FALLBACK_REPLY, cart: input.cart, dialogueState: priorState, messageId: saved.id };
    }
    const lexicon = lexiconResult.rows;
    const inactiveLexicon = await loadExcludedItemLexicon(deps.supabase, input.shopId);
    const proposeFn: ProposeTurnFn = deps.proposeTurnFn ?? defaultProposeTurn;
    const proposeResult: ProposeResult = await proposeFn(
      {
        cart: workingCart,
        // Round 2 addendum item A, rule 2 (2026-09-19): a dropped
        // disambiguation list is treated as a genuinely fresh message —
        // PROPOSE must not be told a question is still open (it isn't;
        // that's the whole point of dropping it), so `open` and its vocab
        // go to null/undefined here exactly as they would for a message
        // that arrived with nothing open at all.
        open: dropDisambiguationList ? null : priorState.open,
        menu: input.menu,
        lexicon,
        history: input.history,
        message: input.message,
        // 00-AY: the engine has had all of this on every turn and never passed
        // it on, so the model interpreted each message with no idea whether the
        // order was pickup or delivery, whether a name was already given, or
        // what had already been settled. Published as STATE, not as history.
        // 00-BI: the closed vocabulary for whatever question is open.
        answerQuestion: dropDisambiguationList ? undefined : answerVocab?.question,
        answerOptions: dropDisambiguationList ? undefined : answerVocab?.options,
        answerValueWanted,
        orderContext: {
          orderType: input.shopContext.orderType ?? null,
          pickupName: input.shopContext.pickupName ?? null,
          deliveryAddressKnown: input.shopContext.deliveryAddressKnown,
          driverTipCents: input.shopContext.driverTipCents ?? null,
          deliveryEnabled: input.shopContext.deliveryEnabled,
        },
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

    let proposal: Proposal;
    if (!proposeResult.ok) {
      // 2026-09-18 PO dispatch (a model timeout must not lose the order):
      // conv 7aa64038/998da1a9 — a plain "cheeseburger" as the very first
      // message timed out twice (25s x2, no backoff) and got "Sorry, I ran
      // into a problem. Please call us directly" on a design partner's
      // FIRST text. Scoped narrowly to the one failure kind and the one
      // dialogue state this dispatch is actually about: reason === "timeout"
      // (schema_violation/malformed_json/network_error/non_200 are a
      // different failure class, unchanged here — those 4 schema_violation
      // rows are a separate question, answered in the reply file, not this
      // code) and priorState.open === null (the "what do you want" /
      // "anything else?" moment a fresh conversation's first message and
      // every ordinary new-item message both arrive in — any OTHER open
      // kind is a specific pending question: an address, a name, a slot
      // choice — decide()'s add-resolution has no business reinterpreting
      // an answer to one of those as a new item).
      //
      // Within that scope: synthesize a single-add Proposal straight from
      // the raw message and let it fall through the SAME decide()/ask()/
      // render() pipeline a real PROPOSE result would use — no new
      // fallback logic, no new customer-facing copy. decide() already
      // resolves item_span against the shop's own lexicon with no model
      // involved (resolve-item.ts), so a plain, single-item message like
      // "cheeseburger" lands as a real cart line exactly as it would have
      // if the model had answered; a span that ties resolves to decide()'s
      // normal disambiguation question; a span that matches nothing (a
      // multi-item sentence the whole-message span can't parse, e.g. "I'd
      // like a cheeseburger and a coke") surfaces decide()'s own existing
      // 00-AX "Sorry, I didn't catch ... mind saying it again?" decline —
      // never a guess, and never "call us." The model gets another try
      // next turn either way, same as PROPOSE succeeding would have left it.
      if (proposeResult.reason === "timeout" && priorState.open === null) {
        proposal = { intent: "order", adds: [{ item_span: input.message, quantity: 1, choices: [] }], removes: [], modifies: [] };
      } else {
        // proposeTurn() has already persisted the error_log row itself
        // (stage: "propose_call", raw response attached) — see propose.ts.
        // Nothing changed this turn: cart and dialogue_state are left
        // exactly as they were, and only the fallback reply is written to
        // messages.
        const saved = await persistOutboundOnly(deps.supabase, input, FALLBACK_REPLY);
        return { reply: FALLBACK_REPLY, cart: input.cart, dialogueState: priorState, messageId: saved.id };
      }
    } else {
      // ── STEP 4: DECIDE ─────────────────────────────────────────────────
      proposal = proposeResult.proposal;
    }
    // Round 2, item 4 (2026-09-19, live v511, 1 of 4 runs): an order-shaped
    // message ("4 large pizzas" — a leading quantity plus a real menu
    // category word) that PROPOSE read as intent:"question" with the
    // model's OWN prose and no adds at all is the model substituting for
    // the real narrowing-question flow, not a genuine question ("what's in
    // the meat lovers?" has no leading quantity and is unaffected). See
    // isOrderShapedMessage's own header in turn-engine.ts. Re-run through
    // the SAME decide()/ask()/render() pipeline as any other add — the
    // model's own answer_text is discarded entirely, never rendered; "the
    // model phrases, the code decides."
    //
    // Round 2, item 1b (2026-09-19, live 2/5 runs): the SAME underlying bug
    // also showed up as intent:"order" with adds:[] — a different shape
    // (zero adds instead of prose-as-answer), same root cause: the model's
    // own classification of whether this message contains an order is
    // being trusted over the message text itself. Dropped the intent
    // check entirely — an order-shaped message with an empty adds array
    // re-runs through this same path regardless of what intent the model
    // assigned it. One detector (orderShapedMessageQuantity), one re-run
    // path, covering both trigger shapes.
    if ((proposal.adds?.length ?? 0) === 0) {
      const orderShapedQuantity = orderShapedMessageQuantity(input.message, input.menu);
      if (orderShapedQuantity !== null) {
        proposal = { intent: "order", adds: [{ item_span: input.message, quantity: orderShapedQuantity, choices: [] }], removes: [], modifies: [] };
      }
    }
    // 00-BI: ANSWER already ran and missed -- that is the only way execution
    // reaches here. If the model could read the message as one of the meanings
    // code offered, act on it now, before the proposal's cart changes are
    // considered. Code still decides what each meaning DOES.
    // 00-BL: a name the model extracted. Code still decides whether it IS a
    // name -- the same shape test the deterministic path uses -- so the model
    // can hand back a sentence and it will be rejected, not stored.
    if (priorState.open?.kind === "name" && typeof proposal.answer_value === "string") {
      const validated = extractCustomerName(proposal.answer_value);
      if (validated) sideEffects = { ...sideEffects, pickup_name: validated };
    }
    // 00-BM: an address the model pulled out of the message. Code still
    // geocodes it -- the model never decides where food goes, it only finds
    // the words the deterministic span-extractor missed.
    if (priorState.open?.kind === "address" && typeof proposal.answer_value === "string" && proposal.answer_value.trim()) {
      const shopGeo = await loadShopGeo(deps.supabase, input.shopId);
      const geocodeFn = deps.geocodeAddressFn ?? defaultGeocodeAddress;
      const g = await geocodeFn(proposal.answer_value.trim(), shopGeo, {
        fetchImpl: deps.fetchImpl ?? fetch,
        apiKey: deps.googleMapsApiKey ?? Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "",
      });
      if (g) sideEffects = { ...sideEffects, delivery_address: { formatted: g.formatted } };
      else addressNotVerified = proposal.answer_value.trim();
    }
    const interpreted = proposal.answer_to_open_question;
    if (interpreted && priorState.open) {
      if (priorState.open.kind === "ordering" && interpreted === "closure") {
        answerOutcomeFromModel = { kind: "closure" };
      } else if (priorState.open.kind === "confirm" && (interpreted === "confirm_yes" || interpreted === "confirm_no")) {
        answerOutcomeFromModel = { kind: interpreted === "confirm_yes" ? "confirm_yes" : "confirm_no" };
      }
      // NOT disambiguation: 00-AT deliberately never consults the model while
      // that question is open, so execution cannot reach here for it. Using
      // the interpreter there needs an interpretation-ONLY call inside that
      // suppression branch -- the model reads the message, its cart changes
      // are discarded. Worth doing; not a two-line change.
    }
    const decideResult = decide(
      proposal,
      workingCart,
      input.menu,
      lexicon,
      deps.newLineKey ?? (() => crypto.randomUUID()),
      input.message,   // 00-BD: to tell a restatement from a new order
      inactiveLexicon,
    );
    workingCart.splice(0, workingCart.length, ...decideResult.cart);
    declines = decideResult.declines;
    // Round 3 P0 (2026-09-19, hallucinated-remove): decide() already dropped
    // these silently (no decline text -- see DecideResult.guardDroppedRemoves'
    // own header); logging here is purely an observability trip-wire, same
    // discipline as the lexicon-load logging above, never a second failure
    // path and never anything the customer sees.
    for (const dropped of decideResult.guardDroppedRemoves) {
      await logError(deps.supabase, {
        conversationId: input.conversationId,
        shopId: input.shopId,
        tenantId: input.tenantId,
        phase: "chat-sms",
        stage: "guard_deny",
        customerMessage: input.message,
        error: new Error("remove without removal language"),
        metadata: { line_key: dropped.line_key, item_name: dropped.item_name },
      });
    }
    turnEvents = {
      ...turnEvents,
      qualifyingAddMenuItemId: decideResult.qualifyingAddMenuItemId,
      disambiguationCandidateIds: decideResult.disambiguationCandidateIds,
      disambiguationQuantity: decideResult.disambiguationQuantity,
      disambiguationSpanText: decideResult.disambiguationSpanText,
      carriedDisambiguationCandidateIds: decideResult.carriedDisambiguationCandidateIds,
      heldModifierText: decideResult.heldModifierText,
      replacementSourceLineKey: decideResult.replacementSourceLineKey,
      categoryMismatchPending: decideResult.categoryMismatchPending,
      checkoutIntentThisTurn: proposal.intent === "checkout",
    };
    if (proposal.intent === "question" && proposal.answer_text) {
      answerText = proposal.answer_text;
    }
    // 00-BI: apply the meaning the model read, through the SAME turnEvents the
    // deterministic path uses -- so ASK and RENDER cannot tell the difference,
    // and there is one code path for "the customer confirmed", not two.
    if (answerOutcomeFromModel) {
      if (answerOutcomeFromModel.kind === "confirm_yes") turnEvents = { ...turnEvents, confirmYes: true };
      else if (answerOutcomeFromModel.kind === "confirm_no") turnEvents = { ...turnEvents, confirmNo: true };
      else if (answerOutcomeFromModel.kind === "closure") turnEvents = { ...turnEvents, checkoutIntentThisTurn: true };
    }
  }

  // Dispatch 00-AP: an opportunistic address found and geocoded above (open
  // question was something else entirely — a Temp slot, order_type, etc.)
  // lands as its own side effect, independent of whatever the primary ANSWER
  // switch above resolved this same turn. Deliberately unconditional on
  // answerResult.resolved — an add-item message that also happens to carry
  // the address should not lose the address just because the item itself
  // fell through to PROPOSE.
  if (opportunisticAddress) {
    sideEffects = { ...sideEffects, delivery_address: { formatted: opportunisticAddress.formatted } };
  }
  // Round 3, item 2b: same "independent of whatever the primary ANSWER
  // switch resolved this turn" reasoning as opportunisticAddress above —
  // never overwrites an order_type the switch itself already resolved this
  // turn (sideEffects.order_type == null guard), so there's no race between
  // the two paths on the rare turn where order_type WAS the open question
  // and also opportunistically matched.
  if (opportunisticOrderType && sideEffects.order_type == null) {
    sideEffects = { ...sideEffects, order_type: opportunisticOrderType };
  }

  // ── STEP 5: ASK ───────────────────────────────────────────────────────────
  // ASK must see what THIS turn's ANSWER just resolved, same as RENDER does a
  // few lines below (deliveryFeeCents/driverTipCents) — otherwise ASK runs
  // against the turn-START snapshot (input.shopContext) and re-fires a
  // question ANSWER already resolved this same turn (order_type, address,
  // driver tip, pickup name each go through this). sideEffects only ever
  // carries fields this turn's ANSWER actually resolved (see CartSideEffects
  // above and the switch that populates it), so this overlay can never mask
  // a question that's still genuinely open.
  const effectiveShopContext: RunTurnShopContext = {
    ...input.shopContext,
    orderType: sideEffects.order_type ?? input.shopContext.orderType,
    deliveryAddressKnown: sideEffects.delivery_address != null ? true : input.shopContext.deliveryAddressKnown,
    driverTipCents: sideEffects.driver_tip_cents ?? input.shopContext.driverTipCents,
    pickupName: sideEffects.pickup_name ?? input.shopContext.pickupName,
  };
  const shopContext = buildAskShopContext(effectiveShopContext, upsellEnabled);
  const nextState = ask(workingCart, priorState, turnEvents, shopContext, input.menu);
  // 2026-09-18 PO dispatch (echo regression follow-up): record what got
  // echoed THIS turn (if anything) so NEXT turn's anti-repeat check (above)
  // can tell a genuine second identical miss from a fresh one. Kept outside
  // `open` deliberately (see DialogueState.lastSlotEchoText's own doc) —
  // set directly on the object ask() already returned, never fed back into
  // ask()'s own pure logic. Cleared unconditionally otherwise (slot
  // resolved and the ladder moved on, OR this turn's echo was itself
  // suppressed as a repeat — nextLastSlotEchoText is already undefined in
  // both cases, so there's nothing case-specific to check here).
  if (nextLastSlotEchoText) nextState.lastSlotEchoText = nextLastSlotEchoText;
  else delete nextState.lastSlotEchoText;

  // ── STEP 6: RENDER ─────────────────────────────────────────────────────────
  // Same values feed persistTurn's total_cents below — one computation, not
  // a second copy that could drift from what the reply footer shows.
  const deliveryFeeCents = input.shopContext.deliveryFeeCents ?? 0;
  const driverTipCents = sideEffects.driver_tip_cents ?? input.shopContext.driverTipCents ?? 0;
  // 00-BB: say what we could not verify, before the question is re-asked.
  const declinesForRender: Decline[] = addressNotVerified
    ? [...declines, { reason: `I couldn't find "${addressNotVerified}" — can you check it, or give me a nearby cross street?` }]
    : declines;
  const rendered = render(cartBefore, workingCart, nextState, declinesForRender, input.menu, {
    deliveryFeeCents: deliveryFeeCents || undefined,
    driverTipCents: driverTipCents || undefined,
    // TurnEngineMenuItem's option_groups/ask_plan shape is a superset of what
    // buildMenuPriceIndex needs (id-based compiled option groups vs. its
    // legacy name/choices shape) — only the ask_plan.steps branch is ever
    // populated on a compiled item, which is exactly what this path prices.
    priceIndexByMenuItemId: buildMenuPriceIndex(input.menu as unknown as MenuItemForPricing[]),
    // 00-AZ: enumerate on ANY genuine repeat of a slot question, not only when
    // this turn happened to route through the suppression branch above. The
    // repeat counter now exists for every question kind, so the escalation no
    // longer depends on which code path re-asked -- if the customer has been
    // asked the same thing twice, show them the real choices.
    enumerateSlotChoices: enumerateSlotChoices || (priorState.openRepeatCount ?? 0) >= 1,
    unmatchedSlotChoiceText,
    enumerateDisambiguationCandidates,
  });
  const reply = answerText ? `${answerText}\n\n${rendered}` : rendered;

  // ── STEP 7: PERSIST ────────────────────────────────────────────────────────
  const saved = await persistTurn(deps.supabase, input, workingCart, nextState, sideEffects, reply, deliveryFeeCents, driverTipCents);

  return { reply, cart: workingCart, dialogueState: nextState, messageId: saved.id };
}
