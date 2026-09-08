// Real self-contradiction, reproduced exactly: "make it an everything
// bagel" -> "Switched to an everything bagel - I'll pass that along to the
// shop. So, want that toasted? Just to be clear - Bagel With Plain Cream
// Cheese doesn't have that kind of option here, so nothing was actually
// changed." One message claims success, then retracts it.
//
// This went through two prior shapes, BOTH of which Jason rejected after
// live-verifying them, and both rejections were correct:
//   Shape 1 — GUARD 17 (see guard17-*.test.ts): a POST-hoc corrector that
//   runs after the model has already composed its reply, appending a
//   correction when it detects a false claim. Structurally this has
//   exactly two outcomes: a claim-then-retraction (when it fires) or an
//   unguarded false claim (when its regex heuristics miss the phrasing) —
//   never a single clean sentence, no matter how many revisions the regex
//   gets (it went through 6). Jason's own words: "a post-hoc corrector on
//   free-form text has no version that's reliable."
//   Shape 2 — buildZeroOptionAttributeChangeHint below: a BEFORE-
//   composition system-prompt nudge, telling the model to phrase itself
//   honestly. Live-verified 3x fresh: still non-deterministic (the model
//   sometimes complied, sometimes didn't), and GUARD 17 still occasionally
//   mis-fired on an HONEST denial the hint successfully produced,
//   recreating the self-contradiction on a message that never needed
//   correcting. A prompt nudge is still probabilistic — it changes the
//   odds, not the guarantee.
//
// resolveZeroOptionAttributeChange (this function) is Shape 3, the
// authoritative one: the same pattern that already makes "large buffalo
// chicken pizza" deterministic on Zio's via ask_plan slot lookup, applied
// here. When a customer names an attribute for an item with NO option
// group capable of holding it, this is detected BEFORE any LLM call for
// the turn, and the reply is RENDERED, not generated — the words
// "switched," "noted," or "got it" attached to a change that didn't happen
// are never produced, because no free-form generation runs for this part
// of the turn at all. Two deterministic outcomes only:
//   1. A genuinely different catalog item matches what the customer
//      described (same category, a real item whose own name contains the
//      word they used) -> offer that swap by name and real price.
//   2. Nothing matches -> say so plainly, once, and record their raw
//      request as a kitchen note via a DIRECT (non-LLM) tool call, so the
//      claim "I've noted it" and the actual note being saved can never
//      drift apart the way they did in ~1/3 of Shape-2's live runs (a
//      separate, real gap Shape 2 also surfaced and never fixed).
//
// Scoped to the UNAMBIGUOUS case only: exactly one zero-option item in the
// cart. Two or more zero-option items in cart makes "which one do you
// mean" a real language-understanding question this deterministic
// resolver isn't built to answer — that residual case still falls through
// to buildZeroOptionAttributeChangeHint (kept below, not deleted) and
// GUARD 17 as a backstop. This is a genuine, intentional exception to "no
// two systems in parallel for the same case": the deterministic resolver
// and the hint/GUARD-17 fallback cover DISJOINT scenarios (one vs. 2+
// zero-option cart items), never both firing for the same turn.

export interface ZeroOptionCartLine {
  menu_item_id?: string;
}

export interface ZeroOptionMenuItem {
  id: string;
  ask_plan?: { display_name: string; steps: unknown[] } | null;
}

// The resolver additionally needs category + price to find and price a
// genuine alternative item — a superset of ZeroOptionMenuItem's shape.
export interface ZeroOptionMenuItemFull extends ZeroOptionMenuItem {
  category: string | null;
  price_cents: number;
}

export interface ZeroOptionResolution {
  menuItemId: string;
  itemDisplayName: string;
  rawRequest: string;
  alternative: { id: string; name: string; priceCents: number } | null;
}

const CHANGE_VERB_RE =
  /\b(?:switch(?:ed|ing)?|chang(?:e|ed|ing)|swap(?:ped|ping)?|instead\s+of|now\s+(?:a|an|with)|make\s+(?:it|that)\s+an?|updat(?:e|ed|ing)\s+to)\b/i;

// Words that can never themselves be "the requested attribute" — the verbs
// and connective tissue of the request itself, not content. Deliberately
// broad (a stopword wrongly excluded just means a slightly less precise
// alternative-item search, not a wrong deterministic reply — the "no
// match found" path is always safe to fall back to).
const REQUEST_STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "of", "that", "this", "it", "them", "those",
  "instead", "please", "now", "with",
  "make", "made", "making", "switch", "switched", "switching",
  "change", "changed", "changing", "swap", "swapped", "swapping",
  "update", "updated", "updating",
  "can", "could", "you", "i", "want", "actually", "just", "one",
]);

/**
 * The authoritative, deterministic resolution for a customer message that
 * names an attribute change on a zero-option cart item. Returns `null`
 * when the change-language gate fails OR the cart doesn't have EXACTLY ONE
 * zero-option item (the ambiguous multi-item case is intentionally left to
 * the hint/GUARD-17 fallback below, not guessed at here).
 */
