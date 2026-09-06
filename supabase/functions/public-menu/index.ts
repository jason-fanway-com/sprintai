/**
 * public-menu edge function — renders the public, read-only, mobile-first
 * per-shop menu page at getsprintai.com/m/<shop-slug>.
 *
 * Spec: docs/specs/2026-09-06-public-menu-page.md (approved by Jason 2026-09-06).
 *
 * NOT a copy. Rendered at request time from the SAME rows chat-sms reads —
 * menus -> menu_items -> option_groups -> option_choices, service-role read.
 * No build step, no cache of the menu body, no generated file. It cannot
 * disagree with what the bot will sell because there is no second copy to
 * disagree with.
 *
 * No auth (it's a public link texted to strangers). No ordering, no cart, no
 * JS framework — server-rendered HTML + inline CSS so it opens fast on a
 * phone with a cold cache on a bad connection.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { dayWindows } from "../_shared/hours.ts";

// PostgREST caps a single response at 1000 rows by default, silently — no
// error, no truncation flag. Vito's alone has 2640 option_choices across 186
// groups, almost all sharing display_order=0, so which 1000 survive a given
// request is whatever order ties happen to come back in — a real shop's menu
// page can render with option groups missing choices depending on luck. Page
// through with .range() (stable secondary sort on id) so a table of any size
// reads in full. Same fix as chat-sms's buildEffectiveMenu — same underlying
// bug, same shape.
const FETCH_PAGE_SIZE = 1000;
async function fetchAllRows<T>(queryBuilder: () => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await (queryBuilder() as any).range(from, from + FETCH_PAGE_SIZE - 1);
    if (error) {
      console.error(`[public-menu] fetchAllRows error at offset ${from}:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < FETCH_PAGE_SIZE) break;
    from += FETCH_PAGE_SIZE;
  }
  return rows;
}

function h(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function money(cents: number | null | undefined): string {
  if (cents == null) return "";
  return `$${(cents / 100).toFixed(2)}`;
}

interface Choice { id: string; name: string; price_cents: number }
interface Group { id: string; name: string; required: boolean; min_select: number; max_select: number; choices: Choice[] }
interface Item {
  id: string; name: string; price_cents: number; description: string | null;
  category: string | null; display_order: number | null; groups: Group[];
}

const DAY_LABEL: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function formatHours(openHours: unknown): string {
  if (!openHours || typeof openHours !== "object") return "";
  const oh = openHours as Record<string, unknown>;
  const rows: string[] = [];
  for (const d of DAY_ORDER) {
    const slots = dayWindows(oh[d] as Parameters<typeof dayWindows>[0]);
    if (slots.length === 0) { rows.push(`${DAY_LABEL[d]} closed`); continue; }
    rows.push(`${DAY_LABEL[d]} ${slots.map(s => `${s.open}–${s.close}`).join(", ")}`);
  }
  return rows.join(" &middot; ");
}

function renderGroup(g: Group): string {
  const cardinality = g.required
    ? (g.max_select > 1 ? `required &middot; pick ${g.min_select}–${g.max_select}` : "required &middot; pick 1")
    : (g.max_select > 1 ? `optional &middot; pick up to ${g.max_select}` : "optional");
  const SHOWN = 8;
  const shown = g.choices.slice(0, SHOWN);
  const rest = g.choices.slice(SHOWN);
  const choiceHtml = (c: Choice) =>
    `<li>${h(c.name)}${c.price_cents > 0 ? ` <span class="up">+${money(c.price_cents)}</span>` : ""}</li>`;
  const restBlock = rest.length > 0
    ? `<details><summary>+${rest.length} more</summary><ul class="choices">${rest.map(choiceHtml).join("")}</ul></details>`
    : "";
  return `
    <div class="group">
      <div class="group-name">${h(g.name)} <span class="card">(${cardinality})</span></div>
      <ul class="choices">${shown.map(choiceHtml).join("")}</ul>
      ${restBlock}
    </div>`;
}

function renderItem(item: Item): string {
  const groupsHtml = item.groups.length > 0
    ? item.groups.map(renderGroup).join("")
    : "";
  return `
    <div class="item">
      <div class="item-row">
        <span class="item-name">${h(item.name)}</span>
        <span class="item-price">${money(item.price_cents)}</span>
      </div>
      ${item.description ? `<div class="item-desc">${h(item.description)}</div>` : ""}
      ${groupsHtml}
    </div>`;
}

function renderCategory(name: string, items: Item[]): string {
  const anyOptions = items.some(i => i.groups.length > 0);
  // Spec: an item with no options must look like it has none — no silent
  // omission. Surfaced at the category level: if NOTHING in this category has
  // options, say so once rather than let 62 items silently look identical to
  // items that were never checked.
  const note = anyOptions
    ? ""
    : `<div class="no-options-note">No add-ons or choices are configured for this category yet.</div>`;
  return `
    <section class="category">
      <h2>${h(name)}</h2>
      ${note}
      ${items.map(renderItem).join("")}
    </section>`;
}

const PAGE_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:#fafaf8; color:#1a1a1a; line-height:1.4; }
  header { background:#1a1a2e; color:#fff; padding:20px 16px; }
  header h1 { margin:0 0 4px; font-size:22px; }
  header .meta { font-size:13px; color:#c9c9d4; }
  header .hours { font-size:12px; color:#9a9aad; margin-top:6px; }
  main { max-width:640px; margin:0 auto; padding:0 12px 40px; }
  .category { margin-top:22px; }
  .category h2 { font-size:15px; text-transform:uppercase; letter-spacing:0.04em; color:#666; border-bottom:1px solid #e2e2de; padding-bottom:6px; margin-bottom:10px; }
  .no-options-note { font-size:12px; color:#8a6d00; background:#fff8e1; border-radius:6px; padding:6px 10px; margin-bottom:10px; }
  .item { padding:10px 0; border-bottom:1px solid #ececea; }
  .item-row { display:flex; justify-content:space-between; align-items:baseline; gap:12px; }
  .item-name { font-weight:600; font-size:15px; }
  .item-price { font-weight:600; font-size:15px; white-space:nowrap; }
  .item-desc { font-size:13px; color:#555; margin-top:2px; }
  .group { margin-top:8px; padding:8px 10px; background:#f2f2ee; border-radius:8px; }
  .group-name { font-size:13px; font-weight:600; }
  .group .card { font-weight:400; color:#666; }
  ul.choices { list-style:none; margin:6px 0 0; padding:0; font-size:13px; columns:2; column-gap:16px; }
  ul.choices li { break-inside:avoid; padding:1px 0; }
  .up { color:#8a4b00; }
  details summary { font-size:12px; color:#1a1a2e; margin-top:6px; cursor:pointer; }
  footer { text-align:center; font-size:11px; color:#999; padding:24px 16px 32px; }
  .not-found { max-width:480px; margin:80px auto; text-align:center; padding:0 20px; font-family:-apple-system,sans-serif; }
`;

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/functions\/v1\/public-menu\//, "").replace(/^\/public-menu\//, "").split("/").filter(Boolean);
  const slug = parts[0];

  const notFound = () => new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${PAGE_CSS}</style></head>
     <body><div class="not-found"><h1>Menu not found</h1><p>This link may be out of date.</p></div></body></html>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

  if (!slug) return notFound();

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: shop } = await supabase
    .from("shops")
    .select("id, slug, name, display_name, formatted_address, phone_number_e164, open_hours, timezone, is_paused")
    .eq("slug", slug)
    .maybeSingle();

  // Retired/paused shops serve no page at all — not a stale menu, not a
  // "closed" notice. A public link to a retired shop should read exactly
  // like a link that never existed.
  if (!shop || shop.is_paused) return notFound();

  const { data: menu } = await supabase
    .from("menus")
    .select("id")
    .eq("shop_id", shop.id)
    .or(`effective_until.is.null,effective_until.gte.${new Date().toISOString()}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!menu) return notFound();

  const itemList = await fetchAllRows<{ id: string; name: string; price_cents: number; description: string | null; category: string | null; display_order: number | null }>(() =>
    supabase
      .from("menu_items")
      .select("id, name, price_cents, description, category, display_order")
      .eq("menu_id", menu.id)
      .eq("active", true)
      .order("display_order", { ascending: true })
      .order("id", { ascending: true }),
  );
  const itemIds = itemList.map((i) => i.id);

  const groups = itemIds.length > 0
    ? await fetchAllRows<{ id: string; menu_item_id: string; name: string; required: boolean; min_select: number; max_select: number }>(() =>
        supabase
          .from("option_groups")
          .select("id, menu_item_id, name, required, min_select, max_select, display_order")
          .in("menu_item_id", itemIds)
          .order("display_order", { ascending: true })
          .order("id", { ascending: true }),
      )
    : [];

  const groupIds = groups.map((g) => g.id);
  const choices = groupIds.length > 0
    ? await fetchAllRows<{ id: string; option_group_id: string; name: string; price_cents: number }>(() =>
        supabase
          .from("option_choices")
          .select("id, option_group_id, name, price_cents, display_order")
          .in("option_group_id", groupIds)
          .order("display_order", { ascending: true })
          .order("id", { ascending: true }),
      )
    : [];

  const choicesByGroup = new Map<string, Choice[]>();
  for (const c of choices) {
    const arr = choicesByGroup.get(c.option_group_id) ?? [];
    arr.push({ id: c.id, name: c.name, price_cents: c.price_cents });
    choicesByGroup.set(c.option_group_id, arr);
  }
  const groupsByItem = new Map<string, Group[]>();
  for (const g of groups ?? []) {
    const arr = groupsByItem.get(g.menu_item_id) ?? [];
    arr.push({ id: g.id, name: g.name, required: g.required, min_select: g.min_select, max_select: g.max_select, choices: choicesByGroup.get(g.id) ?? [] });
    groupsByItem.set(g.menu_item_id, arr);
  }

  const byCategory = new Map<string, Item[]>();
  for (const it of itemList) {
    const cat = it.category?.trim() || "Other";
    const arr = byCategory.get(cat) ?? [];
    arr.push({ ...it, groups: groupsByItem.get(it.id) ?? [] });
    byCategory.set(cat, arr);
  }

  const displayName = shop.display_name || shop.name;
  const hoursHtml = formatHours(shop.open_hours);
  const textLine = shop.phone_number_e164
    ? `<div class="meta">Text us to order: ${h(shop.phone_number_e164)}</div>`
    : "";

  const categoriesHtml = [...byCategory.entries()]
    .map(([cat, its]) => renderCategory(cat, its))
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${h(displayName)} — Menu</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <header>
    <h1>${h(displayName)}</h1>
    ${shop.formatted_address ? `<div class="meta">${h(shop.formatted_address)}</div>` : ""}
    ${textLine}
    ${hoursHtml ? `<div class="hours">${hoursHtml}</div>` : ""}
  </header>
  <main>
    ${categoriesHtml || `<p style="text-align:center;color:#888;margin-top:40px;">Menu is being set up — check back soon.</p>`}
  </main>
  <footer>Menu shown live from ${h(displayName)}'s Sprint account &middot; Prices set by the restaurant.</footer>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});
