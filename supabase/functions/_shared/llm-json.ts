/**
 * Parse JSON out of a raw LLM chat-completion message body.
 *
 * OpenRouter's anthropic/* passthrough does not honor
 * `response_format: {type: "json_object"}` reliably — it can wrap valid JSON
 * in a ```json code fence anyway. JSON.parse on that raw string throws, and
 * callers that swallow the error silently lose the whole extraction. This
 * strips a leading/trailing fence, then falls back to slicing from the first
 * `{`/`[` to the last matching `}`/`]` (handles prose-then-JSON replies).
 * Returns null — and always logs why — when nothing parses.
 */
export function parseLlmJson<T = unknown>(raw: string | null | undefined): T | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    console.error("[parseLlmJson] empty response");
    return null;
  }

  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  try {
    return JSON.parse(unfenced) as T;
  } catch (firstErr) {
    const firstBrace = unfenced.indexOf("{");
    const firstBracket = unfenced.indexOf("[");
    const start = firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);

    if (start === -1) {
      console.error(
        "[parseLlmJson] no JSON object/array found. First 300 chars:",
        trimmed.slice(0, 300),
        "error:", firstErr,
      );
      return null;
    }

    const closeChar = unfenced[start] === "{" ? "}" : "]";
    const end = unfenced.lastIndexOf(closeChar);
    if (end <= start) {
      console.error(
        "[parseLlmJson] no closing bracket found (likely truncated). First 300 chars:",
        trimmed.slice(0, 300), "error:", firstErr,
      );
      return null;
    }

    try {
      return JSON.parse(unfenced.slice(start, end + 1)) as T;
    } catch (secondErr) {
      console.error(
        "[parseLlmJson] parse failed after fence-strip + slice. First 300 chars:",
        trimmed.slice(0, 300), "error:", secondErr,
      );
      return null;
    }
  }
}
