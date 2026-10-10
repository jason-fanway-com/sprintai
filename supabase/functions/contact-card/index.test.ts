import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildVcard, esc, fold } from "./index.ts";

Deno.test("vCard: name escaped, number, note, CRLF lines, photo folded at 75 octets", () => {
  const v = buildVcard({ name: "FNA's Grille, Center Valley", phone: "+16105550100", url: null }, "A".repeat(300));
  assert(v.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n"));
  assertStringIncludes(v, "FN:FNA's Grille\\, Center Valley\r\n");
  assertStringIncludes(v, "TEL;TYPE=CELL,VOICE,PREF:+16105550100\r\n");
  assertStringIncludes(v, "NOTE:Text this number to order.\r\n");
  for (const line of v.split("\r\n")) assert(line.length <= 75, line.slice(0, 20));
  assert(v.trimEnd().endsWith("END:VCARD"));
});

Deno.test("vCard: no photo and no url when the shop has none", () => {
  const v = buildVcard({ name: "Vito's Pizza", phone: "+16107358315" }, null);
  assert(!v.includes("PHOTO")); assert(!v.includes("URL:"));
  assertEquals(esc("a;b\\c"), "a\;b\\\\c");
  assertEquals(fold("x".repeat(75)), "x".repeat(75));
});
