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

export function splitCustomerPhrases(text: string): string[] {
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
export function resolveClaimedPhraseIndex(phrases: string[], claimedPhrase: string): number | null {
  if (phrases.length <= 1) return phrases.length === 1 ? 0 : null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const claim = norm(claimedPhrase);
  if (!claim) return null;
  const matches: number[] = [];
  phrases.forEach((p, i) => {
    const pn = norm(p);
    if (pn && (pn.includes(claim) || claim.includes(pn))) matches.push(i);
  });
  return matches.length === 1 ? matches[0] : null;
}
