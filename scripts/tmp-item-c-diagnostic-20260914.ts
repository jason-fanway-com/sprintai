#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --no-check
// Throwaway diagnostic for Item C (2026-09-14) — NOT a permanent asset.
import { handleChatSmsRequest } from "../supabase/functions/chat-sms/index.ts";

const VITOS_ID = "e0000000-0000-0000-0000-000000000001";

async function send(sessionId: string, message: string) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: VITOS_ID, message, session_id: sessionId, test: true }),
  });
  const res = await handleChatSmsRequest(req);
  return await res.json();
}

const sessionId = `itemC-diag-${crypto.randomUUID()}`;
await send(sessionId, "Testmode");
await send(sessionId, "pickup");
const r = await send(sessionId, "I'll have french fries");
console.log("REPLY:", JSON.stringify(r.reply));
console.log("CART:", JSON.stringify(r.cart));
