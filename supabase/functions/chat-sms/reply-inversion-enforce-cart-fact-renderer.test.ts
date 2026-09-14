// Reply inversion, item 5 (2026-09-13, docs/specs/2026-09-13-reply-inversion.md):
// enforcement that closes the spec's acceptance criterion — a reply-producing
// branch must never interpolate a cart item's name/price/quantity directly
// into customer-facing text; it must go through the shared renderer
// (renderItemizedRecap / renderLedgerFooter / renderMissingOptionsPrompt /
// renderActionConfirmation / ...). Same shape as enforce-single-cart-writer.
// test.ts: a static scan of index.ts's own source, not a behavioral test.
//
// SCOPE: this checks every `reply = ` / `reply += ` assignment in index.ts
// (43 at last count, all of them — not just one pinned site, unlike
// reply-inversion-site21-enforcement.test.ts which is scoped to the mutated-
// cart branch alone). For each assignment, every `${...}` template
// interpolation in its right-hand side is checked for a direct
// `.name` / `.price_cents` / `.quantity` / `.price` property access — the
// shape a hand-authored cart claim takes. Passing cart fields as plain
// (non-template-literal) arguments INTO a renderer call, e.g.
// `renderMissingOptionsPrompt(guardCart.map(i => ({ name: i.name, ... })))`,
// is the correct, expected pattern and is untouched by this check — only
// `${}` interpolations are in scope, because that's the shape of the 19:07
// defect (the model's sentence, or a hand-built template string, asserting
// a fact instead of a renderer function computing it from real cart state).
//
// EXEMPTION: a line may carry the `cart-fact:blessed` marker comment to
// exempt a genuine non-cart-fact use of one of these field names (see
// menuItem.name at the "couple options" disambiguation site below — that
// names a MENU search target being disambiguated, not a claim about what's
// currently in the cart). Same style as enforce-single-cart-writer.test.ts's
// `single-writer:blessed` marker.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX_PATH = new URL("./index.ts", import.meta.url).pathname;
const BLESSED_MARKER = "cart-fact:blessed";
const FORBIDDEN_FIELD_RE = /\.(name|price_cents|quantity|price)\b/;
const INTERPOLATION_RE = /\$\{([^{}]*)\}/g;

interface ReplyStatement {
  /** 1-indexed line of the `reply =`/`reply +=` keyword itself. */
  line: number;
  /** Absolute character offset in `source` where the RHS expression starts. */
  start: number;
  /** The RHS expression text, up to (excluding) the terminating `;`. */
  text: string;
}

interface Violation {
  line: number;
  snippet: string;
}

function skipStringLiteral(src: string, i: number, quote: string): number {
  i++;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

function skipTemplateExpr(src: string, i: number): number {
  // i points at '{' immediately after '$'; returns the index AFTER the
  // matching '}', tolerating nested braces/strings/templates inside.
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") { depth--; i++; if (depth === 0) return i; continue; }
    if (c === "'" || c === '"') { i = skipStringLiteral(src, i, c); continue; }
    if (c === "`") { i = skipTemplate(src, i); continue; }
    i++;
  }
  return i;
}

function skipTemplate(src: string, i: number): number {
  // i points at the opening backtick; returns the index AFTER the closing one.
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    if (c === "$" && src[i + 1] === "{") { i = skipTemplateExpr(src, i + 1); continue; }
    i++;
  }
  return i;
}

/**
 * Finds every `reply = <expr>;` / `reply += <expr>;` statement in `src` and
 * returns each one's RHS expression verbatim (excluding the terminating
 * `;`). Tracks paren/bracket/brace depth (skipping over string and template
 * literal contents, which may themselves contain unbalanced-looking
 * characters) so a `;` inside a nested arrow function or ternary never
 * mistakenly ends the statement early.
 */
function extractReplyStatements(src: string): ReplyStatement[] {
  const results: ReplyStatement[] = [];
  const re = /(^|\n)(\s*)reply\s*(=|\+=)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const exprStart = m.index + m[0].length;
    let i = exprStart;
    let parenDepth = 0, braceDepth = 0, bracketDepth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "'" || c === '"') { i = skipStringLiteral(src, i, c); continue; }
      if (c === "`") { i = skipTemplate(src, i); continue; }
      if (c === "(") { parenDepth++; i++; continue; }
      if (c === ")") { parenDepth--; i++; continue; }
      if (c === "[") { bracketDepth++; i++; continue; }
      if (c === "]") { bracketDepth--; i++; continue; }
      if (c === "{") { braceDepth++; i++; continue; }
      if (c === "}") { braceDepth--; i++; continue; }
      if (c === ";" && parenDepth <= 0 && braceDepth <= 0 && bracketDepth <= 0) break;
      i++;
    }
    const lineNo = src.slice(0, m.index).split("\n").length + 1;
    results.push({ line: lineNo, start: exprStart, text: src.slice(exprStart, i) });
  }
  return results;
}

