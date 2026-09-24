// vocab.ts — closed-vocabulary answers that never need a model. A match is the
// WHOLE normalized message equal to an entry (or an anchored number). No
// substring matching, no intent guessing. Anything else goes to interpret.ts.
import { normalize, optionWords, words, splitList } from "./normalize.ts";
import type { Move, OrderForm, Tip } from "./form.ts";
import type { Menu } from "./menu.ts";
import { matchChoice, narrow } from "./resolve.ts";

const set = (s: string) => new Set(s.split("|").map(normalize));

export const YES = set("yes|yeah|yep|yup|y|ya|ok|okay|sure|correct|right|thats right|that is right|confirm|confirmed|place it|place the order|go ahead|sounds good|looks good|good|perfect|yes please|yes pls|do it|thats correct|that is correct|yes thats it|yes that's it");
/** Words that only mean "no" and depend on the question. */
export const PLAIN_NO = set("no|nope|nah|n|no thanks|no thank you|none|nothing");
/** Words that mean "I'm done adding items" whatever was asked. */
export const CLOSURE = set("nothing else|thats it|thats all|that is it|that is all|im good|i am good|all set|done|im done|thats everything|that will be all|thatll be all|that is everything|thats it thanks|no thats it|no thats all|nope thats it|no that's it|that's it|that's all|i'm good|i'm done|that'll be all|thats all thanks|no im good|no that is all|that should do it|thatll do it|that will do it|thats everything thanks|nothing more|no more");
export const NO = new Set([...PLAIN_NO, ...CLOSURE]);
export const PICKUP = set("pickup|pick up|pick-up|carry out|carryout|takeout|take out|ill pick it up|i will pick it up|ill pick up|to go|for pickup|pickup please|pick up please");
export const DELIVERY = set("delivery|deliver|delivered|deliver it|for delivery|delivery please|deliver please");
export const CANCEL = set("cancel|cancel order|cancel my order|cancel the order|start over|restart|new order|clear my cart|clear cart|reset");
export const CART = set("whats my total|what is my total|total so far|how much so far|how much is it|how much is that|how much is it so far|whats the total|what's my total|what's the total|running total|cart|my cart|whats in my cart|what is in my cart|show cart|show my cart|my order|whats my order|what do i have|what do i have so far|read it back|order so far|whats in my order|what is in my order|show me the cart|show me my cart|what's in my cart|what's my order");
export const MENU = set("menu|the menu|options|what are the options|what are my options|what do you have|whats on the menu|what's on the menu|show me the menu|see the menu");
export const HUMAN = set("human|agent|person|call me|talk to a person|speak to someone|real person|operator|representative");
export const SKIP = set("skip|never mind|nevermind|forget it|forget that|leave it off|drop it|remove it|take it off|no|none|nothing");
export const EACH = ["one of each", "one of every kind", "one of everything", "all of them", "all of the above", "every kind"];
const PRICE_WORDS = new Set(["price", "prices", "cost", "costs", "much", "expensive", "cheap", "dollars", "charge", "pricing"]);
export function asksPrice(message: string): boolean { return normalize(message).split(" ").some((w) => PRICE_WORDS.has(w)); } // "how much is X" may carry a price; "what is X" does not
export const HELLO = set("hi|hello|hey|yo|hi there|hello there|good morning|good afternoon|good evening|hey there|sup|howdy|hola");

const TIP_RE = /^\$?\s*(\d{1,4}(?:\.\d{1,2})?)\s*(%|percent|pct|dollars?|bucks|dollar tip|tip)?$/;
const DIGIT_RE = /^(\d{1,2})$/;

