/**
 * public-tester edge function — the ONLY thing the public /try page talks to.
 *
 * Spec:  docs/specs/2026-09-05-public-tester.md
 * Build: docs/specs/2026-09-05-public-tester-BUILD.md
 *
 * The public page never calls chat-sms directly (test_transcripts REVOKEs
 * anon and its INSERT policy requires an authenticated tenant JWT — a public
 * browser cannot write one). This function holds the service role, proxies
 * to chat-sms internally, and is the single place every guard rail (kill
 * switch, live-shop guard, rate limits, turn cap) is enforced. Anything
 * enforced only in the browser is bypassed in thirty seconds on a public
 * endpoint, so nothing here is optional or client-trusted.
 *
 * Three actions, one POST body shape: { action: "start" | "send" | "submit", ... }.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TURN_CAP = 20; // Cost is quadratic in turns (full ~17k-token system prompt resent
                      // every turn): 3 turns=$0.018, 9=$0.082, 16=$0.226 (measured against
                      // production). This is the cost control; raising it is expensive,
                      // not linear. The rate limits below are the abuse control — do not
                      // weaken either without re-measuring.
const CAP_MESSAGE =
  "We've reached the end of this test conversation — thanks for sticking with it! " +
  "Hit \"Send for review\" below to tell us what felt wrong, then start a fresh order if you'd like to try another.";

// The ONLY volume control. This is a link Jason texts to friends and family,
// not an endpoint under attack: the abuse risk is near zero and the friction
// cost is total — a friend who orders three pizzas and hits a wall stops
// testing, and we lose exactly the data the page exists to collect.
//
// Removed 2026-09-05 after Jason was blocked on his own phone:
//   - per-IP hourly limit. Households, offices and phone carriers share one
//     public IP. The crew tests from a machine on Jason's home network, so our
//     own testing spent his allowance before he opened the page.
//   - per-browser hourly limit. A tester running ten orders in an hour is the
//     best possible outcome, not abuse.
//
// What still bounds spend: this daily cap, the 20-turn per-conversation cap
// (a runaway single session), and the kill switch — one row, instant off,
// which is the real abuse control.
const RATE_LIMIT_GLOBAL_PER_DAY    = 1000;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function refuse(reason: string, status = 400) {
  return jsonResponse({ ok: false, reason }, status);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Midnight today in the given IANA timezone, as an ISO instant. */
function startOfShopDay(timeZone: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now).reduce<Record<string, string>>((a, p) => (a[p.type] = p.value, a), {});
  const localMidnight = Date.UTC(+parts.year, +parts.month - 1, +parts.day);
  const asUtc = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second,
  );
  // offset = how far the shop's wall clock is from UTC right now
  const offsetMs = asUtc - now.getTime() + (now.getTime() % 1000);
  return new Date(localMidnight - offsetMs).toISOString();
}

/** Best-effort client IP from the platform's forwarding headers. Never the raw
 *  value stored anywhere — only its salted hash. */
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

