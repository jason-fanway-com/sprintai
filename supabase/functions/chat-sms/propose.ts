// Turn Engine, Phase 2 (docs/specs/2026-09-14-turn-engine-oversight.md §3b
// step 3, §3c, §4 Phase 2).
//
// PROPOSE: the one place left that calls the model. The model is an NLU,
// not an agent — it returns a structured Proposal (ids only, no free-text
// item names, no source_phrase, no `modifiers: string[]`), never acts
// directly, and has no reply authority (`answer_text` is permitted only
// when `intent === "question"`). One model call. No tool loop, no second
// round-trip inside a call — exactly one retry of the whole call if the
// first attempt fails, for any reason.
//
// Every failure — a non-200 response, a timeout, a response body that
// isn't valid JSON, or a body that IS valid JSON but violates the Proposal
// contract — persists a row to error_log (stage: "propose_call") once both
// attempts are exhausted, carrying the raw response body of the failing
// attempt(s). This is the whole point of the phase: today's "Sorry, I ran
// into a problem" fallback leaves no trace at all (conversation b4c80c78,
// open item E in the oversight doc), so item E has been unfalsifiable.
// A schema-invalid proposal is a failure, logged and returned as a typed
// failure result — it is never silently coerced into a partial proposal.
//
// Shaped for testability per the Phase 2 dispatch: the Supabase client, the
// HTTP transport, and the clock are all injected via ProposeDeps, never a
// module-level global. propose.test.ts exercises every parse and failure
// path with a stubbed transport — zero network in the unit tests. The 20
// live model calls happen only in the acceptance script
// (~/po-scratch/propose-mx.py), not here.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { logError } from "../_shared/error-log.ts";
import { identityKey } from "./turn-reconciler.ts";
import type {
  Proposal,
  DialogueState,
  TurnEngineCartLine,
  TurnEngineMenuItem,
} from "./turn-engine.ts";

export const DEFAULT_CHAT_API = "https://openrouter.ai/api/v1/messages";
export const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
export const DEFAULT_TIMEOUT_MS = 25_000;

const PROPOSAL_TOOL_NAME = "submit_proposal";

// ─── Public input/output shapes ─────────────────────────────────────────

export interface LexiconTerm {
  term: string;
  target_id: string;
}

export interface ProposeTurnInput {
  cart: TurnEngineCartLine[];
  open: DialogueState["open"];
  menu: TurnEngineMenuItem[];
  // Compiled item-level lexicon terms (the `lexicon` table, target_type =
  // 'item', active = true), injected by the caller — see the note by
  // buildMenuIndex below for why this is not derived here.
  lexicon: LexiconTerm[];
  // Last six turns of conversation history, oldest first — NOT including
  // the current customer message, which is `message` below.
  history: Array<{ role: "user" | "assistant"; content: string }>;
  message: string;
}

export interface ProposeDeps {
  supabase: SupabaseClient;
  apiKey: string;
  // Injected transport. Defaults to the global fetch; propose.test.ts
  // always overrides this, so no unit test ever touches the network.
  fetchImpl?: typeof fetch;
  // Injected clock, used only to measure and report attempt latency in the
  // error_log metadata — never for control flow.
  now?: () => number;
  model?: string;
  chatApiUrl?: string;
  timeoutMs?: number;
  conversationId?: string | null;
  shopId?: string | null;
  tenantId?: string | null;
}

export type ProposeFailureReason =
  | "non_200"
  | "timeout"
  | "network_error"
  | "malformed_json"
  | "schema_violation";

export interface ProposeAttemptRecord {
  attempt: number;
  reason: ProposeFailureReason;
  detail: string;
  rawBody: string | null;
  ms: number;
}

export type ProposeResult =
  | { ok: true; proposal: Proposal; attempts: number }
  | { ok: false; reason: ProposeFailureReason; detail: string; attempts: ProposeAttemptRecord[] };

// ─── Menu index / cart projection for the prompt ────────────────────────
//
// §3c: "the prompt shrinks to: the menu index (id, name, price, category,
// orderable, lexicon), the cart with line_keys, the open question, the
// last six turns, and the schema." The schema itself is the tool's own
// input_schema below — OpenRouter/Anthropic-style tool definitions already
// put that in front of the model, so it is not duplicated into prose here.

