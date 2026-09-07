#!/usr/bin/env node
/**
 * Read real option-group/modifier data for Zio's Pizza (shop_id
 * 2cba7b51-211c-4437-8910-1af4dcc03498) via Firecrawl /scrape (JS rendering)
 * against its live public Slice ordering page — reusing scrape-shop's
 * existing Firecrawl plumbing per Jason's redirect away from the standalone
 * Playwright reader (scripts/load-zios-slice-options.mjs, preserved,
 * unused). No Slice API key extracted or reused, per the standing hard rule
 * — Firecrawl fetches the page as a normal browser visitor would.
 *
 * Source: https://slicelife.com/restaurants/pa/allentown/18104/zio-s-pizza-allentown/menu
 *
 * PARSING METHOD — deviation from the literal instruction, flagged in
 * BLOCKED.txt: rather than regex-parsing Firecrawl's markdown output, this
 * requests `formats:["rawHtml"]` and feeds that HTML into a local,
 * networkless Playwright page via `page.setContent()`, then runs the exact
 * DOM-structural extraction already validated against the live site (role=
 * radio/checkbox, stable id/aria attributes) — markdown text alone cannot
 * reliably distinguish a group header with no subtitle (e.g. "Make it")
 * from a same-shaped priceless choice line, since Slice's own group names
 * aren't a fixed enum ("Choose an option", "Choose Cheese", "Choose
 * Dressing" all occur). The DOM gives an unambiguous, already-bug-fixed
 * signal for the same output Jason specified. Firecrawl still does 100% of
 * the actual network fetch/JS rendering — Playwright here only parses a
 * static string, zero requests to Slice's site.
 *
 * PRICING CONVENTION — deviation from the literal instruction, flagged in
 * BLOCKED.txt: storing a required size group's absolute price ($19.99) as
 * option_choices.price_cents, as literally instructed, would conflict with
 * this repo's own deployed compiler (supabase/functions/_shared/
 * compile-menu.ts:243 — `price_delta_cents: c.price_cents`, and :262
 * `base_price_cents: item.price_cents` — added together for a real order
 * total). Storing absolute prices there would double-charge every sized
 * item the moment compile-menu runs. This script stores a DELTA (choice
 * price minus the item's own base price_cents) for every group, matching
 * the compiler's real, load-bearing semantics — same convention already
 * used by every other shop's hand-built option_choices rows in this DB.
 *
 * provenance='stated' + source_span = the actual rendered row text, for
 * every group/choice row, per migration 113's model.
 *
 * Usage:
 *   node scripts/load-zios-firecrawl-options.mjs                 # dry run
 *   node scripts/load-zios-firecrawl-options.mjs --apply          # writes to DB
 *   node scripts/load-zios-firecrawl-options.mjs --apply --limit=5
 */
import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SUPABASE_URL = 'https://rvdqfxtrskxekfkqnegx.supabase.co';
const MENU_URL = 'https://slicelife.com/restaurants/pa/allentown/18104/zio-s-pizza-allentown/menu';
const MATCHES_FILE = process.env.MATCHES_FILE || '/tmp/zios/matches.json';
const EXTRACT_OUT = '/tmp/zios/zios-firecrawl-extract.json';
const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

