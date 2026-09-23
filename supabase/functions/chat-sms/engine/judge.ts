// judge.ts — the second and last adapter that talks to a model. Jev (TypeSafe's System One
// classifier, reached through OpenRouter's decisions endpoint with the same key as the
// interpreter) answers typed yes/no questions over candidates the engine already holds. It never
// generates text, never sees money, never adds or removes a line: the pure core decides what a
// probability means (JUDGE in turn.ts) and falls back to today's behaviour when this call fails.
// Phase 1 asks one thing: omission adjudication — "did the customer actually ask for this?"
// Evidence for the threshold: docs/specs/2026-09-23-jev-phase0-eval.md.

export interface JudgeConfig { apiKey: string; model?: string; timeoutMs?: number; baseURL?: string }
export interface OmissionAsk { span: string; candidates: string[] }
export type JudgeResult =
  | { ok: true; p: Record<string, number>; ms: number; cost: number | null }
  | { ok: false; reason: "timeout" | "network" | "http" | "schema"; detail: string; ms: number };

export async function judgeOmissions(ctx: { message: string; last_bot: string | null; asks: OmissionAsk[] }, cfg: JudgeConfig): Promise<JudgeResult> {
  const t0 = performance.now(); const ms = () => Math.round(performance.now() - t0);
  const state = { customer_message: ctx.message, our_previous_message: ctx.last_bot ?? "", asks: ctx.asks.map((a) => ({ words: a.span, menu_items: a.candidates })) };
  const questions: Record<string, unknown> = {};
  ctx.asks.forEach((_a, i) => {
    questions[`q${i}`] = { type: "noul", instructions: `In \`customer_message\` (a reply to \`our_previous_message\`), is the customer asking to ADD one of \`asks[${i}].menu_items\` to their order with the words \`asks[${i}].words\`? Answer no when those words are part of a closing phrase, a question, a removal, a description or option of another item, or anything other than ordering that item.` };
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 1500);
  try {
    const res = await fetch(cfg.baseURL ?? "https://openrouter.ai/api/alpha/decisions", {
      method: "POST", signal: controller.signal,
      headers: { "Authorization": `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model ?? "typesafe/jev-1.13", state, questions }),
    });
    // deno-lint-ignore no-explicit-any
    const body: any = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: "http", detail: `${res.status} ${JSON.stringify(body).slice(0, 200)}`, ms: ms() };
    const p: Record<string, number> = {};
    ctx.asks.forEach((a, i) => { const v = body?.answers?.[`q${i}`]?.noul; if (typeof v === "number") p[a.span] = v; });
    if (Object.keys(p).length !== ctx.asks.length) return { ok: false, reason: "schema", detail: JSON.stringify(body).slice(0, 200), ms: ms() };
    return { ok: true, p, ms: ms(), cost: typeof body?.usage?.cost === "number" ? body.usage.cost : null };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return { ok: false, reason: err?.name === "AbortError" ? "timeout" : "network", detail: String(err?.message ?? e), ms: ms() };
  } finally { clearTimeout(timer); }
}
