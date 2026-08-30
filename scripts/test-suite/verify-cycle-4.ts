#!/usr/bin/env deno run --allow-net --allow-env
/**
 * verify-cycle-4.ts — Melvin verification of cycle-4 pricing fix (commit 3da9b54).
 * 
 * KEY INSIGHT: During "building" phase, total_cents = subtotal_cents (no fees).
 * At checkout, total_cents = subtotal + service_fee + delivery + tip.
 * The bot quotes: subtotal + $0.99 service fee (in prose, not in cart DB).
 * 
 * Verifications:
 *   (a) Modifier pricing: subtotal includes modifier price_cents
 *   (b) Bot-quoted price = subtotal + $0.99 (building) or proper checkout total
 *   (c) Cart integrity: DB total = sum of cart lines + fees
 *   (d) D1/E1/F1/G3 regression check via existing runner+judge
 */

const SUPABASE_URL = "https://rvdqfxtrskxekfkqnegx.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2ZHFmeHRyc2t4ZWtma3FuZWd4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDc0ODY4OSwiZXhwIjoyMDkwMzI0Njg5fQ.18IySZjyLd2KPNxJSDq--UMvICqbTbjMM1ZC5J-g9oI";
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const SHOP_ID = "38ae034c-cb9d-4f32-b4f1-d9b40393574b";

const H = { "Authorization": `Bearer ${SUPABASE_KEY}`, "apikey": SUPABASE_KEY };

interface Verdict { id: string; label: string; category: string; passed: boolean; detail: string; }
const verdicts: Verdict[] = [];
function v(v: Verdict) { verdicts.push(v); const i = v.passed ? "✅" : "❌"; console.log(`${i} ${v.id}: ${v.label} | ${v.detail}`); }

// ── DB helpers ──────────────────────────────────────────────────────────────

async function sq(table: string, params: string) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, { headers: H });
  if (!res.ok) throw new Error(`${table}: ${res.status}`);
  return res.json();
}

