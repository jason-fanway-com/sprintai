// voice.ts — the third adapter that talks to a model. The engine decides WHAT to say: the plan, rendered by
// templates.ts into a draft that carries every fact. This adapter asks a small model to say the draft the way the
// person at the counter would, then checks the rewrite against the draft (numbers, names, the question) before it
// can go out. Any failure, timeout or doubt means the draft itself is sent. Nothing here can add, remove or reprice
// a line: the form is closed before this runs. Jason, 2026-09-25: "this is an ai chatbot, it should feel damn near human."
import { faithfulRewrite } from "./normalize.ts";

export interface VoiceConfig { apiKey: string; shopName: string; model?: string; timeoutMs?: number; baseURL?: string }
export interface VoiceInput { draft: string; customer: string; lastBot: string | null }
export type VoiceResult = { ok: true; text: string; ms: number } | { ok: false; reason: "ineligible" | "timeout" | "http" | "schema" | "unfaithful"; detail: string; ms: number };

/** Lists, links and long read-backs stay exactly as rendered; only short conversational replies get a voice. */
export function eligible(draft: string): boolean { return !draft.includes("\n") && !draft.includes("http") && draft.length <= 320; }

const RULES = [
  "You are the person answering text messages at a pizza shop. Rewrite the DRAFT as one natural text message in your own voice.",
  "Keep every fact exactly: item names, quantities, sizes, options, prices and the question being asked. Do not add, drop or change any of them. Write item and option names exactly as the draft spells them, capitals included (\"Chicken Parmesan Sandwich\", never \"chicken parm\"). Keep the shop's name if the draft has it.",
  "Never add items, prices, wait times, promises to call or text, or anything about the menu that the draft does not say.",
  "The draft's question stays, as the last sentence. If the draft says 'Yes, we do' or 'Oh, gotcha', keep that meaning.",
  "Sound like a friendly person at the counter: contractions, short, warm, plain. No emoji, no special symbols, plain quotes only. No exclamation points. No 'I'd be happy to'. Shorter is better and never longer than the draft: every character is paid for.",
  "Reply with the message text only.",
].join("\n");

export async function voice(input: VoiceInput, cfg: VoiceConfig): Promise<VoiceResult> {
  const t0 = Date.now(); const ms = () => Date.now() - t0;
  if (!eligible(input.draft)) return { ok: false, reason: "ineligible", detail: "list, link or long", ms: ms() };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 2500);
  try {
    const res = await fetch(cfg.baseURL ?? "https://openrouter.ai/api/v1/messages", {
      method: "POST", signal: controller.signal,
      headers: { "Authorization": `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://getsprintai.com", "X-Title": "SprintAI" },
      body: JSON.stringify({
        model: cfg.model ?? "anthropic/claude-haiku-4.5", max_tokens: 160, temperature: 0.4, system: `${RULES}\nThe shop is ${cfg.shopName}.`,
        messages: [{ role: "user", content: `CUSTOMER'S LAST TEXT: ${input.customer}\n${input.lastBot ? `YOUR PREVIOUS TEXT: ${input.lastBot}\n` : ""}DRAFT: ${input.draft}` }],
      }),
    });
    const body = await res.json().catch(() => null) as { content?: Array<{ type: string; text?: string }> } | null;
    if (!res.ok) return { ok: false, reason: "http", detail: `${res.status}`, ms: ms() };
    let text = (body?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
    for (const q of ['"', "“", "”"]) { if (text.startsWith(q)) text = text.slice(1); if (text.endsWith(q)) text = text.slice(0, -1); }
    if (!text) return { ok: false, reason: "schema", detail: "no text", ms: ms() };
    const why = faithfulRewrite(input.draft, text);
    return why ? { ok: false, reason: "unfaithful", detail: `${why}: ${text}`, ms: ms() } : { ok: true, text, ms: ms() };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return { ok: false, reason: err?.name === "AbortError" ? "timeout" : "http", detail: String(err?.message ?? e), ms: ms() };
  } finally { clearTimeout(timer); }
}