function loadEnvFile(p) {
  const out = {};
  const txt = fs.readFileSync(p, 'utf8');
  for (let line of txt.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    line = line.replace(/^export\s+/, '');
    const m = line.match(/^(\S+)\s*=\s*(.+)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/^["']|["']$/g, '').replace(/;$/, '');
    out[m[1].trim()] = v;
  }
  return out;
}

function getFirecrawlKey() {
  const env = loadEnvFile(path.join(os.homedir(), '.openclaw-sprintai/po-inbox/firecrawl.env'));
  const key = env['FIRECRAWL_API_KEY'];
  if (!key) throw new Error('FIRECRAWL_API_KEY not found in po-inbox/firecrawl.env');
  return key; // never logged, never written anywhere below
}

function getSupabaseKey() {
  const env = loadEnvFile(path.join(os.homedir(), '.openclaw/.secrets'));
  const key = env['SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY'];
  if (!key) throw new Error('SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY not found');
  return key;
}

async function supabase(method, pathAndQuery, body, prefer) {
  const key = getSupabaseKey();
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

let firecrawlRequestCount = 0;
async function firecrawlScrape(url) {
  const key = getFirecrawlKey();
  firecrawlRequestCount++;
  const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, formats: ['rawHtml'], waitFor: 8000 }),
  });
  if (res.status === 429) return { rateLimited: true };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const data = await res.json();
  if (!data.success) return { error: 'firecrawl success=false' };
  return { html: data.data?.rawHtml || '' };
}