export function resolveZeroOptionAttributeChange(
  userMessage: string,
  cartLines: ZeroOptionCartLine[],
  effectiveMenu: ZeroOptionMenuItemFull[],
): ZeroOptionResolution | null {
  if (!CHANGE_VERB_RE.test(userMessage)) return null;

  const menuById = new Map(effectiveMenu.map(mi => [mi.id, mi]));
  const zeroOptionLines = cartLines.filter(line => {
    if (!line.menu_item_id) return false;
    const mi = menuById.get(line.menu_item_id);
    return Boolean(mi?.ask_plan && mi.ask_plan.steps.length === 0);
  });
  // Dedup by menu_item_id — two cart lines of the same zero-option item
  // (quantity 2 as two rows, or a re-add) is still ONE unambiguous item.
  const distinctIds = new Set(zeroOptionLines.map(l => l.menu_item_id));
  if (distinctIds.size !== 1) return null;

  const menuItemId = [...distinctIds][0]!;
  const menuItem = menuById.get(menuItemId)!;
  const itemDisplayName = menuItem.ask_plan!.display_name;

  // SAFETY GATE — without this, "switch my order to delivery" with a
  // zero-option bagel already in cart matches CHANGE_VERB_RE ("switch") and
  // would otherwise hijack a completely unrelated request: no alternative
  // item's name would match "order"/"delivery" either, so it would fall to
  // the "no match" branch and render "I can't change that on the Bagel with
  // Plain Cream Cheese" for a request that was never about the bagel at
  // all — and WORSE, short-circuit the turn so the customer's actual
  // request (their order type) never reaches the code that handles it.
  // Require at least one real word from the item's OWN name to also appear
  // in the message — the real repro's own phrasing ("an everything BAGEL
  // instead") already satisfies this by construction; an order-type/
  // delivery/tip/address change never will, because none of those share a
  // word with a menu item's name.
  // Crude singular/plural fold (strip a trailing "s") so "make them
  // everything bagelS instead" still overlaps with the item's own "Bagel"
  // — same tradeoff as normalize.ts's own singularize helper: only needs
  // to bridge ordinary plurals, not full English morphology.
  const fold = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
  const itemNameWords = new Set(
    itemDisplayName.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2).map(fold),
  );
  const messageWords = userMessage.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!messageWords.some(w => itemNameWords.has(fold(w)))) return null;

  // Real bug, caught live-verifying the very first deployed acceptance run:
  // candidateWords must ALSO exclude the current item's own name-words, not
  // just stopwords. "an everything bagel" contains "bagel" — the item's own
  // generic category word, shared by EVERY item in the "Bagel With"
  // category — so without this exclusion, the alternative search below
  // matched on "bagel" alone and returned the first same-category item it
  // happened to iterate to ("Bagel With Butter"), a nonsense answer 3/3
  // times (deterministic, but deterministically wrong). Only "everything"
  // — the word that ISN'T already part of this item's own name — is a
  // genuine descriptor worth searching for.
  const candidateWords = messageWords.filter(
    w => w.length > 2 && !REQUEST_STOPWORDS.has(w) && !itemNameWords.has(fold(w)),
  );

  let alternative: ZeroOptionResolution["alternative"] = null;
  for (const other of effectiveMenu) {
    if (other.id === menuItemId) continue;
    if (!other.ask_plan || other.category !== menuItem.category) continue;
    const otherFirstWord = fold(
      other.ask_plan.display_name.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "",
    );
    if (otherFirstWord && candidateWords.some(w => fold(w) === otherFirstWord)) {
      alternative = { id: other.id, name: other.ask_plan.display_name, priceCents: other.price_cents };
      break;
    }
  }

  return { menuItemId, itemDisplayName, rawRequest: userMessage.trim(), alternative };
}

/**
 * Renders the fixed, deterministic reply for a resolution — never
 * generated, never containing "switched"/"noted"/"got it" attached to a
 * change that didn't happen.
 */
export function renderZeroOptionAttributeChangeReply(resolution: ZeroOptionResolution): string {
  if (resolution.alternative) {
    const price = (resolution.alternative.priceCents / 100).toFixed(2);
    return `The ${resolution.alternative.name} is a separate item ($${price}) — want me to swap it in?`;
  }
  return `I can't change that on the ${resolution.itemDisplayName} — it doesn't have that option.`;
}

// ============================================================
// Fallback for the ambiguous case (2+ zero-option items in cart): a
// system-prompt nudge, not a guarantee. See this function's own history
// above (Shape 2) for why it's kept only as a fallback, not the primary
// mechanism, for the unambiguous case the resolver above now owns.
// ============================================================

/**
 * Returns a system-prompt addendum when the customer's message uses
 * change/switch language AND the current order has at least one item with
 * zero ask_plan steps (no configurable options at all) — or `null` when
 * neither condition holds, in which case the system prompt is unaffected.
 */
export function buildZeroOptionAttributeChangeHint(
  userMessage: string,
  cartLines: ZeroOptionCartLine[],
  effectiveMenu: ZeroOptionMenuItem[],
): string | null {
  if (!CHANGE_VERB_RE.test(userMessage)) return null;

  const menuById = new Map(effectiveMenu.map(mi => [mi.id, mi]));
  const zeroOptionNames = new Set<string>();
  for (const line of cartLines) {
    if (!line.menu_item_id) continue;
    const menuItem = menuById.get(line.menu_item_id);
    if (menuItem?.ask_plan && menuItem.ask_plan.steps.length === 0) {
      zeroOptionNames.add(menuItem.ask_plan.display_name);
    }
  }
  if (zeroOptionNames.size === 0) return null;

  const names = [...zeroOptionNames].join(", ");
  return (
    `\n\nIMPORTANT — HONESTY CHECK FOR THIS REPLY: the customer's message uses ` +
    `change/switch language, and the order currently includes these items with ` +
    `NO configurable options at all: ${names}. If the customer is asking to ` +
    `change an attribute of one of these (a bagel type, a topping, or anything ` +
    `else that isn't a real listed option), you may call set_note to record ` +
    `their preference for the kitchen, but your reply must be ONE honest, ` +
    `coherent message — never claim the item itself changed. For example: ` +
    `"I can't officially change the bagel type on that one, but I've noted ` +
    `everything bagel for the kitchen." Never say something was switched or ` +
    `changed and then contradict that in the same reply.`
  );
}
