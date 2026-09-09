// Item 2 (2026-09-09, module extraction): pure cart-content analysis helpers
// pulled out of index.ts verbatim. These functions never touch Supabase, the
// LLM, or any other I/O — given a cart array (and, for the reference-tracking
// pair, conversation history) they answer a yes/no or list question about
// what the cart currently contains. Extracted so they can be imported and
// unit-tested directly instead of only being reachable through the 7.6k-line
// module that also boots a Deno.serve listener.
//
// CartLine is deliberately a single flat shape (not index.ts's CartItem |
// BundleItem union) — every field these functions read is optional here, so
// index.ts's real cart arrays are structurally assignable with no cast at
// the call site, and the `.type === "bundle"` checks below need no per-call
// type assertion the way the union-typed originals did.

import { significantStems } from "./pending-disambiguation.ts";

export interface CartLine {
  type?: string;
  name: string;
  modifiers?: string[];
  options?: Record<string, string[]>;
  unverified_requests?: string[];
}

export function claimsItemInCart(reply: string, guardCart: CartLine[]): string | null {
  if (!reply) return null;

  // If cart is empty, ANY assertion of cart contents is a hallucination.
  if (guardCart.length === 0) {
    if (/\b(?:in\s+(?:your|the)\s+cart|already\s+(?:have|in|added)|you\s+(?:have|got).*(?:in\s+(?:your|the)\s+cart))\b/i.test(reply)) {
      return "(empty cart)";
    }
    return null;
  }

  // Cart has items — extract what the LLM claims is in the cart and verify.
  //
  // CHANGE 3 (2026-09-05, Jason): every pattern now REQUIRES the literal phrase
  // "in your/the cart". Pattern 2 used to make that suffix optional against a
  // lazy capture, so plain English tripped it: "I can add it if you have a
  // preference" matched "you have a pr" and was reported as a claim that an item
  // called "pr" was in the cart. On 2026-09-05 that discarded the model's honest
  // answer to "you're not really checking with the kitchen, you're a bot" and
  // shipped a cart recital instead — the customer's direct question went
  // unanswered. Pattern 3's bare "already" alternative had the same shape.
  // A cart-content claim says "in your cart". Nothing else is one.
  const patterns = [
    /(?:one\s+)?(["']?[A-Za-z][\w\s&'-]{1,40}?)(?:\s+is\s+)?(?:already\s+)?in\s+(?:your|the)\s+cart/i,
    /you\s+(?:already\s+)?have\s+(?:a\s+|an\s+|the\s+)?(["']?[A-Za-z][\w\s&'-]{1,40}?)\s+in\s+(?:your|the)\s+cart/i,
    /i['"]?(?:ve|\s+have)\s+(?:already\s+)?(?:got\s+)?(?:a\s+)?(["']?[A-Za-z][\w\s&'-]{1,40}?)\s+(?:already\s+)?in\s+(?:your|the)\s+cart/i,
  ];

  for (const re of patterns) {
    const m = reply.match(re);
    if (!m) continue;
    const claimed = m[1].replace(/["']/g, '').trim();
    // A one- or two-letter fragment is never a menu item name; it is the regex
    // catching a preposition. Require enough characters to be a real claim.
    if (claimed.length < 4) continue;
    // CHANGE 2 (2026-09-04, Jason): an item COUNT is not an item NAME. These
    // patterns capture "You've got 3 items in your cart" as a claim that an
    // item literally called "3 items" is in the cart, so a TRUE statement was
    // flagged as a hallucination and the whole reply was thrown away. Verify a
    // count as a count: right number, no hallucination.
    // EXTENDED (2026-09-08): also handle "N pizzas", "N large pizzas",
    // "all 4 pizzas" etc. — the model's natural summary after a deterministic
    // compose adds 2 pizzas and the model adds 2 more, it says "all 4 large
    // pizzas in your cart" which is truthful but "pizzas" isn't "items".
    const FOOD_TYPE_PAT = "(?:items?|pizzas?|pies?|sandwiches?|burgers?|subs?|salads?|wings?|orders?|wraps?)";
    const SIZE_PAT      = "(?:(?:large|medium|small|regular|personal|family)\\s+)?";
    const countClaim = claimed.match(
      new RegExp(`\\b(\\d+)\\s+${SIZE_PAT}${FOOD_TYPE_PAT}\\b`, "i"),
    );
    if (countClaim) {
      if (Number(countClaim[1]) === guardCart.length) continue; // truthful
      return claimed;                                           // wrong count
    }
    // Word-number count claim: "all four large pizzas", "four pizzas", etc.
    // — digit check above only catches numerals; word numbers are a separate
    // pattern that the model also produces naturally.
    const WORD_NUM: Record<string, number> = {
      one:1, two:2, three:3, four:4, five:5,
      six:6, seven:7, eight:8, nine:9, ten:10,
    };
    const wordCountClaim = claimed.match(
      new RegExp(`\\b(${Object.keys(WORD_NUM).join("|")})\\s+${SIZE_PAT}${FOOD_TYPE_PAT}\\b`, "i"),
    );
    if (wordCountClaim) {
      const claimedCount = WORD_NUM[wordCountClaim[1].toLowerCase()];
      if (claimedCount === guardCart.length) continue; // truthful
      return claimed;                                  // wrong count
    }
    // Live-confirmed regression (2026-09-08, pizza-topping-compose.ts): a
    // composed line's own `name` field never carries its topping (e.g.
    // "Large 18'' Neapolitan Cheese Pizza" with options {"Add
    // Toppings":["Pepperoni"]}) — same shape as every other compiled/legacy
    // item with options. A perfectly honest reply describing the FULL
    // composition ("Neapolitan Cheese Pizza with Pepperoni is in your
    // cart") was flagged as a hallucination because "with Pepperoni" isn't
    // a substring of the bare name. Match against each line's real
    // options/modifiers too, not just its bare name, so a truthful
    // topping-qualified claim is recognized instead of false-tripping this
    // guard onto "Sorry, I got mixed up" over a cart that was actually
    // correct.
    const cartNames = guardCart.flatMap(item => {
      if (item.type === "bundle") return [item.name];
      const extras = [...(item.modifiers ?? []), ...Object.values(item.options ?? {}).flat()];
      return extras.length > 0 ? [item.name, `${item.name} ${extras.join(" ")}`] : [item.name];
    });
    const found = cartNames.some(n => {
      if (n.toLowerCase().includes(claimed.toLowerCase())) return true;
      if (claimed.toLowerCase().includes(n.toLowerCase())) return true;
      // Stem-overlap fallback: model may describe a composed item without a
      // size qualifier (e.g. "Large Neapolitan Cheese Pizza" omitting "18''")
      // — neither substring direction matches, but 3+ significant stems in
      // common is a strong signal the model is describing this cart item.
      // Threshold 3 is intentionally conservative so a 2-word slip like
      // "Pepperoni Calzone" can't accidentally clear a real hallucination.
      const nStems = significantStems(n);
      const cStems = significantStems(claimed);
      let overlap = 0;
      for (const s of nStems) if (cStems.has(s)) overlap++;
      return overlap >= 3;
    });
    if (!found) return claimed;
  }

  return null;
}

/**
 * CHANGE 2 (2026-09-04, Jason): does the model's reply already acknowledge the
 * cart state?
 *
 * Guard 1f used to REPLACE the model's reply with a flat recital
 * ("Your cart: 1x Cheese - Large (16"), 1x French Fries. What else can I add?")
 * whenever it suspected a narrated correction that never mutated the cart. In a
 * six-turn test it discarded two perfectly coherent replies, because its
 * predicate matches a plain cart listing ("1x ...") next to the word "want".
 *
 * The recital is now a FALLBACK, not a blanket replacement: it is used only when
 * the model produced nothing usable, or wrote something that shows no awareness
 * of what is in the cart. A reply that names an item in the cart, or refers to
 * the cart/order at all, is coherent — send the model's words.
 */
export function replyAcknowledgesCart(reply: string, cart: CartLine[]): boolean {
  const text = (reply ?? "").trim();
  if (text.length === 0) return false;

  // Generic cart/order awareness.
  if (/\b(?:cart|order|added|got it|that'?s|so far|total)\b/i.test(text)) return true;

  // Or it names something actually in the cart. Match on the item's most
  // distinctive word so "Cheese - Large (16\")" is recognised in "large cheese".
  const norm = text.toLowerCase();
  for (const item of cart) {
    const name = (item.name ?? "").toLowerCase();
    if (!name) continue;
    if (norm.includes(name)) return true;
    const words = name.split(/[^a-z0-9]+/).filter(w => w.length > 3);
    if (words.some(w => norm.includes(w))) return true;
  }
  return false;
}

/**
 * Detect when the LLM's reply is "closing" — summarizing the order, quoting
 * a total, asking to confirm, or heading to checkout. These are the moments
 * where a missing item in the cart is most dangerous.
 */
export function isClosingReply(reply: string): boolean {
  if (!reply) return false;
  const norm = reply.toLowerCase();
  // Check 1: Total-line patterns — dollar amount adjacent to total/summary language.
  const hasTotal = (
    /\$\d+[.,]\d{2}/.test(norm) &&
    /\b(?:total|comes to|that['’]s|that is|that['’]ll be|order (?:total|summary)|your (?:total|order)|subtotal|plus.*fee|all together|grand total)\b/i.test(norm)
  );
  // Check 2: Checkout/confirmation language — the LLM is asking to close.
  const hasCheckoutSignal = (
    /\b(?:confirm\??|ready to check out|ready to check|ready to pay|check(?:-| )?out|place your order|all set|good to go|proceed(?: to (?:pay|checkout|order))?|all good\??|look good\??|looks good\??|that look good|that sound good|how['’]s that look|how['’]s that sound|i['’]ll send|sending your|payment link|your order is|let me know if|just confirm|just let me know)\b/i.test(norm)
  );
  // Check 3: Closing item-count summary (with cart/summary context).
  const hasCountSummary = (
    /\b\d+\s+items?\b/i.test(norm) &&
    /\b(?:in (?:your|the) (?:cart|order)|so far|total(?:ing)?|that['’]s \d+ items?|i['’]ve got|you['’]ve got|you have|your (?:cart|order)|we have)\b/i.test(norm)
  );
  return hasTotal || hasCheckoutSignal || hasCountSummary;
}

/**
 * Walk conversation history and return the set of menu-item display names the
 * customer has referenced. Uses the same canonical-key matching as
 * buildMenuItemNames. Scans the CURRENT user message + all prior user messages
 * that contain ordering conjunctions ("and", "also", etc.) — pure questions
 * ("Do you have coffee?") are excluded from prior-turn scanning to avoid
 * false positives on items the customer merely asked about.
 *
 * The current message is always scanned regardless of form.
 */
export function extractCustomerReferencedItems(
  history: Array<{ role: "user" | "assistant"; content: string | unknown[] }>,
  menuNames: Map<string, string>,
): Set<string> {
  const referenced = new Set<string>();
  const userMessages = history
    .filter(h => h.role === "user" && typeof h.content === "string")
    .map(h => (h.content as string).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim());

  for (let i = 0; i < userMessages.length; i++) {
    const msg = userMessages[i];
    const isCurrent = i === userMessages.length - 1;
    // For prior messages, only scan ones that look like orders (contain
    // conjunctions/connectors), not pure questions.
    if (!isCurrent && !/\b(?:and|also|plus|with|then|as well|too)\b/i.test(msg)) continue;

    for (const [key, displayName] of menuNames) {
      // Skip ID-based keys (UUIDs / short hashes) — not natural language.
      if (/^[a-f0-9-]{8,}$/.test(key)) continue;
      if (msg.includes(key)) {
        referenced.add(displayName);
      }
    }
  }
  return referenced;
}

/**
 * Return menu-item display names that the customer referenced but are absent
 * from the cart. Match is bidirectional substring ("Shrimp Scampi" ref matches
 * cart item "Shrimp Scampi", and vice versa).
 */
export function findMissingCartItems(
  referencedItems: Set<string>,
  cart: CartLine[],
): string[] {
  // A referenced name is satisfied by ANYTHING already on the cart that
  // means it, not just a cart LINE whose own name matches. Before this fix,
  // ordering "large cheese pizza ... add pepperoni and mushrooms" put
  // pepperoni into the cart as an OPTION CHOICE
  // (options: {"Toppings": ["Pepperoni (Whole pizza)"]}) on the cheese pizza
  // line — never as a line item literally named "Pepperoni". Guard 4 read
  // that as still missing and offered to add pepperoni immediately after
  // adding it (2026-09-06, Jason's Test Kitchen transcript). Modifiers,
  // selected option choices, AND unverified_requests (a customer ask the shop
  // hasn't confirmed a real choice for) all count as "this is on the ticket".
  const cartLower = new Set<string>();
  for (const item of cart) {
    if (item.type === "bundle") { cartLower.add(item.name.toLowerCase()); continue; }
    cartLower.add(item.name.toLowerCase());
    for (const m of item.modifiers ?? []) cartLower.add(m.toLowerCase());
    for (const selections of Object.values(item.options ?? {})) {
      for (const sel of selections) cartLower.add(sel.toLowerCase());
    }
    for (const u of item.unverified_requests ?? []) cartLower.add(u.toLowerCase());
  }

  const missing: string[] = [];
  for (const displayName of referencedItems) {
    const itemLower = displayName.toLowerCase();
    const inCart = [...cartLower].some(cn =>
      cn.includes(itemLower) || itemLower.includes(cn)
    );
    if (!inCart) {
      missing.push(displayName);
    }
  }
  return missing;
}

/**
 * Remove items from the referenced set that appear inside a negated phrase
 * in the current customer message. Safety net — the narrowing-order guard
 * already suppresses prior-history scanning on "just"/"only", but this
 * catches the remaining case where a customer says e.g.
 * "actually, no pepperoni pizza — just the cheese" in the CURRENT message.
 *
 * Prefer under-asking to nagging: when in doubt about a negation, suppress.
 */
export function filterNegatedItems(
  referencedItems: Set<string>,
  currentMessage: string,
): Set<string> {
  if (!currentMessage) return referencedItems;
  const msg = currentMessage.toLowerCase();
  const result = new Set<string>();
  for (const displayName of referencedItems) {
    const itemLower = displayName.toLowerCase();
    const escaped = itemLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Patterns: "no <item>", "not <item>", "remove <item>", "skip <item>",
    // "drop <item>", "scratch <item>", "don't want/need/get <item>",
    // "cancel <item>", "i don't want <item>".
    const negRegex = new RegExp(
      `\\b(?:no|not|remove|skip|drop|scratch|removing|skipping|dropping|cancel(?:ling)?|i\\s+don['\\u2019]t\\s+(?:want|need|get))\\s+(?:the\\s+)?(?:any\\s+)?${escaped}\\b|` +
      `\\bdon['\\u2019]t\\s+(?:want|need|get)\\s+(?:the\\s+)?(?:any\\s+)?${escaped}\\b`,
      'i'
    );
    if (!negRegex.test(msg)) {
      result.add(displayName);
    } else {
      console.log(`[chat-sms] GUARD 4 v2 negation-filter: suppressed "${displayName}" (appears in negated context)`);
    }
  }
  return result;
}