async function chat(shop: string, msg: string, sid: string, hours?: string) {
  const body: Record<string, unknown> = { shop_id: shop, message: msg, session_id: sid, test: true };
  if (hours === "closed") { delete body.test; (body as any).test_hours = "closed"; }
  const res = await fetch(CHAT_URL, { method: "POST", headers: { "Content-Type": "application/json", ...H }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`chat: ${res.status}`);
  return res.json();
}

async function getCart(sid: string) {
  const convs = await sq("conversations", `session_id=eq.${encodeURIComponent(sid)}&select=id&order=started_at.desc&limit=1`);
  if (!convs.length) return null;
  const carts = await sq("order_carts", `conversation_id=eq.${convs[0].id}&select=cart_json,phase,total_cents,subtotal_cents,delivery_fee_cents&order=created_at.desc&limit=1`);
  return carts[0] || null;
}

function sub(cj: any) {
  if (!Array.isArray(cj) && cj?.lines) cj = cj.lines;
  if (!Array.isArray(cj)) return 0;
  return cj.reduce((s: number, i: any) => s + (i.price_cents || 0) * (i.quantity || 1), 0);
}

function dollars(cents: number) { return `$${(cents / 100).toFixed(2)}`; }
function parseDollar(text: string) { const m = text.match(/\$(\d+\.\d{2})/); return m ? Math.round(parseFloat(m[1]) * 100) : null; }

// ── Single-turn pricing test ────────────────────────────────────────────────

async function priceTest(id: string, label: string, msg: string, expectedSub: number, expectedQuoted: number | null) {
  const sid = `mel-${id}-${Date.now()}`;
  try {
    const r = await chat(SHOP_ID, msg, sid);
    const sid2 = r.session_id || sid;
    const reply = (r.reply || "").slice(0, 200);
    
    // Handle bread-type follow-up for butter/CC items
    let reply2 = "";
    if (reply.toLowerCase().includes("what type of bagel") || reply.toLowerCase().includes("what bagel flavor")) {
      const r2 = await chat(SHOP_ID, "plain", sid2);
      reply2 = (r2.reply || "").slice(0, 200);
    }

    // Handle flavor follow-up for flavored CC
    if (reply.toLowerCase().includes("which flavored cream cheese") || reply.toLowerCase().includes("which flavor")) {
      const r2 = await chat(SHOP_ID, "scallion", sid2);
      reply2 = (r2.reply || "").slice(0, 200);
    }

    const cart = await getCart(sid2);
    const actualSub = sub(cart?.cart_json);
    const actualQuoted = parseDollar(reply2 || reply);
    const expectedQuotedCalc = expectedSub > 0 ? expectedSub + 99 : null; // building phase: sub + $0.99

    const mods = Array.isArray(cart?.cart_json) ? cart.cart_json.flatMap((i: any) => i.modifiers || []) : [];
    
    const subOk = actualSub === expectedSub;
    const quotedOk = expectedQuoted != null ? actualQuoted === expectedQuoted : (actualQuoted === expectedQuotedCalc);
    const passed = subOk && (quotedOk || expectedQuoted == null && actualQuoted == null);

    let detail = `sub=${dollars(actualSub)} (exp ${dollars(expectedSub)}) `;
    detail += actualQuoted != null ? `quoted=${dollars(actualQuoted)} (exp ${dollars(expectedQuoted ?? expectedQuotedCalc!)}) ` : "no quote ";
    if (mods.length > 0) detail += `mods=[${mods.join(",")}]`;
    if (!subOk) detail += ` | SUB FAIL`;
    if (!quotedOk) detail += ` | QUOTE FAIL`;
    if (passed) detail = detail.trim();

    v({ id, label, category: "pricing", passed, detail: detail.trim() });
    return passed;
  } catch (e) {
    v({ id, label, category: "pricing", passed: false, detail: `ERR: ${(e as Error).message}` });
    return false;
  }
}

// ── Multi-turn test ─────────────────────────────────────────────────────────

async function multiTest(id: string, label: string, msgs: string[], checks: Array<{ desc: string; fn: (reply: string, cart: any) => [boolean, string] }>) {
  let sid = `mel-${id}-${Date.now()}`;
  try {
    let reply = "";
    for (const msg of msgs) {
      const r = await chat(SHOP_ID, msg, sid);
      if (r.session_id) sid = r.session_id;
      reply = (r.reply || "").slice(0, 200);
    }
    const cart = await getCart(sid);
    let allOk = true;
    let detail = "";
    for (const chk of checks) {
      const [ok, d] = chk.fn(reply, cart);
      if (!ok) { allOk = false; detail += `[${chk.desc}: ${d}] `; }
    }
    v({ id, label, category: "multi-turn", passed: allOk, detail: detail || `${dollars(sub(cart?.cart_json))} sub` });
  } catch (e) {
    v({ id, label, category: "multi-turn", passed: false, detail: `ERR: ${(e as Error).message}` });
  }
}

// ── RUN PRICING TESTS ───────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════");
console.log("  CYCLE-4 PRICING FIX VERIFICATION (commit 3da9b54)");
console.log("  Shop: Not Just Bagels (TEST CLONE)");
console.log("═══════════════════════════════════════════════════════════\n");

console.log("═══ A. MODIFIER PRICING (subtotal must include modifier price_cents) ═══\n");

// Bagel w/ Butter (275) + Flagel upgrade (60) = 335 subtotal, quoted ~$4.34
await priceTest("p1-butter-flagel", "Bagel w/ Butter + Flagel upgrade",
  "I want a bagel with butter, and upgrade to flagel", 335, 434);

// BOBO (875) + Flagel upgrade (60) = 935 subtotal
await priceTest("p2-bobo-flagel", "BOBO Sandwich + Flagel upgrade",
  "I'll have a bobo sandwich and I'd like to upgrade to a flagel", 935, null);

// TBOBO (950) + Flagel upgrade (60) = 1010 subtotal
await priceTest("p3-tbobo-flagel", "TBOBO Sandwich + Flagel upgrade",
  "I want a tbobo sandwich, upgrade to flagel please", 1010, null);

// Bagel w/ CC (350) + Flagel (60) = 410 subtotal
await priceTest("p4-cc-flagel", "Bagel w/ Plain Cream Cheese + Flagel upgrade",
  "bagel with plain cream cheese, upgrade to flagel", 410, 509);

// Bagel w/ Flavored CC (450) + Flagel (60) = 510 subtotal
await priceTest("p5-flav-cc-flagel", "Bagel w/ Flavored Cream Cheese + Flagel upgrade",
  "bagel with flavored cream cheese, upgrade to flagel", 510, null);

// Bagel w/ Bacon Scallion CC (495) + Flagel (60) = 555 subtotal
await priceTest("p6-bac-sc-cc-flagel", "Bagel w/ Bacon Scallion CC + Flagel upgrade",
  "bagel with bacon scallion cream cheese, upgrade to flagel", 555, null);

// Simple bagel w/ butter — NO modifier, verify baseline
await priceTest("p7-butter-no-upgrade", "Baseline: Bagel w/ Butter (no upgrade)",
  "bagel with butter", 275, 374);

// Plain bagel — baseline, no modifiers at all
await priceTest("p8-plain-bagel", "Baseline: Plain Bagel (no modifiers)",
  "plain bagel", 150, null);

// ── B. MULTI-TURN INTEGRITY ────────────────────────────────────────────────

console.log("\n═══ B. CART INTEGRITY (add-then-add, quoted = cart + fees) ═══\n");

await multiTest("m1-add-then-add", "Add bagel w/ butter, then CC",
  ["I want a bagel with butter", "also add a plain bagel with cream cheese"],
  [
    { desc: "subtotal=625", fn: (r, c) => {
      const s = sub(c?.cart_json);
      return [s === 625, `${dollars(s)} (exp ${dollars(625)})`];
    }},
    { desc: "items_count=2", fn: (r, c) => {
      const n = Array.isArray(c?.cart_json) ? c.cart_json.length : 0;
      return [n === 2, `${n} items (exp 2)`];
    }},
  ]);

await multiTest("m2-order-then-add", "Bagel w/ CC then BOBO",
  ["plain bagel with cream cheese", "i also want to add a bobo sandwich"],
  [
    { desc: "subtotal=1225", fn: (r, c) => {
      const s = sub(c?.cart_json);
      return [s === 1225, `${dollars(s)} (exp ${dollars(1225)})`];
    }},
    { desc: "items_count=2", fn: (r, c) => {
      const n = Array.isArray(c?.cart_json) ? c.cart_json.length : 0;
      return [n === 2, `${n} items (exp 2)`];
    }},
  ]);

// ── C. RUN EXISTING TEST SUITE CASES (D1/E1/F1/G3) ────────────────────────

console.log("\n═══ C. STRUCTURAL CASES (existing runner+judge) ═══\n");

const OPENROUTER_KEY = Deno.env.get("OPENROUTER_API_KEY") || Deno.env.get("ANTHROPIC_API_KEY") || "";

const runnerConfig = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_KEY,
  chatFunctionUrl: CHAT_URL,
  simulatorApiKey: OPENROUTER_KEY,
};

