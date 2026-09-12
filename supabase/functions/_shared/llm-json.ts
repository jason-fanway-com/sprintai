/**
 * Parse JSON out of a raw LLM chat-completion message body.
 *
 * This is the SINGLE shared implementation of "strip fences / extract a
 * balanced JSON value / repair common LLM formatting mistakes / recover from
 * truncation" — the mechanics behind `parseLlmJson` (this file),
 * `parseJudgeJson` (judge-rubric.ts), and `parseExtractionResult`
 * (parse-menu-pdf/index.ts). Each of those three call sites has slightly
 * different requirements (object-only vs object-or-array, schema-aware
 * truncation recovery vs none), so `extractLlmJson` is parameterized rather
 * than forked — a fix to the fence-stripping or bracket-matching logic here
 * now reaches all three call sites instead of just one.
 *
 * OpenRouter's anthropic/* passthrough does not honor
 * `response_format: {type: "json_object"}` reliably — it can wrap valid JSON
 * in a ```json code fence anyway, or the reply gets cut off mid-object when
 * max_tokens is hit. JSON.parse on that raw string throws, and callers that
 * swallow the error silently lose the whole extraction.
 */

export interface ExtractLlmJsonOptions<T = unknown> {
  /** Only accept an object result (rejects arrays and primitives). Default: false. */
  objectOnly?: boolean;
  /** Attempt trailing-comma / single-quoted-key-or-value repair when a balanced candidate fails to parse. Default: true. */
  repairCommonErrors?: boolean;
  /**
   * Schema-aware last resort invoked with the fence-stripped text when
   * nothing else parses (e.g. the LLM reply was truncated mid-object).
   * Return the recovered value, or null/undefined to give up.
   */
  recoverTruncated?: (strippedText: string) => T | null | undefined;
  /** Called at most once, only on final failure, with a reason and a text snippet for logging. */
  onFailure?: (reason: string, snippet: string) => void;
}

function firstJsonStart(text: string, objectOnly: boolean): number {
  const brace = text.indexOf("{");
  if (objectOnly) return brace;
  const bracket = text.indexOf("[");
  if (brace === -1) return bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}

/**
 * Scan forward from `from` (which need not itself be an opening bracket)
 * tracking `openCh`/`closeCh` depth while skipping over string literals
 * (including escaped characters), and return the index of the closing
 * bracket where depth returns to zero, or -1 if it never balances.
 */
export function indexOfBalancedClose(
  text: string,
  from: number,
  openCh: string,
  closeCh: string,
): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Extract the balanced `{...}`/`[...]` substring starting exactly at `start`, or null if unbalanced. */
export function extractBalancedJson(text: string, start: number): string | null {
  const openCh = text[start];
  const closeCh = openCh === "{" ? "}" : openCh === "[" ? "]" : undefined;
  if (!closeCh) return null;
  const end = indexOfBalancedClose(text, start, openCh, closeCh);
  return end === -1 ? null : text.slice(start, end + 1);
}

function repairCommonJsonErrors(jsonStr: string): string {
  return jsonStr
    // Remove trailing commas
    .replace(/,\s*([}\]])/g, "$1")
    // Fix single-quoted keys: {'key': -> {"key":
    .replace(/([{,]\s*)'([^']+)'(\s*:)/g, '$1"$2"$3')
    // Fix single-quoted string values: :'val' -> :"val"
    .replace(/(:\s*)'([^']*)'(\s*[,}\]])/g, '$1"$2"$3');
}

function stripCodeFences(text: string, objectOnly: boolean): string {
  let stripped = text
    .replace(/^[ \t]*```[a-zA-Z]*\s*\n?/gm, "")
    .replace(/^[ \t]*~~~[a-zA-Z]*\s*\n?/gm, "")
    .replace(/```\s*$/gm, "")
    .replace(/~~~\s*$/gm, "")
    .trim();

  if (stripped.includes("```")) {
    // A stray fence marker survived (e.g. an unclosed opening fence). Trim
    // trailing "```" / "```json" remnants, then drop anything before the
    // first JSON value.
    const lastFence = stripped.lastIndexOf("```");
    if (lastFence > 0) {
      const afterFence = stripped.slice(lastFence + 3).trim();
      if (afterFence === "" || afterFence === "json") {
        stripped = stripped.slice(0, lastFence).trim();
      }
    }
    const start = firstJsonStart(stripped, objectOnly);
    if (start > 0) {
      stripped = stripped.slice(start);
    }
  }

  return stripped;
}

/**
 * Extract a JSON value from raw LLM text. Strategy:
 *   1. Strip markdown code fences (any flavor: ```json, ```, ~~~json, ~~~).
 *   2. Fast path: try parsing the whole stripped string.
 *   3. Balanced-bracket scan: find the first `{`/`[` and its true matching
 *      close, respecting strings/escapes (tolerates leading/trailing prose).
 *   4. If that candidate fails to parse, optionally repair common LLM
 *      formatting mistakes (trailing commas, single-quoted keys/values).
 *   5. If still nothing parses, hand the stripped text to the caller's
 *      `recoverTruncated` hook (for schema-aware truncation recovery).
 * Returns null — and calls `onFailure` at most once — when nothing parses.
 */
export function extractLlmJson<T = unknown>(
  raw: string | null | undefined,
  options: ExtractLlmJsonOptions<T> = {},
): T | null {
  const {
    objectOnly = false,
    repairCommonErrors = true,
    recoverTruncated,
    onFailure,
  } = options;

  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    onFailure?.("empty response", "");
    return null;
  }

  const stripped = stripCodeFences(trimmed, objectOnly);

  const acceptable = (value: unknown): value is T =>
    !objectOnly || (value !== null && typeof value === "object" && !Array.isArray(value));

  const tryRecover = (): T | null => {
    if (!recoverTruncated) return null;
    const recovered = recoverTruncated(stripped);
    return recovered === null || recovered === undefined ? null : recovered;
  };

  try {
    const fast = JSON.parse(stripped);
    if (acceptable(fast)) return fast;
  } catch { /* fall through to balanced scan */ }

  const start = firstJsonStart(stripped, objectOnly);
  if (start === -1) {
    const recovered = tryRecover();
    if (recovered !== null) return recovered;
    onFailure?.("no JSON object/array found", stripped.slice(0, 300));
    return null;
  }

  const candidate = extractBalancedJson(stripped, start);
  if (!candidate) {
    const recovered = tryRecover();
    if (recovered !== null) return recovered;
    onFailure?.("no closing bracket found (likely truncated)", stripped.slice(0, 300));
    return null;
  }

  try {
    const parsed = JSON.parse(candidate);
    if (acceptable(parsed)) return parsed;
  } catch {
    if (repairCommonErrors) {
      try {
        const repaired = JSON.parse(repairCommonJsonErrors(candidate));
        if (acceptable(repaired)) return repaired;
      } catch { /* fall through */ }
    }
  }

  const recovered = tryRecover();
  if (recovered !== null) return recovered;
  onFailure?.("parse failed after fence-strip + slice", stripped.slice(0, 300));
  return null;
}

export function parseLlmJson<T = unknown>(raw: string | null | undefined): T | null {
  return extractLlmJson<T>(raw, {
    onFailure: (reason, snippet) => {
      if (snippet) {
        console.error(`[parseLlmJson] ${reason}. First 300 chars:`, snippet);
      } else {
        console.error(`[parseLlmJson] ${reason}`);
      }
    },
  });
}
