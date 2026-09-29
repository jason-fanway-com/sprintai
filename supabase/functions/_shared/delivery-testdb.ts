// _shared/delivery-testdb.ts — test helper: an in-memory stand-in for the supabase-js calls the delivery code makes.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

type Row = Record<string, unknown>;
export function memDb(unique: Record<string, string[]> = { deliveries: ["cart_id"] }) {
  const tables: Record<string, Row[]> = {};
  let seq = 0, clock = 0;
  const t = (name: string) => (tables[name] ??= []);
  function builder(table: string) {
    let op: "select" | "insert" | "update" = "select", payload: Row | null = null, single = false;
    const filters: Array<[string, unknown]> = [];
    const q = {
      select(_c?: string) { return q; },
      insert(r: Row) { op = "insert"; payload = r; return q; },
      update(p: Row) { op = "update"; payload = p; return q; },
      eq(k: string, v: unknown) { filters.push([k, v]); return q; },
      maybeSingle() { single = true; return q; },
      then(res: (v: { data: unknown; error: { message: string; code?: string } | null }) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(res, rej);
      },
    };
    const match = (r: Row) => filters.every(([k, v]) => r[k] === v);
    function run() {
      if (op === "insert") {
        for (const col of unique[table] ?? []) if (t(table).some((r) => r[col] === payload![col])) return { data: null, error: { message: "duplicate key", code: "23505" } };
        const row: Row = { id: `row_${++seq}`, events: [], updated_at: `t${++clock}`, ...payload };
        t(table).push(row);
        return { data: single ? { ...row } : [{ ...row }], error: null };
      }
      const hits = t(table).filter(match);
      if (op === "update") { for (const r of hits) Object.assign(r, payload, table === "deliveries" && !("updated_at" in payload!) ? {} : { updated_at: `t${++clock}` }); }
      const out = hits.map((r) => ({ ...r }));
      return { data: single ? (out[0] ?? null) : out, error: null };
    }
    return q;
  }
  return { client: { from: builder } as unknown as SupabaseClient, tables: t };
}

