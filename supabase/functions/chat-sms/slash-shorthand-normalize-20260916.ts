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
//
// Follow-up fix (2026-09-17, live QA report): the above scope collides with
// real menu data. Vito's has two live menu_items both literally named
// "Cheesesteak / Chicken Cheesesteak" (a whitespace-padded slash baked into
// the item's real name, not customer shorthand). The system prompt tells
// the model to recite menu item names to the customer VERBATIM, so the bot
// says "Cheesesteak / Chicken Cheesesteak" -- and if the customer names it
// back ("I'll take the Cheesesteak / Chicken Cheesesteak"), the naive
// regex above silently rewrites that to "Cheesesteak, Chicken Cheesesteak",
// which every downstream parser now reads as two separate items instead of
// the one the customer actually named. Same failure class (silent order
// corruption) as the original bug, triggered by the fix itself.
//
// Guard: callers may pass the shop's live menu item names. Any name that
// itself contains a whitespace-padded slash is a "protected" span -- if the
// customer's raw text contains that name (case-insensitive, whitespace
// runs collapsed to compare), the slash occurrence(s) inside that matched
// span are left untouched; every other spaced slash in the message is
// still normalized as before. Matching is exact-after-normalization, not
// typo-tolerant fuzzy matching -- deliberately, to keep this auditable and
// because both known live collisions are exact recitations of prompt text.
export function normalizeSlashShorthand(text: string, liveMenuItemNames: string[] = []): string {
  const protectedNames = liveMenuItemNames
    .filter(name => /\s\/\s/.test(name))
    .map(name => name.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(name => name.length > 0);

  if (protectedNames.length === 0) {
    return text.replace(/\s+\/\s+/g, ", ");
  }

  const { normalized, map } = buildNormalizedMap(text);
  const protectedRanges: Array<[number, number]> = [];
  for (const name of protectedNames) {
    let idx = normalized.indexOf(name);
    while (idx !== -1) {
      protectedRanges.push([map[idx], map[idx + name.length]]);
      idx = normalized.indexOf(name, idx + 1);
    }
  }

  if (protectedRanges.length === 0) {
    return text.replace(/\s+\/\s+/g, ", ");
  }

  const isProtected = (start: number, end: number) =>
    protectedRanges.some(([rangeStart, rangeEnd]) => start >= rangeStart && end <= rangeEnd);

  const re = /\s+\/\s+/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    result += text.slice(lastIndex, start);
    result += isProtected(start, end) ? match[0] : ", ";
    lastIndex = end;
  }
  result += text.slice(lastIndex);
  return result;
}

// Builds a lowercased, whitespace-collapsed view of `text` alongside a map
// from each character index in that view back to the original text index
// it came from (plus a trailing sentinel for the end position), so a match
// found in the normalized view can be translated back to an original-text
// span without re-scanning.
function buildNormalizedMap(text: string): { normalized: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      const start = i;
      while (i < n && /\s/.test(text[i])) i++;
      normalized += " ";
      map.push(start);
    } else {
      normalized += ch.toLowerCase();
      map.push(i);
      i++;
    }
  }
  map.push(n);
  return { normalized, map };
}
