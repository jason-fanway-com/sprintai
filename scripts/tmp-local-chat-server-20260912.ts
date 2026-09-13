/**
 * Local HTTP server wrapping handleChatSmsRequest for in-process testing.
 * Used by the proof suite via TEST_CHAT_FUNCTION_URL.
 *
 * Run:
 *   source ~/.openclaw-sprintai/.secrets
 *   SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *   SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *   OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
 *   STRIPE_TEST_SECRET_KEY="$STRIPE_TEST_SECRET_KEY" \
 *   deno run --allow-net --allow-env --no-check scripts/tmp-local-chat-server-20260912.ts
 */
import { handleChatSmsRequest } from "../supabase/functions/chat-sms/index.ts";

const port = 9876;
console.log(`[local-server] Listening on http://localhost:${port}/chat-sms`);

Deno.serve({ port }, async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname !== "/chat-sms" && url.pathname !== "/functions/v1/chat-sms") {
    return new Response("Not found", { status: 404 });
  }
  try {
    return await handleChatSmsRequest(req);
  } catch (e) {
    console.error("[local-server] error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
