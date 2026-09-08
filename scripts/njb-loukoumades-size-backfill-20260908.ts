/**
 * NJB Loukoumades size backfill (2026-09-08, PO-approved plan ec35040, item B).
 *
 * NJB is source='pdf', never went through the Slice importer, so its size
 * variants never got normalize.ts's "Base - SizeLabel" dash convention or a
 * populated size_label column -- parse-menu-pdf instead left the size as a
 * "(Small)"/"(Large)" parenthetical suffix inside `name`, with size_label
 * NULL. normalize.ts's stripSizeSuffix() only fires when size_label is
 * ALREADY populated and name ends in "<base> - <size_label>" -- neither is
 * true today, so these 18 rows (9 flavors x Small/Large, live-counted;
 * plan ec35040's "~20-23" was an estimate, corrected here against the real
 * data) never fold into one product, and normalize.ts/archetypes.ts's
 * SIBLING_SOURCED_SLOTS size logic treats each size as its own singleton
 * item with no size question ever asked or answerable -- "large loukoumades"
 * has no clean match. Fix: rewrite `name` to the dash convention and
 * populate `size_label`, exactly what Vito's own Slice-sourced rows already
 * look like, so the EXISTING fold logic (unchanged) picks these up on the
 * next compile.
 *
 * SCOPE: category='Loukoumades' only. Explicitly does NOT touch "Half Dozen
 * Bagels" / "One Dozen Bagels" (a different category entirely -- Bagels/
 * Bagel With -- and per PO decision in the dispatch, those are quantity
 * variants, not size, and must stay separate items regardless).
 *
 * Only writes `name` and `size_label`. Does NOT touch product_key,
 * display_name, bot_state, ask_plan, or lexicon -- those are compile-menu's
 * write-back columns exclusively (see supabase/functions/compile-menu/
 * index.ts) and only take on the new fold once a compile-menu run
 * re-normalizes these rows. No compile-menu invocation happens here or as
 * part of this task -- NJB compiles have historically been run by the PO
 * himself (BLOCKED.txt, "the PO's authorized 'ran the compile myself'
 * action"), not unilaterally by an agent; flagging as a follow-up.
 *
 * Dry-run by default, same convention as refresh-owner-questions.ts /
 * njb-infer-only-20260907.ts. Pass --apply to write.
 *
 * Usage: set -a; source ~/.openclaw/.secrets; set +a
 *        SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *        SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *        deno run --allow-env --allow-net scripts/njb-loukoumades-size-backfill-20260908.ts [--apply]
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Run: set -a; source ~/.openclaw/.secrets; set +a");
  Deno.exit(1);
}

const NJB_SHOP_ID = "b0000000-0000-0000-0000-000000000001";
const APPLY = Deno.args.includes("--apply");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const SIZE_SUFFIX_RE = /^(.*?)\s*\((Small|Large)\)\s*$/i;

interface Row {
  id: string;
  name: string;
  size_label: string | null;
  active: boolean;
}

const { data: menus, error: menuErr } = await supabase
  .from("menus").select("id").eq("shop_id", NJB_SHOP_ID)
  .order("created_at", { ascending: false }).limit(1);
if (menuErr || !menus?.[0]) {
  console.error("no menu found for NJB shop_id", menuErr);
  Deno.exit(1);
}
const menuId = menus[0].id;

const { data: rows, error } = await supabase
  .from("menu_items")
  .select("id, name, size_label, active")
  .eq("menu_id", menuId)
  .eq("category", "Loukoumades")
  .eq("active", true)
  .order("name") as { data: Row[] | null; error: unknown };
if (error) { console.error(error); Deno.exit(1); }

console.log(`shop_id=${NJB_SHOP_ID} menu_id=${menuId} mode=${APPLY ? "APPLY" : "dry-run"}`);
console.log(`Loukoumades active rows: ${rows?.length ?? 0}\n`);

const updates: { id: string; before_name: string; after_name: string; size_label: string }[] = [];
const skipped: { id: string; name: string; reason: string }[] = [];

for (const row of rows ?? []) {
  const m = row.name.match(SIZE_SUFFIX_RE);
  if (!m) {
    skipped.push({ id: row.id, name: row.name, reason: "no (Small)/(Large) suffix found" });
    continue;
  }
  const base = m[1].trim();
  // Title-case size label to match Vito's own convention ("Large", not "LARGE").
  const sizeLabel = m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
  const newName = `${base} - ${sizeLabel}`;
  if (row.size_label !== null) {
    skipped.push({ id: row.id, name: row.name, reason: `size_label already set (${row.size_label}) -- not touching` });
    continue;
  }
  updates.push({ id: row.id, before_name: row.name, after_name: newName, size_label: sizeLabel });
}

for (const u of updates) {
  console.log(`  UPDATE ${u.id}: "${u.before_name}" -> name="${u.after_name}", size_label="${u.size_label}"`);
}
for (const s of skipped) {
  console.log(`  SKIP   ${s.id}: "${s.name}" -- ${s.reason}`);
}
console.log(`\nplan: ${updates.length} to update, ${skipped.length} skipped`);

if (!APPLY) {
  console.log("\nDry run only — no writes made. Re-run with --apply to execute this plan.");
  Deno.exit(0);
}

let applied = 0;
for (const u of updates) {
  const { error: updErr } = await supabase
    .from("menu_items")
    .update({ name: u.after_name, size_label: u.size_label })
    .eq("id", u.id);
  if (updErr) {
    console.error(`FAILED to update ${u.id}:`, updErr);
    continue;
  }
  applied++;
}
console.log(`\nApplied: ${applied} updated.`);
console.log("DONE. No product_key, display_name, bot_state, ask_plan, or lexicon rows were touched -- those require a compile-menu run.");