function parsePriceCents(text) {
  const m = text.match(/([+-]?)\$\s*([\d,]+\.\d{2})/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * Math.round(parseFloat(m[2].replace(/,/g, '')) * 100);
}

// Runs inside the local (networkless) page — identical logic to, and
// validated via, the live-browser reader (scripts/load-zios-slice-options.mjs).
function extractGroupsFromDialog() {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return null;
  const headers = Array.from(dialog.querySelectorAll(
    '#product-group-selections-header, [id^="selection-category-"]'
  ));
  const groups = [];
  for (const header of headers) {
    if (header.id === 'notes-for-kitchen-label') continue;
    const children = Array.from(header.children);
    const groupName = (children[0]?.textContent || '').trim();
    const subtitle = (children[1]?.textContent || '').trim() || null;
    const choicesContainer = header.nextElementSibling;
    if (!choicesContainer) continue;
    const choiceEls = Array.from(choicesContainer.querySelectorAll('[role="radio"], [role="checkbox"]'));
    if (choiceEls.length === 0) continue;
    const isRadio = choiceEls[0].getAttribute('role') === 'radio';
    const choices = choiceEls.map((el, idx) => {
      const row = el.parentElement;
      const rowText = (row?.textContent || '').trim();
      const ariaChecked = el.getAttribute('aria-checked') === 'true';
      return { rowText, ariaChecked, displayOrder: idx };
    });
    let required = false, minSelectStated = null, maxSelectStated = null;
    if (isRadio) {
      required = choicesContainer.getAttribute?.('aria-required') === 'true';
    } else if (subtitle) {
      required = /^required/i.test(subtitle);
      const upTo = subtitle.match(/select up to (\d+)/i);
      if (upTo) maxSelectStated = parseInt(upTo[1], 10);
      const atLeast = subtitle.match(/select at least (\d+)/i);
      if (atLeast) minSelectStated = parseInt(atLeast[1], 10);
    }
    groups.push({
      groupName, subtitle, isRadio, required, minSelectStated, maxSelectStated,
      sourceSpan: subtitle ? `${groupName} — ${subtitle}` : groupName,
      choices,
    });
  }
  return groups;
}

function buildGroupRows(match, rawGroups, basePriceCents) {
  const out = [];
  for (const g of rawGroups) {
    const parsedChoices = g.choices.map(c => {
      const priceCents = parsePriceCents(c.rowText);
      let name = c.rowText.replace(/[+-]?\$\s*[\d,]+\.\d{2}\s*$/, '').trim();
      return { name, priceCents, ariaChecked: c.ariaChecked, displayOrder: c.displayOrder, sourceSpan: c.rowText };
    });
    // DELTA convention for every group (including required size groups) —
    // see file header for why this deviates from the literal instruction.
    const choices = parsedChoices.map(c => ({
      name: c.name,
      price_cents: c.priceCents != null ? (g.isRadio ? c.priceCents - basePriceCents : c.priceCents) : 0,
      is_default: c.ariaChecked,
      display_order: c.displayOrder,
      source_span: c.sourceSpan,
    }));
    const required = g.required;
    const min_select = required ? (g.minSelectStated ?? 1) : (g.minSelectStated ?? 0);
    const max_select = g.isRadio ? 1 : (g.maxSelectStated ?? choices.length);
    out.push({
      name: g.groupName, required, min_select, max_select,
      kind: required ? 'slot' : 'modifier', provenance: 'stated', source_span: g.sourceSpan,
      choices,
    });
  }
  return out;
}

// Hard-abort on any write failure — per Jason's standing instruction. A
// partial write is a hidden defect, not a recoverable state. The choice is
// deliberate: full stop on first failure so the error is isolated and
// diagnosable, rather than silently skipping groups/choices and producing a
// menu that passes QA but has missing modifiers.
class WriteAbortError extends Error {
  constructor(msg, details) {
    super(msg);
    this.name = 'WriteAbortError';
    this.details = details;
  }
}

async function writeItem(menuItemId, groupRows) {
  let written = 0;
  let firstGroupId = null;
  for (const g of groupRows) {
    const import_key = g.name.toLowerCase().trim();
    const groupBody = {
      menu_item_id: menuItemId, name: g.name, required: g.required,
      min_select: g.min_select, max_select: g.max_select, display_order: 0,
      import_key, kind: g.kind, provenance: g.provenance, source_span: g.source_span,
    };

    // Migration 115 added full UNIQUE constraints on
    // option_groups(menu_item_id, import_key) and
    // option_choices(option_group_id, import_key) so PostgREST's
    // on_conflict+resolution=ignore-duplicates works — the original
    // partial unique indexes from migration 010 weren't recognized by
    // PostgreSQL for ON CONFLICT targeting (returned 42P10).
    let result = await supabase(
      'POST', `option_groups?on_conflict=menu_item_id,import_key`, groupBody,
      'return=representation,resolution=ignore-duplicates',
    );
    if (result === null) {
      throw new WriteAbortError(
        `option_groups write FAILED for "${g.name}" (item ${menuItemId})`,
        { menuItemId, groupName: g.name, import_key }
      );
    }
    let groupId = result[0]?.id ?? null;
    if (!groupId) {
      throw new WriteAbortError(
        `option_groups returned no id for "${g.name}" (item ${menuItemId}) — insert likely failed or conflict resolution returned empty`,
        { menuItemId, groupName: g.name, import_key, resultLength: result?.length }
      );
    }
    if (firstGroupId === null) firstGroupId = groupId;

    const choiceRows = g.choices.map((c, i) => ({
      option_group_id: groupId, name: c.name, display_name: c.name,
      price_cents: c.price_cents, is_default: c.is_default, display_order: i,
      import_key: c.name.toLowerCase().trim(), provenance: 'stated', source_span: c.source_span,
    }));
    if (choiceRows.length) {
      const cresult = await supabase(
        'POST', `option_choices?on_conflict=option_group_id,import_key`, choiceRows,
        'return=representation,resolution=ignore-duplicates',
      );
      if (cresult === null) {
        throw new WriteAbortError(
          `option_choices write FAILED for group "${g.name}" (${choiceRows.length} choices, group ${groupId})`,
          { groupId, groupName: g.name, choiceCount: choiceRows.length }
        );
      }
    }
    written++;
  }
  return { written, firstGroupId };
}

async function main() {
  const startedAt = Date.now();
  const matches = JSON.parse(fs.readFileSync(MATCHES_FILE, 'utf8'));
  let entries = Object.entries(matches).slice(0, LIMIT);

  let alreadyDone = new Set();
  if (APPLY) {
    const ids = entries.map(([id]) => id).join(',');
    const existing = await supabase('GET', `option_groups?menu_item_id=in.(${ids})&select=menu_item_id`);
    alreadyDone = new Set((existing || []).map(r => r.menu_item_id));
    if (alreadyDone.size) {
      console.log(`Resuming: ${alreadyDone.size} item(s) already have option_groups from a prior run — skipping re-scrape.`);
      entries = entries.filter(([id]) => !alreadyDone.has(id));
    }
  }
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${entries.length} matched items to process (of ${Object.keys(matches).length} total matches, ${alreadyDone.size} already done)`);

  let browser = await chromium.launch();

  // Per-item page creation with browser-context crash recovery. A shared page
  // died mid-loop at Hawaiian Pizza (apply7) and took the entire run. This
  // creates a fresh page per item and, on "closed/destroyed" errors, relaunches
  // the browser and retries that single item — one crash costs one extra scrape,
  // not the whole session.
  async function parseHtmlWithBrowser(html) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let pg;
      try {
        pg = await browser.newPage();
        await pg.setContent(html, { waitUntil: 'domcontentloaded' });
        const groups = await pg.evaluate(extractGroupsFromDialog);
        await pg.close();
        return groups;
      } catch (e) {
        if (pg) { try { await pg.close(); } catch (_) {} }
        if (attempt === 0 && /closed|destroyed/i.test(e.message)) {
          console.log('  [browser] context crashed — relaunching and retrying...');
          try { await browser.close(); } catch (_) {}
          browser = await chromium.launch();
          continue;
        }
        throw e;
      }
    }
  }

  const extractLog = [];
  let attempted = 0, scraped = 0, failed = 0, rateLimited = 0;
  let totalGroups = 0, totalChoices = 0, itemsWithGroups = 0, itemsNoDialog = 0;

  for (const [menuItemId, match] of entries) {
    attempted++;
    process.stdout.write(`  [${match.category}] ${match.db_name} (slice#${match.slice_id}) ... `);
    const url = `${MENU_URL}?view_product=${match.slice_id}`;
    let result = await firecrawlScrape(url);

    if (result.rateLimited) {
      // Free-plan cap is 12 req/min. Retry with backoff up to 3 times.
      const maxRetries = 3;
      let retried = false;
      for (let r = 0; r < maxRetries; r++) {
        const waitMs = 6000 * (r + 1);
        console.log(`rate-limited, retrying in ${waitMs / 1000}s (attempt ${r + 1}/${maxRetries})...`);
        await new Promise(res => setTimeout(res, waitMs));
        const retryResult = await firecrawlScrape(url);
        if (!retryResult.rateLimited && !retryResult.error) {
          result = retryResult;
          retried = true;
          break;
        }
        if (retryResult.rateLimited) {
          console.log(`  still rate-limited`);
        } else {
          console.log(`  retry error: ${retryResult.error}`);
        }
      }
      if (!retried) {
        rateLimited++;
        console.log(`RATE LIMITED after ${maxRetries} retries — stopping.`);
        extractLog.push({ menuItemId, match, error: 'rate_limited_exhausted' });
        break;
      }
    }
    if (result.error) {
      failed++;
      console.log(`FAILED: ${result.error}`);
      extractLog.push({ menuItemId, match, error: result.error });
      continue;
    }
    scraped++;
    const rawGroups = await parseHtmlWithBrowser(result.html);
    if (!rawGroups) {
      itemsNoDialog++;
      console.log('no dialog in rendered HTML (no configurable options)');
      extractLog.push({ menuItemId, match, groups: [], noDialog: true });
      continue;
    }
    // STANDING CHECK — Slice is live restaurant pricing, our DB copy is a
    // scrape of unknown age. If they disagree, trust Slice: self-heal the
    // DB row's base price and use the Slice figure (not the stale one) for
    // every delta computed below. Prevents the exact silent-drift class of
    // bug found manually in 5 items on 2026-09-07 (e.g. Brooklyn Pizza 18
    // priced $24.99 in our DB vs $23.99 live on Slice).
    const sliceBaseCents = Math.round(match.slice_price * 100);
    let basePriceCents = match.db_price_cents;
    if (APPLY && sliceBaseCents !== match.db_price_cents) {
      console.log(`  PRICE DRIFT: DB had $${(match.db_price_cents / 100).toFixed(2)}, Slice states $${(sliceBaseCents / 100).toFixed(2)} for "${match.db_name}" — updating DB to Slice price.`);
      const healRes = await supabase('PATCH', `menu_items?id=eq.${menuItemId}`, { price_cents: sliceBaseCents }, 'return=representation');
      if (healRes === null || healRes.length === 0) {
        throw new WriteAbortError(`price self-heal FAILED for "${match.db_name}" (item ${menuItemId})`, { menuItemId, sliceBaseCents });
      }
      basePriceCents = sliceBaseCents;
    }
    const groupRows = buildGroupRows(match, rawGroups, basePriceCents);
    const nChoices = groupRows.reduce((s, g) => s + g.choices.length, 0);
    if (groupRows.length) itemsWithGroups++;
    totalGroups += groupRows.length;
    totalChoices += nChoices;
    console.log(`${groupRows.length} group(s), ${nChoices} choice(s)`);
    extractLog.push({ menuItemId, match, groups: groupRows });

    if (APPLY && groupRows.length) {
      try {
        const { written, firstGroupId } = await writeItem(menuItemId, groupRows);
        // After-first-write self-check: SELECT the first group back by id to
        // prove the write actually persisted. Catches phantom-success scenarios
        // (e.g. schema routing, view-layer filtering) that return HTTP 200 but
        // silently discard the row. Abort immediately — do not continue writing
        // 100+ items into a broken state.
        if (firstGroupId) {
          const readBack = await supabase('GET', `option_groups?id=eq.${firstGroupId}&select=id`);
          if (!readBack || readBack.length === 0) {
            throw new WriteAbortError(
              `after-first-write self-check FAILED: wrote group id=${firstGroupId} (item ${menuItemId}) but SELECT by id returned empty — row did not persist`,
              { menuItemId, firstGroupId }
            );
          }
          // Self-check passed — log only once (first item of the run)
          if (itemsWithGroups === 1) {
            console.log(`  [self-check] id=${firstGroupId} confirmed in DB ✓`);
          }
        }
      } catch (e) {
        if (e.name === 'WriteAbortError') {
          console.error(`\nHARD-ABORT: ${e.message}`);
          if (e.details) console.error(`  details: ${JSON.stringify(e.details)}`);
        }
        await browser.close();
        fs.writeFileSync(EXTRACT_OUT, JSON.stringify(extractLog, null, 2));
        throw e; // re-throw — main's catch handler will exit(1)
      }
    }
    // Firecrawl free plan: 12 req/min. 5.5s pacing = ~10.9 req/min, safe
    // margin below the cap. The 1.5s gap was too tight and hit 429 at 7 requests.
    await new Promise(r => setTimeout(r, 5500));
  }

  await browser.close();
  const elapsedMs = Date.now() - startedAt;
  fs.writeFileSync(EXTRACT_OUT, JSON.stringify(extractLog, null, 2));

  console.log('\n=== SUMMARY (exact, not rounded) ===');
  console.log(`Products attempted: ${attempted}`);
  console.log(`Scraped successfully: ${scraped}`);
  console.log(`Failed: ${failed}`);
  console.log(`Rate-limited (stopped): ${rateLimited}`);
  console.log(`Items with >=1 option group: ${itemsWithGroups}`);
  console.log(`Items with no dialog (no options): ${itemsNoDialog}`);
  console.log(`Total groups: ${totalGroups}, total choices: ${totalChoices}`);
  console.log(`Total Firecrawl requests: ${firecrawlRequestCount}`);
  console.log(`Total wall-clock time: ${elapsedMs}ms (${(elapsedMs / 1000).toFixed(1)}s)`);
  console.log(`Extract log written to ${EXTRACT_OUT}`);
  if (!APPLY) console.log('\nDRY RUN — pass --apply to write to the DB.');
}

main().catch(e => { console.error(e); process.exit(1); });
