/**
 * SprintAI resend-webhook Edge Function (INSTRUCTION-10 item H).
 *
 * Receives Resend delivery webhooks (Svix-signed) and writes the true delivery
 * outcome back against resend_message_id, then mirrors the latest outcome onto
 * the order so the Expo Screen surfaces a bounce per order.
 *
 * POST /functions/v1/resend-webhook
 * Headers: svix-id, svix-timestamp, svix-signature (Svix HMAC)
 *
 * Events handled: email.delivered, email.bounced, email.complained,
 * email.delivery_delayed. All others are acknowledged (200) and ignored.
 *
 * SECURITY: fail-closed. If RESEND_WEBHOOK_SECRET is unset, or the signature does
 * not verify, we reject — we never accept an unverified delivery claim. A wrong
 * signing secret is exactly the failure that let a Stripe webhook silently drop
 * real payments; we do not repeat it by trusting unsigned input.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// Resend event type → the status we persist.
const EVENT_STATUS: Record<string, string> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivery_delayed": "delivery_delayed",
};

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Constant-time compare of two equal-length strings.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Verify a Svix (Resend) webhook signature.
 * signedContent = `${id}.${timestamp}.${rawBody}`; expected = base64(HMAC-SHA256).
 * The svix-signature header is a space-separated list of `v1,<sig>` entries.
 */
async function verifySvix(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  rawBody: string,
): Promise<boolean> {
  // Secret is "whsec_<base64key>"; the key is the base64 part.
  const secretKey = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(secretKey);
  } catch {
    return false;
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(signedContent) as unknown as BufferSource,
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));

  // Header: "v1,<sig> v1,<sig2> ..." — any matching v1 signature passes.
  for (const entry of svixSignature.split(" ")) {
    const [version, sig] = entry.split(",");
    if (version === "v1" && sig && timingSafeEqual(sig, expected)) return true;
  }
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResp({ error: "Method Not Allowed" }, 405);

  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";
  if (!secret) {
    // Fail closed — never accept unverified delivery claims.
    console.error("[resend-webhook] RESEND_WEBHOOK_SECRET not set — rejecting");
    return jsonResp({ error: "webhook not configured" }, 500);
  }

  const svixId = req.headers.get("svix-id") ?? "";
  const svixTimestamp = req.headers.get("svix-timestamp") ?? "";
  const svixSignature = req.headers.get("svix-signature") ?? "";
  const rawBody = await req.text();

  if (!svixId || !svixTimestamp || !svixSignature) {
    return jsonResp({ error: "missing svix headers" }, 401);
  }

  // Reject stale timestamps (replay protection): 5-minute tolerance.
  const tsSec = Number(svixTimestamp);
  if (!Number.isFinite(tsSec) || Math.abs(Date.now() / 1000 - tsSec) > 300) {
    return jsonResp({ error: "timestamp out of tolerance" }, 401);
  }

  const ok = await verifySvix(secret, svixId, svixTimestamp, svixSignature, rawBody);
  if (!ok) {
    console.error("[resend-webhook] signature verification failed");
    return jsonResp({ error: "invalid signature" }, 401);
  }

  let event: { type?: string; created_at?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResp({ error: "invalid json" }, 400);
  }

  const status = event.type ? EVENT_STATUS[event.type] : undefined;
  if (!status) {
    // Acknowledge unhandled event types so Resend does not retry them.
    return jsonResp({ ok: true, ignored: event.type ?? null }, 200);
  }

  const data = event.data ?? {};
  const emailId = typeof data.email_id === "string" ? data.email_id : null;
  if (!emailId) {
    console.warn("[resend-webhook] event has no data.email_id — ignoring", event.type);
    return jsonResp({ ok: true, ignored: "no email_id" }, 200);
  }

  // Detail: bounce reason / complaint feedback when Resend provides it.
  let detail: string | null = null;
  const bounce = data.bounce as Record<string, unknown> | undefined;
  if (bounce && typeof bounce === "object") {
    const parts = [bounce.type, bounce.subType, bounce.message].filter(
      (v) => typeof v === "string" && v,
    );
    if (parts.length) detail = parts.join(" · ");
  }

  const eventAt = typeof event.created_at === "string" ? event.created_at : new Date().toISOString();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // 1) Audit truth: update the matching send-log row(s).
  const { data: logRows, error: logErr } = await supabase
    .from("ticket_send_log")
    .update({
      delivery_status: status,
      delivery_detail: detail,
      delivery_event_at: eventAt,
    })
    .eq("resend_message_id", emailId)
    .select("cart_id");

  if (logErr) {
    console.error("[resend-webhook] ticket_send_log update failed:", logErr.message);
    return jsonResp({ error: "log update failed" }, 500);
  }
  if (!logRows || logRows.length === 0) {
    // No matching send — a message we didn't originate, or race before insert.
    console.warn(`[resend-webhook] no ticket_send_log row for email_id ${emailId}`);
    return jsonResp({ ok: true, matched: 0 }, 200);
  }

  // 2) Owner-visible mirror: latest outcome onto the order the Expo Screen reads.
  const cartIds = [...new Set(logRows.map((r) => r.cart_id).filter(Boolean))];
  for (const cartId of cartIds) {
    const { error: cartErr } = await supabase
      .from("order_carts")
      .update({
        ticket_delivery_status: status,
        ticket_delivery_detail: detail,
        ticket_delivery_at: eventAt,
      })
      .eq("id", cartId);
    if (cartErr) {
      console.error(`[resend-webhook] order_carts mirror failed for ${cartId}:`, cartErr.message);
    }
  }

  console.log(`[resend-webhook] ${event.type} → ${status} for email_id ${emailId} (${cartIds.length} order(s))`);
  return jsonResp({ ok: true, status, matched: logRows.length }, 200);
});
