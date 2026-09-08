#!/usr/bin/env node
/**
 * Read real option-group/modifier data for Zio's Pizza (shop_id
 * 2cba7b51-211c-4437-8910-1af4dcc03498) off its live public Slice ordering
 * page, using a real rendered browser (Playwright) — no API key extracted
 * or reused, per Jason's hard rule (see BLOCKED.txt "[SPIKE CORRECTION]").
 *
 * Source: https://slicelife.com/restaurants/pa/allentown/18104/zio-s-pizza-allentown/menu
 *
 * For each of Zio's 220 active menu_items, this script:
 *   1. Matches it to a real Slice product by name (+ price/section
 *      disambiguation for shared display names — see MATCHES_FILE, built by
 *      a one-time offline matching pass, not part of this script's runtime).
 *   2. Navigates to `?view_product=<id>` (a real page navigation, not an
 *      API call) and reads the RENDERED modal DOM for real: group name,
 *      required/select-one-vs-many exactly as Slice's own DOM states it
 *      (role="radiogroup" + aria-required, vs role="checkbox" rows), every
 *      choice + its stated upcharge, and which choice (if any) Slice
 *      pre-selects as default (aria-checked on initial render).
 *   3. Writes option_groups/option_choices rows with provenance='stated'
 *      and source_span = the actual rendered text read, matching migration
 *      113's provenance model.
 *
 * Rate-limited to human page-load pace (2-4s jittered delay between
 * products) — this is 200 real page navigations against a live third-party
 * site, not a bulk API hammer.
 *
 * Idempotent via import_key (menu-scoped per migration 010), safe to re-run
 * — matches the load-vitos-sandwich-options.py convention in this repo.
 *
 * Size-fold (2026-09-08, ec35040 item A): a required singleton "Size"-named
 * group is Slice's own per-item size UI, the same shape the one-time
 * scripts/fold-zios-sizes.ts backfill already exploded for the 78 groups
 * live at that time. Any FUTURE scrape (a Zio's re-run after a menu change,
 * or a new Slice-sourced shop) must fold size at import time too, or the
 * un-folded shape comes right back the next time this script runs. See
 * foldSizeGroupIfPresent below -- it uses the exact same pure decision
 * function (supabase/functions/_shared/size-fold.ts) as the one-time
 * backfill, so the two can never drift into different fold rules.
 *
 * Usage:
 *   node scripts/load-zios-slice-options.mjs                # dry run, writes /tmp/zios-extract.json
 *   node scripts/load-zios-slice-options.mjs --apply         # writes to DB
 *   node scripts/load-zios-slice-options.mjs --apply --limit=5   # first 5 matched items only (spot-check run)
 */
import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { planSizeFold } from '../supabase/functions/_shared/size-fold.ts';

const SUPABASE_URL = 'https://rvdqfxtrskxekfkqnegx.supabase.co';
const SHOP_ID = '2cba7b51-211c-4437-8910-1af4dcc03498';
const MENU_URL = 'https://slicelife.com/restaurants/pa/allentown/18104/zio-s-pizza-allentown/menu';
const MATCHES_FILE = process.env.MATCHES_FILE || '/tmp/zios/matches.json';
const EXTRACT_OUT = '/tmp/zios/zios-extract.json';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

