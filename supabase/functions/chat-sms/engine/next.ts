// next.ts — the single policy for "what do we ask now", and the repeat ladder.
import type { OpenQuestion, OrderForm } from "./form.ts";
import type { Menu } from "./menu.ts";

export function questionKey(q: OpenQuestion | null): string | null {
  if (!q) return null;
  switch (q.kind) {
    case "line_unresolved": return `line_unresolved:${q.line_id}`;
    case "line_ambiguous": return `line_ambiguous:${q.line_id}`;
    case "line_slot": return `line_slot:${q.line_id}:${q.group_id}`;
    case "line_picks": return `line_picks:${q.line_id}`;
    case "omission": return `omission:${q.spans.join("|")}`;
    case "line_ref": return `line_ref`;
    default: return q.kind;
  }
}

/** The next open question, by fixed priority. Pure. */
export function next(form: OrderForm, menu: Menu, refAsk: { candidates: number[]; pending: import("./form.ts").Move } | null): OpenQuestion | null {
  if (form.status === "abandoned" || form.status === "paid") return null;
  if (refAsk) return { kind: "line_ref", candidates: refAsk.candidates, pending: refAsk.pending };
  for (const l of form.lines) {
    if (l.status.kind === "unresolved") return { kind: "line_unresolved", line_id: l.line_id };
  }
  for (const l of form.lines) {
    if (l.status.kind === "ambiguous") return { kind: "line_ambiguous", line_id: l.line_id, facet: l.status.facet ?? "list" };
    if (l.status.kind === "needs_slot") return { kind: "line_slot", line_id: l.line_id, group_id: l.status.group_id };
    if (l.status.kind === "needs_picks") return { kind: "line_picks", line_id: l.line_id, remaining: l.status.remaining };
  }
  const pending = form.omissions.filter((o) => !o.declined);
  if (pending.length) return { kind: "omission", spans: pending.map((o) => o.span) };
  const delivery = form.fulfillment === "delivery";
  for (const step of menu.shop.ask_order) {
    if (step === "fulfillment" && form.fulfillment === null) {
      if (!menu.shop.delivery_enabled) { continue; }
      return { kind: "fulfillment" };
    }
    if (step === "address" && delivery && (form.address === null || !form.address.validated || !form.address.zone_ok)) return { kind: "address" };
    if (step === "items" && !form.items_done) return { kind: "items" };
    if (step === "tip" && delivery && form.tip === null) return { kind: "tip" };
    if (step === "confirm" && !form.confirmed) return { kind: "confirm" };
  }
  return null;
}

/**
 * Safe automatic resolution once the same question has gone unanswered too
 * many times. Mutates the form. Returns a ledger note or null.
 */
export function escalate(form: OrderForm, menu: Menu): string | null {
  const q = form.open;
  if (!q || form.asked.count < 3) return null;
  switch (q.kind) {
    case "line_unresolved":
    case "line_ambiguous":
    case "line_picks":
    case "line_slot": {
      const idx = form.lines.findIndex((l) => l.line_id === q.line_id);
      if (idx >= 0) { const [gone] = form.lines.splice(idx, 1); return `dropped_line:${gone.span}`; }
      return null;
    }
    case "omission": {
      for (const o of form.omissions) if (q.spans.includes(o.span)) o.declined = true;
      return `omission_dropped:${q.spans.join(", ")}`;
    }
    case "address": {
      form.fulfillment = "pickup"; form.address = null; form.tip = null;
      return "address_to_pickup";
    }
    case "tip": { form.tip = { kind: "cents", value: 0 }; return "tip_zero"; }
    case "fulfillment": { if (!menu.shop.delivery_enabled) { form.fulfillment = "pickup"; return "fulfillment_pickup"; } return null; }
    default: return null;
  }
}
