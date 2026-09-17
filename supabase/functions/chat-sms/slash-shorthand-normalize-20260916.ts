// Bug fix (2026-09-16, live report): a customer texting in a hurry
// compresses a multi-clause order behind slashes instead of commas, e.g.
// "cheeseburger / medium / thats it". Live-endpoint testing against the
// deployed model proved this is NOT a code bug swallowing a valid tool call
// -- the compiled/deterministic add_item path behaves identically for a
// slash- or comma- delimited message once it reaches it. The failure is
// upstream: the model itself intermittently reads "/" between clauses as
// "or" (an either/or choice, "coke or sprite?") rather than "and" (multiple
// clauses stated together) and responds with a clarifying question instead
// of ordering, leaving the cart silently empty. A live comparison (n=8 each,
// same session shape, same model) measured a ~70-90% empty-cart failure rate
// for slash-delimited turns against a ~25% failure rate for the equivalent
// comma-delimited phrasing -- the SAME model is dramatically more reliable
// once the delimiter is a comma. A prompt-only instruction telling the model
// to treat "/" like "," did not move that rate in the same live comparison
// (the instruction competes with thousands of words of other system-prompt
// content and this model does not reliably prioritize it here) -- so the
// fix normalizes the text itself, upstream of both the model call and every
// deterministic parser (phrase-split.ts, resolve-item.ts, guard19, etc.),
// rather than trusting the model to apply an instruction it has already
// been shown not to reliably follow.
//
// Scope is deliberately narrow: only a slash with whitespace on BOTH sides
// ("cheeseburger / medium") is treated as a phrase-shorthand delimiter and
// rewritten to a comma. A slash with no surrounding whitespace is left
// completely alone -- "1/2", "50/50", "N/A", a date like "9/16", or a
// menu-name compound like "Rare/Medium" never match, since none of those
// are the customer using "/" AS whitespace-separated shorthand for "and".
export function normalizeSlashShorthand(text: string): string {
  return text.replace(/\s+\/\s+/g, ", ");
}
