/**
 * SprintAI judge-transcript — the ADVISORY review-panel judge
 * (docs/specs/2026-09-05-judge-panel.md).
 *
 * On-demand, synchronous, called by the admin dashboard right after an owner
 * presses "Send for review" on a captured `test_transcripts` row. It:
 *   1. Loads ONE transcript by id (service role — RLS on test_transcripts has
 *      no SELECT policy for owners, only super-admins; this function does the
 *      access check itself, below).
 *   2. Calls a judge model with the transcript, asking for a plain-language
 *      critique for a restaurant owner (see _shared/transcript-judge.ts).
 *   3. Writes judge_summary / judge_score / judge_proposals / judged_at back
 *      onto that same row.
 *
 * HARD INVARIANT (spec's "hard constraint"): this function is READ + judge +
 * write-back-to-test_transcripts ONLY. It never touches shops, menus, prompts,
 * or any shared config, and every proposal it writes carries status
 * 'proposed' (enforced in coerceVerdict, not here) — there is no code path
 * from a proposal to a live prompt anywhere in this file. Advisory only; it
 * never gates anything.
 *
 * Auth: the request must carry a real Supabase user JWT (verify_jwt = true at
 * the gateway, see supabase/config.toml). This function then additionally
 * requires the caller be a super-admin OR the owner of the SAME tenant that
 * filed the transcript, mirroring the INSERT policy in 095_test_transcripts.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  assembleTranscriptJudgePrompt,
  coerceVerdict,
  type TranscriptJudgeInput,
} from "../_shared/transcript-judge.ts";
import { parseJudgeJson, RETRY_INSTRUCTION } from "../_shared/judge-rubric.ts";

const JUDGE_MODEL = Deno.env.get("TRANSCRIPT_JUDGE_MODEL") ?? "deepseek/deepseek-v4-flash";
const JUDGE_API = "https://openrouter.ai/api/v1/messages";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

/**
 * Decode a JWT's payload without verifying the signature. Safe here because
 * the gateway (verify_jwt = true, supabase/config.toml) has already verified
 * this request carries a validly-signed Supabase JWT before invoking this
 * function — we only need to read its claims, same as the is_super_admin()/
 * current_user_tenant_id() Postgres functions read auth.jwt() directly rather
 * than round-tripping to GoTrue.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callJudgeModel(system: string, userMessage: string): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const res = await fetch(JUDGE_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://getsprintai.com",
      "X-Title": "SprintAI",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 2048,
      reasoning: { enabled: false },
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Judge API ${res.status}: ${t}`);
  }
  const data = await res.json();
  return (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("")
    .trim();
}

async function callJudgeWithRetry(system: string, user: string): Promise<unknown> {
  const first = await callJudgeModel(system, user);
  const parsed = parseJudgeJson(first);
  if (parsed !== null) return parsed;

  await sleep(300);
  const retry = await callJudgeModel(system, user + "\n" + RETRY_INSTRUCTION);
  const retryParsed = parseJudgeJson(retry);
  if (retryParsed !== null) return retryParsed;

  throw new Error(`judge output not parseable JSON after retry (sample): ${retry.slice(0, 200)}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, error: "missing SUPABASE_URL / SERVICE_ROLE_KEY" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ ok: false, error: "Unauthorized" }, 401);

  let body: { transcript_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const transcriptId = body.transcript_id;
  if (!transcriptId) return json({ ok: false, error: "transcript_id required" }, 400);

  // Service-role client. Bypasses RLS; the access check below is the real gate
  // for this endpoint (same shape as admin-api's).
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: transcript, error: fetchErr } = await supabase
    .from("test_transcripts")
    .select("id, tenant_id, shop_name, model, messages, final_cart, reporter_note")
    .eq("id", transcriptId)
    .maybeSingle();

  if (fetchErr) return json({ ok: false, error: fetchErr.message }, 500);
  if (!transcript) return json({ ok: false, error: "transcript not found" }, 404);

  // Access check: super-admin, or the owner of the SAME tenant that filed it.
  // Both roles and service-to-service calls are Supabase JWTs by the time
  // they reach here (verify_jwt = true already rejected anything else), so
  // read claims straight off the token rather than round-tripping to GoTrue
  // (whose /auth/v1/user requires a `sub` claim that service-role tokens and
  // some service JWTs don't carry).
  const token = authHeader.replace("Bearer ", "");
  const claims = decodeJwtPayload(token);
  if (!claims) return json({ ok: false, error: "Unauthorized" }, 401);

  const isServiceCall = claims.role === "service_role";
  if (!isServiceCall) {
    const appMeta = (claims.app_metadata ?? {}) as Record<string, unknown>;
    const userMeta = (claims.user_metadata ?? {}) as Record<string, unknown>;
    const isAdmin = appMeta.role === "super_admin" || userMeta.is_admin === true;
    const callerTenantId = (appMeta.tenant_id ?? userMeta.tenant_id ?? null) as string | null;
    const ownsTenant = Boolean(callerTenantId) && Boolean(transcript.tenant_id) && callerTenantId === transcript.tenant_id;

    if (!isAdmin && !ownsTenant) {
      return json({ ok: false, error: "Forbidden" }, 403);
    }
  }

  const input: TranscriptJudgeInput = {
    shop_name: transcript.shop_name,
    model: transcript.model,
    messages: Array.isArray(transcript.messages) ? transcript.messages : [],
    final_cart: transcript.final_cart,
    reporter_note: transcript.reporter_note,
  };

  if (input.messages.length === 0) {
    return json({ ok: false, error: "transcript has no messages to judge" }, 400);
  }

  const { system, user } = assembleTranscriptJudgePrompt(input);

  let verdict;
  try {
    const parsed = await callJudgeWithRetry(system, user);
    verdict = coerceVerdict(parsed);
  } catch (e) {
    console.error(`[judge-transcript] judge failed for ${transcriptId}:`, (e as Error).message);
    return json({ ok: false, error: `judge failed: ${(e as Error).message}` }, 502);
  }

  const judgedAt = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("test_transcripts")
    .update({
      judge_summary: verdict.summary,
      judge_score: verdict.score,
      judge_proposals: verdict.proposals,
      judged_at: judgedAt,
    })
    .eq("id", transcriptId);

  if (updateErr) return json({ ok: false, error: updateErr.message }, 500);

  return json({
    ok: true,
    transcript_id: transcriptId,
    judge_summary: verdict.summary,
    judge_score: verdict.score,
    judge_proposals: verdict.proposals,
    judged_at: judgedAt,
  });
});
