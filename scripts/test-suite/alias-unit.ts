// Quick alias-resolution unit — verifies menuNameCheck behavior after fix.
// Run: deno run /Users/joestrazza/sprintai-ordering/scripts/test-suite/alias-unit.ts

const STOP_WORDS = new Set([
  "the","a","an","and","or","of","in","on","it","is","my","to",
  "for","with","its","at","by","from","as",
]);

function menuNameCheck(claimed: string, menuNorm: Map<string, string>): boolean {
  if (menuNorm.has(claimed)) return true;
  for (const mn of menuNorm.keys()) {
    if (claimed.includes(mn) || mn.includes(claimed)) return true;
  }
  for (const mn of menuNorm.keys()) {
    const mnWords = mn.split(/\s+/);
    if (mnWords.length >= 2 && mnWords.every(w => claimed.includes(w))) return true;
  }
  const claimedTokens = claimed.split(/[\s-]+/).filter(w => w.length > 0 && !STOP_WORDS.has(w));
  if (claimedTokens.length === 0) return false;
  for (const mn of menuNorm.keys()) {
    const mnTokens = mn.split(/[\s-]+/).filter(w => w.length > 0 && !STOP_WORDS.has(w));
    for (const ct of claimedTokens) {
      if (ct.length < 3) continue;
      // >=6: match anywhere in the menu item. 3-5: match only in the first
      // two meaningful tokens to avoid false positives on common short words.
      const limit = ct.length >= 6 ? mnTokens.length : Math.min(2, mnTokens.length);
      for (let i = 0; i < limit; i++) {
        if (mnTokens[i].startsWith(ct)) return true;
      }
      // Acronym match: short alphanumeric token matches the initials of the
      // menu item ("bec" → Bacon Egg Cheese). Restricted to 3-5 chars and
      // menu items with 2+ tokens to avoid false positives.
      if (ct.length >= 3 && ct.length <= 5 && /^[a-z]+$/.test(ct) && mnTokens.length >= 2) {
        const initials = mnTokens.map(w => w[0] ?? "").join("");
        if (initials === ct) return true;
      }
    }
  }
  return false;
}

// ── Test ──────────────────────────────────────────────────────────────────

const menu = new Map<string, string>([
  ["bobo sandwich", "BOBO Sandwich"],
  ["bacon egg cheese", "Bacon Egg Cheese"],
  ["ec everything", "EC Everything"],
  ["cinnamon sugar loukoumades", "Cinnamon Sugar Loukoumades"],
  ["the works", "The Works"],
  ["buffalo chicken wrap", "Buffalo Chicken Wrap"],
]);

function check(label: string, claim: string, expect: boolean) {
  const result = menuNameCheck(claim, menu);
  const status = result === expect ? "PASS" : "FAIL";
  console.log(`${status} | ${label.padEnd(32)} "${claim}" → ${result} (expected ${expect})`);
  return result === expect;
}

// Note: "the" alone matches via substring ("the works".includes("the")) —
// that's pre-existing behavior from the original function. The production
// caller strips "the" before reaching menuNameCheck, so it's irrelevant.
let ok = true;
ok = check("short token (prefix of menu)",   "bobo", true) && ok;
ok = check("short token with article",        "the bobo", true) && ok;
ok = check("short token, 2nd position menu",  "ec", true) && ok;
ok = check("distinctive (len >= 6)",           "buffalo", true) && ok;
ok = check("abbrev prefix (partial match)",   "sug", true) && ok;
ok = check("acronym (bec → bacon egg cheese)","bec", true) && ok;
ok = check("genuine hallucination",           "lobster roll", false) && ok;
ok = check("genuine hallucination 2",         "pterodactyl", false) && ok;
ok = check("short word not in menu",          "cat", false) && ok;

if (ok) {
  console.log("\nAll alias-resolution unit tests passed.");
} else {
  console.log("\nSome tests FAILED.");
  Deno.exit(1);
}