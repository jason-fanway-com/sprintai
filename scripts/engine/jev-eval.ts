// jev-eval.ts — Phase 0 of the Jev integration: an OFFLINE eval, no product code touched.
//
// Builds labeled cases from the engine ledger (real, harness and phone traffic since the
// clean engine went live) and asks Jev (typesafe/jev-1.13 via OpenRouter's decisions API)
// the judgments the engine would ask it, then scores accuracy and coverage per confidence
// threshold. Two datasets:
//   A. item ambiguity — a line the resolver found ambiguous, later resolved by the customer's
//      answer: would Jev have picked the right item from the customer's ORIGINAL message?
//   B. omission — a lexicon hit the model's moves did not cover, later accepted or declined:
//      would Jev have known whether the customer asked for it?
//
// usage (on the Air, inside the worktree, secrets in env):
//   set -a; . ~/.openclaw-sprintai/.secrets; set +a
//   deno run --allow-net --allow-env --allow-read --allow-write scripts/engine/jev-eval.ts [--limit N] [--dry]
// output: ~/po-scratch/jev/{cases-A,cases-B,answers-A,answers-B}.jsonl and a table on stdout.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { loadMenu, type RunnerShop } from "../../supabase/functions/chat-sms/engine/runner.ts";
import { bindLine, resolveSpan } from "../../supabase/functions/chat-sms/engine/resolve.ts";
import type { Line } from "../../supabase/functions/chat-sms/engine/form.ts";
import type { Menu } from "../../supabase/functions/chat-sms/engine/menu.ts";

const URL_ = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const OR_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? Deno.env.get("SPRINTAI_CHAT_OPENROUTER_API_KEY")!;
const SHOPS = ["e0000000-0000-0000-0000-000000000001", "b0000000-0000-0000-0000-000000000001", "2cba7b51-211c-4437-8910-1af4dcc03498"];
const SINCE = "2026-09-20T00:00:00Z";
const args = Deno.args;
const LIMIT = Number(args[args.indexOf("--limit") + 1] || 0) || Infinity;
const DRY = args.includes("--dry");
const OUT = `${Deno.env.get("HOME")}/po-scratch/jev`;
await Deno.mkdir(OUT, { recursive: true });