interface RequestBody {
  action?:        string;
  session_id?:    string;
  message?:       string;
  tester_name?:   string;
  reporter_note?: string;
  final_cart?:    unknown;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return refuse("method_not_allowed", 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("[public-tester] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return refuse("misconfigured", 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  let body: RequestBody;
  try { body = await req.json(); } catch { return refuse("invalid_json", 400); }

  const action = body.action;
  if (action !== "start" && action !== "send" && action !== "submit") {
    return refuse("invalid_action", 400);
  }

  // ── Shared preconditions — checked on EVERY action before anything else ──

  // 1. Kill switch.
  const { data: cfgRows, error: cfgErr } = await supabase
    .from("app_config")
    .select("key, value")
    .in("key", ["public_tester_enabled", "public_tester_shop_id"]);
  if (cfgErr) {
    console.error("[public-tester] app_config lookup failed:", cfgErr.message);
    return refuse("misconfigured", 500);
  }
  const cfg = Object.fromEntries((cfgRows ?? []).map(r => [r.key, r.value]));
  if (cfg.public_tester_enabled !== true) {
    return refuse("disabled", 503);
  }

  // 2. Resolve + hard-guard the target shop. Checked per request, not at
  //    deploy time, because the config row is editable — a misconfigured
  //    shop id must fail closed every time, not just today.
  const shopId = typeof cfg.public_tester_shop_id === "string" ? cfg.public_tester_shop_id : null;
  const { data: shop, error: shopErr } = shopId
    ? await supabase
        .from("shops")
        .select("id, name, tenant_id, is_test, phone_number_e164, timezone")
        .eq("id", shopId)
        .maybeSingle()
    : { data: null, error: null };
  if (shopErr) console.error("[public-tester] shop lookup failed:", shopErr.message);
  if (!shop || shop.is_test !== true || shop.phone_number_e164 !== null) {
    console.error(
      "[public-tester] REFUSED: target shop failed the test-shop guard",
      { shopId, found: !!shop, is_test: shop?.is_test, hasPhone: !!shop?.phone_number_e164 },
    );
    return refuse("misconfigured", 503);
  }

  // 3. Hash the client IP. Raw IP is never stored — minimum PII is a hard rule.
  //
  // FAIL CLOSED on a missing salt. An unsalted SHA-256 of an IPv4 address is
  // reversible by brute force in seconds (2^32 candidates), so an empty salt
  // silently turns "we store hashed IPs" into "we store IPs". That is a
  // privacy claim we would be making falsely, so refuse to run instead.
  const salt = Deno.env.get("PUBLIC_TESTER_SALT") ?? "";
  if (!salt) {
    console.error("[public-tester] REFUSED: PUBLIC_TESTER_SALT is not set — refusing to hash IPs unsalted");
    return refuse("misconfigured", 500);
  }
  const ipHash = await sha256Hex(`${clientIp(req)}:${salt}`);

  // ── action: start ─────────────────────────────────────────────────────────
  if (action === "start") {
    // Day boundary in the SHOP's timezone, not UTC. A UTC midnight reset means
    // the "150 per day" window rolls over at 8pm local, which is neither the
    // day Jason means nor the day the spend lands on.
    const dayStart = startOfShopDay(shop.timezone ?? "America/New_York");

    const { count: globalCount, error: globalErr } = await supabase
      .from("public_tester_sessions")
      .select("id", { count: "exact", head: true })
      .gte("created_at", dayStart);
    if (globalErr) { console.error("[public-tester] global rate check failed:", globalErr.message); return refuse("misconfigured", 500); }
    if ((globalCount ?? 0) >= RATE_LIMIT_GLOBAL_PER_DAY) return refuse("global_cap", 429);

    // No per-IP and no per-browser limit. See the constants above.
    const hintedSessionId = typeof body.session_id === "string" ? body.session_id : null;

    const newSessionId = crypto.randomUUID();
    const { error: insertErr } = await supabase.from("public_tester_sessions").insert({
      session_id:  newSessionId,
      // Kept for grouping a returning browser's conversations when reading the
      // corpus. No longer gates anything — the per-browser limit it existed for
      // was removed 2026-09-05.
      client_hint: hintedSessionId ?? newSessionId,
      ip_hash:     ipHash,
      shop_id:     shop.id,
      turns:       0,
      submitted:   false,
    });
    if (insertErr) {
      console.error("[public-tester] session insert failed:", insertErr.message);
      return refuse("misconfigured", 500);
    }

    return jsonResponse({ ok: true, session_id: newSessionId, shop_name: shop.name });
  }

  // ── action: send ──────────────────────────────────────────────────────────
  if (action === "send") {
    const sessionId = body.session_id;
    const message = body.message;
    if (!sessionId || typeof message !== "string" || !message.trim()) {
      return refuse("invalid_request", 400);
    }

    const { data: session, error: sessionLookupErr } = await supabase
      .from("public_tester_sessions")
      .select("id, turns, messages")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (sessionLookupErr) { console.error("[public-tester] session lookup failed:", sessionLookupErr.message); return refuse("misconfigured", 500); }
    if (!session) return refuse("unknown_session", 400);

    // ATOMIC claim. The cap is enforced by the UPDATE's WHERE clause inside the
    // database, so two concurrent requests cannot both win a turn. The previous
    // read-check-increment here was not a ceiling: QA fired three concurrent
    // sends at a session seeded to turns=19 and got two real model replies.
    // Cost is quadratic in turns and this endpoint is public, so a soft cap is
    // an unbounded bill.
    const { data: claimed, error: claimErr } = await supabase
      .rpc("public_tester_claim_turn", { p_session_id: sessionId, p_cap: TURN_CAP });
    if (claimErr) { console.error("[public-tester] turn claim failed:", claimErr.message); return refuse("misconfigured", 500); }
    if (claimed === null || claimed === undefined) {
      return jsonResponse({ ok: true, capped: true, reply: CAP_MESSAGE });
    }
    const newTurns = claimed as number;

    let chatRes: Response;
    try {
      chatRes = await fetch(`${supabaseUrl}/functions/v1/chat-sms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceRoleKey}`,
        },
        // test: true is mandatory on every call — never omit it.
        body: JSON.stringify({ shop_id: shop.id, message: message.trim(), session_id: sessionId, test: true }),
      });
    } catch (err) {
      console.error("[public-tester] chat-sms fetch failed:", err instanceof Error ? err.message : err);
      return refuse("upstream_error", 502);
    }
    if (!chatRes.ok) {
      console.error("[public-tester] chat-sms returned", chatRes.status);
      return refuse("upstream_error", 502);
    }
    const chatData = await chatRes.json();

    // Append this turn to the SERVER-side transcript, verbatim, both directions,
    // in order. Done as a single `messages = messages || turn` statement in the
    // database: the previous read-modify-write here lost turns whenever two
    // requests overlapped. The browser's copy is for display only and is never
    // what gets stored — see the column comment in migration 096.
    const { error: transcriptErr } = await supabase
      .rpc("public_tester_append_turn", {
        p_session_id: sessionId,
        p_user_text:  message.trim(),
        p_bot_text:   chatData.reply ?? "",
        p_model:      chatData.model ?? null,
      });
    if (transcriptErr) {
      // Non-fatal for the tester's conversation, but it means this turn would
      // be missing from the corpus — say so in the log rather than lose it silently.
      console.error("[public-tester] transcript append failed:", transcriptErr.message);
    }

    return jsonResponse({
      ok:           true,
      reply:        chatData.reply ?? "",
      cart:         chatData.cart ?? [],
      model:        chatData.model ?? null,
      turns_left:   TURN_CAP - newTurns,
      // Checkout stays live in the tester — it's test mode (routes to
      // order-success-test.html) and the most defect-dense part of the flow.
      checkout_url: chatData.checkout_url ?? null,
    });
  }