interface MenuIndexEntry {
  id: string;
  name: string;
  price_cents: number;
  category: string | null;
  orderable: boolean;
  lexicon: string[];
}

// Turn Engine Phase 2 bounce (2026-09-14/15, PO): this used to derive a
// one-word alias per item at runtime (last-word-if-unique-across-the-menu),
// re-implementing index.ts's buildMenuItemNames heuristic. On Vito's real
// 221-item menu that left 197 items — including both "Cheese Burger" and
// "Bacon Cheeseburger" — with an EMPTY derived lexicon, because "burger"
// isn't unique across the menu's several burger rows. The model then
// matched on bare `name` substring alone, and "cheeseburger" as a token
// happens to substring-match "Bacon Cheeseburger" — 8 of 17 non-ambiguous
// live calls in the first acceptance run resolved a plain "cheeseburger"
// order to the $10.99 item instead of the $8.49 one. Wrong item for money.
//
// The compile-menu.ts compiler already materializes a correct, reviewed
// lexicon (the `lexicon` table: term -> target_id, provenance, active) —
// 'cheese burger' -> Cheese Burger, 'bacon cheeseburger' -> Bacon
// Cheeseburger, distinct and correct. Re-deriving a worse copy of it here
// was the bug. This module takes that lexicon as an INJECTED INPUT
// (ProposeTurnInput.lexicon) instead — propose.ts stays pure of I/O, same
// as every other dependency; the caller (Phase 3 in production; the
// acceptance script for now) is the one that reads the `lexicon` table,
// filtered to active = true.
function buildMenuIndex(menu: TurnEngineMenuItem[], lexicon: LexiconTerm[]): MenuIndexEntry[] {
  const termsByTargetId = new Map<string, string[]>();
  for (const { term, target_id } of lexicon) {
    const arr = termsByTargetId.get(target_id) ?? [];
    arr.push(term);
    termsByTargetId.set(target_id, arr);
  }
  return menu.map(item => ({
    id: item.id,
    name: item.name,
    price_cents: item.price_cents,
    category: item.category ?? null,
    orderable: item.bot_state !== "blocked" && item.bot_state !== "display_only",
    lexicon: termsByTargetId.get(item.id) ?? [],
  }));
}

interface CartIndexEntry {
  line_key: string;
  menu_item_id: string;
  name: string;
  quantity: number;
  price_cents: number;
  options?: Record<string, string[]>;
}

function buildCartIndex(cart: TurnEngineCartLine[]): CartIndexEntry[] {
  return cart
    .filter(line => typeof line.menu_item_id === "string")
    .map(line => ({
      line_key: identityKey(line.menu_item_id, line.options),
      menu_item_id: line.menu_item_id,
      name: line.name,
      quantity: line.quantity,
      price_cents: line.price_cents,
      options: line.options,
    }));
}

const SYSTEM_PROMPT_PREAMBLE = `You are the ordering NLU for a restaurant's SMS/chat bot. You do not talk to the customer — you translate their message into a structured Proposal that code will validate and apply. You have no reply authority: never write anything the customer will see, except answer_text, and only when intent is "question".

Rules:
- Use ONLY menu_item_id, group_id, choice_id values that appear in the menu index or cart below. Never invent an id. Never use a free-text item name in place of an id.
- quantity is always an integer count the customer actually stated or clearly implied (e.g. "two cheeseburgers" -> 2). Never infer a quantity from price or guesswork.
- removes and modifies reference an existing cart line by its line_key, never by item name.
- remove_choices on a modify is a list of choice_id values to drop from that line's existing selections — only when the customer is removing a specific option, not swapping the whole group.
- intent is exactly one of: "order" (adding/removing/changing items), "checkout" (ready to pay), "cancel" (wants to cancel the whole order), "question" (asking something that isn't an order action — hours, ingredients, policy), "other" (anything else, including small talk).
- answer_text is allowed ONLY when intent is "question": a short, plain answer, no digits, no item names, at most two sentences. Every other intent must omit answer_text entirely.
- Call submit_proposal exactly once. It is the only tool available.`;