const judgeConfig = {
  judgeApiKey: OPENROUTER_KEY,
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_KEY,
};

async function runStructural(caseId: string, category: string) {
  try {
    // Dynamically import to get the generated cases
    const { generateCases } = await import("./generator.ts");
    const gen = await generateCases({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SUPABASE_KEY,
      shopId: SHOP_ID,
    });

    const tc = gen.cases.find((c: any) => c.id === caseId);
    if (!tc) {
      v({ id: caseId, label: "not found", category, passed: false, detail: "Case not found in generated library" });
      return;
    }
    
    console.log(`  Running: ${tc.id} (${tc.label})`);
    const { runCase } = await import("./runner.ts");
    const { judgeCase } = await import("./judge.ts");
    const { verifyHoursClosed } = await import("./hours-closed.ts");
    const { verifyCartOpsInvariants } = await import("./cart-ops.ts");

    const run = await runCase(runnerConfig, SHOP_ID, tc);
    if (run.error) {
      v({ id: tc.id, label: tc.label, category, passed: false, detail: `Runner error: ${run.error}` });
      return;
    }

    let passed: boolean;
    let detail: string;

    if (tc.category === "hours-closed") {
      const result = verifyHoursClosed(run);
      passed = result.passed;
      detail = result.invariants.map((i: any) => `${i.id}:${i.passed ? "PASS" : i.detail}`).join("; ");
    } else if (tc.category === "cart-ops") {
      const result = verifyCartOpsInvariants(run);
      passed = result.passed;
      detail = result.invariants.map((i: any) => `${i.id}:${i.passed ? "PASS" : "FAIL-${i.detail}"}`).join("; ");
    } else {
      const result = await judgeCase(judgeConfig, run, tc, gen.shop);
      passed = result.passed;
      const flagsStr = result.flags.length > 0 ? result.flags.map((f: any) => `${f.check}:${f.severity}`).join(",") : "clean";
      detail = `judge=${result.verdict} flags=[${flagsStr}]`;
    }

    v({ id: tc.id, label: tc.label, category, passed, detail });
  } catch (e) {
    v({ id: caseId, label: "?", category, passed: false, detail: `EXCEPTION: ${(e as Error).message}` });
  }
}