  // ── action: submit ────────────────────────────────────────────────────────
  if (action === "submit") {
    const sessionId = body.session_id;
    if (!sessionId) return refuse("invalid_request", 400);

    const { data: session, error: sessionLookupErr } = await supabase
      .from("public_tester_sessions")
      .select("id, messages, model, submitted")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (sessionLookupErr) { console.error("[public-tester] session lookup failed:", sessionLookupErr.message); return refuse("misconfigured", 500); }
    if (!session) return refuse("unknown_session", 400);

    // One transcript per conversation. Without this a valid session id could be
    // re-submitted without limit, each call inserting another row with
    // client-controlled name and note — storage amplification on a public
    // endpoint, and duplicate noise in a corpus we intend to trust.
    if (session.submitted === true) {
      return jsonResponse({ ok: true, already: true });
    }

    const testerName = typeof body.tester_name === "string" && body.tester_name.trim()
      ? body.tester_name.trim().slice(0, 60)
      : null;
    // Server-side cap. The page limits this to 280 chars, but the page is not
    // the only thing that can POST here.
    const reporterNote = typeof body.reporter_note === "string" && body.reporter_note.trim()
      ? body.reporter_note.trim().slice(0, 500)
      : null;

    const { error: insertErr } = await supabase.from("test_transcripts").insert({
      shop_id:       shop.id,
      tenant_id:     shop.tenant_id,
      shop_name:     shop.name,
      // Both taken from the SERVER's record of the conversation, never from
      // the request body. This endpoint is public: a client-supplied
      // transcript would let anyone write anything into the corpus, and
      // "verbatim" would mean "whatever the browser claimed".
      model:         session.model ?? null,
      messages:      Array.isArray(session.messages) ? session.messages : [],
      final_cart:    body.final_cart ?? null,
      reporter_note: reporterNote,
      tester_name:   testerName,
      source:        "public-tester",
    });
    if (insertErr) {
      console.error("[public-tester] transcript insert failed:", insertErr.message);
      return jsonResponse({ ok: false, message: "Could not save your feedback — please try again." }, 500);
    }

    await supabase.from("public_tester_sessions").update({ submitted: true }).eq("id", session.id);

    return jsonResponse({ ok: true });
  }

  return refuse("invalid_action", 400);
});
