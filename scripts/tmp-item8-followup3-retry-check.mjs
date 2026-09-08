#!/usr/bin/env node
// Item 8 follow-up 3 retry (2026-09-08): check current null slot_key count for Zio's
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SPRINTAI_CHAT_SUPABASE_URL,
  process.env.SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY,
);

const ZIOS_MENU_ID = "6c309547-dae1-4ac8-acb6-77f2354d6a59";

const { data: items, error: itemErr } = await supabase.from("menu_items").select("id").eq("menu_id", ZIOS_MENU_ID);
if (itemErr) { console.error("items error:", JSON.stringify(itemErr)); process.exit(1); }
const itemIds = items.map(i => i.id);
console.log("Zio item count:", itemIds.length);

let allGroups = [];
for (let i = 0; i < itemIds.length; i += 100) {
  const batch = itemIds.slice(i, i + 100);
  const { data, error } = await supabase
    .from("option_groups")
    .select("id, name, kind, slot_key")
    .is("slot_key", null)
    .in("menu_item_id", batch);
  if (error) { console.error("groups error:", JSON.stringify(error)); process.exit(1); }
  allGroups = allGroups.concat(data || []);
}

const counts = {};
allGroups.forEach(g => {
  const key = `${g.name}/${g.kind}`;
  counts[key] = (counts[key] || 0) + 1;
});
console.log("\nNull slot_key groups by name/kind:");
Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v}  ${k}`));
console.log("\nTotal null slot groups:", allGroups.length);