function buildSystemPrompt(menu: TurnEngineMenuItem[], lexicon: LexiconTerm[], cart: TurnEngineCartLine[], open: DialogueState["open"]): string {
  return [
    SYSTEM_PROMPT_PREAMBLE,
    `Menu index:\n${JSON.stringify(buildMenuIndex(menu, lexicon))}`,
    `Cart:\n${JSON.stringify(buildCartIndex(cart))}`,
    `Currently open question (what the customer is mid-answering, if anything):\n${JSON.stringify(open)}`,
  ].join("\n\n");
}

const PROPOSAL_TOOL = {
  name: PROPOSAL_TOOL_NAME,
  description: "Report the customer's intent and any cart changes as a structured proposal. Ids only — never free text.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["order", "checkout", "cancel", "question", "other"] },
      adds: {
        type: "array",
        items: {
          type: "object",
          properties: {
            menu_item_id: { type: "string" },
            quantity: { type: "integer", minimum: 1 },
            choices: {
              type: "array",
              items: {
                type: "object",
                properties: { group_id: { type: "string" }, choice_id: { type: "string" } },
                required: ["group_id", "choice_id"],
              },
            },
          },
          required: ["menu_item_id", "quantity", "choices"],
        },
      },
      removes: {
        type: "array",
        items: {
          type: "object",
          properties: { line_key: { type: "string" } },
          required: ["line_key"],
        },
      },
      modifies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line_key: { type: "string" },
            quantity: { type: "integer", minimum: 1 },
            choices: {
              type: "array",
              items: {
                type: "object",
                properties: { group_id: { type: "string" }, choice_id: { type: "string" } },
                required: ["group_id", "choice_id"],
              },
            },
            remove_choices: { type: "array", items: { type: "string" } },
          },
          required: ["line_key"],
        },
      },
      answer_text: { type: "string", description: "Only set when intent is \"question\"." },
    },
    required: ["intent", "adds", "removes", "modifies"],
  },
};

// ─── Schema validation — hand-rolled, same convention as the rest of this
// codebase (no zod/ajv anywhere in supabase/functions/). Structural only:
// do ids actually exist on the menu/cart is DECIDE's job (§3b step 4), not
// PROPOSE's. A violation here is a typed failure, never a partial coercion.

const VALID_INTENTS = new Set(["order", "checkout", "cancel", "question", "other"]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function validateChoices(v: unknown): v is Array<{ group_id: string; choice_id: string }> {
  if (!Array.isArray(v)) return false;
  return v.every(c => c && typeof c === "object" && isNonEmptyString((c as Record<string, unknown>).group_id) && isNonEmptyString((c as Record<string, unknown>).choice_id));
}

function validateProposalShape(v: unknown): v is Proposal {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;

  if (typeof p.intent !== "string" || !VALID_INTENTS.has(p.intent)) return false;

  if (!Array.isArray(p.adds)) return false;
  for (const a of p.adds) {
    if (!a || typeof a !== "object") return false;
    const add = a as Record<string, unknown>;
    if (!isNonEmptyString(add.menu_item_id)) return false;
    if (typeof add.quantity !== "number" || !Number.isInteger(add.quantity) || add.quantity < 1) return false;
    if (!validateChoices(add.choices)) return false;
  }

  if (!Array.isArray(p.removes)) return false;
  for (const r of p.removes) {
    if (!r || typeof r !== "object" || !isNonEmptyString((r as Record<string, unknown>).line_key)) return false;
  }

  if (!Array.isArray(p.modifies)) return false;
  for (const m of p.modifies) {
    if (!m || typeof m !== "object") return false;
    const mod = m as Record<string, unknown>;
    if (!isNonEmptyString(mod.line_key)) return false;
    if (mod.quantity !== undefined && (typeof mod.quantity !== "number" || !Number.isInteger(mod.quantity) || mod.quantity < 1)) return false;
    if (mod.choices !== undefined && !validateChoices(mod.choices)) return false;
    if (mod.remove_choices !== undefined) {
      if (!Array.isArray(mod.remove_choices) || !mod.remove_choices.every(isNonEmptyString)) return false;
    }
  }

  // The model has no reply authority outside intent === "question" — a
  // proposal that sets answer_text under any other intent is a contract
  // violation, not something to strip and pass through.
  if (p.answer_text !== undefined) {
    if (typeof p.answer_text !== "string") return false;
    if (p.intent !== "question") return false;
  }

  return true;
}

// ─── Response parsing ────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  text?: string;
}

