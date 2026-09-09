/**
 * ITEM 7 (C2 prompt renderer) — proof #3: with the new gate code in place
 * (prompt_version check + V2 renderer), confirm Vito's (prompt_version
 * still null in the DB — never mutated by this task) runs a normal order
 * conversation exactly as before. Calls handleChatSmsRequest DIRECTLY
 * (imported from the locally-edited chat-sms/index.ts, no deploy) against
 * the real Vito's shop_id, web channel + test:true — same safe pattern
 * scripts/test-suite/proof.ts uses (web channel never reaches SMS/a real
 * phone; test:true only affects business-hours gating).
 *
 * Run:
 *   SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *   SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *   OPENROUTER_API_KEY=... \
 *   deno run --allow-net --allow-env --no-check scripts/tmp-item7-c2-vitos-legacy-proof.ts
 */
import { handleChatSmsRequest } from "../supabase/functions/chat-sms/index.ts";

const VITOS_ID = "e0000000-0000-0000-0000-000000000001";
const sessionId = `c2-vitos-legacy-proof-${crypto.randomUUID()}`;

async function send(message: string) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: VITOS_ID, message, session_id: sessionId, test: true }),
  });
  const res = await handleChatSmsRequest(req);
  const json = await res.json();
  return { status: res.status, ...json };
}

const turns = ["pickup", "I'll take a large cheese pizza", "that's it, confirm"];
for (const turn of turns) {
  const r = await send(turn);
  console.log(`customer: ${turn}`);
  console.log(`status: ${r.status}`);
  console.log(`bot: ${r.reply}`);
  console.log(`phase: ${r.phase}`);
  console.log(`cart: ${JSON.stringify(r.cart)}`);
  console.log("---");
}
