// Structural enforcement: writeCartLine (turn-reconciler.ts) is the ONLY
// function permitted to create or modify a cart line anywhere in this
// directory. This test fails immediately if any source file contains a
// direct `cart.push(`, `cartItems.push(`, `guardCart.push(`, or
// `cart_json.push(` OUTSIDE of the three blessed single-writer functions
// (writeCartLine, writeBundleLine, applyCartSnapshot) in turn-reconciler.ts.
//
// Legitimate cart_json FIELD assignments (= [], = freshCart.cart_json,
// = cartItems after writeCartLine wrote them) are NOT violations — those
// are DB reloads and in-memory reference syncs. Only push() calls that
// APPEND new items into a live cart array are forbidden outside the
// single writer.
//
// To add a cart line: call writeCartLine (turn-reconciler.ts).
// To add a bundle line: call writeBundleLine (turn-reconciler.ts).
// To install a corrected snapshot: call applyCartSnapshot (turn-reconciler.ts).
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
];

// Inside turn-reconciler.ts these function declarations open the blessed zones:
const BLESSED_FN_PATTERNS: RegExp[] = [
  /\bfunction writeCartLine\b/,
  /\bfunction writeBundleLine\b/,
  /\bfunction applyCartSnapshot\b/,
];

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

      for (const { pattern, label } of FORBIDDEN_PATTERNS) {
        if (!pattern.test(line)) continue;

        // In turn-reconciler.ts: allow if the hit is inside one of the
        // three blessed function bodies. We check by scanning back up to
        // 150 lines for the most recent function declaration.
        if (fileName === SINGLE_WRITER_FILE) {
          const contextStart = Math.max(0, i - 150);
          const context = lines.slice(contextStart, i + 1).join("\n");
          const inBlessed = BLESSED_FN_PATTERNS.some(p => p.test(context));
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
