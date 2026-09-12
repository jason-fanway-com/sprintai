#!/usr/bin/env node
/**
 * Item K — verify FIRECRAWL_API_KEY is actually live on the DEPLOYED
 * scrape-shop function after the secret was set + function redeployed
 * (2026-09-08). Single cheap site, fresh throwaway tenant.
 * Writes ids -> tmp-item-K-secretverify-ids.json, results -> tmp-item-K-secretverify-results.json.
 */
const fs = require("fs");

const URL = process.env.SPRINTAI_CHAT_SUPABASE_URL;
const SRK = process.env.SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SRK) { console.error("missing SPRINTAI_CHAT_SUPABASE_URL / SERVICE_ROLE_KEY"); process.exit(2); }

const REST = `${URL}/rest/v1`;
const H = { "apikey": SRK, "Authorization": `Bearer ${SRK}`, "Content-Type": "application/json" };

const SITE = [17, "https://www.hoagiesandhops.com/", "HTML rung-1 PASS (cheapest of the item-K sample)"];

async function rest(method, path, body, extraHeaders) {
  const res = await fetch(`${REST}${path}`, {
    method, headers: { ...H, ...(extraHeaders||{}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json; try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
  if (!res.ok) throw new Error(`REST ${method} ${path} -> ${res.status}: ${txt.slice(0,300)}`);
  return json;
}

async function invokeScrape(shopId) {
  const t0 = Date.now();
  let status, body;
  try {
    const res = await fetch(`${URL}/functions/v1/scrape-shop`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${SRK}`, "apikey": SRK, "Content-Type": "application/json" },
      body: JSON.stringify({ shop_id: shopId, force: true }),
    });
    status = res.status;
    const txt = await res.text();
    try { body = JSON.parse(txt); } catch { body = txt; }
  } catch (e) {
    status = 0; body = { error: "network: " + e.message };
  }
  return { status, body, ms: Date.now() - t0 };
}

(async () => {
  const mode = process.argv[2] || "run";
  const idsPath = __dirname + "/tmp-item-K-secretverify-ids.json";

  if (mode === "cleanup") {
    const ids = JSON.parse(fs.readFileSync(idsPath, "utf8"));
    await rest("DELETE", `/tenants?id=eq.${ids.tenant_id}`, null, { Prefer: "return=minimal" });
    console.log("deleted tenant (cascade):", ids.tenant_id);
    const shopsLeft = await rest("GET", `/shops?tenant_id=eq.${ids.tenant_id}&select=id`);
    console.log("PROOF shops remaining:", shopsLeft.length);
    return;
  }

  const TAG = "itemk-secretverify-20260908";
  const tenant = await rest("POST", "/tenants", {
    name: "ITEMK Secretverify (delete me)", slug: `${TAG}-tenant`, status: "onboarding",
  }, { Prefer: "return=representation" });
  const tenant_id = tenant[0].id;
  console.log("tenant:", tenant_id);

  const [n, url, label] = SITE;
  const shop = await rest("POST", "/shops", {
    tenant_id, name: `ITEMK-SV site${n}`, slug: `${TAG}-shop-${n}`,
    website_url: url, crawl_status: null,
  }, { Prefer: "return=representation" });
  const shop_id = shop[0].id;
  const menu = await rest("POST", "/menus", {
    shop_id, name: "ITEMK menu", source: "manual",
  }, { Prefer: "return=representation" });
  const menu_id = menu[0].id;
  const ids = { tenant_id, shops: [{ n, url, label, shop_id, menu_id }] };
  fs.writeFileSync(idsPath, JSON.stringify(ids, null, 2));

  console.log(`\n[site ${n}] invoking DEPLOYED scrape-shop for ${url} ...`);
  const inv = await invokeScrape(shop_id);

  const shopRow = await rest("GET", `/shops?id=eq.${shop_id}&select=crawl_status,crawl_error`);
  const currentMenuRows = await rest("GET", `/menus?shop_id=eq.${shop_id}&select=id,source`);
  const current_menu_id = (currentMenuRows[0] && currentMenuRows[0].id) || menu_id;
  const items = await rest("GET", `/menu_items?menu_id=eq.${current_menu_id}&select=name,price_cents`);

  const r = {
    n, url, label,
    http: inv.status, ms: inv.ms,
    fn_ok: inv.body && inv.body.ok === true,
    fn_error: (inv.body && typeof inv.body === "object" && inv.body.error) || null,
    crawl_status: shopRow[0]?.crawl_status,
    crawl_error: shopRow[0]?.crawl_error || null,
    pages_scraped: inv.body?.pages_scraped ?? null,
    menu_items_extracted: inv.body?.menu_items_extracted ?? null,
    items_in_db: items.length,
    raw_response: inv.body,
  };
  fs.writeFileSync(__dirname + "/tmp-item-K-secretverify-results.json", JSON.stringify(r, null, 2));
  console.log("\nRESULT:", JSON.stringify(r, null, 2));
  console.log("\nRun with 'cleanup' to delete tenant.");
})();
