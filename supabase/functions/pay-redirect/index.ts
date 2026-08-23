/**
 * pay-redirect — Short-link Stripe checkout redirect
 *
 * GET /functions/v1/pay-redirect?code=<short_code>
 * Looks up short_code in pay_links, 302 redirects to the Stripe URL.
 *
 * Production domain: https://pay.getsprintai.com/o/<short_code>
 * Provisioning DNS: pay.getsprintai.com CNAME → rvdqfxtrskxekfkqnegx.supabase.co
 *   + Supabase custom domain config for functions (Dashboard → Edge Functions → Custom Domains)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Support both query param (?code=X) and path-style (/o/X) routing.
  let shortCode = url.searchParams.get("code") ?? "";
  if (!shortCode) {
    const pathMatch = url.pathname.match(/\/o\/([A-Za-z0-9]+)/);
    if (pathMatch) shortCode = pathMatch[1];
  }

  if (!shortCode) {
    return new Response("Missing payment code", { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: link, error } = await supabase
    .from("pay_links")
    .select("stripe_url")
    .eq("short_code", shortCode)
    .maybeSingle();

  if (error || !link) {
    console.error(`[pay-redirect] Not found: ${shortCode}`, error);
    return new Response("Payment link not found or expired", { status: 404 });
  }

  return Response.redirect(link.stripe_url, 302);
});