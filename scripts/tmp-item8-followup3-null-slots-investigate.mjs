#!/usr/bin/env node
// Item 8 follow-up 3 (2026-09-08): read-only investigation of Zio's
// option_groups with slot_key still null AND kind='slot' (the 157 the PO's
// qa_ro query flagged as the real defect — modifier-kind groups staying
// null is expected and out of scope here). Prints group name breakdown,
// then a representative sample of choices per group name so the "Type"
// question (is it one thing or several?) and the "Choose Pasta" slot-vs-
// modifier split can be answered from real data, not a guess.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SPRINTAI_CHAT_SUPABASE_URL,
  process.env.SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY,
);

const ZIOS_MENU_ID = "6c309547-dae1-4ac8-acb6-77f2354d6a59";

async function fetchAll(table, select, filter) {
  let all = [];
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    all = all.concat(data ?? []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

const menuItems = await fetchAll(
  "menu_items", "id, name, category",
  q => q.eq("menu_id", ZIOS_MENU_ID),
);
const itemById = new Map(menuItems.map(i => [i.id, i]));
const itemIds = menuItems.map(i => i.id);

const groups = [];
for (let i = 0; i < itemIds.length; i += 200) {
  const batch = itemIds.slice(i, i + 200);
  const { data, error } = await supabase
    .from("option_groups")
    .select("id, menu_item_id, name, kind, slot_key, provenance")
    .in("menu_item_id", batch);
  if (error) throw error;
  groups.push(...data);
}

const nullSlotGroups = groups.filter(g => g.slot_key === null && g.kind === "slot");
console.log(`Total Zio's option_groups: ${groups.length}`);
console.log(`kind='slot' with slot_key=null: ${nullSlotGroups.length}`);
console.log(`kind='modifier' with slot_key=null: ${groups.filter(g => g.slot_key === null && g.kind === "modifier").length} (expected, out of scope)`);

const byName = new Map();
for (const g of nullSlotGroups) {
  const arr = byName.get(g.name) ?? [];
  arr.push(g);
  byName.set(g.name, arr);
}
console.log("\n=== Breakdown by raw group name (kind=slot, slot_key=null) ===");
for (const [name, arr] of [...byName.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  "${name}": ${arr.length}`);
}

const groupIds = nullSlotGroups.map(g => g.id);
const choices = [];
for (let i = 0; i < groupIds.length; i += 200) {
  const batch = groupIds.slice(i, i + 200);
  const { data, error } = await supabase
    .from("option_choices")
    .select("id, option_group_id, name, price_cents, is_default")
    .in("option_group_id", batch);
  if (error) throw error;
  choices.push(...data);
}
const choicesByGroup = new Map();
for (const c of choices) {
  const arr = choicesByGroup.get(c.option_group_id) ?? [];
  arr.push(c);
  choicesByGroup.set(c.option_group_id, arr);
}

console.log("\n=== Sample groups per name (up to 12 each, with item name/category + choices) ===");
for (const [name, arr] of byName.entries()) {
  console.log(`\n--- "${name}" (${arr.length} groups) ---`);
  const sampleSize = name === "Type" ? 40 : Math.min(arr.length, 12);
  for (const g of arr.slice(0, sampleSize)) {
    const item = itemById.get(g.menu_item_id);
    const gChoices = (choicesByGroup.get(g.id) ?? []).map(c => `${c.name}${c.price_cents ? ` (+${c.price_cents}c)` : ""}${c.is_default ? " [default]" : ""}`);
    console.log(`  [${item?.category ?? "?"}] ${item?.name ?? g.menu_item_id}: ${gChoices.join(" | ")}`);
  }
}
