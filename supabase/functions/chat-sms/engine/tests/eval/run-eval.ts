// run-eval.ts — run the answer key through interpret() on one model and report.
// usage: deno run -A run-eval.ts --provider openrouter --model deepseek/deepseek-v4-flash [--limit N] [--concurrency 4] [--outdir DIR] [--out results.jsonl]
// Results are written under --outdir (default: cwd), never next to this file: the sync script wipes untracked files there.
// Keys: ANTHROPIC_API_KEY or OPENROUTER_API_KEY in env.
import { interpret, summarizeOpen, type InterpretContext } from "../../interpret.ts";
import type { OpenQuestion } from "../../form.ts";
import { fixtureMenu } from "../fixture-menu.ts";
import { scoreCase, summarize, type CaseScore, type EvalCase } from "./score.ts";

const args = Object.fromEntries(Deno.args.map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? "true"] : []).filter((x) => x.length));
const provider = (args.provider ?? "anthropic") as "anthropic" | "openrouter";
const model = args.model ?? "claude-haiku-4-5";
const limit = args.limit ? parseInt(args.limit, 10) : Infinity;
const concurrency = args.concurrency ? parseInt(args.concurrency, 10) : 4;
const apiKey = provider === "anthropic" ? Deno.env.get("ANTHROPIC_API_KEY") ?? "" : Deno.env.get("OPENROUTER_API_KEY") ?? "";
// Without a local key, go through the engine-eval edge function (it holds the project keys).
const remote = !apiKey ? { url: `${Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")}/functions/v1/engine-eval`, key: Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "" } : null;
if (!apiKey && !remote?.key) { console.error(`missing API key for ${provider} and no service key for engine-eval`); Deno.exit(2); }

const menu = fixtureMenu();
const text = await Deno.readTextFile(new URL("./moves.jsonl", import.meta.url));
const cases: EvalCase[] = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).slice(0, limit);

function choicesFor(q: OpenQuestion): string[] | null {
  if (q.kind === "line_slot") { for (const it of menu.items.values()) { const g = it.groups.find((x) => x.id === q.group_id); if (g) return g.choices.map((c) => c.name); } }
  if (q.kind === "line_ambiguous") return q.facet === "size" ? ["small", "medium", "large"] : null;
  return null;
}

async function viaEdge(id: string, ctx: InterpretContext): Promise<Awaited<ReturnType<typeof interpret>>> {
  const t0 = Date.now();
  const res = await fetch(remote!.url, { method: "POST", headers: { "Authorization": `Bearer ${remote!.key}`, "apikey": remote!.key, "Content-Type": "application/json" }, body: JSON.stringify({ provider, model, cases: [{ id, ctx }] }) });
  if (!res.ok) return { ok: false, reason: "http", detail: `engine-eval HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, raw: null, ms: Date.now() - t0 };
  const data = await res.json() as { results: Array<{ id: string; result: Awaited<ReturnType<typeof interpret>> }> };
  return data.results[0]?.result ?? { ok: false, reason: "http", detail: "empty engine-eval response", raw: null, ms: Date.now() - t0 };
}

const results: Array<{ id: string; score: CaseScore; ms: number; actual: unknown; expected: unknown; message: string }> = [];
let idx = 0;
async function worker() {
  while (idx < cases.length) {
    const c = cases[idx++];
    const open = (c.context.open ?? null) as OpenQuestion | null;
    const ctx: InterpretContext = {
      shop_name: menu.shop.name, message: c.message, last_bot: c.context.last_bot ?? null,
      open, open_summary: summarizeOpen(open, c.context.lines ?? [], choicesFor), lines: c.context.lines ?? [],
    };
    const r = remote ? await viaEdge(c.id, ctx) : await interpret(ctx, { provider, model, apiKey, timeoutMs: 30000 });
    const score = r.ok ? scoreCase(c, r.moves) : scoreCase(c, null, `${r.reason}: ${r.detail}`);
    results.push({ id: c.id, score, ms: r.ms, actual: r.ok ? r.moves : r.detail, expected: c.expected, message: c.message });
    if (results.length % 25 === 0) console.error(`${results.length}/${cases.length}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const summary = summarize(results.map((r) => r.score), results.map((r) => r.ms));
console.log(JSON.stringify({ provider, model, ...summary }, null, 2));
const outdir = args.outdir ?? Deno.cwd();
const out = `${outdir}/${args.out ?? `results-${model.replace(/[^a-z0-9.-]/gi, "_")}.jsonl`}`;
await Deno.writeTextFile(out, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
const failures = results.filter((r) => !r.score.ok);
console.log(`\n${failures.length} imperfect cases written to ${out}; first 10:`);
for (const f of failures.slice(0, 10)) console.log(`- [${f.id}] "${f.message}"\n    expected: ${JSON.stringify(f.expected)}\n    actual:   ${JSON.stringify(f.actual)}`);
