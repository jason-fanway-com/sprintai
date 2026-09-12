#!/usr/bin/env node
/**
 * Item K — regression spot-check for the extractMenuItems() chunking fix
 * (vigil 72d197cc, uncommitted). Drives the LOCAL function (deno run,
 * LOCAL_TEST_PORT) over the network with real Firecrawl + real OpenRouter,
 * against 3 previously-PASSing HTML-rung sites from the item-K sample, to
 * confirm the chunked-parallel extraction doesn't regress sites that were
 * already fine under v73.
 * Fresh throwaway tenant. Writes ids -> ...-ids.json, results -> ...-results.json.
 */
const fs = require("fs");

const URL = process.env.SPRINTAI_CHAT_SUPABASE_URL;
const SRK = process.env.SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY;
const FN_URL = process.env.LOCAL_FN_URL || "http://127.0.0.1:8788";
if (!URL || !SRK) { console.error("missing SPRINTAI_CHAT_SUPABASE_URL / SERVICE_ROLE_KEY"); process.exit(2); }

const REST = `${URL}/rest/v1`;
const H = { "apikey": SRK, "Authorization": `Bearer ${SRK}`, "Content-Type": "application/json" };

// Previously PASS (rung-1 HTML) sites from the third measurement, item-K doc.
// biaggiopizza was the largest HTML menu (124 items, needed the 90s->170s LLM
// timeout bump) — the most relevant stress test for the chunking change.
const SITES = [
  [6,  "https://www.biaggiopizza.com/",     "HTML rung-1 PASS, 124 items (largest HTML menu in sample)"],
  [17, "https://www.hoagiesandhops.com/",   "HTML rung-1 PASS"],
  [7,  "https://www.myfamilypizzas.com/",   "HTML rung-1 PASS"],
];

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
    const res = await fetch(`${FN_URL}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  const idsPath = __dirname + "/tmp-item-K-chunkfix-regress-ids.json";

  if (mode === "cleanup") {
    const ids = JSON.parse(fs.readFileSync(idsPath, "utf8"));
    await rest("DELETE", `/tenants?id=eq.${ids.tenant_id}`, null, { Prefer: "return=minimal" });
    console.log("deleted tenant (cascade):", ids.tenant_id);
    const shopsLeft = await rest("GET", `/shops?tenant_id=eq.${ids.tenant_id}&select=id`);
    console.log("PROOF shops remaining:", shopsLeft.length);
    return;
  }

  const TAG = "itemk-chunkfix-regress-20260907";
  const tenant = await rest("POST", "/tenants", {
    name: "ITEMK Chunkfix Regress (delete me)", slug: `${TAG}-tenant`, status: "onboarding",
  }, { Prefer: "return=representation" });
  const tenant_id = tenant[0].id;
  console.log("tenant:", tenant_id);

  const ids = { tenant_id, shops: [] };
  const results = [];

  for (let i = 0; i < SITES.length; i++) {
    const [n, url, label] = SITES[i];
    const shop = await rest("POST", "/shops", {
      tenant_id, name: `ITEMK-CFR site${n}`, slug: `${TAG}-shop-${n}`,
      website_url: url, crawl_status: null,
    }, { Prefer: "return=representation" });
    const shop_id = shop[0].id;
    const menu = await rest("POST", "/menus", {
      shop_id, name: "ITEMK menu", source: "manual",
    }, { Prefer: "return=representation" });
    const menu_id = menu[0].id;
    ids.shops.push({ n, url, label, shop_id, menu_id });
    fs.writeFileSync(idsPath, JSON.stringify(ids, null, 2));

    console.log(`\n[site ${n}] invoking local scrape-shop for ${url} ...`);
    const inv = await invokeScrape(shop_id);

    const shopRow = await rest("GET", `/shops?id=eq.${shop_id}&select=crawl_status,crawl_error`);
    const currentMenuRows = await rest("GET", `/menus?shop_id=eq.${shop_id}&select=id,source,source_detail`);
    const currentMenu = currentMenuRows[0] || null;
    const current_menu_id = currentMenu ? currentMenu.id : menu_id;
    const items = await rest("GET", `/menu_items?menu_id=eq.${current_menu_id}&select=name,price_cents,category`);
    const withPrice = items.filter(it => Number(it.price_cents) > 0).length;

    const r = {
      n, url, label,
      http: inv.status, ms: inv.ms,
      fn_ok: inv.body && inv.body.ok === true,
      fn_error: (inv.body && typeof inv.body === "object" && inv.body.error) || null,
      crawl_status: shopRow[0]?.crawl_status,
      crawl_error: shopRow[0]?.crawl_error || null,
      pages_scraped: inv.body?.pages_scraped ?? null,
      menu_items_extracted: inv.body?.menu_items_extracted ?? null,
      menu_items_inserted: inv.body?.menu_items_inserted ?? null,
      items_in_db: items.length,
      items_with_price: withPrice,
      sample_items: items.slice(0, 5).map(it => ({ name: it.name, price_cents: it.price_cents })),
    };
    results.push(r);
    console.log(`[site ${n}] http=${r.http} ms=${r.ms} fn_ok=${r.fn_ok} status=${r.crawl_status} items_db=${r.items_in_db} priced=${r.items_with_price}`);
    if (r.fn_error) console.log(`   fn_error: ${JSON.stringify(r.fn_error).slice(0,300)}`);
    fs.writeFileSync(__dirname + "/tmp-item-K-chunkfix-regress-results.json", JSON.stringify(results, null, 2));

    if (i < SITES.length - 1) {
      console.log("pausing 10s before next site (Firecrawl pacing)...");
      await new Promise(res => setTimeout(res, 10_000));
    }
  }

  console.log("\nwrote results + ids. Run with 'cleanup' to delete tenant.");
})();
