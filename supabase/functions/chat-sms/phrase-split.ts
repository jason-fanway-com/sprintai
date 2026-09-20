// Shared phrase-boundary splitter for a multi-item customer message (P0,
// 2026-09-09, Zio's live money regression — "one plain, one pepperoni, one
// meat lover and one hawaai" bled the pepperoni topping onto the Meat
// Lover's AND Hawaiian lines too, because the ONLY previously-recognized
// boundary was a comma; "and" was invisible as a separator anywhere a
// consumer of this module split customer text).
//
// A phrase boundary is a comma, the word "and", or "&" — plus the implicit
// boundary a REPEATED leading digit quantity creates with no explicit
// separator at all ("1 cheese 1 pepperoni 1 meat lover 1 hawaiian").
//
// "and" only counts as a boundary when what immediately follows is itself a
// quantity or article (a digit, a number word, or "a"/"an"/"the"). This is
// what keeps a real dish name that happens to contain the word "and" ("Mac
// and Cheese", "Salt and Pepper Wings") from being torn in two — every
// phrase this splitter was built to handle states a quantity right after
// "and" ("...and one hawaiian", "...and a hawaiian", "...and a meat lover").
// The implicit digit-repeat boundary is deliberately narrower still (digits
// only, not word-numbers) — a bare number word ("one") appearing mid-phrase
// for an unrelated reason is a real risk; a bare digit essentially never is.
//
// Used by:
//   - pizza-topping-compose.ts's splitIntoSegments (deterministic bare-
//     topping/plain compose — one base-pizza item + choice per segment).
//   - ask-plan-engine.ts's isolatePhraseForItem (reactive modifier match,
//     scoped per item so a topping named in one phrase can't attach itself
//     to a DIFFERENT item resolved from a different phrase in the same
//     message).
const QTY_LEAD = "\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|the";
const PHRASE_SEPARATOR_RE = new RegExp(`,|&|\\band\\s+(?=(?:${QTY_LEAD})\\b)`, "i");
const IMPLICIT_DIGIT_REPEAT_RE = /\s+(?=\d+\s)/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A menu item's own display name is data, not phrasing — it must never be
// torn apart by the generic boundary heuristics above just because it
// happens to contain one of their trigger characters/words (e.g. Zio's real
// "Mac & Cheese Bites": the '&' is part of the dish name, not a separator
// between two dishes — live regression, 2026-09-10, §8.4 gate run against
// real Zio's data, 5/20 multi-item cases). Only names that actually contain
// a trigger are worth the match cost; a plain "Cheese Pizza" can't be
// mis-split regardless.
function findProtectedNames(menu: { name: string }[] | undefined): string[] {
  if (!menu || menu.length === 0) return [];
  return menu
    .map(m => m.name)
    .filter(name => name && /[,&]|\band\b/i.test(name))
    // Longest first: if one item's name is a substring of another's
    // (e.g. "Mac & Cheese Bites" vs. a hypothetical "Cheese Bites"), the
    // longer, more specific match must claim the span first.
    .sort((a, b) => b.length - a.length);
}

export function splitCustomerPhrases(text: string, menu?: { name: string }[]): string[] {
  const protectedNames = findProtectedNames(menu);
  if (protectedNames.length === 0) {
    return splitOnBoundaries(text);
  }

  // Mask every occurrence of a protected name behind a sentinel token before
  // splitting, then restore the original text into whichever phrase it
  // landed in — this keeps the name's own internal punctuation invisible to
  // PHRASE_SEPARATOR_RE without having to special-case any specific name.
  const restore: string[] = [];
  const nameRe = new RegExp(
    protectedNames.map(n => escapeRegex(n).replace(/\s+/g, "\\s+")).join("|"),
    "gi",
  );
  // Plain ASCII marker (no punctuation the boundary regexes react to, and no
  // digit directly touching whitespace) so masking never itself creates or
  // hides a phrase boundary.
  const masked = text.replace(nameRe, match => {
    restore.push(match);
    return `XPROTECTEDNAMEX${restore.length - 1}XPROTECTEDNAMEX`;
  });

  return splitOnBoundaries(masked).map(seg =>
    seg.replace(/XPROTECTEDNAMEX(\d+)XPROTECTEDNAMEX/g, (_m, i) => restore[Number(i)]),
  );
}