const sb: SupabaseClient = createClient(URL_, KEY);
async function pageAll<T>(q: (a: number, b: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = []; const step = 1000;
  for (let a = 0; ; a += step) {
    const { data, error } = await q(a, a + step - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[]; out.push(...rows);
    if (rows.length < step) return out;
  }
}

// ── load ─────────────────────────────────────────────────────────────────────
const shopRows = (await sb.from("shops").select("id, tenant_id, name, delivery_enabled, delivery_fee_cents, tax_rate_bps, phone_number_e164, latitude, longitude, delivery_radius_mi").in("id", SHOPS)).data as RunnerShop[];
const menus = new Map<string, Menu>();
for (const s of shopRows) menus.set(s.id, await loadMenu(sb, s, 99));
console.error("menus loaded:", [...menus.entries()].map(([id, m]) => `${id.slice(0, 8)}=${m.items.size} items`).join(", "));

type Cart = { id: string; shop_id: string; conversation_id: string; engine_form: { lines: Array<{ line_id: number; span: string; item_id: string | null; qty: number }> } | null };
const carts = await pageAll<Cart>((a, b) => sb.from("order_carts").select("id, shop_id, conversation_id, engine_form").in("shop_id", SHOPS).gte("created_at", SINCE).not("engine_form", "is", null).order("created_at", { ascending: true }).range(a, b));
console.error("carts:", carts.length);
type Led = { cart_id: string; turn_no: number; event: string; data: Record<string, unknown>; created_at: string };
const ledger = await pageAll<Led>((a, b) => sb.from("engine_ledger").select("cart_id, turn_no, event, data, created_at").gte("created_at", SINCE).order("id", { ascending: true }).range(a, b));
const byCart = new Map<string, Led[]>();
for (const r of ledger) { const arr = byCart.get(r.cart_id) ?? []; arr.push(r); byCart.set(r.cart_id, arr); }
console.error("ledger rows:", ledger.length);
type Msg = { conversation_id: string; role: string; content: string; created_at: string };
const msgs = new Map<string, Msg[]>();
const convIds = [...new Set(carts.map((c) => c.conversation_id))];
for (let i = 0; i < convIds.length; i += 100) {
  const rows = await pageAll<Msg>((a, b) => sb.from("messages").select("conversation_id, role, content, created_at").in("conversation_id", convIds.slice(i, i + 100)).gte("created_at", SINCE).order("created_at", { ascending: true }).range(a, b));
  for (const m of rows) { const arr = msgs.get(m.conversation_id) ?? []; arr.push(m); msgs.set(m.conversation_id, arr); }
}
console.error("conversations with messages:", msgs.size);

/** the customer message that produced turn `turn` of a cart: turns map 1:1 onto customer messages,
 *  with any pre-engine messages (TESTMODE, RESET, closed-kitchen) at the start of the conversation */
function messageFor(cart: Cart, turn: number, at: string): { customer: string; previousBot: string } | null {
  const list = msgs.get(cart.conversation_id) ?? [];
  const cust0 = list.filter((m) => m.role === "customer");
  const T = Math.max(0, ...(byCart.get(cart.id) ?? []).map((r) => r.turn_no));
  let cust: Msg | null = null;
  if (cust0.length >= T && T > 0) cust = cust0[cust0.length - T + turn - 1] ?? null;
  // sanity: the message must precede the ledger row; else fall back to the latest message before it
  if (!cust || Date.parse(cust.created_at) > Date.parse(at) + 2000) {
    cust = null; const t = Date.parse(at);
    for (const m of cust0) { if (Date.parse(m.created_at) > t + 2000) break; cust = m; }
  }
  if (!cust) return null;
  // previous bot message = the last assistant message before the customer one
  let prev = "";
  for (const m of list) { if (Date.parse(m.created_at) >= Date.parse(cust.created_at)) break; if (m.role !== "customer") prev = m.content; }
  return { customer: cust.content, previousBot: prev.split("Msg & data")[0].trim() };
}

// ── dataset A: item ambiguity ─────────────────────────────────────────────────
type CaseA = { id: string; shop: string; message: string; span: string; candidates: Array<{ id: string; name: string; category: string | null }>; label_id: string; label_name: string; customer_answer: string; source: string };
const A: CaseA[] = []; const stillAsks = { solved: 0, asks: 0 };
type CaseB = { id: string; shop: string; message: string; previous_bot: string; span: string; qty: number; candidates: string[]; label: boolean; source: string };
const B: CaseB[] = [];
for (const cart of carts) {
  const menu = menus.get(cart.shop_id)!; const rows = byCart.get(cart.id) ?? [];
  const conv = msgs.get(cart.conversation_id) ?? [];
  const source = conv.length && /test-suite/.test(JSON.stringify(conv[0])) ? "test-suite" : "other";
  const lines = cart.engine_form?.lines ?? [];
  for (const r of rows) {
    if (r.event === "add_line") {
      const span = String(r.data.span ?? ""); const lineId = Number(r.data.line_id);
      const res = resolveSpan(span, menu);
      if (res.kind !== "ambiguous") continue;
      const ans = rows.find((x) => x.event === "answer_option" && Number(x.data.line_id) === lineId && x.turn_no > r.turn_no);
      const line = lines.find((l) => l.line_id === lineId);
      if (!ans || !line?.item_id || !res.ids.includes(line.item_id)) continue;
      // would TODAY's resolver still ask? bind the line with the options the model gave it
      const probe: Line = { line_id: 1, span, item_id: null, qty: Number(r.data.qty ?? 1), choices: {}, modifiers: [], held: [...((r.data.options as string[]) ?? [])], notes: [], slot_candidates: {}, status: { kind: "unresolved" } };
      bindLine(probe, menu);
      if (probe.status.kind !== "ambiguous") { stillAsks.solved++; continue; }
      stillAsks.asks++;
      const m = messageFor(cart, r.turn_no, r.created_at); if (!m) continue;
      const cands = res.ids.map((id) => ({ id, name: menu.items.get(id)!.display_name, category: menu.items.get(id)!.category ?? null }));
      A.push({ id: `${cart.id.slice(0, 8)}:${lineId}`, shop: cart.shop_id.slice(0, 8), message: m.customer, span, candidates: cands, label_id: line.item_id, label_name: menu.items.get(line.item_id)!.display_name, customer_answer: String(ans.data.span ?? ""), source });
    }
    if (r.event === "possible_omission") {
      const span = String(r.data.span ?? "");
      const verdict = rows.find((x) => (x.event === "omission_accepted" || x.event === "omission_declined") && x.turn_no > r.turn_no && (x.data.spans as string[] | undefined)?.includes(span));
      if (!verdict) continue;
      const m = messageFor(cart, r.turn_no, r.created_at); if (!m) continue;
      const ids = (r.data.item_ids as string[]) ?? [];
      B.push({ id: `${cart.id.slice(0, 8)}:${r.turn_no}:${span}`, shop: cart.shop_id.slice(0, 8), message: m.customer, previous_bot: m.previousBot, span, qty: Number(r.data.qty ?? 1), candidates: ids.map((id) => menu.items.get(id)?.display_name ?? id).slice(0, 8), label: verdict.event === "omission_accepted", source });
    }
  }
}
const dedupe = <T extends { message: string; span: string }>(xs: T[]) => { const seen = new Set<string>(); return xs.filter((x) => { const k = x.message.toLowerCase() + "|" + x.span.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };
const A2 = dedupe(A).slice(0, LIMIT), B2 = dedupe(B).slice(0, LIMIT);
console.error(`A: current resolver already solves ${stillAsks.solved} raw cases without asking; still asks ${stillAsks.asks}`);
console.error(`cases A (ambiguity): ${A.length} raw, ${A2.length} unique; B (omission): ${B.length} raw, ${B2.length} unique`);
await Deno.writeTextFile(`${OUT}/cases-A.jsonl`, A2.map((x) => JSON.stringify(x)).join("\n") + "\n");
await Deno.writeTextFile(`${OUT}/cases-B.jsonl`, B2.map((x) => JSON.stringify(x)).join("\n") + "\n");
if (DRY) Deno.exit(0);

// ── Jev via OpenRouter ────────────────────────────────────────────────────────
async function jev(state: unknown, questions: Record<string, unknown>): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = performance.now();
    const res = await fetch("https://openrouter.ai/api/alpha/decisions", { method: "POST", headers: { "Authorization": `Bearer ${OR_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "typesafe/jev-1.13", state, questions }) });
    const ms = performance.now() - t0;
    if (res.status === 429 || res.status === 529) { await res.text(); await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
    const j = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(j).slice(0, 300));
    return { ...j, ms };
  }
  throw new Error("jev: gave up after retries");
}
async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
}

const ansA = await pool(A2, 6, async (c) => {
  const criteria: Record<string, string> = {};
  for (const k of c.candidates) criteria[k.name] = k.category ? `${k.name} (${k.category})` : k.name;
  criteria["ask"] = "the message does not make clear which one; ask the customer";
  const r = await jev(
    { customer_message: c.message, item_words: c.span, options: c.candidates.map((k) => k.name) },
    { which: { type: "choice", instructions: "The customer ordered `item_words` in `customer_message`. Which of `options` did they mean? Choose ask unless the message itself makes it clear.", criteria } },
  );
  const a = r.answers.which;
  return { id: c.id, choice: a.choice, confidence: a.confidence, correct: a.choice === c.label_name, label: c.label_name, n: c.candidates.length, ms: r.ms, cost: r.usage?.cost ?? null, tokens: r.usage?.input_tokens ?? null };
});
await Deno.writeTextFile(`${OUT}/answers-A.jsonl`, ansA.map((x) => JSON.stringify(x)).join("\n") + "\n");

let reviewed: Record<string, boolean> = {};
try { reviewed = JSON.parse(await Deno.readTextFile(`${OUT}/labels-B.json`)); } catch { /* none */ }
const keyB = (c: CaseB) => `${c.message.toLowerCase().trim()}|${c.span.toLowerCase()}`;
for (const c of B2) if (keyB(c) in reviewed) (c as CaseB & { label_reviewed?: boolean }).label_reviewed = reviewed[keyB(c)];
const ansB = await pool(B2, 6, async (c) => {
  const r = await jev(
    { customer_message: c.message, our_previous_message: c.previous_bot, words_in_question: c.span, menu_items_those_words_could_name: c.candidates },
    { asked: { type: "noul", instructions: "In `customer_message` (a reply to `our_previous_message`), is the customer asking to ADD one of `menu_items_those_words_could_name` to their order with `words_in_question`? Answer no when those words are part of a closing phrase, a question, a description of another item, or anything other than ordering that item." } },
  );
  return { id: c.id, p: r.answers.asked.noul, label: c.label, reviewed: (c as CaseB & { label_reviewed?: boolean }).label_reviewed, ms: r.ms, cost: r.usage?.cost ?? null };
});
await Deno.writeTextFile(`${OUT}/answers-B.jsonl`, ansB.map((x) => JSON.stringify(x)).join("\n") + "\n");

// ── score ─────────────────────────────────────────────────────────────────────
const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(0)}%` : "-";
const med = (xs: number[]) => xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;
console.log(`\n## A. item ambiguity — ${ansA.length} cases (label = what the customer ended up with)\n`);
console.log("| threshold | picked (coverage) | right | WRONG | asked |\n|---|---|---|---|---|");
for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  const picked = ansA.filter((a) => a.choice !== "ask" && a.confidence >= t);
  const right = picked.filter((a) => a.correct).length;
  console.log(`| ≥${t} | ${picked.length} (${pct(picked.length, ansA.length)}) | ${right} | **${picked.length - right}** | ${ansA.length - picked.length} |`);
}
console.log("\nby candidate-set size at ≥0.8:");
for (const [lo, hi] of [[2, 6], [7, 15], [16, 999]]) { const xs = ansA.filter((a) => a.n >= lo && a.n <= hi); const p = xs.filter((a) => a.choice !== "ask" && a.confidence >= 0.8); console.log(`  ${lo}-${hi === 999 ? "+" : hi} candidates: ${xs.length} cases, picked ${p.length}, right ${p.filter((a) => a.correct).length}, wrong ${p.filter((a) => !a.correct).length}`); }
console.log(`\nmedian latency ${med(ansA.map((a) => a.ms)).toFixed(0)} ms; median tokens ${med(ansA.map((a) => a.tokens ?? 0))}; total cost $${ansA.reduce((s, a) => s + (a.cost ?? 0), 0).toFixed(4)}`);
console.log("\nwrong picks at ≥0.8:");
for (const a of ansA.filter((x) => x.choice !== "ask" && x.confidence >= 0.8 && !x.correct)) { const c = A2.find((y) => y.id === a.id)!; console.log(`  - "${c.message}" span "${c.span}" → Jev ${a.choice} (${a.confidence}) | customer chose ${c.label_name} via "${c.customer_answer}"`); }
for (const [title, lab] of [["harness label (scripted customer said yes)", (b: typeof ansB[0]) => b.label], ["REVIEWED label (hand-read: did they ask to add it?)", (b: typeof ansB[0]) => b.reviewed ?? b.label]] as const) {
  console.log(`\n## B. omission — ${ansB.length} cases, ${title}\n`);
  console.log("| threshold p(yes) | predicted yes | true yes caught | FALSE yes | missed yes | questions saved |\n|---|---|---|---|---|---|");
  const yes = ansB.filter((b) => lab(b)).length;
  for (const t of [0.3, 0.5, 0.7, 0.9]) {
    const pred = ansB.filter((b) => b.p >= t); const tp = pred.filter((b) => lab(b)).length;
    console.log(`| ≥${t} | ${pred.length} | ${tp}/${yes} | **${pred.length - tp}** | ${yes - tp} | ${ansB.length - pred.length} of ${ansB.length} |`);
  }
}
console.log("\nB cases with p and label:");
for (const b of ansB) { const c = B2.find((y) => y.id === b.id)!; console.log(`  - p=${b.p.toFixed(2)} harness=${c.label ? "YES" : "no"} reviewed=${b.reviewed === undefined ? "?" : b.reviewed ? "YES" : "no"} "${c.message.slice(0, 90)}" span "${c.span}"`); }
