#!/usr/bin/env deno run --allow-read --allow-write
/**
 * segments.ts — GSM-7 segment counter for SprintAI QA results.
 *
 * Counts segments per bot reply across all completed test cases.
 * GSM-7: 160 chars/segment (1st), 153 chars/segment (subsequent).
 * UCS-2: 70 chars/segment (1st), 67 chars/segment (subsequent).
 * Automatically detects charset per message.
 *
 * Usage:
 *   deno run --allow-read scripts/test-suite/segments.ts <logfile>
 *   deno run --allow-read scripts/test-suite/segments.ts /tmp/njb_pr_full3_1787420249.log
 */

// ── GSM-7 Character Set ─────────────────────────────────────────────────────
// Standard GSM-7 alphabet (3GPP TS 23.038). Characters not in this set
// trigger UCS-2 encoding.
const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
    .split("")
);

// Extended characters (require escape code = 2 GSM-7 chars)
const GSM7_EXTENDED = new Set("|^{}[]~\\€");

/**
 * Returns true if the message can be encoded in GSM-7.
 */
function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXTENDED.has(ch)) return false;
  }
  return true;
}

/**
 * Count GSM-7 chars accounting for extended chars (which use 2 chars each).
 */
function gsm7CharCount(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (GSM7_EXTENDED.has(ch)) count += 2;
    else count += 1;
  }
  return count;
}

/**
 * Number of SMS segments for a message.
 */
function segmentCount(text: string): number {
  const len = text.length;
  if (len === 0) return 0;
  if (isGsm7(text)) {
    const chars = gsm7CharCount(text);
    if (chars <= 160) return 1;
    return 1 + Math.ceil((chars - 160) / 153);
  }
  // UCS-2
  if (len <= 70) return 1;
  return 1 + Math.ceil((len - 70) / 67);
}

// ── Log Parser ──────────────────────────────────────────────────────────────

interface CaseSegmentData {
  caseId: string;
  label: string;
  totalReplies: number;
  totalSegments: number;
  segmentsPerReply: number[];
  charsPerReply: number[];
}

/**
 * Parse the QA suite log to extract bot replies for each completed case.
 * Expected log format per case:
 *   [N/100] case-id: label
 *     → X turns returned
 *     → PASS | X/Y criteria | cost $...
 */
function parseLog(logPath: string): CaseSegmentData[] {
  const text = Deno.readTextFileSync(logPath);
  const lines = text.split("\n");

  const results: CaseSegmentData[] = [];
  let currentCase: CaseSegmentData | null = null;

  // We don't have raw replies in the log — we need to extract from the
  // JSON transcript if available, or estimate from what we have.
  // For initial pass, we'll extract what we can from the log,
  // then supplement with a re-run against the actual chat-sms endpoint
  // for precise segment counts.

  return results;
}

// ── Main: extract segments from actual test results ────────────────────────

interface AggStats {
  count: number;
  totalReplies: number;
  totalSegments: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  max: number;
  distribution: Record<number, number>; // segments → count of replies
}

function computeStats(allSegments: number[]): AggStats {
  if (allSegments.length === 0) {
    return { count: 0, totalReplies: 0, totalSegments: 0, mean: 0, p50: 0, p90: 0, p95: 0, max: 0, distribution: {} };
  }
  const sorted = [...allSegments].sort((a, b) => a - b);
  const totalSegments = sorted.reduce((s, v) => s + v, 0);
  const mean = totalSegments / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const max = sorted[sorted.length - 1];

  const distribution: Record<number, number> = {};
  for (const s of sorted) {
    distribution[s] = (distribution[s] || 0) + 1;
  }

  return { count: sorted.length, totalReplies: sorted.length, totalSegments, mean, p50, p90, p95, max, distribution };
}

// ── Estimate from raw reply texts ──────────────────────────────────────────

/**
 * Given a list of bot reply texts, compute segment stats.
 */
export function analyzeReplies(replies: string[]): AggStats {
  return computeStats(replies.map(segmentCount));
}

/**
 * Given just text, return per-message segment counts + total.
 */
export function countSegments(texts: string[]): { perMessage: number[]; total: number; gsm7: boolean[] } {
  const perMessage = texts.map(segmentCount);
  const gsm7 = texts.map(isGsm7);
  return { perMessage, total: perMessage.reduce((s, v) => s + v, 0), gsm7 };
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = Deno.args;
  if (args.length === 0 || args.includes("--help")) {
    console.log("Usage: deno run --allow-read scripts/test-suite/segments.ts <logfile>");
    console.log("  Also accepts JSON from stdin: deno run segments.ts --stdin < results.json");
    Deno.exit(0);
  }

  if (args[0] === "--stdin") {
    const stdin = new TextDecoder().decode(await Deno.readAll(Deno.stdin));
    const data = JSON.parse(stdin);
    if (data.replies && Array.isArray(data.replies)) {
      const stats = analyzeReplies(data.replies);
      console.log(JSON.stringify(stats, null, 2));
    }
    Deno.exit(0);
  }

  const logPath = args[0];
  console.error(`Segment analysis of ${logPath} requires raw reply texts.`);
  console.error(`Use extract-replies.ts to pull replies from the QA test runs,`);
  console.error(`then pipe to: deno run segments.ts --stdin`);
  Deno.exit(1);
}