/**
 * Scans every `${...}` interpolation inside each reply statement's RHS for a
 * direct cart-fact field access (`.name`, `.price_cents`, `.quantity`,
 * `.price`). A hit is exempted only if the ORIGINAL SOURCE line it falls on
 * (not the extracted snippet — the marker lives past the statement's `;`)
 * carries the `cart-fact:blessed` marker comment.
 */
function findForbiddenInterpolations(src: string, statements: ReplyStatement[]): Violation[] {
  const sourceLines = src.split("\n");
  const violations: Violation[] = [];
  for (const stmt of statements) {
    let match: RegExpExecArray | null;
    INTERPOLATION_RE.lastIndex = 0;
    while ((match = INTERPOLATION_RE.exec(stmt.text)) !== null) {
      const inner = match[1];
      if (!FORBIDDEN_FIELD_RE.test(inner)) continue;
      const absoluteOffset = stmt.start + match.index;
      const lineNo = src.slice(0, absoluteOffset).split("\n").length; // 1-indexed
      const sourceLine = sourceLines[lineNo - 1] ?? "";
      if (sourceLine.includes(BLESSED_MARKER)) continue;
      violations.push({ line: lineNo, snippet: `\${${inner}}` });
    }
  }
  return violations;
}

function scan(src: string): Violation[] {
  return findForbiddenInterpolations(src, extractReplyStatements(src));
}

// ── RED proof: the detector actually detects a direct cart-fact claim ──────

Deno.test("RED: a reply assignment that interpolates a cart item's .name directly is flagged", () => {
  const bad = `
function handle() {
  reply = \`Added \${cartItems[0].name} to your order!\`;
}
`;
  const violations = scan(bad);
  assertEquals(violations.length, 1, `expected exactly one violation, got ${JSON.stringify(violations)}`);
  assert(violations[0].snippet.includes("cartItems[0].name"));
});

Deno.test("RED: a reply assignment that interpolates a cart item's .price_cents directly is flagged", () => {
  const bad = `
function handle() {
  reply = \`That'll be \${guardCart[0].price_cents} cents.\`;
}
`;
  assertEquals(scan(bad).length, 1);
});

Deno.test("RED: multiple items enumerated by hand in one sentence are ALL flagged", () => {
  const bad = `
function handle() {
  reply = \`Your cart has \${cartItems[0].name} and \${cartItems[1].name}.\`;
}
`;
  assertEquals(scan(bad).length, 2);
});

// ── GREEN proof: the detector does not flag legitimate patterns ────────────

Deno.test("GREEN: routing through the renderer as a template-literal call produces no violation", () => {
  const good = `
function handle() {
  reply = \`Your cart:\\n\\n\${renderItemizedRecap(guardCart)}\\n\\nWhat else can I add?\`;
}
`;
  assertEquals(scan(good).length, 0);
});

Deno.test("GREEN: passing cart fields as plain (non-template) renderer arguments is untouched", () => {
  const good = `
function handle() {
  reply = renderMissingOptionsPrompt(
    guardCart
      .filter(i => (i.pending_options?.length ?? 0) > 0)
      .map(i => ({ name: i.name, missingGroups: i.pending_options })),
  );
}
`;
  assertEquals(scan(good).length, 0);
});

Deno.test("GREEN: a marked exemption for a genuine non-cart-fact use is not flagged", () => {
  const good = `
function handle() {
  reply = \`We've got a couple options called "\${menuItem.name}" — \${optionsText}. Which one?\`; // cart-fact:blessed — echoes the customer's search term, not a cart claim
}
`;
  assertEquals(scan(good).length, 0);
});

Deno.test("GREEN: an UNMARKED use of the same shape IS flagged (the marker is load-bearing, not decorative)", () => {
  const bad = `
function handle() {
  reply = \`We've got a couple options called "\${menuItem.name}" — \${optionsText}. Which one?\`;
}
`;
  assertEquals(scan(bad).length, 1);
});

// ── The real check: index.ts itself must be clean ──────────────────────────

Deno.test("reply-inversion enforcement: no reply= site in index.ts interpolates a cart fact outside a blessed renderer", async () => {
  const source = await Deno.readTextFile(INDEX_PATH);
  const statements = extractReplyStatements(source);
  assert(statements.length > 0, "found zero `reply =` statements — extractor's anchors broke, update this test");
  const violations = findForbiddenInterpolations(source, statements);
  if (violations.length > 0) {
    console.error(
      "\n[reply-inversion enforcement] VIOLATIONS — cart fact interpolated outside a renderer:\n" +
        violations.map(v => `  index.ts:${v.line}: ${v.snippet}`).join("\n") + "\n",
    );
  }
  assertEquals(
    violations.length,
    0,
    `${violations.length} unrendered cart-fact interpolation(s) found in index.ts — see stderr above`,
  );
});
