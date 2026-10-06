/**
 * access-request — a signed-in user with no role asks for access; the approver approves or denies from an email link.
 *
 * POST { action: "request", name, note? }   (user JWT)  -> records one pending request, emails the approver
 * POST { action: "status" }                 (user JWT)  -> { status: "none" | "pending" | "approved" | "denied", role }
 * POST { action: "view", id, t }            (no JWT; the emailed token)  -> { name, email, status }
 * POST { action: "decide", id, t, decision } (no JWT; the emailed token) -> approves (role super_admin) or denies, once
 *
 * The token is the approver's proof: 32 random bytes, stored hashed, single use, 7-day expiry. The admin-site page
 * shows the request and asks for a click, so a mail scanner that opens the link approves nothing.
 * Deploy with --no-verify-jwt (the approve page has no session); the request/status actions verify the user here.
 * Approved team members get app_metadata.role = "super_admin" (Jason 2026-10-05: full admin for Erin now).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const SITE = Deno.env.get("ADMIN_SITE_URL") ?? "https://getsprintai.com/admin";
const APPROVER = Deno.env.get("ACCESS_APPROVER_EMAIL") ?? "jason@getsprintai.com";
const FROM = "OrderFare <orders@getsprintai.com>";

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) { console.error("[access-request] RESEND_API_KEY missing"); return false; }
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: FROM, to: [to], subject, html }) });
  if (!r.ok) console.error("[access-request] resend", r.status, (await r.text()).slice(0, 300));
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({})) as Record<string, string>;

  if (body.action === "request" || body.action === "status") {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await db.auth.getUser(jwt);
    if (!user?.email) return json({ error: "Please sign in first." }, 401);
    const role = (user.app_metadata as { role?: string } | null)?.role ?? null;
    const { data: last } = await db.from("access_requests").select("status").eq("user_id", user.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (body.action === "status") return json({ status: role ? "approved" : (last?.status ?? "none"), role });
    if (role) return json({ status: "approved", role });
    if (last?.status === "pending") return json({ status: "pending" });
    const name = (body.name ?? "").trim().slice(0, 120);
    if (!name) return json({ error: "Please enter your name." }, 400);
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const { data: row, error } = await db.from("access_requests").insert({ user_id: user.id, email: user.email, name, note: (body.note ?? "").slice(0, 500) || null, token_hash: await sha256(token) }).select("id").single();
    if (error || !row) return json({ error: "Couldn't record the request. Try again." }, 500);
    const link = `${SITE}/approve-access?id=${row.id}&t=${token}`;
    const sent = await sendEmail(APPROVER, `${name} is asking for OrderFare admin access`,
      `<p><b>${esc(name)}</b> (${esc(user.email)}) is asking for OrderFare team access (full admin).</p>${body.note ? `<p>Note: ${esc(body.note)}</p>` : ""}<p><a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Review and approve</a></p><p style="color:#888;font-size:12px">The link works once and expires in 7 days.</p>`);
    return json({ status: "pending", emailed: sent });
  }

  if (body.action === "view" || body.action === "decide") {
    if (!body.id || !body.t) return json({ error: "This link is incomplete." }, 400);
    const { data: r } = await db.from("access_requests").select("*").eq("id", body.id).maybeSingle();
    if (!r || r.token_hash !== await sha256(body.t)) return json({ error: "This link isn't valid." }, 404);
    if (body.action === "view") return json({ name: r.name, email: r.email, status: r.status, expired: new Date(r.expires_at) < new Date() });
    if (r.status !== "pending") return json({ error: `This request was already ${r.status}.`, status: r.status }, 409);
    if (new Date(r.expires_at) < new Date()) return json({ error: "This link has expired. Ask them to request again." }, 410);
    const approve = body.decision === "approve";
    if (approve) {
      const { data: u } = await db.auth.admin.getUserById(r.user_id);
      const { error } = await db.auth.admin.updateUserById(r.user_id, { app_metadata: { ...(u?.user?.app_metadata ?? {}), role: "super_admin" } });
      if (error) return json({ error: "Couldn't grant access: " + error.message }, 500);
    }
    await db.from("access_requests").update({ status: approve ? "approved" : "denied", decided_at: new Date().toISOString() }).eq("id", r.id).eq("status", "pending");
    if (approve) await sendEmail(r.email, "You have OrderFare admin access", `<p>Hi ${esc(r.name ?? "")}, you're approved. Sign in at <a href="${SITE}/">${SITE}</a>.</p>`);
    return json({ status: approve ? "approved" : "denied", name: r.name, email: r.email });
  }
  return json({ error: "Unknown action" }, 400);
});
