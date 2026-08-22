/**
 * verify-4.ts — Run the 4 critical cases from f20965f3 directly against
 * the deployed chat-sms edge function + local judge-rubric.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { runCase } from "./runner.ts";
import { judgeCase } from "./judge.ts";
import type { TestCase } from "./library.ts";
import type { RunnerConfig } from "./runner.ts";
import type { JudgeConfig } from "./judge.ts";

const SHOP_ID = "38ae034c-cb9d-4f32-b4f1-d9b40393574b";
const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const PROJECT_REF = "rvdqfxtrskxekfkqnegx";
const CHAT_FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/chat-sms`;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing env vars");
  Deno.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// Load shop
const { data: shop } = await supabase.from("shops").select("id,tenant_id,name,protected,phone_number_e164").eq("id", SHOP_ID).single();
if (!shop) { console.error("shop not found"); Deno.exit(1); }
if (shop.protected || shop.phone_number_e164) { console.error("SAFETY: shop is protected or has a phone number"); Deno.exit(1); }

const runnerConfig: RunnerConfig = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_KEY,
  chatFunctionUrl: CHAT_FUNCTION_URL,
};

const judgeConfig: JudgeConfig = {
  judgeApiKey: ANTHROPIC_API_KEY,
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_KEY,
};

const cases: TestCase[] = [
  {
    id: "menu-single-504",
    category: "happy-path",
    criticality: "critical",
    label: "Order single: Pumpernickel Bagel ($1.50)",
    turns: [{ role: "customer", message: "I'd like a Pumpernickel Bagel please" }],
    success_criteria: [
      { id: "item_recognized", description: 'Bot recognizes "Pumpernickel Bagel"', check_id: "invented_item" },
      { id: "correct_price", description: "Bot acknowledges $1.50", check_id: "wrong_total" },
    ],
  },
  {
    id: "menu-single-525",
    category: "happy-path",
    criticality: "critical",
    label: "Order single: Everything Bagel ($1.50)",
    turns: [{ role: "customer", message: "I'd like a Everything Bagel please" }],
    success_criteria: [
      { id: "item_recognized", description: 'Bot recognizes "Everything Bagel"', check_id: "invented_item" },
      { id: "correct_price", description: "Bot acknowledges $1.50", check_id: "wrong_total" },
    ],
  },
  {
    id: "menu-single-529",
    category: "happy-path",
    criticality: "critical",
    label: "Order single: Bagel with Jelly ($0.75)",
    turns: [{ role: "customer", message: "I'd like a Bagel with Jelly please" }],
    success_criteria: [
      { id: "item_recognized", description: 'Bot recognizes "Bagel with Jelly" as standalone', check_id: "invented_item" },
      { id: "correct_price", description: "Bot acknowledges $0.75", check_id: "wrong_total" },
    ],
  },
  {
    id: "menu-single-531",
    category: "happy-path",
    criticality: "critical",
    label: "Order single: Steak, Egg & Cheese ($8.75)",
    turns: [{ role: "customer", message: "I'd like a Steak, Egg & Cheese please" }],
    success_criteria: [
      { id: "item_recognized", description: 'Bot recognizes "Steak, Egg & Cheese"', check_id: "invented_item" },
      { id: "correct_price", description: "Bot acknowledges $8.75", check_id: "wrong_total" },
    ],
  },
];

let passed = 0;
let failed = 0;

for (const tc of cases) {
  console.log(`\n=== ${tc.id}: ${tc.label} ===`);
  try {
    const run = await runCase(runnerConfig, SHOP_ID, tc);
    if (run.error) {
      console.log(`  RUN ERROR: ${run.error}`);
      failed++;
      continue;
    }
    console.log(`  Reply: ${run.transcript[0]?.reply?.slice(0, 200)}...`);
    const result = await judgeCase(judgeConfig, run, tc, shop);
    const ok = result.passed;
    console.log(`  ${ok ? "PASS" : "FAIL"} | ${result.criteria.map(c => c.passed ? "✓" + c.id : "✗" + c.id + ":" + c.reason).join(", ")} | cost $${result.costCents.toFixed(4)}`);
    if (ok) passed++; else {
      failed++;
      console.log(`  RAW FLAGS: ${JSON.stringify(result.flags)}`);
    }
  } catch (e) {
    console.log(`  EXCEPTION: ${(e as Error).message}`);
    failed++;
  }
}

console.log(`\n=== RESULT: ${passed}/${passed + failed} passed ===`);
if (failed > 0) Deno.exit(1);