/** "20", "20%", "$5", "5 dollars", "no tip", "none" -> a Tip; null when it is not a tip answer. */
export function parseTip(text: string): Tip | null {
  const n = normalize(text);
  if (!n) return null;
  if (NO.has(n) || n === "no tip" || n === "skip" || n === "zero") return { kind: "cents", value: 0 };
  const m = TIP_RE.exec(n.replace(/^(tip|add|make it|lets do|let us do|ill do|i will do)\s+/, ""));
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = m[2] ?? "";
  const isDollars = text.includes("$") || /dollar|buck/.test(unit) || m[1].includes(".");
  if (isDollars) return { kind: "cents", value: Math.round(num * 100) };
  if (/%|percent|pct/.test(unit) || num <= 50) return { kind: "percent", value: num };
  return { kind: "cents", value: Math.round(num * 100) };
}

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
  if (open?.kind === "fulfillment" && (n === "1" || n === "2")) return [{ kind: "answer", field: "fulfillment", value: n === "1" ? "pickup" : "delivery" }];

  if (open?.kind === "tip") { const tip = parseTip(message); if (tip) return [{ kind: "answer", field: "tip", value: tip }]; }
  if (open?.kind === "confirm" || open?.kind === "omission") { if (YES.has(n)) return [{ kind: "answer_yes" }]; if (NO.has(n)) return [{ kind: "answer_no" }]; }
  if (open?.kind === "items" && NO.has(n)) return [{ kind: "answer", field: "items_done", value: true }];
  // "that's it" closes the item list whatever else is open (the open question is asked again after)
  if (CLOSURE.has(n) && open?.kind === "line_unresolved") return [{ kind: "remove_line", ref: { line_id: open.line_id } }, { kind: "answer", field: "items_done", value: true }];
  if (CLOSURE.has(n) && form.lines.length > 0) return [{ kind: "answer", field: "items_done", value: true }];
  if (!open && NO.has(n) && form.lines.length > 0) return [{ kind: "answer", field: "items_done", value: true }];

  const digit = DIGIT_RE.exec(n)?.[1];
  if (digit && (open?.kind === "line_ref" || open?.kind === "line_ambiguous")) return [{ kind: "answer_option", value_span: digit }];
  if (open?.kind === "line_slot" || open?.kind === "line_ambiguous" || open?.kind === "line_unresolved" || open?.kind === "line_picks") {
    if (SKIP.has(n)) return [{ kind: "remove_line", ref: { line_id: open.line_id } }];
    const line = form.lines.find((l) => l.line_id === open.line_id);
    if (line && open.kind === "line_slot" && line.item_id) {
      const g = menu.items.get(line.item_id)?.groups.find((x) => x.id === open.group_id);
      // closed means the WHOLE message is the option (plus the group's own noun): "hot sauce" yes; "hot sauce. actually scratch the soup" goes to the model
      const m = g ? matchChoice(n, g, line.slot_candidates[g.id]) : null;
      const chosen = m?.kind === "one" ? g!.choices.find((c) => c.id === m.choice_id) : undefined;
      if (chosen && optionWords(n).every((w) => chosen.words.includes(w) || menu.items.get(line.item_id!)!.words.includes(w) || words(g?.name ?? "").includes(w))) return [{ kind: "answer_option", value_span: message.trim() }]; // "linguine for the pasta with clam sauce"
      const within = line.slot_candidates[g?.id ?? ""], pick = g && digit ? (within ? g.choices.filter((c) => within.includes(c.id)) : g.choices)[parseInt(digit, 10) - 1] : undefined;
      const list = splitList(message).map(normalize); if (g && list.length > 1 && list.every((x) => matchChoice(x, g, within).kind === "one")) return [{ kind: "answer_option", value_span: message.trim() }]; // "bbq, garlic hot, mango habanero": a list of this slot's options is an answer (the engine asks which one)
      if (pick) return [{ kind: "answer_option", value_span: pick.name }];
    }
    if (line && open.kind === "line_ambiguous" && line.status.kind === "ambiguous") {
      if (EACH.includes(n) || EACH.includes(n.replace(/ (kind|please)$/, ""))) { // one line per kind, each to be sized or completed in turn
        const kinds = [...new Set(line.status.candidates.map((id) => menu.items.get(id)?.facets.kind ?? menu.items.get(id)?.display_name ?? id))];
        return [{ kind: "split_line", line_id: line.line_id, parts: kinds.map((k) => ({ span: k, qty: 1 })) }];
      }
      const narrowed = narrow(line.status.candidates, n, menu);
      if (narrowed.length > 0 && narrowed.length < line.status.candidates.length) return [{ kind: "answer_option", value_span: message.trim() }];
    }
  }
  // "ranch" while we are asking about another line: the whole message names an option of exactly one waiting line's unfilled required slot (never a paid add-on)
  const waiting = form.lines.filter((l) => l.item_id && l.status.kind === "needs_slot" && !(open && "line_id" in open && open.line_id === l.line_id));
  const fits = waiting.filter((l) => menu.items.get(l.item_id!)!.groups.some((g) => g.kind === "slot" && !l.choices[g.id] && matchChoice(n, g, l.slot_candidates[g.id]).kind === "one"));
  return fits.length === 1 ? [{ kind: "answer_option", value_span: message.trim(), line_id: fits[0].line_id }] : null;
}
