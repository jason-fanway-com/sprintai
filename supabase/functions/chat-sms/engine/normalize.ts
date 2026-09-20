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
