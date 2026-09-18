// Same minimal in-memory Supabase-like mock as apply.test.ts (kept local
// rather than shared — the two files' fake needs are small and diverging is
// cheaper than coupling them through an extra shared test helper).
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectSharedModifierSets } from "../_shared/modifier-set-detect.ts";
import { syncModifierSets } from "./sync-modifier-sets.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

class FakeBuilder implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Array<[string, unknown]> = [];
  private inFilter: [string, unknown[]] | null = null;
  private op: "select" | "update" | "insert" | "delete" = "select";
  private payload: Row | null = null;
  private wantSingle = false;

  constructor(private store: Record<string, Row[]>, private table: string) {}

  select(_cols?: string) { return this; }
  eq(col: string, val: unknown) { this.filters.push([col, val]); return this; }
  in(col: string, vals: unknown[]) { this.inFilter = [col, vals]; return this; }
  update(patch: Row) { this.op = "update"; this.payload = patch; return this; }
  insert(row: Row) { this.op = "insert"; this.payload = row; return this; }
  delete() { this.op = "delete"; return this; }
  single() { this.wantSingle = true; return this; }
  maybeSingle() { this.wantSingle = true; return this; }

  private matched(): Row[] {
    const rows = this.store[this.table] ?? (this.store[this.table] = []);
    let out = rows;
    if (this.filters.length) out = out.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.inFilter) {
      const [c, vals] = this.inFilter;
      out = out.filter((r) => vals.includes(r[c]));
    }
    return out;
  }

  private resolve(): { data: unknown; error: unknown } {
    if (this.op === "insert") {
      const row: Row = { id: crypto.randomUUID(), ...this.payload };
      (this.store[this.table] ?? (this.store[this.table] = [])).push(row);
      return { data: this.wantSingle ? row : [row], error: null };
    }
    if (this.op === "update") {
      const rows = this.matched();
      for (const r of rows) Object.assign(r, this.payload);
      return { data: rows, error: null };
    }
    if (this.op === "delete") {
      const toDelete = new Set(this.matched());
      this.store[this.table] = (this.store[this.table] ?? []).filter((r) => !toDelete.has(r));
      return { data: null, error: null };
    }
    const rows = this.matched();
    if (this.wantSingle) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

function makeFakeSupabase(seed: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = { ...seed };
  return {
    from: (table: string) => new FakeBuilder(store, table),
    rows: (table: string) => store[table] ?? [],
  };
}

// Test-only cast: FakeBuilder resolves `data` as `unknown` (it mirrors the
// real Supabase client's untyped surface), but every insert below is a
// single-row `.select("id").single()` call, so `{ id: string }` always holds.
function asIdRow(data: unknown): { id: string } {
  return data as { id: string };
}

const SHOP_ID = "shop-1";
const MENU_ID = "menu-1";

Deno.test("syncModifierSets: 20 pizzas sharing an identical Toppings group link to ONE modifier_sets row, existing option_groups/option_choices untouched otherwise", async () => {
  const supabase = makeFakeSupabase();

  const toppingsChoiceNames = ["Pepperoni", "Mushroom", "Onion"];
  const items = [];
  const itemIdByImportKey = new Map<string, string>();

  for (let i = 0; i < 20; i++) {
    const itemImportKey = `pizza|pie ${i}|`;
    const { data: itemData } = await supabase.from("menu_items").insert({ menu_id: MENU_ID, import_key: itemImportKey }).select("id").single();
    const item = asIdRow(itemData);
    itemIdByImportKey.set(itemImportKey, item.id);

    const { data: groupData } = await supabase.from("option_groups").insert({
      menu_item_id: item.id, name: "Toppings", import_key: "add-ons",
    }).select("id").single();
    const group = asIdRow(groupData);

    const choices = toppingsChoiceNames.map((name) => ({
      importKey: name.toLowerCase(), name, priceCents: 200, displayOrder: 0,
    }));
    for (const c of choices) {
      await supabase.from("option_choices").insert({
        option_group_id: group.id, name: c.name, import_key: c.importKey,
      });
    }

    items.push({
      importKey: itemImportKey, name: `Pie ${i}`, description: "", priceCents: 1500,
      category: "Pizza", sizeLabel: "", displayOrder: i,
      groups: [{
        importKey: "add-ons", name: "Toppings", required: false, minSelect: 0, maxSelect: 99,
        displayOrder: 0, choices,
      }],
      promptFor: "", upsell: "add extra toppings", modifiersJson: null,
    });
  }

  // deno-lint-ignore no-explicit-any
  const candidates = detectSharedModifierSets(items as any);
  assertEquals(candidates.length, 1, "detection itself should find exactly one shared set");

  const result = await syncModifierSets(supabase, SHOP_ID, MENU_ID, candidates, itemIdByImportKey);

  assertEquals(result.setsCreated, 1);
  assertEquals(result.groupsLinked, 20);
  assertEquals(result.choicesLinked, 60); // 20 items x 3 choices

  const sets = supabase.rows("modifier_sets");
  assertEquals(sets.length, 1);
  assertEquals(sets[0].name, "Toppings");
  assertEquals(sets[0].shop_id, SHOP_ID);
  assertEquals(sets[0].menu_id, MENU_ID);

  const setChoices = supabase.rows("modifier_set_choices");
  assertEquals(setChoices.length, 3);

  const groups = supabase.rows("option_groups");
  assertEquals(groups.length, 20);
  for (const g of groups) assertEquals(g.set_id, sets[0].id);

  const choiceRows = supabase.rows("option_choices");
  assertEquals(choiceRows.length, 60);
  for (const c of choiceRows) assertExists(c.set_choice_id);

  // No new menu_items/option_groups/option_choices rows were created by this
  // sync step — same 20/20/60 counts as before it ran.
  assertEquals(supabase.rows("menu_items").length, 20);
});

Deno.test("syncModifierSets: re-running with unchanged input is idempotent (no duplicate set)", async () => {
  const supabase = makeFakeSupabase();
  const itemIdByImportKey = new Map<string, string>();
  const choices = [
    { importKey: "ranch", name: "Ranch", priceCents: 0, displayOrder: 0 },
    { importKey: "italian", name: "Italian", priceCents: 0, displayOrder: 1 },
  ];

  const items = [];
  for (let i = 0; i < 2; i++) {
    const key = `salad|s${i}|`;
    const { data: itemData } = await supabase.from("menu_items").insert({ menu_id: MENU_ID, import_key: key }).select("id").single();
    const item = asIdRow(itemData);
    itemIdByImportKey.set(key, item.id);
    const { data: groupData } = await supabase.from("option_groups").insert({ menu_item_id: item.id, import_key: "dressing" }).select("id").single();
    const group = asIdRow(groupData);
    for (const c of choices) {
      await supabase.from("option_choices").insert({ option_group_id: group.id, import_key: c.importKey, name: c.name });
    }
    items.push({
      importKey: key, name: `Salad ${i}`, description: "", priceCents: 900, category: "Salads",
      sizeLabel: "", displayOrder: i,
      groups: [{ importKey: "dressing", name: "Dressing", required: true, minSelect: 1, maxSelect: 1, displayOrder: 0, choices }],
      promptFor: "", upsell: "", modifiersJson: null,
    });
  }

  // deno-lint-ignore no-explicit-any
  const candidates = detectSharedModifierSets(items as any);
  await syncModifierSets(supabase, SHOP_ID, MENU_ID, candidates, itemIdByImportKey);
  await syncModifierSets(supabase, SHOP_ID, MENU_ID, candidates, itemIdByImportKey);

  assertEquals(supabase.rows("modifier_sets").length, 1, "a second run must not create a duplicate set");
  assertEquals(supabase.rows("modifier_set_choices").length, 2, "a second run must not duplicate the set's choices");
});