function loadSecrets() {
  const secrets = {};
  const txt = fs.readFileSync(path.join(os.homedir(), '.openclaw/.secrets'), 'utf8');
  for (let line of txt.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    line = line.replace(/^export\s+/, '');
    const m = line.match(/^(\S+)\s*=\s*(.+)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/^["']|["']$/g, '').replace(/;$/, '');
    secrets[m[1].trim()] = v;
  }
  return secrets;
}

async function supabase(method, pathAndQuery, body, prefer) {
  const secrets = loadSecrets();
  const key = secrets['SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY'];
  if (!key) throw new Error('SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY not found');
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`  HTTP ${res.status} on ${method} ${pathAndQuery}: ${text.slice(0, 400)}`);
    return null;
  }
  return text.trim() ? JSON.parse(text) : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(baseMs, spreadMs) { return baseMs + Math.random() * spreadMs; }

function parsePriceCents(text) {
  // "+$4.00" -> 400, " $15.25" -> 1525, "" / no number -> null
  const m = text.match(/([+-]?)\$\s*([\d,]+\.\d{2})/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * Math.round(parseFloat(m[2].replace(/,/g, '')) * 100);
}

// Runs inside the page — extracts every option group from an open product modal.
function extractGroupsFromDialog() {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return null;

  const headers = Array.from(dialog.querySelectorAll(
    '#product-group-selections-header, [id^="selection-category-"]'
  ));

  const groups = [];
  for (const header of headers) {
    if (header.id === 'notes-for-kitchen-label') continue; // free-text field, not an option group
    const children = Array.from(header.children);
    const groupName = (children[0]?.textContent || '').trim();
    const subtitle = (children[1]?.textContent || '').trim() || null;

    // The choices container is the header's own next sibling (both are direct
    // children of the same group wrapper) — NOT header.parentElement's next
    // sibling, which is the *next group's whole wrapper* and silently pulls
    // in the wrong group's choices (caught via a live spot-check: a radio
    // group with one real choice was showing the next checkbox group's 5
    // choices instead).
    const choicesContainer = header.nextElementSibling;
    if (!choicesContainer) continue;

    const choiceEls = Array.from(
      choicesContainer.querySelectorAll('[role="radio"], [role="checkbox"]')
    );
    if (choiceEls.length === 0) continue;

    const isRadio = choiceEls[0].getAttribute('role') === 'radio';
    const choices = choiceEls.map((el, idx) => {
      const row = el.parentElement; // the choice row wraps both the control and its label as siblings
      const rowText = (row?.textContent || '').trim();
      const ariaChecked = el.getAttribute('aria-checked') === 'true';
      return { rowText, ariaChecked, displayOrder: idx };
    });

    let required = false;
    let minSelectStated = null;
    let maxSelectStated = null;
    if (isRadio) {
      // choicesContainer is the radiogroup itself (header's direct next sibling).
      required = choicesContainer.getAttribute?.('aria-required') === 'true'
        || choicesContainer.querySelector?.('[role="radiogroup"]')?.getAttribute('aria-required') === 'true';
    } else if (subtitle) {
      required = /^required/i.test(subtitle);
      const upTo = subtitle.match(/select up to (\d+)/i);
      if (upTo) maxSelectStated = parseInt(upTo[1], 10);
      const atLeast = subtitle.match(/select at least (\d+)/i);
      if (atLeast) minSelectStated = parseInt(atLeast[1], 10);
    }

    groups.push({
      groupName, subtitle, isRadio, required,
      minSelectStated, maxSelectStated,
      sourceSpan: subtitle ? `${groupName} — ${subtitle}` : groupName,
      choices,
    });
  }
  return groups;
}

async function extractProduct(page, slug, productId) {
  const url = `${MENU_URL}?view_product=${productId}`;
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  let dialogAppeared = false;
  try {
    await page.waitForSelector('[role="dialog"]', { timeout: 6000 });
    dialogAppeared = true;
  } catch {
    // Some items (e.g. a plain soda) may have no configurable options at all
    // and never open a modal — a real, valid zero-groups outcome, not an error.
  }
  if (!dialogAppeared) return { groups: [], noModal: true };
  await page.waitForTimeout(400); // let the modal's own render settle
  const rawGroups = await page.evaluate(extractGroupsFromDialog);
  return { groups: rawGroups || [], noModal: false };
}

function buildGroupRows(match, rawGroups) {
  const basePriceCents = match.db_price_cents;
  const out = [];
  for (const g of rawGroups) {
    const parsedChoices = g.choices.map(c => {
      const priceCents = parsePriceCents(c.rowText);
      let name = c.rowText;
      // Strip a trailing "$X.XX" or "+$X.XX" price fragment to isolate the choice name.
      name = name.replace(/[+-]?\$\s*[\d,]+\.\d{2}\s*$/, '').trim();
      return { name, priceCents, ariaChecked: c.ariaChecked, displayOrder: c.displayOrder, sourceSpan: c.rowText };
    });

    let choices;
    if (g.isRadio) {
      // Radio choice prices are absolute (e.g. per-size); convert to a
      // delta off the item's base price, same convention as every other
      // upcharge in this schema (price_cents = extra cost beyond base).
      choices = parsedChoices.map(c => ({
        name: c.name,
        price_cents: c.priceCents != null ? c.priceCents - basePriceCents : 0,
        is_default: c.ariaChecked,
        display_order: c.displayOrder,
        source_span: c.sourceSpan,
      }));
    } else {
      choices = parsedChoices.map(c => ({
        name: c.name,
        price_cents: c.priceCents != null ? c.priceCents : 0,
        is_default: c.ariaChecked,
        display_order: c.displayOrder,
        source_span: c.sourceSpan,
      }));
    }

    const required = g.required;
    const min_select = required ? (g.minSelectStated ?? 1) : (g.minSelectStated ?? 0);
    // No stated cap for an optional multi-select group: the only honest,
    // non-guessed upper bound is "can't select more than exist" — the
    // literal choice count. Documented here, not silently invented.
    const max_select = g.isRadio
      ? 1
      : (g.maxSelectStated ?? choices.length);

    out.push({
      name: g.groupName,
      required,
      min_select,
      max_select,
      kind: required ? 'slot' : 'modifier',
      provenance: 'stated',
      source_span: g.sourceSpan,
      choices,
    });
  }
  return out;
}

function isSizeGroup(g) {
  return g.kind === 'slot' && g.required && /size/i.test(g.name);
}

// Splits the Size group (if any) out of groupRows and folds it into
// menu_items rows via the shared planSizeFold decision function, instead of
// writing it as an option_group like every other group. Returns the
// remaining (non-size) groups for the normal writeItem path. Only writes
// when apply=true -- during a dry run this still computes and returns the
// plan so it shows up in the per-item log, matching every other write path
// in this script.
async function foldSizeGroupIfPresent(menuItemId, groupRows, apply) {
  const sizeGroupIdx = groupRows.findIndex(isSizeGroup);
  if (sizeGroupIdx === -1) return { remainingGroups: groupRows, sizeFoldPlan: null };
  const sizeGroup = groupRows[sizeGroupIdx];
  const remainingGroups = groupRows.filter((_, i) => i !== sizeGroupIdx);

  const [item] = await supabase('GET',
    `menu_items?id=eq.${menuItemId}&select=id,menu_id,name,category,description,price_cents`);
  if (!item) {
    console.error(`    FAILED size-fold: menu_item ${menuItemId} not found`);
    return { remainingGroups, sizeFoldPlan: null };
  }

  const sourceItem = { id: item.id, name: item.name, category: item.category, description: item.description, price_cents: item.price_cents };
  const sourceChoices = sizeGroup.choices.map(c => ({ id: null, name: c.name, display_name: c.name, price_cents: c.price_cents }));
  const plan = planSizeFold(sourceItem, sourceChoices);

  if (!apply) return { remainingGroups, sizeFoldPlan: plan };

  if (plan.retiresOriginal) {
    const insertRows = plan.actions
      .filter(a => a.kind === 'explode_insert')
      .map(a => ({ menu_id: item.menu_id, name: a.name, category: a.category, description: a.description, price_cents: a.price_cents, size_label: a.size_label, active: true, source: 'manual' }));
    const inserted = await supabase('POST', 'menu_items', insertRows, 'return=representation');
    if (!inserted || inserted.length !== insertRows.length) { console.error(`    FAILED size-fold insert for "${item.name}"`); return { remainingGroups, sizeFoldPlan: plan }; }
    // return=representation so a successful-but-empty-body ambiguity (PATCH's
    // default Prefer is return=minimal, a 204 with no body) can't be
    // misread as the same `null` the helper returns on a real HTTP error.
    const retired = await supabase('PATCH', `menu_items?id=eq.${item.id}`, { active: false }, 'return=representation');
    if (!retired || retired.length !== 1) console.error(`    FAILED to retire original "${item.name}" after size-fold`);
  } else if (plan.actions[0]?.kind === 'singleton_update') {
    const updated = await supabase('PATCH', `menu_items?id=eq.${item.id}`, { size_label: plan.actions[0].size_label }, 'return=representation');
    if (!updated || updated.length !== 1) console.error(`    FAILED singleton size_label update for "${item.name}"`);
  }

  return { remainingGroups, sizeFoldPlan: plan };
}

async function writeItem(menuItemId, groupRows) {
  let written = 0;
  for (const g of groupRows) {
    const import_key = g.name.toLowerCase().trim();
    const groupBody = {
      menu_item_id: menuItemId, name: g.name, required: g.required,
      min_select: g.min_select, max_select: g.max_select, display_order: 0,
      import_key, kind: g.kind, provenance: g.provenance, source_span: g.source_span,
    };
    const result = await supabase('POST', 'option_groups', groupBody,
      'return=representation,resolution=ignore-duplicates');
    if (!result || !result[0]) { console.error(`    FAILED group "${g.name}"`); continue; }
    const groupId = result[0].id;
    const choiceRows = g.choices.map((c, i) => ({
      option_group_id: groupId, name: c.name, display_name: c.name,
      price_cents: c.price_cents, is_default: c.is_default, display_order: i,
      import_key: c.name.toLowerCase().trim(), provenance: 'stated', source_span: c.source_span,
    }));
    if (choiceRows.length) {
      const cresult = await supabase('POST', 'option_choices', choiceRows,
        'return=representation,resolution=ignore-duplicates');
      if (cresult === null) { console.error(`    FAILED choices for "${g.name}"`); continue; }
    }
    written++;
  }
  return written;
}

async function main() {
  const matches = JSON.parse(fs.readFileSync(MATCHES_FILE, 'utf8'));
  const entries = Object.entries(matches).slice(0, LIMIT);
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${entries.length} matched items (of ${Object.keys(matches).length} total matches)`);

  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });

  const extractLog = [];
  let totalGroups = 0, totalChoices = 0, itemsWithGroups = 0, itemsNoModal = 0, itemsSizeFolded = 0;

  for (const [menuItemId, match] of entries) {
    process.stdout.write(`  [${match.category}] ${match.db_name} (slice#${match.slice_id}) ... `);
    let result;
    try {
      result = await extractProduct(page, match.slice_name, match.slice_id);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      extractLog.push({ menuItemId, match, error: e.message });
      await sleep(jitter(1500, 1500));
      continue;
    }
    if (result.noModal) {
      itemsNoModal++;
      console.log('no modal (no configurable options)');
      extractLog.push({ menuItemId, match, groups: [], noModal: true });
      await sleep(jitter(1500, 1500));
      continue;
    }
    let groupRows = buildGroupRows(match, result.groups);
    const { remainingGroups, sizeFoldPlan } = await foldSizeGroupIfPresent(menuItemId, groupRows, APPLY);
    if (sizeFoldPlan) {
      itemsSizeFolded++;
      const desc = sizeFoldPlan.retiresOriginal
        ? `folded into ${sizeFoldPlan.actions.length} size rows`
        : `size_label set (${sizeFoldPlan.actions[0]?.size_label})`;
      console.log(`  size-fold: ${desc}`);
      extractLog.push({ menuItemId, match, sizeFold: sizeFoldPlan });
    }
    groupRows = remainingGroups;

    const nChoices = groupRows.reduce((s, g) => s + g.choices.length, 0);
    if (groupRows.length) itemsWithGroups++;
    totalGroups += groupRows.length;
    totalChoices += nChoices;
    console.log(`${groupRows.length} group(s), ${nChoices} choice(s)`);
    extractLog.push({ menuItemId, match, groups: groupRows });

    if (APPLY && groupRows.length) {
      const written = await writeItem(menuItemId, groupRows);
      if (written !== groupRows.length) {
        console.error(`    partial write: ${written}/${groupRows.length} groups`);
      }
    }
    await sleep(jitter(2000, 2000)); // human page-load pace, jittered 2-4s
  }

  await browser.close();
  fs.writeFileSync(EXTRACT_OUT, JSON.stringify(extractLog, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(`Items processed: ${entries.length}`);
  console.log(`Items with >=1 option group: ${itemsWithGroups}`);
  console.log(`Items with no modal (no options): ${itemsNoModal}`);
  console.log(`Items size-folded (Size group converted to rows, not written as an option_group): ${itemsSizeFolded}`);
  console.log(`Total groups: ${totalGroups}, total choices: ${totalChoices}`);
  console.log(`Extract log written to ${EXTRACT_OUT}`);
  if (!APPLY) console.log('\nDRY RUN — pass --apply to write to the DB.');
}

main().catch(e => { console.error(e); process.exit(1); });
