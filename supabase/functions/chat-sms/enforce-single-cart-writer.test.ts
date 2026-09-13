// Structural enforcement: turn-reconciler.ts is the ONLY file permitted to
// create, modify, remove, clear, or persist a cart line anywhere in this
// directory. This test fails immediately if any source file contains a
// direct `cart.push(`/`cart.splice(` (or the cartItems/guardCart/cart_json
// equivalents) OUTSIDE the blessed single-writer functions (writeCartLine,
// writeBundleLine, writeSplitCartLine, removeCartLine, clearCart,
// applyCartSnapshot) in turn-reconciler.ts, or a direct `cart_json:` DB write
// outside saveCart (index.ts).
//
// Legitimate cart_json FIELD assignments (= [], = freshCart.cart_json,
// = cartItems after writeCartLine wrote them) are NOT violations — those
// are DB reloads and in-memory reference syncs. Only push()/splice() calls
// that mutate a live cart array, or a direct DB write of cart_json, are
// forbidden outside the single writer.
//
// To add a cart line: call writeCartLine (turn-reconciler.ts).
// To add a bundle line: call writeBundleLine (turn-reconciler.ts).
// To split a line (D1 quantity-split create): call writeSplitCartLine (turn-reconciler.ts).
// To remove a cart line: call removeCartLine (turn-reconciler.ts).
// To clear the cart: call clearCart (turn-reconciler.ts).
// To install a corrected/reverted snapshot: call applyCartSnapshot (turn-reconciler.ts).
// To persist a cart to the DB: call saveCart (index.ts).
//
// See supabase/functions/chat-sms/turn-reconciler.ts header for why.

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const DIR = new URL(".", import.meta.url).pathname;

// The one source file whose cart.push calls are the implementation of the
// single-writer functions themselves — not violations.
const SINGLE_WRITER_FILE = "turn-reconciler.ts";

// Forbidden patterns (in priority order):
// 1. Direct push onto any of the known cart array variables.
// 2. Push directly onto cart_json (bypassing the array alias).
const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bcart\.push\s*\(/, label: "cart.push(" },
  { pattern: /\bcartItems\.push\s*\(/, label: "cartItems.push(" },
  { pattern: /\bguardCart\.push\s*\(/, label: "guardCart.push(" },
  { pattern: /\.cart_json\.push\s*\(/, label: "cart_json.push(" },
  // Added 2026-09-13 (PO). The original patterns covered ONLY .push(, so this
  // test passed green while five .splice( sites and two direct cart_json DB
  // writes bypassed writeCartLine entirely. A test that certifies an invariant
  // it does not check is how the invariant erodes without anyone noticing.
  // NOTE: .splice() is not only removal — ask-plan-engine's qty-split splices a
  // line IN, which is a CREATE and must be idempotent like any other create.
  { pattern: /\bcart\.splice\s*\(/, label: "cart.splice(" },
  { pattern: /\bcartItems\.splice\s*\(/, label: "cartItems.splice(" },
  { pattern: /\bguardCart\.splice\s*\(/, label: "guardCart.splice(" },
  // A single-writer invariant at the array level is worthless if two code paths
  // persist the array independently. saveCart is the only blessed persister.
  { pattern: /cart_json:\s*(cart|cartItems)\b/, label: "cart_json: DB write" },
];

// Inside turn-reconciler.ts these function declarations open the blessed zones:
const BLESSED_FN_PATTERNS: RegExp[] = [
  /\bfunction writeCartLine\b/,
  /\bfunction writeBundleLine\b/,
  /\bfunction applyCartSnapshot\b/,
  /\bfunction removeCartLine\b/,
  /\bfunction clearCart\b/,
  /\bfunction writeSplitCartLine\b/,
];

// Every top-level function declaration in this codebase starts at column 0
// (no nested/inner function declarations share this shape) — used below to
// find the NEAREST enclosing function, not just "some blessed function
// within N lines." A fixed lookback window would silently exempt code in
// reconcileAddProposals() too, just because writeBundleLine()/
// applyCartSnapshot() happen to be declared shortly before it in the file —
// which is exactly how this file's own internal `cart.splice(lineIdx, 1)`
// (dropped_unauthorized path) used to pass this test without ever calling a
// blessed writer.
const TOP_LEVEL_FN_DECL = /^(export )?function \w+/;

async function readDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(`${dir}/${entry.name}`);
    }
  }
  return files;
}

Deno.test("enforce-single-cart-writer: no direct cart.push outside writeCartLine", async () => {
  const files = await readDir(DIR);
  const violations: string[] = [];

  for (const filePath of files) {
    const fileName = filePath.split("/").pop()!;
    const source = await Deno.readTextFile(filePath);
    const lines = source.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      // Skip blank and comment-only lines
      if (trimmed === "" || trimmed.startsWith("//")) continue;

      // Explicit, greppable exemption. A line carrying this marker is a
      // deliberately blessed writer (saveCart, the single persister). Using a
      // marker rather than a file/line allowlist means the exemption travels
      // with the code and is visible at the call site.
      if (line.includes("single-writer:blessed")) continue;
      for (const { pattern, label } of FORBIDDEN_PATTERNS) {
        if (!pattern.test(line)) continue;

        // In turn-reconciler.ts: allow only if the NEAREST preceding
        // top-level function declaration (not just any blessed declaration
        // somewhere above) is one of the blessed writers — i.e. the hit is
        // actually inside that function's own body, not merely close to it
        // in the file.
        if (fileName === SINGLE_WRITER_FILE) {
          let nearestDeclLine: string | null = null;
          for (let j = i; j >= 0; j--) {
            if (TOP_LEVEL_FN_DECL.test(lines[j])) { nearestDeclLine = lines[j]; break; }
          }
          const inBlessed = nearestDeclLine !== null && BLESSED_FN_PATTERNS.some(p => p.test(nearestDeclLine!));
          if (inBlessed) continue;
        }

        violations.push(`${fileName}:${i + 1} [${label}]: ${line.trim()}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      "\n[enforce-single-cart-writer] VIOLATIONS — direct cart push outside writeCartLine:\n" +
        violations.map(v => `  ${v}`).join("\n") + "\n",
    );
  }

  assert(
    violations.length === 0,
    `${violations.length} direct cart push(es) found outside writeCartLine — see stderr above`,
  );
});