function splitOnBoundaries(text: string): string[] {
  return text
    .split(PHRASE_SEPARATOR_RE)
    .flatMap(seg => seg.split(IMPLICIT_DIGIT_REPEAT_RE))
    .map(s => s.trim())
    .filter(Boolean);
}

// P0 fix (2026-09-09, third recurrence of the pepperoni-bleed defect): the
// prior three fixes all tried to RE-DERIVE, after the fact, which phrase an
// already-resolved item/choice came from (context, position, word-stem
// overlap) — fragile by construction, since every derivation is a guess that
// works on the phrasing it was tested against and fails on the next one. The
// real fix moves identity to the front: the model's own add_item/modify_item
// tool call now states which words of its OWN message it's resolving
// (`source_phrase`), and this function VALIDATES that claim against the
// turn's real, structurally-split phrase boundaries — it is never trusted
// blindly, and it is never used to search for a plausible attachment; it
// either maps to exactly one real phrase or it doesn't (missing beats
// wrong, this codebase's standing principle — see ask-plan-engine.ts).
// Word-level containment, not raw string substring containment — a raw
// `.includes()` reads a short phrase's own letters as present INSIDE an
// unrelated longer word purely by coincidence ("Hi" — the comma-split
// artifact of "Hi, I'd like to order..." — is a literal substring of
// "White", so claim.includes("hi") was true for a "Gourmet White Fiesta"
// claim that has nothing to do with the greeting). That false match made two
// phrases match the same claim, so this returned null (genuinely ambiguous
// by its own contract) and every caller fell back to the UNSCOPED whole
// message — see this file's own scopedModifierText, whose entire job is to
// prevent exactly that. PO dispatch 2026-09-19 (M1, real live money bug,
// conv d95306c8 #26): that fallback is what let "Sausage" (a separate,
// pending pizza named earlier in the same message) get read as a topping
// mention on the Gourmet White Fiesta line two phrases later. Comparing
// word arrays for a contiguous run closes this without weakening the
// legitimate case this function exists for (a claim that's a real prefix/
// suffix/substring-of-words match against its own phrase, never a
// coincidental in-word letter run).
function containsWordRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    let matched = true;
    for (let i = 0; i < needle.length; i++) {
      if (haystack[start + i] !== needle[i]) { matched = false; break; }
    }
    if (matched) return true;
  }
  return false;
}

export function resolveClaimedPhraseIndex(phrases: string[], claimedPhrase: string): number | null {
  if (phrases.length <= 1) return phrases.length === 1 ? 0 : null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const claim = norm(claimedPhrase);
  if (!claim) return null;
  const claimWords = claim.split(" ").filter(Boolean);
  const matches: number[] = [];
  phrases.forEach((p, i) => {
    const pn = norm(p);
    if (!pn) return;
    const pnWords = pn.split(" ").filter(Boolean);
    if (containsWordRun(pnWords, claimWords) || containsWordRun(claimWords, pnWords)) matches.push(i);
  });
  return matches.length === 1 ? matches[0] : null;
}

