#!/usr/bin/env node
// Item 8 follow-up 3 (2026-09-08): backfill slot_key='flavor' for the 4
// Zio's option_groups whose real choices are a genuine flavor selection —
// "Choose Sauce" on Bone In Wings / Boneless Wings (Plain/Hot/Mild/BBQ/
// Sweet & Hot Sauce — literal wing flavor) and on Pasta with Clam Sauce
// (Red/White Clam Sauce — a flavor variant of the sauce), plus "Choose
// Soda" on Soda (Coke/Diet Coke/Dr. Pepper/Ginger Ale/Sprite — soda
// flavor). All 4 confirmed required=true, min=1, max=1 (real single-select
// slot decisions, not optional add-ons) before this script ran — see
// BLOCKED.txt for the full investigation. Scoped to these 4 exact ids only
// (Zio's menu 6c309547-dae1-4ac8-acb6-77f2354d6a59) — Vito's/NJB untouched,
// no other Zio's group written. provenance set to 'inferred', matching this
// morning's (fa098f6) size/dressing/toppings backfill convention.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SPRINTAI_CHAT_SUPABASE_URL,
  process.env.SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY,
);

const GROUP_IDS = [
  "20d233c9-1e0a-42ea-aaf0-51db070ac5bd", // Choose Soda / Soda
  "bf60bbc7-a8e3-4f06-a8dc-3dee7301fac3", // Choose Sauce / Pasta with Clam Sauce
  "fcaec120-3341-4308-a04e-08b1d51454c8", // Choose Sauce / Bone In Wings
  "b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d", // Choose Sauce / Boneless Wings
];

const { data, error } = await supabase
  .from("option_groups")
  .update({ slot_key: "flavor", provenance: "inferred" })
  .in("id", GROUP_IDS)
  .select("id, name, menu_item_id, slot_key, provenance");

if (error) { console.error(error); process.exit(1); }
console.log(`Updated ${data.length} rows:`);
for (const r of data) console.log(`  ${r.id} ${r.name} -> slot_key=${r.slot_key} provenance=${r.provenance}`);
