// interpret.ts — the one model call. The model translates one customer message
// into typed moves with verbatim spans. It never sees the menu, the ledger, or
// the transcript, and nothing it returns reaches the customer as text.
import Anthropic from "npm:@anthropic-ai/sdk";
import type { Move, OpenQuestion } from "./form.ts";
import { parseTip } from "./vocab.ts";
import { talkClaimsTime, validTalk } from "./normalize.ts";
import { T } from "./templates.ts";

export interface InterpretContext {
  shop_name: string;
  message: string;
  last_bot: string | null;
  /** the open question, already reduced to words the model can use */
  open: OpenQuestion | null;
  open_summary: string | null;          // e.g. "size for Pepperoni Pizza: small, medium, or large"
  lines: Array<{ line_id: number; name: string; qty: number }>;
}

export interface ModelConfig {
  provider: "anthropic" | "openrouter";
  model: string;
  apiKey: string;
  timeoutMs?: number;
  baseURL?: string;
}

export type InterpretResult =
  | { ok: true; moves: Move[]; raw: unknown; ms: number; usage?: unknown }
  | { ok: false; reason: "timeout" | "network" | "http" | "schema" | "refusal"; detail: string; raw: unknown; ms: number };

export const SYSTEM_PROMPT = `You translate one text message from a restaurant customer into a list of moves for an ordering form. You are a translator, not the cashier: you never choose menu items, never compute anything, and never write a reply.

Return moves in the order the customer said them. Copy words exactly as the customer typed them (verbatim spans, lowercase is fine, keep their spelling).

Move kinds:
- add_line: one per distinct item the customer wants. item_span = their words for the item only (no quantity, no size). qty = the integer they said, else 1. option_spans = each descriptor they attached to that item (size, topping, sauce, cooked temperature, "no onions", "extra cheese"), one string each, verbatim.
- change_line: they change an item already in the order. ref_span = their words for which line (or ref_last=true when there is one line or they say "that"). qty for a new quantity; add_option_spans / remove_option_spans for options.
- remove_line: take an item off. "X not Y" = remove_line(Y) then add_line(X).
- answer: field fulfillment (value "pickup" or "delivery"), address (value = the address text), tip (value = their exact words, keep any % or dollar sign or the word dollars), items_done (they are finished adding items: "that's it", "no that's all"), confirmed (value "yes" or "no" when asked to confirm the order).
- answer_option: the message answers the open item question (a size, a kind, a cooked temperature, a dressing, a numbered choice). value_span = their words. Use this instead of add_line when the words answer that question.
- answer_yes / answer_no: a bare yes or no to a yes/no question.
- ask_menu: a question about the menu ("what sizes", "do you have", "how much is"). about_span = the customer's own words for the thing they asked about, verbatim ("gluten free crust", "pizzas"); null ONLY when they ask what the options are without naming anything ("what are my choices", "what do you have"). A request phrased as a question ("can I get a large pepperoni?") is add_line, not ask_menu.
- control: cancel, start_over, human (wants a person), greeting (just hello), show_cart (what's in my order), unclear (nothing above applies).
- talk: the customer is talking rather than ordering: a question about something we said, a complaint, a thank-you, a joke, small talk. Put a short, honest, friendly reply in the value field (one or two sentences, plain words). Never mention what anything costs, never say you added, removed or changed anything (the order system reports that itself), never promise things about the food. You do not know prep or delivery times, opening hours, or whether the shop is open: say you can't see that from here and that we text when the order is ready. If they ask what an earlier line of ours meant, explain it simply. You may return talk together with order moves when a message does both.

A message may need several moves: "delivery to 12 Main St, 2 large pepperoni and knots" = answer fulfillment delivery; answer address "12 Main St"; add_line "pepperoni" qty 2 option_spans ["large"]; add_line "knots".
If the open question is about an item and the message only answers it ("medium", "the large one", "ranch please"), return one answer_option.
Quantity words: "a", "an", "one" = 1; "a couple" = 2; "a few" = 3. "A dozen bagels" or "half a dozen" is ONE item whose item_span is "dozen bagels" / "half dozen bagels" with qty 1; the flavor counts ("6 plain, 6 everything") are its option_spans.
Never invent an item the customer did not name. Never drop one they did.

Examples (context -> customer -> moves):
- open none; "2 large pepperoni and an order of garlic knots" -> add_line "pepperoni" qty 2 ["large"]; add_line "garlic knots" qty 1 []
- open none; "cheeseburger, medium please" -> add_line "cheeseburger" qty 1 ["medium"]
- open size question for Pepperoni Pizza; "large please" -> answer_option "large"
- open cooked-temperature question for Cheese Burger; "medium" -> answer_option "medium"
- order has Large Cheese Pizza and Garlic Knots; "actually pepperoni not cheese" -> remove_line ref_span "cheese"; add_line "pepperoni" qty 1 []
- order has Garlic Knots; "make that 3 knots" -> change_line ref_span "knots" qty 3
- order has one line; "make it 2" -> change_line ref_last true qty 2
- order has Garlic Knots; "remove the knots" -> remove_line ref_span "knots"
- open anything-else; "no that's it" -> answer items_done
- open pickup-or-delivery; "delivery to 12 Main St" -> answer fulfillment "delivery"; answer address "12 Main St"
- open tip; "20" -> answer tip "20"
- open confirm; "yes" -> answer confirmed "yes"
- "what sizes do the pizzas come in" -> ask_menu about_span "pizzas"
- "can I get a large pepperoni" -> add_line "pepperoni" qty 1 ["large"]
- "whats in my order" -> control show_cart
- "asdf" -> control unclear
- "what does that mean?" (after we said something odd) -> talk value "Sorry about that, that was a note I attached by mistake. Nothing changes on your order."
- "thanks!" -> talk value "You're welcome!"
- "you're terrible at this" -> talk value "Sorry, I'm not getting it right. Tell me the item and I'll get it in."`;

const MOVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    moves: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["answer", "add_line", "change_line", "remove_line", "answer_option", "answer_yes", "answer_no", "ask_menu", "control", "talk"] },
          field: { type: ["string", "null"], enum: ["fulfillment", "address", "tip", "items_done", "confirmed", null] },
          value: { type: ["string", "null"] },
          item_span: { type: ["string", "null"] },
          qty: { type: ["integer", "null"] },
          option_spans: { type: "array", items: { type: "string" } },
          ref_span: { type: ["string", "null"] },
          ref_last: { type: "boolean" },
          add_option_spans: { type: "array", items: { type: "string" } },
          remove_option_spans: { type: "array", items: { type: "string" } },
          value_span: { type: ["string", "null"] },
          about_span: { type: ["string", "null"] },
          what: { type: ["string", "null"], enum: ["cancel", "start_over", "human", "greeting", "unclear", "show_cart", null] },
        },
        required: ["kind", "field", "value", "item_span", "qty", "option_spans", "ref_span", "ref_last", "add_option_spans", "remove_option_spans", "value_span", "about_span", "what"],
      },
    },
  },
  required: ["moves"],
} as const;

const TOOL_NAME = "submit_moves";

export function renderContext(ctx: InterpretContext): string {
  const lines = ctx.lines.length
    ? ctx.lines.map((l, i) => `${i + 1}) ${l.qty} × ${l.name}`).join("\n")
    : "(empty)";
  return [
    `Shop: ${ctx.shop_name}`,
    `Order so far:\n${lines}`,
    `Open question: ${ctx.open_summary ?? "none"}`,
    `Our last message: ${ctx.last_bot ? JSON.stringify(ctx.last_bot) : "none"}`,
    `Customer says: ${JSON.stringify(ctx.message)}`,
  ].join("\n\n");
}

interface RawMove {
  kind: string; field: string | null; value: string | null; item_span: string | null; qty: number | null;
  option_spans: string[]; ref_span: string | null; ref_last: boolean; add_option_spans: string[]; remove_option_spans: string[];
  value_span: string | null; about_span: string | null; what: string | null;
}