function escapeRegexPublic(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// P0 fix (2026-09-10, PO-authorized structural follow-up — fourth live
// recurrence of the pepperoni/bacon-bleed defect family, this time as a real
// PRICED overcharge: "Chicken Bacon Ranch flatbread, BBQ Chicken flatbread
// with pepperoni, Cheesesteak flatbread, Margherita flatbread" applied and
// CHARGED a "Bacon" topping (present only as three letters of item 1's own
// display name, never requested) onto all four lines, via
// reactive-modifier-match.ts's matchReactiveExtras being handed the RAW,
// UNSCOPED, UN-STRIPPED whole-turn customerMessage). Three call sites
// (legacy reactive-modifier matching, GUARD 12, GUARD 16) had each
// independently re-derived their own version of "what text may this item's
// modifier claim be matched against" — this is the ONE shared answer, so a
// future guard or resolver gets this defect class fixed for free instead of
// becoming a fifth ad hoc re-derivation.
//
// Two rules, both required (a live incident exists for skipping either):
//  1. Scope to the item's OWN claimed phrase, never the whole turn — a word
//     spoken for ONE phrase (e.g. "pepperoni" naming its own pizza) must
//     never be readable as a claim for any OTHER phrase's item.
//  2. Strip the item's OWN display name from that phrase, as one contiguous
//     unit (not word-by-word) — naming the item is not the customer asking
//     for an ingredient of its name as a separate modifier, but stripping
//     word-by-word would also destroy a genuinely separate, later mention of
//     the same word in the same phrase ("Chicken Bacon Ranch with extra
//     bacon" must still see the real "extra bacon" request after "chicken
///    bacon ranch" is removed as one unit — word-by-word erasure would wipe
//     BOTH, wrongly dropping a real customer ask).
//
// Fallback is "whole text" (not "" / not undefined) for a single-phrase turn
// or an unresolved phrase claim — same "no worse than before this fix"
// contract every caller already had; this function only ever narrows what a
// caller used to see, never taking away resolution ability nothing here
// alone was regressing.
export function scopedModifierText(
  phrases: string[],
  phraseIndex: number | null | undefined,
  itemName: string,
  wholeText: string,
): string {
  const scoped = phrases.length > 1 && phraseIndex !== null && phraseIndex !== undefined && phraseIndex < phrases.length
    ? phrases[phraseIndex]
    : wholeText;
  if (!itemName) return scoped;
  // Freeze-queue item 6, part C (2026-09-19 PO dispatch, real Vito's
  // Quesadillas "Chicken" item): NOT global. This function's own header
  // already establishes the rule a later, separate mention of the same
  // word must survive ("Chicken Bacon Ranch with extra bacon" keeps
  // "bacon" because the multi-word contiguous unit "chicken bacon ranch"
  // never matches a later BARE "bacon") — but a `g` flag broke that same
  // rule whenever the item's own name IS a single bare word ("Chicken"),
  // since every standalone occurrence of that one word, including a
  // genuinely separate later request for the identically-named add-on
  // ("a Chicken quesadilla with grilled chicken"), matches the "contiguous
  // unit" trivially and got erased. Stripping only the FIRST occurrence —
  // the one that actually named the item — restores the header's own
  // stated intent for a single-word name without changing anything for a
  // multi-word name (which essentially never repeats verbatim in the same
  // phrase anyway).
  const nameRe = new RegExp(`\\b${escapeRegexPublic(itemName).replace(/\s+/g, "\\s+")}\\b`, "i");
  return scoped.replace(nameRe, " ");
}

// PO dispatch 2026-09-19 (M1 rule 1, real live money bug, conv d95306c8
// #26): "a Sausage Pizza - Small and a Gourmet White Fiesta - Large" wrongly
// billed a $4.50 Sausage topping onto the Gourmet White Fiesta line AND left
// "Sausage Pizza" pending its own which-one question — the same word
// double-counted as a topping on one line and a whole separate item on
// another. scopedModifierText above is supposed to prevent the 00-BF
// modifier floor from ever seeing another item's own words, but it can
// still fall back to the UNSCOPED whole message (a single-phrase message,
// or a claim that doesn't resolve to exactly one phrase — see
// resolveClaimedPhraseIndex's own word-boundary fix for the specific way
// that happened here). This is the backstop, applied regardless of how the
// scoped text was derived: a span that is ALREADY spoken for in this
// message — another add resolved to a real item, or a span still pending
// its own which-one question — is stripped out before the topping scan
// ever sees it, whole-word-boundary, contiguous-run removal (same
// discipline as scopedModifierText's own item-name strip just above).
// Spans under 3 characters are left alone; too short to safely remove as a
// unit without risking a real word elsewhere in the text.
export function stripOtherItemSpansFromModifierText(text: string, otherSpans: string[]): string {
  let result = text;
  for (const span of otherSpans) {
    const trimmed = span.trim();
    if (trimmed.length < 3) continue;
    const escaped = escapeRegexPublic(trimmed).replace(/\s+/g, "\\s+");
    result = result.replace(new RegExp(`\\b${escaped}\\b`, "i"), " ");
  }
  return result;
}
