// engine-eval — runs interpreter eval cases with the project's model keys.
// Service-role only. Not on any customer path. Body: { provider, model, cases: [{ id, ctx }] }
import { interpret, type InterpretContext, type ModelConfig } from "../chat-sms/engine/interpret.ts";

Deno.serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!svc || auth !== `Bearer ${svc}`) return new Response("forbidden", { status: 403 });
  const body = await req.json() as { provider: "anthropic" | "openrouter"; model: string; cases: Array<{ id: string; ctx: InterpretContext }>; timeoutMs?: number };
  const apiKey = body.provider === "anthropic" ? Deno.env.get("ANTHROPIC_API_KEY") ?? "" : Deno.env.get("OPENROUTER_API_KEY") ?? "";
  if (!apiKey) return new Response(JSON.stringify({ error: `no key for ${body.provider}` }), { status: 500 });
  const cfg: ModelConfig = { provider: body.provider, model: body.model, apiKey, timeoutMs: body.timeoutMs ?? 30000 };
  const results = await Promise.all(body.cases.slice(0, 25).map(async (c) => ({ id: c.id, result: await interpret(c.ctx, cfg) })));
  return new Response(JSON.stringify({ results }), { headers: { "content-type": "application/json" } });
});