interface ChatApiResponse {
  stop_reason?: string;
  content?: ContentBlock[];
}

function extractProposalInput(data: ChatApiResponse): unknown {
  const block = (data.content ?? []).find(b => b.type === "tool_use" && b.name === PROPOSAL_TOOL_NAME);
  return block?.input;
}

// ─── One HTTP attempt ────────────────────────────────────────────────────

interface AttemptSuccess { ok: true; proposal: Proposal; rawBody: string; ms: number }
interface AttemptFailure { ok: false; reason: ProposeFailureReason; detail: string; rawBody: string | null; ms: number }
type AttemptResult = AttemptSuccess | AttemptFailure;

async function attemptOnce(
  input: ProposeTurnInput,
  deps: Required<Pick<ProposeDeps, "apiKey" | "model" | "chatApiUrl" | "timeoutMs">> & { fetchImpl: typeof fetch; now: () => number },
): Promise<AttemptResult> {
  const t0 = deps.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

  const messages = [
    ...input.history.slice(-6).map(h => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: input.message },
  ];

  let res: Response;
  try {
    res = await deps.fetchImpl(deps.chatApiUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://getsprintai.com",
        "X-Title": "SprintAI",
      },
      body: JSON.stringify({
        model: deps.model,
        max_tokens: 1024,
        reasoning: { enabled: false },
        system: buildSystemPrompt(input.menu, input.lexicon, input.cart, input.open),
        messages,
        tools: [PROPOSAL_TOOL],
        tool_choice: { type: "tool", name: PROPOSAL_TOOL_NAME },
      }),
    });
  } catch (err) {
    const ms = deps.now() - t0;
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "timeout", detail: `no response within ${deps.timeoutMs}ms`, rawBody: null, ms };
    }
    return { ok: false, reason: "network_error", detail: err instanceof Error ? err.message : String(err), rawBody: null, ms };
  } finally {
    clearTimeout(timer);
  }

  const ms = deps.now() - t0;
  const rawBody = await res.text();

  if (!res.ok) {
    return { ok: false, reason: "non_200", detail: `HTTP ${res.status}`, rawBody, ms };
  }

  let data: ChatApiResponse;
  try {
    data = JSON.parse(rawBody);
  } catch (err) {
    return { ok: false, reason: "malformed_json", detail: err instanceof Error ? err.message : String(err), rawBody, ms };
  }

  const proposalInput = extractProposalInput(data);
  if (!validateProposalShape(proposalInput)) {
    return { ok: false, reason: "schema_violation", detail: "response did not contain a schema-valid submit_proposal tool call", rawBody, ms };
  }

  return { ok: true, proposal: proposalInput, rawBody, ms };
}

// ─── Public entry point ──────────────────────────────────────────────────

export async function proposeTurn(input: ProposeTurnInput, deps: ProposeDeps): Promise<ProposeResult> {
  const resolved = {
    apiKey: deps.apiKey,
    model: deps.model ?? DEFAULT_MODEL,
    chatApiUrl: deps.chatApiUrl ?? DEFAULT_CHAT_API,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: deps.fetchImpl ?? fetch,
    now: deps.now ?? (() => Date.now()),
  };

  const records: ProposeAttemptRecord[] = [];
  // Exactly one retry: two attempts total, regardless of which of the four
  // failure kinds the first attempt hits.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await attemptOnce(input, resolved);
    if (result.ok) return { ok: true, proposal: result.proposal, attempts: attempt };
    records.push({ attempt, reason: result.reason, detail: result.detail, rawBody: result.rawBody, ms: result.ms });
  }

  const last = records[records.length - 1];
  await logError(deps.supabase, {
    conversationId: deps.conversationId ?? null,
    shopId: deps.shopId ?? null,
    tenantId: deps.tenantId ?? null,
    phase: "chat-sms",
    stage: "propose_call",
    customerMessage: input.message,
    error: new Error(`propose_call failed after ${records.length} attempts: ${last.reason} — ${last.detail}`),
    metadata: {
      model: resolved.model,
      timeoutMs: resolved.timeoutMs,
      attempts: records.map(r => ({ attempt: r.attempt, reason: r.reason, detail: r.detail, ms: r.ms, raw_body: r.rawBody })),
    },
  });

  return { ok: false, reason: last.reason, detail: last.detail, attempts: records };
}
