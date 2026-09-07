// Unit tests for the §9 entity-key scheme (_shared/menu-entity-key.ts).
// Examples are the real worked cases from
// docs/specs/2026-09-07-conversation-ready-menu-design.md Appendix B, not
// synthetic data, so a spot check against the spec is direct.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  choiceEntityKey,
  groupEntityKey,
  itemEntityKey,
  normaliseEntityTerm,
  ownerEntityKey,
  setChoiceEntityKey,
  setEntityKey,
} from "./menu-entity-key.ts";

// ─── normaliseEntityTerm ────────────────────────────────────────────────────
Deno.test("normalise: lowercases, trims, collapses whitespace", () => {
  assertEquals(normaliseEntityTerm("  Extra   Cheese "), "extra cheese");
});

Deno.test("normalise: strips punctuation that doesn't change meaning", () => {
  assertEquals(normaliseEntityTerm("Cheese - Large (16\")"), "cheese - large 16");
});

Deno.test("normalise: does NOT accent-fold — must stay byte-identical to the SQL mirror in migration 114, which can't cheaply match Unicode NFKD without an extension", () => {
  assertEquals(normaliseEntityTerm("Jalapeño"), "jalapeño");
});

Deno.test("normalise: case-insensitive collisions map to the same key", () => {
  assertEquals(normaliseEntityTerm("Pepperoni"), normaliseEntityTerm("PEPPERONI"));
});

// ─── item ───────────────────────────────────────────────────────────────────
Deno.test("item: uses import_key when present (Vito's Cheese - Large)", () => {
  assertEquals(
    itemEntityKey({ id: "11111111-1111-1111-1111-111111111111", importKey: "pizza:cheese-large" }),
    "pizza:cheese-large",
  );
});

Deno.test("item: falls back to owner:<uuid> when import_key is null", () => {
  const id = "22222222-2222-2222-2222-222222222222";
  assertEquals(itemEntityKey({ id, importKey: null }), `owner:${id}`);
  assertEquals(itemEntityKey({ id, importKey: null }), ownerEntityKey(id));
});

// ─── group ──────────────────────────────────────────────────────────────────
Deno.test("group: <item import_key>#<slot_key> (Zio's Gyro protein slot)", () => {
  const itemKey = itemEntityKey({ id: "gyro-1", importKey: "zios:gyro" });
  assertEquals(
    groupEntityKey(itemKey, { slotKey: "protein", name: "Beef or Chicken" }),
    "zios:gyro#protein",
  );
});

Deno.test("group: falls back to normalised group name when slot_key is null", () => {
  const itemKey = itemEntityKey({ id: "sandwich-1", importKey: "zios:chicken-cutlet" });
  assertEquals(
    groupEntityKey(itemKey, { slotKey: null, name: "Bread Type" }),
    "zios:chicken-cutlet#bread type",
  );
});

Deno.test("group: two groups with the same slot_key on different items never collide", () => {
  const gyroKey = groupEntityKey(itemEntityKey({ id: "g", importKey: "zios:gyro" }), {
    slotKey: "protein",
    name: "Protein",
  });
  const wrapKey = groupEntityKey(itemEntityKey({ id: "w", importKey: "zios:wrap" }), {
    slotKey: "protein",
    name: "Protein",
  });
  assertEquals(gyroKey === wrapKey, false);
});

// ─── choice ─────────────────────────────────────────────────────────────────
Deno.test("choice: <group key>#<normalised choice name> (NJB cream cheese lox spread)", () => {
  const itemKey = itemEntityKey({ id: "njb-1", importKey: "njb:bagel-with-cream-cheese" });
  const groupKey = groupEntityKey(itemKey, { slotKey: "spread", name: "Cream cheese" });
  assertEquals(
    choiceEntityKey(groupKey, { name: "Lox spread (+$2)" }),
    "njb:bagel-with-cream-cheese#spread#lox spread +$2",
  );
});

Deno.test("choice: naming variants that mean the same choice normalise the same way", () => {
  const groupKey = "njb:bagel-with-cream-cheese#spread";
  assertEquals(
    choiceEntityKey(groupKey, { name: "Plain." }),
    choiceEntityKey(groupKey, { name: "  PLAIN  " }),
  );
});

// ─── set / set_choice (P1 shape; module supports it even though the P0
// trigger doesn't write set overrides yet — see migration 114 header) ──────
Deno.test("set: <menu>#<normalised set name>", () => {
  assertEquals(setEntityKey("vitos-menu", { name: "Toppings" }), "vitos-menu#toppings");
});

Deno.test("set_choice: <set key>#<normalised choice name>", () => {
  const setKey = setEntityKey("vitos-menu", { name: "Toppings" });
  assertEquals(setChoiceEntityKey(setKey, { name: "Pepperoni" }), "vitos-menu#toppings#pepperoni");
});

// ─── stability across a re-crawl: the whole point of §9 ────────────────────
Deno.test("stability: identical import_key + slot_key + choice name reproduce the same key on a second crawl", () => {
  const crawl1 = choiceEntityKey(
    groupEntityKey(itemEntityKey({ id: "a", importKey: "zios:gyro" }), {
      slotKey: "protein",
      name: "Protein",
    }),
    { name: "Chicken" },
  );
  const crawl2 = choiceEntityKey(
    groupEntityKey(itemEntityKey({ id: "a-different-row-id-after-recrawl", importKey: "zios:gyro" }), {
      slotKey: "protein",
      name: "Protein",
    }),
    { name: "Chicken" },
  );
  assertEquals(crawl1, crawl2);
});
