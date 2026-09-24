// normalize.ts — the ONLY place customer text is normalized for matching.
// Pure string hygiene plus a fixed alias table. No intent detection lives here.

const ALIASES: Record<string, string> = {
  lg: "large", lrg: "large", l: "large", med: "medium", md: "medium", m: "medium", sm: "small", s: "small",
  xl: "xlarge", "x-large": "xlarge", "extra-large": "xlarge", w: "with",
};

export function normalize(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, " ")
    .replace(/'/g, "")
    .replace(/(\d+)\s*"/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function words(text: string): string[] {
  const n = normalize(text);
  if (!n) return [];
  return n.split(" ").map((w) => ALIASES[w] ?? w.replace(/-/g, "")).filter((w) => w.length > 0 && w !== "and" && w !== "n");
}

/** Index at which `needle` occurs in `hay` as a contiguous whole-word run, else -1. */
export function findWordRun(hay: string[], needle: string[], from = 0, eq: (a: string, b: string) => boolean = (a, b) => a === b): number {
  if (needle.length === 0 || needle.length > hay.length) return -1;
  for (let i = from; i <= hay.length - needle.length; i++) {
    if (needle.every((w, j) => eq(hay[i + j], w))) return i;
  }
  return -1;
}

/** True when every word of `sub` appears somewhere in `sup`. */
export function isWordSubset(sub: string[], sup: string[]): boolean { const set = new Set(sup); return sub.length > 0 && sub.every((w) => set.has(w)); }

export function sameWords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

export function isDigits(s: string): boolean { return /^\s*\d+\s*$/.test(s); }
export function singular(w: string): string { return w.endsWith("s") ? w.slice(0, -1) : w; }

/** The same word up to a plural ending: sandwich/sandwiches, pie/pies, fry/fries, wing/wings. */
export function sameWord(a: string, b: string): boolean { const [s, l] = a.length <= b.length ? [a, b] : [b, a]; return a === b || l === s + "s" || l === s + "es" || (s.endsWith("y") && l === s.slice(0, -1) + "ies"); }



export const SIZE_WORDS = new Set(["small", "medium", "large", "xlarge", "personal", "sheet", "cup", "bowl", "pint", "quart", "half", "whole", "regular"]);
export const STOPWORDS = new Set(["a", "an", "the", "of", "with", "and", "please", "some", "order", "side", "one", "two", "three", "for", "me", "get", "want", "like", "id", "i", "can", "have", "to", "my", "on", "it", "that", "just", "thanks", "thank", "you", "pls", "plz", "size", "sized", "inch", "inches"]);
/** The words of a span that could name an item: no stopwords, no size words. */
export function contentWords(text: string): string[] { return words(text).filter((w) => !STOPWORDS.has(w) && !SIZE_WORDS.has(w)); }

const OPTION_LEAD = new Set(["with", "no", "extra", "add", "and"]);
/** Comparable key for an option phrase: normalized words minus a leading connector. */
export function optionKey(text: string): string {
  const w = words(text);
  while (w.length > 1 && OPTION_LEAD.has(w[0])) w.shift();
  return w.join(" ");
}

const NUMBER_WORDS: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, half: 0 };
/** "6 plain" -> {count: 6, rest: "plain"}; "plain" -> {count: null, rest: "plain"} */
export function leadingCount(text: string): { count: number | null; rest: string } {
  const w = words(text);
  if (w.length === 0) return { count: null, rest: "" };
  if (isDigits(w[0])) return { count: parseInt(w[0], 10), rest: w.slice(1).join(" ") };
  if (w[0] in NUMBER_WORDS && NUMBER_WORDS[w[0]] > 0 && w.length > 1) return { count: NUMBER_WORDS[w[0]], rest: w.slice(1).join(" ") };
  return { count: null, rest: w.join(" ") };
}

/** Split "6 plain, 6 everything and 2 sesame" into its parts. */
export function splitList(text: string): string[] {
  return text.split(/\s*(?:,|\band\b|\+|;|\bplus\b)\s*/i).map((x) => x.trim()).filter(Boolean);
}

/** The count a phrase implies for a bundle: "a dozen" 12, "half a dozen" 6, "12 bagels" 12; null when none. */
export function impliedCount(text: string): number | null {
  const w = words(text);
  for (let i = 0; i < w.length; i++) {
    if (w[i] === "dozen") return i > 0 && w[i - 1] === "half" ? 6 : 12;
    if (isDigits(w[i])) return parseInt(w[i], 10);
  }
  return null;
}

/** Words of an option phrase: stopwords removed, size and placement words kept ("half anchovies on it" -> half anchovies). */
export function optionWords(text: string): string[] { return words(text).filter((w) => !STOPWORDS.has(w)); }

/** A model-written conversational sentence is allowed only if it makes no money or action claims. */
export function validTalk(raw: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || text.length > 240) return null;
  if (/\$|\d{1,3}\.\d\d|\b(added|removed|updated|changed|charged|free|discount|refund)\b/i.test(text)) return null;
  // no promises to contact, no claims about what it can see or what the menu has
  return talkClaimsTime(text) || /\b(let me|i'?ll|i will|going to|gonna|we'?ll)\s+(add|remove|change|update|swap|put|fix|take)\b/i.test(text) || /\b(text|call|notify|message|ping|let you know|send you a)\b.*\b(you|when|once)\b/i.test(text) || /\b(can'?t|cannot|don'?t|unable to)\s+(see|access|view|check|find)\b|\bnot (on|in) (our|the) (menu|system)\b|\bnot (finding|seeing)\b|\b(we|i) (don'?t|do not|dont) (think we |believe we )?have\b|\border system\b/i.test(text) ? null : text;
}
export function talkClaimsTime(raw: string): boolean { return /\b(\d+|an?|half an?)\s*(-|to|–)?\s*\d*\s*(min|mins|minutes?|hours?|hrs?)\b/i.test(raw); } // "15-20 minutes", "about an hour": times are not ours to promise

/** "hawiaan" -> "hawaiian": the unique menu word within one edit (two for longer words), or null. Pure string distance, no guessing. */
export function closestWord(w: string, vocab: Iterable<string>): string | null {
  if (w.length < 4 || /\d/.test(w)) return null;
  const budget = w.length >= 6 ? 2 : 1, hits: Array<[number, string]> = [];
  for (const v of vocab) if (v !== w && Math.abs(v.length - w.length) <= budget) { const d = editDistance(w, v, budget); if (d <= budget) hits.push([d, v]); }
  hits.sort((x, y) => x[0] - y[0]);
  return hits.length > 0 && (hits.length === 1 || hits[0][0] < hits[1][0]) ? hits[0][1] : null; // one clear winner, or nothing
}
function editDistance(a: string, b: string, max: number): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    if (Math.min(...cur) > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
