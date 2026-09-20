// normalize.ts — the ONLY place customer text is normalized for matching.
// Pure string hygiene plus a fixed alias table. No intent detection lives here.

const ALIASES: Record<string, string> = {
  lg: "large", lrg: "large", l: "large",
  med: "medium", md: "medium", m: "medium",
  sm: "small", s: "small",
  xl: "xlarge", "x-large": "xlarge", "extra-large": "xlarge",
  w: "with",
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
  return n.split(" ").map((w) => ALIASES[w] ?? w.replace(/-/g, "")).filter((w) => w.length > 0);
}

/** Index at which `needle` occurs in `hay` as a contiguous whole-word run, else -1. */
export function findWordRun(hay: string[], needle: string[], from = 0): number {
  if (needle.length === 0 || needle.length > hay.length) return -1;
  for (let i = from; i <= hay.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/** True when every word of `sub` appears somewhere in `sup`. */
export function isWordSubset(sub: string[], sup: string[]): boolean {
  const set = new Set(sup);
  return sub.length > 0 && sub.every((w) => set.has(w));
}

export function sameWords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

export function isDigits(s: string): boolean { return /^\s*\d+\s*$/.test(s); }
export function singular(w: string): string { return w.endsWith("s") ? w.slice(0, -1) : w; }

export const SIZE_WORDS = new Set(["small", "medium", "large", "xlarge", "personal", "sheet", "cup", "bowl", "half", "whole", "regular"]);
export const STOPWORDS = new Set(["a", "an", "the", "of", "with", "and", "please", "some", "order", "side", "one", "two", "three", "for", "me", "get", "want", "like", "id", "i", "can", "have", "to", "my", "on", "it", "that", "just", "thanks", "thank", "you", "pls", "plz"]);
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
