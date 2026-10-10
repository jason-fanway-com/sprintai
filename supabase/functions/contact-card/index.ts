/**
 * contact-card — a shop's vCard (.vcf), with its logo as the contact photo.
 *
 * GET /functions/v1/contact-card/<shop_id>.vcf
 *
 * Attached to a customer's first paid receipt (MMS) so the shop's number is saved under its name and logo:
 * the logo then shows on the shop's Messages thread. Public on purpose: the carrier fetches it with no
 * credentials, and it holds only what the shop already shows customers (name, texting number, logo).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** vCard text values escape backslash, comma, semicolon and newlines (RFC 6350 3.4). */
export function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\;").replace(/\r?\n/g, "\\n");
}

/** Lines longer than 75 octets fold onto continuation lines that start with one space (RFC 6350 3.2). */
export function fold(line: string): string {
  if (line.length <= 75) return line;
  const out = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) out.push(" " + line.slice(i, i + 74));
  return out.join("\r\n");
}

export function buildVcard(shop: { name: string; phone: string; url?: string | null }, photoB64: string | null): string {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:;${esc(shop.name)};;;`,
    `FN:${esc(shop.name)}`,
    `ORG:${esc(shop.name)}`,
    `TEL;TYPE=CELL,VOICE,PREF:${shop.phone}`,
    ...(shop.url ? [`URL:${shop.url}`] : []),
    `NOTE:${esc("Text this number to order.")}`,
    ...(photoB64 ? [`PHOTO;ENCODING=b;TYPE=JPEG:${photoB64}`] : []),
    "END:VCARD",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
  const id = new URL(req.url).pathname.split("/").pop()?.replace(/\.vcf$/i, "") ?? "";
  if (!UUID.test(id)) return new Response("Not Found", { status: 404 });

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const { data: shop } = await supabase.from("shops").select("name, display_name, phone_number_e164, website_url, logo_path").eq("id", id).maybeSingle();
  if (!shop?.phone_number_e164) return new Response("Not Found", { status: 404 });

  let photo: string | null = null;
  if (shop.logo_path) {
    const { data } = await supabase.storage.from("shop-logos").download(shop.logo_path);
    if (data && data.size <= 60_000) photo = b64(new Uint8Array(await data.arrayBuffer())); // a carrier caps the whole MMS; a contact photo is a thumbnail
  }
  const name = (shop.display_name ?? shop.name) as string;
  const body = buildVcard({ name, phone: shop.phone_number_e164 as string, url: shop.website_url as string | null }, photo);
  const file = name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shop";
  return new Response(req.method === "HEAD" ? null : body, {
    status: 200,
    headers: { "Content-Type": "text/vcard; charset=utf-8", "Content-Disposition": `attachment; filename="${file}.vcf"`, "Cache-Control": "public, max-age=3600" },
  });
});