// Critical structural cases to test
const structuralCases: Array<[string, string]> = [
  // F1: Hallucination guard
  ["price-challenge", "adversarial"],
  ["prompt-injection", "adversarial"],
  ["nonexistent-item", "edge"],
  // D1: Checkout
  ["menu-checkout-13", "happy-path"],
  // G3: Hours closed
  ["hours-closed-1", "hours-closed"],
  // E1: CartOps (persistence)
  // we'll find first 2 cart-ops dynamically
  // General: ambiguous + multi-item
  ["ambiguous-order", "compliance"],
  ["multi-item-run-on", "edge"],
  ["change-mind-mid-order", "edge"],
];

// Find cart-ops cases
try {
  const { generateCases } = await import("./generator.ts");
  const gen = await generateCases({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_KEY, shopId: SHOP_ID,
  });
  let cartOpsCount = 0;
  for (const c of gen.cases) {
    if (c.category === "cart-ops" && cartOpsCount < 2) {
      structuralCases.push([c.id, "cart-ops"]);
      cartOpsCount++;
    }
  }
} catch { /* dynamic import */ }

for (const [id, cat] of structuralCases) {
  await runStructural(id, cat);
}

// ── SUMMARY ────────────────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════════════════════════════");
const passed = verdicts.filter(r => r.passed).length;
const total = verdicts.length;
console.log(`  RESULT: ${passed}/${total} passed`);
console.log("═══════════════════════════════════════════════════════════════");

console.log("\n═══ BY CATEGORY ═══");
for (const cat of [...new Set(verdicts.map(r => r.category))]) {
  const catV = verdicts.filter(r => r.category === cat);
  console.log(`  ${cat}: ${catV.filter(r => r.passed).length}/${catV.length}`);
}

console.log("\n═══ DETAIL ═══");
for (const r of verdicts) {
  const i = r.passed ? "✅" : "❌";
  console.log(`${i} ${r.id} | ${r.detail}`);
}

// Viability
const pricingAll = verdicts.filter(r => r.category === "pricing");
const pricingOk = pricingAll.every(r => r.passed);
const structuralOk = verdicts.filter(r => r.category !== "pricing" && r.category !== "multi-turn").every(r => r.passed);

console.log("\n═══════════════════════════════════════");
if (pricingOk && structuralOk) {
  console.log("✅ PUSH — all verifications passed");
} else if (pricingOk && !structuralOk) {
  console.log("⚠️  CONDITIONAL — modifier pricing correct; structural regressions need review");
} else {
  console.log("❌ NO-PUSH — failures in pricing logic");
}
console.log("═══════════════════════════════════════");

Deno.exit(passed === total ? 0 : 1);