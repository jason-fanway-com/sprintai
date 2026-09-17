// ─── Answer interpretation: the model reads, code decides ─────────────────
//
// WHY THIS EXISTS (2026-09-17, Jason): "You actually built a natural language
// chat to only accept exact matches to questions being answered by a human?
// Aren't we using an LLM?"
//
// He was right. Every answer detector in the turn engine was a hand-rolled
// regex anchored to the WHOLE message. Seven were found and loosened in one
// day -- the name question ("It's Alex!"), the confirm gate ("Yes, confirm the
// order!"), closure ("Nope, that's it for now!"), the delivery address, the tip
// decline, the tip amount, the confirm decline -- and the dominant loop STILL
// did not close, because real customers say things no pattern anticipates:
//
//   "whoa, what happened? i just wanted the large veggie pizza w/ just half
//    tomatoes, not extra"
//   "can u just confirm that I have the large veggie pizza w/ half tomatoes
//    for the original price"
//
// Neither is a closure, an affirmation, or a new order. There is no regex for
// that and there never will be.
//
// HOW THIS KEEPS THE ENGINE'S CONTRACT. The rebuild's rule is "the model
// phrases, code decides", which was read as "code interprets everything". That
// conflated two different jobs:
//   - "which menu item is this, and what does it cost" -- must be
//     deterministic; money depends on it; stays exactly as it is.
//   - "did this person just say yes" -- natural language understanding, where
//     the model is far better than any regex and being wrong is cheap and
//     recoverable.
// This module does only the second, and the model can never invent: it is
// handed a CLOSED LIST of answer ids that code supplied, and code rejects
// anything not on that list. A refusal falls back to exactly the behaviour
// that exists today.
//
// It is also the LAST resort, never the first. The deterministic detectors run
// first and this is only called when they all miss -- so the common case costs
// no latency and no tokens, and a conversation that was working keeps working
// byte-for-byte.

export interface AnswerOption {
  id: string;
  /** What choosing this means, in plain words, for the model to match against. */
  describes: string;
}

export interface InterpretAnswerInput {
  /** The question the customer was actually asked, verbatim. */
  question: string;
  /** What the customer said. */
  message: string;
  /** The ONLY ids that may be returned. Code rejects anything else. */
  options: AnswerOption[];
}

export interface InterpretAnswerDeps {
  apiKey: string;
  model?: string;
  chatApiUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const DEFAULT_CHAT_API = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 8000;

const TOOL_NAME = "report_answer";

const SYSTEM = `You read ONE customer message and decide which of a fixed list of answers it matches.

Rules:
- You may ONLY return an id from the options given. Never invent an id.
- If the message does not clearly match any option, return "none". A wrong guess is worse than "none" -- code has a safe fallback for "none".
- Judge only what the customer MEANT by this message. Do not consider the order, prices, or anything else.
- A message can be indirect, misspelled, frustrated, or wrapped in other words and still clearly mean one of the options.`;

function buildTool(options: AnswerOption[]) {
  return {
    name: TOOL_NAME,
    description: "Report which option the customer's message matches, or none.",
    input_schema: {
      type: "object",
      properties: {
        answer_id: {
          type: "string",
          enum: [...options.map(o => o.id), "none"],
          description: "The id of the matching option, or \"none\".",
        },
      },
      required: ["answer_id"],
      additionalProperties: false,
    },
  };
}

/**
 * Returns a validated option id, or null. Null means "nothing matched, or the
 * call failed" -- the caller must behave exactly as it did before this module
 * existed. This function never throws and never returns an id that was not in
 * `options`.
 */
export async function interpretAnswer(
  input: InterpretAnswerInput,
  deps: InterpretAnswerDeps,
): Promise<string | null> {
  if (!input.message.trim() || input.options.length === 0 || !deps.apiKey) return null;

  const allowed = new Set(input.options.map(o => o.id));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetchImpl(deps.chatApiUrl ?? DEFAULT_CHAT_API, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://getsprintai.com",
        "X-Title": "SprintAI",
      },
      body: JSON.stringify({
        model: deps.model ?? DEFAULT_MODEL,
        max_tokens: 128,
        reasoning: { enabled: false },
        system: SYSTEM,
        messages: [{
          role: "user",
          content:
            `The customer was asked: ${input.question}\n\n` +
            `They replied: ${input.message}\n\n` +
            `Options:\n${input.options.map(o => `- ${o.id}: ${o.describes}`).join("\n")}`,
        }],
        tools: [buildTool(input.options)],
        tool_choice: { type: "tool", name: TOOL_NAME },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ type: string; name?: string; input?: unknown }> };
    const block = (data.content ?? []).find(b => b.type === "tool_use" && b.name === TOOL_NAME);
    const id = (block?.input as { answer_id?: unknown } | undefined)?.answer_id;
    if (typeof id !== "string") return null;
    // The whole safety property of this module: an id the model was not
    // offered is discarded, not trusted.
    return allowed.has(id) ? id : null;
  } catch {
    return null;   // timeout, network, malformed — always the existing fallback
  } finally {
    clearTimeout(timer);
  }
}
