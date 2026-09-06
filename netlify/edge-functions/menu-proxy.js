/**
 * Netlify Edge Function: menu-proxy
 *
 * Intercepts /m/<slug> requests, fetches the public-menu Supabase edge
 * function, and returns the response with the correct Content-Type header.
 *
 * Why this exists: Supabase's edge gateway rewrites Content-Type to
 * text/plain + sandboxed CSP for ALL verify_jwt=false functions whose body
 * looks like HTML, regardless of what the function code sets. This is a
 * platform-level safeguard on the shared *.supabase.co domain and cannot be
 * overridden by the function itself. Netlify's [redirects.headers] only sets
 * *request* headers sent to the upstream, so it can't fix response headers.
 * An edge function is the only hop between the browser and the gateway that
 * we fully control — so we fetch, strip the bad headers, and re-serve here.
 */

const SUPABASE_MENU_URL =
  "https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/public-menu";

export default async (request) => {
  const url = new URL(request.url);
  // Strip the /m/ prefix to get the slug
  const slug = url.pathname.replace(/^\/m\//, "").replace(/\/+$/, "");

  const upstream = await fetch(`${SUPABASE_MENU_URL}/${slug}`, {
    method: "GET",
    headers: { "User-Agent": "SprintAI-menu-proxy/1.0" },
  });

  const body = await upstream.text();

  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'",
    },
  });
};

export const config = { path: "/m/*" };
