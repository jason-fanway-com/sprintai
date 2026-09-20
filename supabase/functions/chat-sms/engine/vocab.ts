// vocab.ts — closed-vocabulary answers that never need a model. A match is the
// WHOLE normalized message equal to an entry (or an anchored number). No
// substring matching, no intent guessing. Anything else goes to interpret.ts.
import { normalize } from "./normalize.ts";
import type { Move, OrderForm } from "./form.ts";
import type { Menu } from "./menu.ts";
import { matchChoice, narrow } from "./resolve.ts";

const set = (s: string) => new Set(s.split("|").map(normalize));

export const YES = set("yes|yeah|yep|yup|y|ya|ok|okay|sure|correct|right|thats right|that is right|confirm|confirmed|place it|place the order|go ahead|sounds good|looks good|good|perfect|yes please|yes pls|do it|thats correct|that is correct|yes thats it|yes that's it");
export const NO = set("no|nope|nah|n|no thanks|no thank you|none|nothing|nothing else|thats it|thats all|that is it|that is all|im good|i am good|all set|done|im done|thats everything|that will be all|thatll be all|that is everything|thats it thanks|no thats it|no thats all|nope thats it|no that's it|that's it|that's all|i'm good|i'm done|that'll be all|thats all thanks|no im good|no that is all");
export const PICKUP = set("pickup|pick up|pick-up|carry out|carryout|takeout|take out|ill pick it up|i will pick it up|ill pick up|to go|for pickup|pickup please|pick up please");
export const DELIVERY = set("delivery|deliver|delivered|deliver it|for delivery|delivery please|deliver please");
export const CANCEL = set("cancel|cancel order|cancel my order|cancel the order|start over|restart|new order|clear my cart|clear cart|reset");
export const CART = set("cart|my cart|whats in my cart|what is in my cart|show cart|show my cart|my order|whats my order|what do i have|what do i have so far|read it back|order so far|whats in my order|what is in my order|show me the cart|show me my cart|what's in my cart|what's my order");
export const MENU = set("menu|the menu|options|what are the options|what are my options|what do you have|whats on the menu|what's on the menu|show me the menu|see the menu");
export const HUMAN = set("human|agent|person|call me|talk to a person|speak to someone|real person|operator|representative");
export const SKIP = set("skip|never mind|nevermind|forget it|forget that|leave it off|drop it|remove it|take it off|no|none|nothing");
export const HELLO = set("hi|hello|hey|yo|hi there|hello there|good morning|good afternoon|good evening|hey there|sup|howdy|hola");

const TIP_RE = /^\$?\s*(\d{1,4}(?:\.\d{1,2})?)\s*(%|percent|pct|dollars?|bucks|dollar tip|tip)?$/;
const DIGIT_RE = /^(\d{1,2})$/;

export function closedAnswer(form: OrderForm, message: string, menu: Menu): Move[] | null {
  const n = normalize(message);
  if (!n) return null;
  const open = form.open;

  if (CANCEL.has(n)) return [{ kind: "control", what: n.includes("cancel") ? "cancel" : "start_over" }];
  if (CART.has(n)) return [{ kind: "control", what: "show_cart" }];
  if (HUMAN.has(n)) return [{ kind: "control", what: "human" }];
  if (MENU.has(n)) return [{ kind: "ask_menu", about_span: null }];
  if (HELLO.has(n) && form.lines.length === 0 && !open) return [{ kind: "control", what: "greeting" }];

  if (PICKUP.has(n)) return [{ kind: "answer", field: "fulfillment", value: "pickup" }];
  if (DELIVERY.has(n)) return [{ kind: "answer", field: "fulfillment", value: "delivery" }];
  if (open?.kind === "fulfillment") {
    if (n === "1") return [{ kind: "answer", field: "fulfillment", value: "pickup" }];
    if (n === "2") return [{ kind: "answer", field: "fulfillment", value: "delivery" }];
  }

  if (open?.kind === "tip") {
    if (NO.has(n) || n === "no tip" || n === "skip") return [{ kind: "answer", field: "tip", value: { kind: "cents", value: 0 } }];
    const m = TIP_RE.exec(n);
    if (m) {
      const num = parseFloat(m[1]);
      const unit = m[2] ?? "";
      const isDollars = message.includes("$") || /dollar|buck/.test(unit) || m[1].includes(".");
      if (isDollars) return [{ kind: "answer", field: "tip", value: { kind: "cents", value: Math.round(num * 100) } }];
      if (/%|percent|pct/.test(unit) || num <= 50) return [{ kind: "answer", field: "tip", value: { kind: "percent", value: num } }];
      return [{ kind: "answer", field: "tip", value: { kind: "cents", value: Math.round(num * 100) } }];
    }
  }

  if (open?.kind === "confirm" || open?.kind === "omission") {
    if (YES.has(n)) return [{ kind: "answer_yes" }];
    if (NO.has(n)) return [{ kind: "answer_no" }];
  }
  if (open?.kind === "items") {
    if (NO.has(n)) return [{ kind: "answer", field: "items_done", value: true }];
  }
  if (!open && NO.has(n) && form.lines.length > 0) return [{ kind: "answer", field: "items_done", value: true }];

  if (open?.kind === "line_ref" || (open?.kind === "line_ambiguous" && open.facet === "list")) {
    const d = DIGIT_RE.exec(n);
    if (d) return [{ kind: "answer_option", value_span: d[1] }];
  }
  if (open?.kind === "line_slot" || open?.kind === "line_ambiguous" || open?.kind === "line_unresolved") {
    if (SKIP.has(n)) return [{ kind: "remove_line", ref: { line_id: open.line_id } }];
    const line = form.lines.find((l) => l.line_id === open.line_id);
    if (line && open.kind === "line_slot" && line.item_id) {
      const g = menu.items.get(line.item_id)?.groups.find((x) => x.id === open.group_id);
      if (g && matchChoice(n, g, line.slot_candidates[g.id]).kind === "one") return [{ kind: "answer_option", value_span: message.trim() }];
      const d = DIGIT_RE.exec(n);
      if (g && d) {
        const within = line.slot_candidates[g.id];
        const pool = within ? g.choices.filter((c) => within.includes(c.id)) : g.choices;
        const pick = pool[parseInt(d[1], 10) - 1];
        if (pick) return [{ kind: "answer_option", value_span: pick.name }];
      }
    }
    if (line && open.kind === "line_ambiguous" && line.status.kind === "ambiguous") {
      const narrowed = narrow(line.status.candidates, n, menu);
      if (narrowed.length > 0 && narrowed.length < line.status.candidates.length) return [{ kind: "answer_option", value_span: message.trim() }];
    }
  }
  return null;
}
