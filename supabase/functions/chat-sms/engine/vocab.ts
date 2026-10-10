// vocab.ts — closed-vocabulary answers that never need a model. A match is the WHOLE normalized message equal to an entry (or an anchored number). No substring matching, no intent guessing. Anything else goes to interpret.ts.
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
export const LINK = set("resend the link|resend the payment link|resend link|send the link|send the payment link|send me the link|send me the payment link|send it again|payment link|pay link|the link|link|link please|i want to pay|ready to pay|pay now|lets pay|let me pay|where do i pay|how do i pay|send the link again|resend"); // at the read-back, asking for the link is a yes
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
const THANKS_WORDS = new Set(["thanks", "thank", "thx", "ty", "appreciate", "appreciated"]), HAVE_LEAD = new Set(["do", "does", "have", "got", "can", "is", "are", "any", "yall"]);
/** "how long is the wait", "whats the eta", "when will it be ready": a question about timing */
export function asksWait(message: string): boolean { const w = words(message), run = (a: string, b: string) => w.some((x, i) => x === a && w[i + 1] === b); return run("how", "long") || run("the", "wait") || w.includes("eta") || (w.includes("when") && (w.includes("ready") || w.includes("here"))); } export function asksHours(message: string): boolean { const w = words(message); return w.some((x) => x === "hours" || x === "close" || x === "closing" || x === "closes") || (w.includes("open") && (isQuestion(message) || w.includes("still") || w.includes("til") || w.includes("until"))); } // "oh wait, add knots" is not a question about the wait | "what time do yall close", "are you open"
export function saysThanks(message: string): boolean { return words(message).some((w) => THANKS_WORDS.has(w)); }
/** "do you have X?" wants "Yes, we do."; "what comes on X?" does not */
export function asksHave(message: string): boolean { const w = words(message); return w.length > 0 && (HAVE_LEAD.has(w[0]) || (w.length > 1 && (w[0] === "yes" || w[0] === "ok" || w[0] === "wait") && HAVE_LEAD.has(w[1]))); }
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
  if (/%|percent|pct/.test(unit) || (num >= 10 && num <= 50)) return { kind: "percent", value: num }; // a bare "5" is $5 (Jason, FNA's 2026-10-06); 15 or 20 is a percent
  return { kind: "cents", value: Math.round(num * 100) };
}

const QUESTION_LEAD = new Set(["do", "does", "did", "is", "are", "have", "has", "can", "could", "would", "will", "what", "which", "how", "whats", "got"]); // "you dont have to text me" is not a question
/** "do you have hot dogs?", "did you add a hot dog": the customer is asking, not ordering */
export function isQuestion(message: string): boolean { const w = words(message); return message.trim().endsWith("?") || (w.length > 0 && QUESTION_LEAD.has(w[0])) || (w.length > 1 && (w[0] === "yes" || w[0] === "ok") && QUESTION_LEAD.has(w[1])); }
export function closedAnswer(form: OrderForm, message: string, menu: Menu): Move[] | null {
  const n = normalize(message);
  if (!n) return null;
  const open = form.open;

  if (CANCEL.has(n)) return [{ kind: "control", what: n.includes("cancel") ? "cancel" : "start_over" }]; if (CART.has(n)) return [{ kind: "control", what: "show_cart" }];
  if (HUMAN.has(n)) return [{ kind: "control", what: "human" }]; if (MENU.has(n) || (form.open && "line_id" in form.open && words(n).includes("options"))) return [{ kind: "ask_menu", about_span: null }]; // "lemme get the options" while a choice is open: that choice's list
  if (HELLO.has(n) && form.lines.length === 0 && !open) return [{ kind: "control", what: "greeting" }];

  if (PICKUP.has(n) || DELIVERY.has(n)) return [{ kind: "answer", field: "fulfillment", value: PICKUP.has(n) ? "pickup" : "delivery" }];
  if (open?.kind === "fulfillment" && (n === "1" || n === "2")) return [{ kind: "answer", field: "fulfillment", value: n === "1" ? "pickup" : "delivery" }];

  if (open?.kind === "tip") { const tip = parseTip(message); if (tip) return [{ kind: "answer", field: "tip", value: tip }]; }
  if (open?.kind === "omission" && (n === "extra" || n === "additional" || n === "another order" || n === "an additional order")) return [{ kind: "answer_yes" }];
  if (open?.kind === "confirm" || open?.kind === "omission") { if (YES.has(n) || (open.kind === "confirm" && LINK.has(n))) return [{ kind: "answer_yes" }]; if (NO.has(n)) return [{ kind: "answer_no" }]; }
  if (open?.kind === "items" && NO.has(n)) return [{ kind: "answer", field: "items_done", value: true }];
  const offerLine = open?.kind === "line_slot" ? form.lines.find((l) => l.line_id === open.line_id) : undefined; if (offerLine?.item_id && open?.kind === "line_slot" && menu.items.get(offerLine.item_id)?.groups.find((g) => g.id === open.group_id)?.ask_mode === "offer_once" && (CLOSURE.has(n) || NO.has(n) || YES.has(n))) return [{ kind: "answer_option", value_span: "as is" }, ...(CLOSURE.has(n) ? [{ kind: "answer", field: "items_done", value: true } as Move] : [])]; // "any toppings?" "that's it": as is, and done
  if (CLOSURE.has(n) && open?.kind === "line_unresolved") return [{ kind: "remove_line", ref: { line_id: open.line_id } }, { kind: "answer", field: "items_done", value: true }]; // "that's it" closes the item list whatever else is open (the open question is asked again after)
  if (CLOSURE.has(n) && form.lines.length > 0) return [{ kind: "answer", field: "items_done", value: true }];
  if (!open && NO.has(n) && form.lines.length > 0) return [{ kind: "answer", field: "items_done", value: true }];

  const digit = DIGIT_RE.exec(n)?.[1];
  if (digit && (open?.kind === "line_ref" || open?.kind === "line_ambiguous")) return [{ kind: "answer_option", value_span: digit }];
  if (open?.kind === "line_slot" || open?.kind === "line_ambiguous" || open?.kind === "line_unresolved" || open?.kind === "line_picks") {
    const amb = open.kind === "line_ambiguous" ? form.lines.find((l) => l.line_id === open.line_id) : undefined, usualAsked = !!amb && amb.status.kind === "ambiguous" && amb.status.candidates.some((id) => menu.items.get(id)?.primary_for.includes(words(amb.span).join(" "))) && form.asked.count < 1;
    if (usualAsked && PLAIN_NO.has(n)) return []; else if (SKIP.has(n)) return [{ kind: "remove_line", ref: { line_id: open.line_id } }]; // "the Cheesesteak Sandwich, right?" "no": not that one, so show them all (never drop the line)
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
      const usual = line.status.candidates.map((id) => menu.items.get(id)).filter((i) => i?.primary_for.includes(words(line.span).join(" "))); if (YES.has(n) && usual.length === 1) return [{ kind: "answer_option", value_span: usual[0]!.display_name }]; // "the Cheesesteak Sandwich, right?" "yes"
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
