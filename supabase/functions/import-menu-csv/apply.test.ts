// Backlog 0232fdb1 pin: an owner-edited menu_items row that drops out of one
// CSV import (deactivated) and reappears in the next stayed invisible
// (active: false) forever, because the owner_edited `continue` in the update
// loop bailed out before the reactivation write ever ran. Repro below follows
// Melvin's exact 4-step sequence against a mock Supabase client: import ->
// owner-edit -> import-without (deactivates) -> import-with (must reactivate
// AND must not clobber the owner's hand-typed content).
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { diffItems } from "../../../menu-pipeline/core/import-plan.ts";
import type { DesiredItem, ExistingItem } from "../../../menu-pipeline/core/import-plan.ts";
import { applyToUpdate, upsertItem } from "./apply.ts";

// ---- Minimal in-memory Supabase-like mock ----------------------------------
// Supports exactly the postgrest surface apply.ts touches: from/select/eq/in/
// update/insert/delete/single/maybeSingle, with `await` resolving directly
// off the chain (no real network/DB involved).

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

// ---- Fixtures ---------------------------------------------------------------

const CSV_ITEM_X: DesiredItem = {
  importKey: "entrees|buffalo wings|",
  name: "Buffalo Wings",
  description: "Crispy wings tossed in buffalo sauce",
  priceCents: 1299,
  category: "Entrees",
  sizeLabel: "",
  displayOrder: 0,
  groups: [],
  promptFor: "",
  upsell: "",
  modifiersJson: null,
};

const MENU_ID = "menu-1";

Deno.test("backlog 0232fdb1: owner-edited item reactivates on CSV return without losing owner's edits", async () => {
  const supabase = makeFakeSupabase();

  // Step 1: import a CSV — item X lands active.
  const itemId = await upsertItem(supabase, MENU_ID, CSV_ITEM_X, null);
  assertEquals(supabase.rows("menu_items")[0].active, true);

  // Step 2: owner hand-edits item X in the admin UI.
  const OWNER_NAME = "Buffalo Wings (Owner's Special Recipe)";
  const OWNER_PRICE = 1599;
  const OWNER_DESC = "Owner-added: extra sauce, no celery";
  await supabase.from("menu_items").update({
    owner_edited: true, name: OWNER_NAME, price_cents: OWNER_PRICE, description: OWNER_DESC,
  }).eq("id", itemId);

  // Step 3: re-import a CSV that drops item X -> deactivate (not delete).
  const existingAfterEdit: ExistingItem[] = [{ id: itemId!, importKey: CSV_ITEM_X.importKey, ownerEdited: true }];
  const diffWithout = diffItems([], existingAfterEdit);
  assertEquals(diffWithout.toDeactivate, [itemId]);
  await supabase.from("menu_items").update({ active: false }).in("id", diffWithout.toDeactivate);
  assertEquals(supabase.rows("menu_items")[0].active, false);

  // Step 4: re-import a CSV that has X again -> must reactivate AND must not
  // clobber the owner's hand-edited name/price/description.
  const diffWith = diffItems([CSV_ITEM_X], existingAfterEdit);
  assertEquals(diffWith.toUpdate.length, 1);
  assertEquals(diffWith.toUpdate[0].skippedOwnerEdited, true);

  const result = await applyToUpdate(supabase, MENU_ID, diffWith.toUpdate);

  const finalRow = supabase.rows("menu_items")[0];
  assertEquals(finalRow.active, true, "item present in the CSV must be reactivated even if owner-edited");
  assertEquals(finalRow.name, OWNER_NAME, "owner's hand-typed name must survive the re-import");
  assertEquals(finalRow.price_cents, OWNER_PRICE, "owner's hand-typed price must survive the re-import");
  assertEquals(finalRow.description, OWNER_DESC, "owner's hand-typed description must survive the re-import");
  assertNotEquals(finalRow.name, CSV_ITEM_X.name);

  // Counting semantics unchanged: owner-edited items count as skipped, not updated.
  assertEquals(result.skippedOwnerEdited, 1);
  assertEquals(result.updated, 0);
});

Deno.test("non-owner-edited items still get content updated AND reactivated", async () => {
  const supabase = makeFakeSupabase();
  const itemId = await upsertItem(supabase, MENU_ID, CSV_ITEM_X, null);
  await supabase.from("menu_items").update({ active: false }).eq("id", itemId);

  const existing: ExistingItem[] = [{ id: itemId!, importKey: CSV_ITEM_X.importKey, ownerEdited: false }];
  const updatedCsvItem: DesiredItem = { ...CSV_ITEM_X, priceCents: 1399 };
  const diff = diffItems([updatedCsvItem], existing);
  assertEquals(diff.toUpdate[0].skippedOwnerEdited, false);

  const result = await applyToUpdate(supabase, MENU_ID, diff.toUpdate);

  const finalRow = supabase.rows("menu_items")[0];
  assertEquals(finalRow.active, true);
  assertEquals(finalRow.price_cents, 1399, "non-owner-edited content should still be refreshed from the CSV");
  assertEquals(result.updated, 1);
  assertEquals(result.skippedOwnerEdited, 0);
});