/** Strict conversion from the model's raw shape to typed moves. Anything malformed is dropped, never guessed. */
export function toMoves(raw: unknown, message = ""): Move[] {
  const out: Move[] = [];
  const arr = (raw as { moves?: unknown })?.moves;
  if (!Array.isArray(arr)) return out;
  for (const r0 of arr) {
    const r = r0 as Partial<RawMove>;
    const strs = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []);
    const ref = () => (r.ref_span && r.ref_span.trim() ? { span: r.ref_span.trim() } : r.ref_last ? { last: true as const } : null);
    switch (r.kind) {
      case "answer": {
        const v = (r.value ?? "").trim();
        if (r.field === "fulfillment" && (v === "pickup" || v === "delivery")) out.push({ kind: "answer", field: "fulfillment", value: v });
        else if (r.field === "address" && v) out.push({ kind: "answer", field: "address", value: { text: v, formatted: null, validated: false, zone_ok: false } });
        else if (r.field === "tip") { const t = parseTip(message) ?? parseTip(v); if (t) out.push({ kind: "answer", field: "tip", value: t }); }
        else if (r.field === "items_done") out.push({ kind: "answer", field: "items_done", value: true });
        else if (r.field === "confirmed") { if (v === "yes") out.push({ kind: "answer", field: "confirmed", value: true }); else if (v === "no") out.push({ kind: "answer", field: "confirmed", value: false }); }
        break;
      }
      case "add_line": {
        if (r.item_span && r.item_span.trim()) out.push({ kind: "add_line", item_span: r.item_span.trim(), qty: Math.max(1, Math.floor(r.qty ?? 1)), option_spans: strs(r.option_spans) });
        break;
      }
      case "change_line": {
        const rf = ref(); if (!rf) break;
        out.push({ kind: "change_line", ref: rf, qty: r.qty ?? null, add_option_spans: strs(r.add_option_spans), remove_option_spans: strs(r.remove_option_spans) });
        break;
      }
      case "remove_line": { const rf = ref(); if (rf) out.push({ kind: "remove_line", ref: rf }); break; }
      case "answer_option": { if (r.value_span && r.value_span.trim()) out.push({ kind: "answer_option", value_span: r.value_span.trim() }); break; }
      case "answer_yes": out.push({ kind: "answer_yes" }); break;
      case "answer_no": out.push({ kind: "answer_no" }); break;
      case "ask_menu": out.push({ kind: "ask_menu", about_span: r.about_span && r.about_span.trim() ? r.about_span.trim() : null }); break;
      case "talk": {
        const text = validTalk(r.value ?? "") ?? (talkClaimsTime(r.value ?? "") ? T.noEta() : null);
        if (text) out.push({ kind: "talk", text });
        break;
      }
      case "control": {
        const w = r.what;
        if (w === "cancel" || w === "start_over" || w === "human" || w === "greeting" || w === "unclear" || w === "show_cart") out.push({ kind: "control", what: w });
        break;
      }
    }
  }
  return out;
}

function requestBody(model: string, ctx: InterpretContext) {
  const isHaiku = model.includes("haiku");
  return {
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: renderContext(ctx) }],
    tools: [{ name: TOOL_NAME, description: "Submit the moves for this customer message.", strict: true, input_schema: MOVE_SCHEMA }],
    tool_choice: { type: "tool" as const, name: TOOL_NAME },
    ...(isHaiku ? {} : { output_config: { effort: "low" as const } }),
  };
}

function extractToolInput(content: Array<{ type: string; name?: string; input?: unknown }>): unknown {
  const block = content.find((b) => b.type === "tool_use" && b.name === TOOL_NAME);
  return block?.input ?? null;
}

