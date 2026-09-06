#!/usr/bin/env node
/**
 * Item K — timeout-fix proof (commit 52f4caf, deployed function v73).
 * MEASUREMENT ONLY. Drives the DEPLOYED scrape-shop over the network, force:true.
 * Just the 3 sites named in the brief: the two 504 FAILs (9, 20) from the third
 * measurement, plus one PDF-rung site (3) to prove provenance persists.
 * Fresh throwaway tenant. Firecrawl credit budget: 3 sites only, no re-sweep.
 * Writes ids -> tmp-item-K-timeoutfix-ids.json, results -> tmp-item-K-timeoutfix-results.json.
 * `cleanup` cascade-deletes the tenant and PROVES it gone.
 */
const fs = require("fs");

const URL = process.env.SPRINTAI_CHAT_SUPABASE_URL;
const SRK = process.env.SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SRK) { console.error("missing SPRINTAI_CHAT_SUPABASE_URL / SERVICE_ROLE_KEY"); process.exit(2); }

const REST = `${URL}/rest/v1`;
const H = { "apikey": SRK, "Authorization": `Bearer ${SRK}`, "Content-Type": "application/json" };

// Same locked URLs, same numbering, as tmp-item-K-remeasure2-runner.cjs.
const SITES = [
  [9,  "https://www.familypizzeriarestaurantmenu.com/", "JS-heavy (504 FAIL, stuck done w/ items)"],
  [20, "https://www.orderfamilypizzeriamenu.com/",       "JS-heavy (504 FAIL, stuck running, 0 items)"],
  [3,  "https://www.spinnatoshoagies.com/",               "PDF-only (PDF-rung provenance check)"],
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

async function firecrawlCredits() {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/team/credit-usage", {
      headers: { Authorization: "Bearer " + (process.env.FIRECRAWL_API_KEY || "") },
    });
    const d = await res.json();
    return d?.data?.remaining_credits ?? null;
  } catch { return null; }
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
  const idsPath = __dirname + "/tmp-item-K-timeoutfix-ids.json";

  if (mode === "cleanup") {
    const ids = JSON.parse(fs.readFileSync(idsPath, "utf8"));
    await rest("DELETE", `/tenants?id=eq.${ids.tenant_id}`, null, { Prefer: "return=minimal" });
    console.log("deleted tenant (cascade):", ids.tenant_id);
    const shopsLeft = await rest("GET", `/shops?tenant_id=eq.${ids.tenant_id}&select=id`);
    const tenantLeft = await rest("GET", `/tenants?id=eq.${ids.tenant_id}&select=id`);
    const shopIds = ids.shops.map(s => s.shop_id);
    const menuIds = ids.shops.map(s => s.menu_id);
    const orphanMenus = await rest("GET", `/menus?shop_id=in.(${shopIds.join(",")})&select=id`);
    const orphanItems = await rest("GET", `/menu_items?menu_id=in.(${menuIds.join(",")})&select=id`);
    console.log("PROOF shops remaining:", shopsLeft.length);
    console.log("PROOF tenant remaining:", tenantLeft.length);
    console.log("PROOF menus remaining:", orphanMenus.length);
    console.log("PROOF menu_items remaining:", orphanItems.length);
    return;
  }

  const creditsBefore = await firecrawlCredits();
  console.log("Firecrawl credits BEFORE:", creditsBefore);

  const TAG = "itemk-timeoutfix-20260905";
  const tenant = await rest("POST", "/tenants", {
    name: "ITEMK Timeoutfix Proof (delete me)", slug: `${TAG}-tenant`, status: "onboarding",
  }, { Prefer: "return=representation" });
  const tenant_id = tenant[0].id;
  console.log("tenant:", tenant_id);

  const ids = { tenant_id, credits_before: creditsBefore, shops: [] };
  const results = [];

  for (let i = 0; i < SITES.length; i++) {
    const [n, url, label] = SITES[i];
    const shop = await rest("POST", "/shops", {
      tenant_id, name: `ITEMK-TF site${n}`, slug: `${TAG}-shop-${n}`,
      website_url: url, crawl_status: null,
    }, { Prefer: "return=representation" });
    const shop_id = shop[0].id;
    const menu = await rest("POST", "/menus", {
      shop_id, name: "ITEMK menu", source: "manual",
    }, { Prefer: "return=representation" });
    const menu_id = menu[0].id;
    ids.shops.push({ n, url, label, shop_id, menu_id });
    fs.writeFileSync(idsPath, JSON.stringify(ids, null, 2));

    console.log(`\n[site ${n}] invoking scrape-shop for ${url} ...`);
    const inv = await invokeScrape(shop_id);

    const shopRow = await rest("GET", `/shops?id=eq.${shop_id}&select=crawl_status,crawl_error,menu_links,open_hours`);
    // Re-resolve menu by shop_id — the PDF rung replaces the menu row, so the
    // originally-created menu_id may no longer exist (same fix under test).
    const currentMenuRows = await rest("GET", `/menus?shop_id=eq.${shop_id}&select=id,source,source_detail`);
    const currentMenu = currentMenuRows[0] || null;
    const current_menu_id = currentMenu ? currentMenu.id : menu_id;
    const items = await rest("GET", `/menu_items?menu_id=eq.${current_menu_id}&select=name,price_cents,category,source,flag_review`);
    const withPrice = items.filter(it => Number(it.price_cents) > 0).length;
    const sd = (currentMenu && currentMenu.source_detail) || {};

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
      resp_menu_source: inv.body?.menu_source ?? null,
      resp_rungs_tried: inv.body?.rungs_tried ?? null,
      original_menu_id: menu_id,
      current_menu_id,
      menu_id_swapped: current_menu_id !== menu_id,
      db_menu_source: currentMenu?.source ?? null,
      sd_rung: sd.rung ?? null,
      sd_platform: sd.platform ?? null,
      sd_url: sd.url ?? null,
      sd_on_domain_backend: sd.on_domain_backend ?? null,
      sd_rungs_tried: sd.rungs_tried ?? null,
      sd_persisted: !!(sd && Object.keys(sd).length),
      items_in_db: items.length,
      items_with_price: withPrice,
      sample_items: items.slice(0, 5).map(it => ({ name: it.name, price_cents: it.price_cents })),
    };
    results.push(r);
    console.log(`[site ${n}] http=${r.http} ms=${r.ms} fn_ok=${r.fn_ok} status=${r.crawl_status} items_db=${r.items_in_db} priced=${r.items_with_price} menu_id_swapped=${r.menu_id_swapped} sd_persisted=${r.sd_persisted} sd_rung=${r.sd_rung} backend=${r.sd_on_domain_backend||"-"}`);
    if (r.fn_error) console.log(`   fn_error: ${JSON.stringify(r.fn_error).slice(0,300)}`);
    fs.writeFileSync(__dirname + "/tmp-item-K-timeoutfix-results.json", JSON.stringify(results, null, 2));

    if (i < SITES.length - 1) {
      console.log("pausing 20s before next site (Firecrawl pacing)...");
      await new Promise(res => setTimeout(res, 20_000));
    }
  }

  const creditsAfter = await firecrawlCredits();
  ids.credits_after = creditsAfter;
  fs.writeFileSync(idsPath, JSON.stringify(ids, null, 2));
  console.log("\nFirecrawl credits AFTER:", creditsAfter, "(used", (creditsBefore!=null&&creditsAfter!=null)?creditsBefore-creditsAfter:"?", ")");
  console.log("wrote results + ids. Run with 'cleanup' to delete tenant.");
})();
