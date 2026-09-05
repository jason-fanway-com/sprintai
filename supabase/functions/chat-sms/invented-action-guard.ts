// Defect 1 (2026-09-05, Jason's live simulator test, transcript
// 35ab0c44-fdae-455a-acf0-960e8d1d59e5): asked for wings, the bot twice said
// "Let me check with the kitchen on which ones we have." It checks with nobody.
//
// Root cause was OUR PROMPT, not model freelancing: the OPTION GROUNDING block
// offered "or offer to check" and shipped "Let me check which dressings we have"
// as an APPROVED example, and the unconfigured WING POLICY block said "Ask, or
// say you will check with the kitchen." Those are fixed in index.ts. This module
// is the deterministic backstop, because a prompt rule is probabilistic and the
// previous grounding fix moved the lie rather than removing it.
//
// Design constraint, learned the hard way from Guards 1c/1f/2c: NEVER discard a
// reply. Remove only the offending sentence and ship the rest. The customer's
// question still gets answered.

// The promise: "let me / I'll / one moment ..." — a stall or a hand-off.
const OPENER =
  "(?:let\\s+me|lemme|i['’]?ll|i\\s+will|i\\s+can|i\\s+am\\s+going\\s+to|i['’]?m\\s+going\\s+to|gonna|" +
  "give\\s+me\\s+(?:a\\s+)?(?:sec|second|moment|minute|min)|one\\s+(?:sec|second|moment|minute)|" +
  "hold\\s+on|hang\\s+on|bear\\s+with\\s+me|let\\s+me\\s+just)";

// The act it cannot perform. Deliberately excludes things the tools DO:
// add, remove, note, send the link, get it started.
const ACT =
  "(?:check(?:\\s+with)?|double[-\\s]?check|confirm\\s+with|verify\\s+with|ask\\s+(?:the|our|them|around|someone|the\\s+kitchen)|" +
  "find\\s+out|look\\s+(?:that|it|them|this)?\\s*up|see\\s+what(?:['’]s)?\\s+(?:we|they|available|in)|" +
  "get\\s+back\\s+to\\s+you|run\\s+it\\s+by|reach\\s+out\\s+to)";

const INVENTED_ACTION = new RegExp(`\\b${OPENER}\\b[^.!?\\n]{0,60}?\\b${ACT}\\b`, "i");

// A DENIAL is the behaviour we want, not the lie. "I can't check with the
// kitchen" and "I'm not calling anyone" are the honest sentences this whole fix
// exists to produce — stripping them would repeat the original defect in
// reverse. Caught live on the 2026-09-05 replay: the model wrote "I don't have
// them to share, and I can't check with the kitchen" and the first draft of
// this guard deleted the truthful half.
const NEGATED = /\b(?:can(?:no|['’])?t|cannot|won['’]?t|do(?:n['’]?t| not)|isn['’]?t|am not|i['’]m not|never|unable|no way to|not)\b/i;

/** A match is a PROMISE only when nothing inside it negates the action. */
function isPromise(fragment: string): boolean {
  const m = fragment.match(INVENTED_ACTION);
  return !!m && !NEGATED.test(m[0]);
}

// A trailing clause hanging off a legitimate sentence:
// "What flavor are you thinking - let me check with the kitchen"
const TRAILING_CLAUSE = new RegExp(
  `\\s*[—–,;-]\\s*(?:and\\s+|but\\s+)?${OPENER}\\b[^.!?\\n]{0,60}?\\b${ACT}\\b[^.!?\\n]*`,
  "gi",
);

/** True when this fragment promises an action the bot cannot take. */
export function claimsInventedAction(text: string): boolean {
  if (!text) return false;
  return isPromise(text);
}

/**
 * Remove invented-action promises, keeping everything else the model wrote.
 * Returns the original string when nothing matched, so the common path is free.
 */
export function stripInventedActions(reply: string): string {
  if (!reply || !isPromise(reply)) return reply;

  // 1) Drop trailing clauses first ("What flavor would you like - let me check
  //    with the kitchen"), so the sentence they hang off survives step 2.
  const declaused = reply.replace(TRAILING_CLAUSE, (m) => (NEGATED.test(m) ? m : ""));

  // 2) Drop whole sentences that exist only to promise the check.
  let out = declaused
    .split(/(?<=[.!?\n])\s+/)
    .filter((s) => !isPromise(s))
    .join(" ");

  out = out.replace(/\s{2,}/g, " ").replace(/^[\s,;:—–-]+|[\s,;:—–-]+$/g, "").trim();

  // Never ship an empty or stub reply: the customer asked something.
  if (out.length < 12) {
    return "I don't have that detail on hand - what would you like?";
  }
  return out;
}