export async function interpret(ctx: InterpretContext, cfg: ModelConfig): Promise<InterpretResult> {
  const t0 = Date.now();
  const timeoutMs = cfg.timeoutMs ?? 15000;
  const body = requestBody(cfg.model, ctx);
  try {
    if (cfg.provider === "anthropic") {
      const client = new Anthropic({ apiKey: cfg.apiKey, timeout: timeoutMs, maxRetries: 1, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) });
      // deno-lint-ignore no-explicit-any
      const res = await client.messages.create(body as any);
      const ms = Date.now() - t0;
      if (res.stop_reason === "refusal") return { ok: false, reason: "refusal", detail: "model refused", raw: res, ms };
      const input = extractToolInput(res.content as Array<{ type: string; name?: string; input?: unknown }>);
      if (!input) return { ok: false, reason: "schema", detail: "no submit_moves tool call", raw: res, ms };
      return { ok: true, moves: toMoves(input, ctx.message), raw: input, ms, usage: res.usage };
    }
    // OpenRouter speaks the same Messages shape; used only for baseline comparisons.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(cfg.baseURL ?? "https://openrouter.ai/api/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: { "Authorization": `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://getsprintai.com", "X-Title": "SprintAI" },
        body: JSON.stringify({ ...body, reasoning: { enabled: false }, output_config: undefined }),
      });
    } finally { clearTimeout(timer); }
    const ms = Date.now() - t0;
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: "http", detail: `HTTP ${res.status}: ${text.slice(0, 200)}`, raw: text, ms };
    let data: { content?: Array<{ type: string; name?: string; input?: unknown }>; usage?: unknown };
    try { data = JSON.parse(text); } catch { return { ok: false, reason: "schema", detail: "non-JSON body", raw: text, ms }; }
    const input = extractToolInput(data.content ?? []);
    if (!input) return { ok: false, reason: "schema", detail: "no submit_moves tool call", raw: data, ms };
    return { ok: true, moves: toMoves(input, ctx.message), raw: input, ms, usage: data.usage };
  } catch (err) {
    const ms = Date.now() - t0;
    const e = err as { name?: string; status?: number; message?: string };
    if (e?.name === "AbortError" || e?.name === "APIConnectionTimeoutError") return { ok: false, reason: "timeout", detail: `no response within ${timeoutMs}ms`, raw: null, ms };
    if (typeof e?.status === "number") return { ok: false, reason: "http", detail: `HTTP ${e.status}: ${e.message ?? ""}`, raw: null, ms };
    return { ok: false, reason: "network", detail: e?.message ?? String(err), raw: null, ms };
  }
}

/** Build the open-question summary the model sees (names and choices only). */
export function summarizeOpen(open: OpenQuestion | null, lines: Array<{ line_id: number; name: string }>, choicesFor: (q: OpenQuestion) => string[] | null): string | null {
  if (!open) return null;
  const nameOf = (id: number) => lines.find((l) => l.line_id === id)?.name ?? "the item";
  switch (open.kind) {
    case "fulfillment": return "pickup or delivery";
    case "address": return "the delivery address";
    case "items": return lines.length ? "anything else to add" : "what they would like to order";
    case "tip": return "tip amount for the driver";
    case "confirm": return "confirm the order (yes) or change something";
    case "omission": return `did they also want ${open.spans.map((x) => `"${x}"`).join(" and ")} (yes or no)`;
    case "line_unresolved": return `we could not find "${nameOf(open.line_id)}" on the menu; what would they like instead`;
    case "line_ambiguous": { const c = choicesFor(open); return `which ${open.facet === "size" ? "size" : "kind"} for ${nameOf(open.line_id)}${c ? `: ${c.join(", ")}` : ""}`; }
    case "line_slot": { const c = choicesFor(open); return `a required choice for ${nameOf(open.line_id)}${c ? `: ${c.join(", ")}` : ""}`; }
    case "line_picks": { const c = choicesFor(open); return `which ${open.remaining} more items go in ${nameOf(open.line_id)} and how many of each${c ? `: ${c.join(", ")}` : ""}`; }
    case "line_ref": return "which line they mean (a number)";
  }
}
