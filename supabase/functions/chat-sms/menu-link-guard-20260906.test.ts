// FEATURE (2026-09-06, Jason): "we should be able to send a link to their
// menu." A customer asking for the menu previously got a long category dump
// or "Sorry, I don't have a link to share." (Test Kitchen transcript
// 2026-09-06 13:34, see docs/specs/2026-09-06-public-menu-page.md). The
// public menu page (getsprintai.com/m/<slug>) already exists and reads the
// same rows chat-sms does; this wires a deterministic guard so an explicit
// menu/link ask always gets the link, not a model-composed dump — while a
// narrow question about one item/category is deliberately left to the model
// to answer directly, per the spec.
//
// This is a pure function, copied here verbatim from index.ts (which has no
// exports — it is a Deno.serve entrypoint), matching the convention already
// used by the other test files in this directory.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

function impliesMenuRequest(text: string): boolean {
  const t = text.trim();
  // FIX (2026-09-06, QA-found): narrowed from a broad verb list (send/share/
  // text/get/see/have/got) to send/share/text/show/see, plus exact phrases —
  // the broad list over-fired on ordinary food language containing
  // "menu"/"have". "have" stays out of the verb group; "what do you have"
  // is its own phrase, anchored to the whole message, so "what do you have
  // for wings?" stays narrow.
  //
  // WIDENED (2026-09-06, Jason — real tester phrasing, Luca's exact message
  // was failing): show/see added to the verb group; "what do you have" and
  // "menu please" added as exact phrases.
  return /\b(send|share|text|show|see)\b[^.?!]{0,20}\b(menu|link)\b/i.test(t)
    || /\bmenu\b[^.?!]{0,20}\blink\b/i.test(t)
    || /\b(what('?s| is) on the menu|do you have a menu|can (i|we) see (a |the )?(full |whole )?menu|full menu|whole menu|menu please)\b/i.test(t)
    || /^\s*menu\s*[?.!]?\s*$/i.test(t)
    || /^\s*what do you have\s*[?!.]*\s*$/i.test(t);
}

Deno.test("menu request: bare 'menu?'", () => {
  assert(impliesMenuRequest("menu?"));
});

Deno.test("menu request: 'can you send me a link to the menu'", () => {
  assert(impliesMenuRequest("can you send me a link to the menu"));
});

Deno.test("menu request: 'do you have a menu'", () => {
  assert(impliesMenuRequest("do you have a menu"));
});

Deno.test("menu request: 'what's on the menu'", () => {
  assert(impliesMenuRequest("what's on the menu?"));
});

Deno.test("menu request: 'can I see the full menu'", () => {
  assert(impliesMenuRequest("can I see the full menu"));
});

Deno.test("narrow question is NOT a menu request — the spec's own example", () => {
  assert(!impliesMenuRequest("what wing flavors do you have?"));
});

Deno.test("narrow question is NOT a menu request — ordering language", () => {
  assert(!impliesMenuRequest("I'll take a large pepperoni pizza"));
  assert(!impliesMenuRequest("do you have gluten free crust"));
  assert(!impliesMenuRequest("looks good"));
});

// QA (Melvin, 2026-09-06): these three false-positived under the original
// broad verb list (send/share/text/get/see/have/got) — "have" is far too
// common in ordinary food language to safely pair with "menu" nearby.
Deno.test("QA regression: 'what desserts do you have on the menu' is a narrow question, not a menu request", () => {
  assert(!impliesMenuRequest("what desserts do you have on the menu"));
});

Deno.test("QA regression: 'I'll have the menu special' is an order, not a menu request", () => {
  assert(!impliesMenuRequest("I'll have the menu special"));
});

Deno.test("QA regression: 'do you have a gluten free / kids menu' is a narrow question, not a menu request", () => {
  assert(!impliesMenuRequest("do you have a gluten free / kids menu"));
});

// Jason (2026-09-06 19:37, live-testing both testers' actual phrasing):
// "Three of four is not the win it looks like, because the failing one is
// the sentence Luca actually typed." All five widened below, including the
// exact failing case.
Deno.test("Jason's widen list: 'show me the menu'", () => {
  assert(impliesMenuRequest("show me the menu"));
});

Deno.test("Jason's widen list: 'can you show me the menu' — Luca's exact phrase, was failing", () => {
  assert(impliesMenuRequest("can you show me the menu"));
});

Deno.test("Jason's widen list: 'see the menu'", () => {
  assert(impliesMenuRequest("see the menu"));
});

Deno.test("Jason's widen list: 'can I see a menu'", () => {
  assert(impliesMenuRequest("can I see a menu"));
});

Deno.test("Jason's widen list: 'what do you have'", () => {
  assert(impliesMenuRequest("what do you have"));
  assert(impliesMenuRequest("what do you have?"));
});

Deno.test("Jason's widen list: 'menu please'", () => {
  assert(impliesMenuRequest("menu please"));
});

Deno.test("scoping: 'what do you have' is anchored to the whole message — a category question stays narrow", () => {
  assert(!impliesMenuRequest("what do you have for wings?"), "a specific category question must stay with the model, not get hijacked into a menu-link reply");
});

// ── Wiring regression guards against the live file ─────────────────────────

Deno.test("menu-link wiring: the guard exists, checks shop.slug, and points at getsprintai.com/m/<slug>", () => {
  assert(INDEX_SOURCE.includes("GUARD (menu-link)"), "the menu-link guard marker must exist");
  assert(INDEX_SOURCE.includes("shop.slug && impliesMenuRequest(userMessage)"), "the guard must gate on both a real slug and the menu-request detector");
  assert(INDEX_SOURCE.includes("https://getsprintai.com/m/${shop.slug}"), "the guard must link to the real live public menu page");
});

Deno.test("menu-link wiring: Shop interface carries slug so it's actually available at the guard site", () => {
  const start = INDEX_SOURCE.indexOf("interface Shop {");
  assert(start !== -1, "Shop interface must exist");
  const end = INDEX_SOURCE.indexOf("interface OrderCart", start);
  const block = INDEX_SOURCE.slice(start, end);
  assert(/slug:\s*string;/.test(block), "Shop interface must declare slug");
});

Deno.test("menu-link wiring: guard runs ahead of GUARD 2 so a menu ask is never masked by the checkout flow", () => {
  const menuIdx = INDEX_SOURCE.indexOf("// ── Guard (menu link)");
  const guard2Idx = INDEX_SOURCE.indexOf("// ── Guard 2: order confirmation + no pickup name");
  assert(menuIdx !== -1 && guard2Idx !== -1, "both guard markers must exist");
  assert(menuIdx < guard2Idx, "the menu-link guard must run before GUARD 2");
});
