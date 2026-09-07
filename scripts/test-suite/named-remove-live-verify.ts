#!/usr/bin/env deno run --allow-net --allow-env --allow-read
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { runCase } from "./runner.ts";
import { CONVERSATIONAL_CASES } from "./library.ts";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PROJECT_REF = "rvdqfxtrskxekfkqnegx";
const CHAT_FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/chat-sms`;
const SHOP_ID = "e0000000-0000-0000-0000-000000000001";
const OPENROUTER_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const config = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_KEY,
  chatFunctionUrl: CHAT_FUNCTION_URL,
  simulatorApiKey: OPENROUTER_KEY,
};

const TARGET_IDS = new Set([
  "conv-named-remove-middle",
  "conv-named-remove-not-in-cart",
  "conv-named-remove-name-only-match",
  "conv-named-remove-ambiguous",
]);

const cases = CONVERSATIONAL_CASES.filter(c => TARGET_IDS.has(c.id));
console.log(`Running ${cases.length} named-remove live cases against deployed bot...\n`);

let passed = 0, failed = 0;
for (const c of cases) {
  console.log(`▶ ${c.id}: ${c.label}`);
  const result = await runCase(config, SHOP_ID, c);
  if (result.passed) {
    console.log(`  ✓ PASS\n`);
    passed++;
  } else {
    console.log(`  ✗ FAIL`);
    console.log(`  error: ${result.error ?? "criteria not met"}`);
    if ((result as any).conversation) {
      for (const turn of (result as any).conversation) {
        console.log(`    [${turn.role}]: ${turn.content}`);
      }
    }
    console.log();
    failed++;
  }
}

console.log(`\n═══ RESULT: ${passed}/${cases.length} passed, ${failed} failed ═══`);
Deno.exit(failed > 0 ? 1 : 0);
