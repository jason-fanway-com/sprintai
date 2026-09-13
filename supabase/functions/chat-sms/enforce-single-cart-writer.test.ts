// Structural enforcement: writeCartLine (turn-reconciler.ts) and its sibling
// writers are the ONLY functions permitted to create, modify, remove, clear,
// or persist a cart line anywhere in this directory. This test fails
// immediately if any source file contains a direct `cart.push(`,
// `cartItems.push(`, `guardCart.push(`, `cart_json.push(`, a direct
// `.splice(` on a cart array, or a direct `cart_json: cart`/`cart_json:
// cartItems` write to order_carts — OUTSIDE the blessed single-writer
// functions (writeCartLine, writeBundleLine, applyCartSnapshot,
// removeCartLine, clearCart, writeSplitCartLine) in turn-reconciler.ts, and
// (for the cart_json DB-write pattern only) outside saveCart's own body in
// index.ts, which is the one legitimate DB-write path.
//
// Legitimate cart_json FIELD assignments (= [], = freshCart.cart_json,
// = cartItems after writeCartLine wrote them) are NOT violations — those
// are DB reloads and in-memory reference syncs. Only push()/splice() calls
// that mutate a live cart array, or a direct DB write of cart_json, are
// forbidden outside the single writer.
//
// To add a cart line: call writeCartLine (turn-reconciler.ts).
// To add a bundle line: call writeBundleLine (turn-reconciler.ts).
// To remove a cart line: call removeCartLine (turn-reconciler.ts).
// To clear the cart: call clearCart (turn-reconciler.ts).
// To split a line (D1 quantity-split create): call writeSplitCartLine (turn-reconciler.ts).
// To install a corrected snapshot: call applyCartSnapshot (turn-reconciler.ts).
// To persist a cart to the DB: call saveCart (index.ts).
//
// See supabase/functions/chat-sms/turn-reconciler.ts header for why.

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const DIR = new URL(".", import.meta.url).pathname;

// The one source file whose cart.push/splice calls are the implementation of
// the single-writer functions themselves — not violations.
const SINGLE_WRITER_FILE = "turn-reconciler.ts";

// Forbidden patterns (in priority order):
// 1. Direct push onto any of the known cart array variables.
// 2. Push directly onto cart_json (bypassing the array alias).
// 3. Direct splice on any of the known cart array variables.
// 4. Direct cart_json DB write (bypassing saveCart()).
const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bcart\.push\s*\(/, label: "cart.push(" },
  { pattern: /\bcartItems\.push\s*\(/, label: "cartItems.push(" },
  { pattern: /\bguardCart\.push\s*\(/, label: "guardCart.push(" },
  { pattern: /\.cart_json\.push\s*\(/, label: "cart_json.push(" },
  { pattern: /\b(cart|cartItems|guardCart)\w*\.splice\s*\(/, label: "cart.splice(" },
  { pattern: /cart_json:\s*(cart|cartItems)\b/, label: "cart_json: cart direct DB write" },
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

// Per-file blessed zones OUTSIDE turn-reconciler.ts — currently just
// saveCart() (index.ts), the one legitimate cart_json DB-write path.
const OTHER_BLESSED_ZONES: { file: string; patterns: RegExp[] }[] = [
  { file: "index.ts", patterns: [/\bfunction saveCart\b/] },
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

Deno.test("enforce-single-cart-writer: no direct cart push/splice/cart_json write outside the blessed writers", async () => {
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
        // blessed function bodies. We check by scanning back up to
        // 150 lines for the most recent function declaration.
        if (fileName === SINGLE_WRITER_FILE) {
          const contextStart = Math.max(0, i - 150);
          const context = lines.slice(contextStart, i + 1).join("\n");
          const inBlessed = BLESSED_FN_PATTERNS.some(p => p.test(context));
          if (inBlessed) continue;
        }

        // Other files may have their own single blessed zone (e.g.
        // saveCart's own body in index.ts) — same backward-scan approach.
        const otherZone = OTHER_BLESSED_ZONES.find(z => z.file === fileName);
        if (otherZone) {
          const contextStart = Math.max(0, i - 150);
          const context = lines.slice(contextStart, i + 1).join("\n");
          const inBlessed = otherZone.patterns.some(p => p.test(context));
          if (inBlessed) continue;
        }

        violations.push(`${fileName}:${i + 1} [${label}]: ${line.trim()}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      "\n[enforce-single-cart-writer] VIOLATIONS — direct cart mutation/DB write outside the blessed writers:\n" +
        violations.map(v => `  ${v}`).join("\n") + "\n",
    );
  }

  assert(
    violations.length === 0,
    `${violations.length} direct cart push(es) found outside writeCartLine — see stderr above`,
  );
});
