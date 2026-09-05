/**
 * SprintAI Transcript Judge — the ADVISORY plain-language critique for a
 * single captured `test_transcripts` row (docs/specs/2026-09-05-judge-panel.md).
 *
 * Distinct from judge-rubric.ts (the eval-sweep Conversation Judge): that one
 * emits machine check ids/severities for GATING evals. This one emits a
 * plain-English read for a restaurant owner, a soft advisory score, and
 * proposals for a human review queue. It never gates anything, and it never
 * produces anything an automated path could apply — see coerceVerdict below,
 * which force-sets every proposal's status to 'proposed' regardless of what
 * the model returns.
 */

export interface TranscriptJudgeMessage {
  role: string;
  text: string;
  at?: string;
}

export interface TranscriptJudgeInput {
  shop_name: string;
  model: string | null;
  messages: TranscriptJudgeMessage[];
  final_cart: unknown;
  reporter_note?: string | null;
}

export interface TranscriptJudgeProposal {
  title: string;
  rationale: string;
  target: string;
  status: "proposed";
}

export interface TranscriptJudgeVerdict {
  summary: string;
  score: number | null;
  proposals: TranscriptJudgeProposal[];
}

const SYSTEM_PROMPT = `
You are reading a test conversation between a customer and a restaurant's
SMS ordering assistant, on behalf of the RESTAURANT OWNER who just ran it.

The owner is not an engineer. Write for them, in plain, warm, direct English.

HARD RULES ON TONE:
- Never use engineering language: no "guard", "handler", "phantom add", "flag",
  "turn N did not fire", "rubric", "state machine", file paths, function names,
  or rule names of any kind.
- Instead say what a person would say: "It told the customer the wings were
  added to the order, but they never actually made it into the cart."
- When something went wrong, point to the specific moment in the conversation
  in plain terms — quote or closely paraphrase what was said, and say which
  message in the exchange it was (e.g. "When the customer asked for a large
  pizza, the third reply..."). Do not use internal ids.
- Be concrete and specific. Do not pad with generic praise or generic caution.
- Keep the whole summary readable in under a minute.

YOUR JOB:
1. Write "summary": a short plain-language read of what happened in this
   conversation — what went well, what went wrong, naming the specific moment
   if something broke. If nothing broke, say so plainly and note anything
   that was handled especially well.
2. Give "score": your best-guess rating from 0-100 of how well this
   conversation went for the customer and the restaurant. This is your own
   advisory opinion, not a pass/fail — it never blocks or approves anything.
3. Give "proposals": a list of concrete, specific suggestions for how to
   improve the assistant, if any come to mind. Each one needs:
   - "title": a short plain-language name for the idea
   - "rationale": why you're suggesting it, tied to what happened in THIS
     conversation
   - "target": what part of the experience it would change, described in
     plain language (e.g. "how it confirms items were added to the cart"),
     never a file, function, or rule name.
   If the conversation was clean and you have no real suggestions, return an
   empty proposals list — do not invent filler suggestions.

You are NOT changing anything. You are not able to change anything. You are
only writing a report for a human to read.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{"summary": "...", "score": 0-100, "proposals": [{"title": "...", "rationale": "...", "target": "..."}]}
`.trim();

function formatMessages(messages: TranscriptJudgeMessage[]): string {
  return messages
    .map((m, i) => {
      const who = m.role === "customer" || m.role === "user" ? "Customer" : "Assistant";
      return `${i + 1}. ${who}: ${m.text}`;
    })
    .join("\n");
}

function formatCart(finalCart: unknown): string {
  if (!finalCart) return "(no cart recorded at the end of the conversation)";
  try {
    return JSON.stringify(finalCart);
  } catch {
    return "(cart present but not readable)";
  }
}

export function assembleTranscriptJudgePrompt(
  input: TranscriptJudgeInput,
): { system: string; user: string } {
  const lines = [
    `Shop: ${input.shop_name}`,
    `Assistant model: ${input.model ?? "unknown"}`,
  ];

  if (input.reporter_note && input.reporter_note.trim()) {
    lines.push(
      "",
      `The person who ran this conversation flagged it with this one-line note: "${input.reporter_note.trim()}"`,
      "Treat this as a hint about where to look, not a fact — verify it against the actual conversation below. If the transcript doesn't show what the note describes, say so plainly rather than assuming the note is correct.",
    );
  }

  lines.push(
    "",
    "Conversation, in order:",
    formatMessages(input.messages),
    "",
    "Cart at the end of the conversation:",
    formatCart(input.final_cart),
  );

  return { system: SYSTEM_PROMPT, user: lines.join("\n") };
}

/**
 * Normalize parsed JSON into a TranscriptJudgeVerdict. Every proposal's
 * status is force-set to 'proposed' here — this is the ONE place the shape
 * is built, and it never accepts a status value from the model or caller.
 * There is no code path in this file (or its caller) that produces any other
 * status.
 */
export function coerceVerdict(parsed: unknown): TranscriptJudgeVerdict {
  const obj = (parsed && typeof parsed === "object") ? (parsed as Record<string, unknown>) : {};

  const summary = typeof obj.summary === "string" && obj.summary.trim()
    ? obj.summary.trim().slice(0, 4000)
    : "The judge could not produce a readable summary for this conversation.";

  let score: number | null = null;
  if (typeof obj.score === "number" && Number.isFinite(obj.score)) {
    score = Math.max(0, Math.min(100, Math.round(obj.score)));
  }

  const rawProposals = Array.isArray(obj.proposals) ? obj.proposals : [];
  const proposals: TranscriptJudgeProposal[] = [];
  for (const p of rawProposals) {
    if (!p || typeof p !== "object") continue;
    const title = String((p as Record<string, unknown>).title ?? "").trim().slice(0, 200);
    const rationale = String((p as Record<string, unknown>).rationale ?? "").trim().slice(0, 1000);
    const target = String((p as Record<string, unknown>).target ?? "").trim().slice(0, 200);
    if (!title) continue;
    proposals.push({ title, rationale, target, status: "proposed" });
  }

  return { summary, score, proposals };
}
