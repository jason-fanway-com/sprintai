/**
 * F2 measurement (2026-09-08): reconstruct Zio's menuStr exactly as
 * buildSystemPrompt does, before and after the option-group dedup fix, to
 * quantify the byte savings independent of live latency noise.
 */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MENU_ID = "6c309547-dae1-4ac8-acb6-77f2354d6a59";

async function rest(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

interface Choice { id: string; name: string; price_cents: number; is_default: boolean; }
interface Group { id: string; name: string; required: boolean; min_select: number; max_select: number; menu_item_id: string; choices: Choice[]; }
interface Item { id: string; name: string; category: string; price_cents: number; description: string | null; option_groups: Group[]; }

const items: Item[] = (await rest(`menu_items?menu_id=eq.${MENU_ID}&select=id,name,category,price_cents,description`)).map((i: any) => ({ ...i, option_groups: [] }));
const itemIds = items.map(i => i.id);

// Batch option_groups fetch (avoid the documented ~150-id .in() failure mode).
const groups: Group[] = [];
for (let i = 0; i < itemIds.length; i += 100) {
  const batch = itemIds.slice(i, i + 100);
  const rows = await rest(`option_groups?menu_item_id=in.(${batch.join(',')})&select=id,name,required,min_select,max_select,menu_item_id`);
  groups.push(...rows.map((g: any) => ({ ...g, choices: [] })));
}
const groupIds = groups.map(g => g.id);
for (let i = 0; i < groupIds.length; i += 100) {
  const batch = groupIds.slice(i, i + 100);
  const rows = await rest(`option_choices?option_group_id=in.(${batch.join(',')})&select=id,name,price_cents,is_default,option_group_id`);
  for (const c of rows) {
    const g = groups.find(g => g.id === c.option_group_id);
    if (g) g.choices.push(c);
  }
}
const groupsByItem = new Map<string, Group[]>();
for (const g of groups) {
  if (!groupsByItem.has(g.menu_item_id)) groupsByItem.set(g.menu_item_id, []);
  groupsByItem.get(g.menu_item_id)!.push(g);
}
for (const item of items) item.option_groups = groupsByItem.get(item.id) ?? [];

function optionCardinality(g: Group): string {
  if (!g.required) return "optional";
  if (g.min_select === 1 && g.max_select === 1) return "required, choose 1";
  return `required, choose ${g.min_select}-${g.max_select}`;
}

function buildMenuStr(dedup: boolean): string {
  const menuByCategory: Record<string, Item[]> = {};
  for (const item of items) {
    const cat = item.category ?? "Other";
    if (!menuByCategory[cat]) menuByCategory[cat] = [];
    menuByCategory[cat].push(item);
  }
  const nameAppearances = new Map<string, number>();
  for (const [, its] of Object.entries(menuByCategory)) {
    for (const item of its) {
      const norm = item.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      nameAppearances.set(norm, (nameAppearances.get(norm) || 0) + 1);
    }
  }
  const duplicatedNames = new Set([...nameAppearances.entries()].filter(([, c]) => c > 1).map(([n]) => n));
  const optionGroupTextSeen = new Map<string, string>();

  return Object.entries(menuByCategory)
    .map(([cat, its]) => {
      const rows = its.map(item => {
        const norm = item.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        const label = duplicatedNames.has(norm) ? `${item.name} (${cat})` : item.name;
        const price = `$${(item.price_cents / 100).toFixed(2)}`;
        const desc = item.description ? ` - ${item.description}` : "";
        const groups = item.option_groups || [];
        if (groups.length > 0) {
          const groupLines = groups.map(g => {
            const reqLabel = optionCardinality(g);
            return `    → ${g.name} (${reqLabel}): ${g.choices.map(c => c.name + (c.is_default ? ' [default]' : '') + (c.price_cents > 0 ? ` +$${(c.price_cents / 100).toFixed(2)}` : '')).join(', ')}`;
          }).join('\n');
          if (dedup) {
            const baseName = item.name.replace(/\s*-\s*(?:Large|Medium|Small|Family)\b.*$/i, '').trim();
            const sigKey = `${cat}::${baseName}::${groupLines}`;
            const firstSeenLabel = optionGroupTextSeen.get(sigKey);
            if (firstSeenLabel) {
              return `  ID:${item.id} | ${label} ${price}${desc}\n    → Toppings/options: SAME CHOICES AND PRICES as "${firstSeenLabel}" above (this is the same dish, a different size) — use those exact option names with this ID.`;
            }
            optionGroupTextSeen.set(sigKey, label);
          }
          return `  ID:${item.id} | ${label} ${price}${desc}\n${groupLines}`;
        } else {
          return `  ID:${item.id} | ${label} ${price}${desc}`;
        }
      }).join("\n");
      return `${cat}:\n${rows}`;
    })
    .join("\n\n");
}

const before = buildMenuStr(false);
const after = buildMenuStr(true);
console.log(`items=${items.length} groups=${groups.length}`);
console.log(`BEFORE dedup: ${before.length} bytes`);
console.log(`AFTER  dedup: ${after.length} bytes`);
console.log(`reduction: ${before.length - after.length} bytes (${(100 * (before.length - after.length) / before.length).toFixed(1)}%)`);

// Diagnostics: how many items HAVE option_groups at all, and how many of
// those got deduped vs fell through to a full print?
const withGroups = items.filter(i => (i.option_groups?.length ?? 0) > 0);
console.log(`items with option_groups: ${withGroups.length} / ${items.length}`);
const seen2 = new Map<string, string>();
let dedupedCount = 0, printedCount = 0;
const menuByCategory: Record<string, Item[]> = {};
for (const item of items) {
  const cat = item.category ?? "Other";
  if (!menuByCategory[cat]) menuByCategory[cat] = [];
  menuByCategory[cat].push(item);
}
for (const [cat, its] of Object.entries(menuByCategory)) {
  for (const item of its) {
    const groups = item.option_groups || [];
    if (groups.length === 0) continue;
    const groupLines = groups.map(g => {
      const reqLabel = optionCardinality(g);
      return `    → ${g.name} (${reqLabel}): ${g.choices.map(c => c.name + (c.is_default ? ' [default]' : '') + (c.price_cents > 0 ? ` +$${(c.price_cents / 100).toFixed(2)}` : '')).join(', ')}`;
    }).join('\n');
    const baseName = item.name.replace(/\s*-\s*(?:Large|Medium|Small|Family)\b.*$/i, '').trim();
    const sigKey = `${cat}::${baseName}::${groupLines}`;
    if (seen2.has(sigKey)) { dedupedCount++; } else { seen2.set(sigKey, item.name); printedCount++; }
  }
}
console.log(`deduped rows: ${dedupedCount}, first-seen (printed in full) rows: ${printedCount}`);
