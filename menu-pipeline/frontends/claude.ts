/**
 * Claude front-end for Stage A: PDF / image / text -> MenuModel.
 *
 * This is the non-deterministic extraction layer. We pin the model and set
 * temperature 0 to maximize run-to-run stability, but the determinism GUARANTEE
 * lives in the serializer (same MenuModel -> byte-identical CSV), not here.
 *
 * The prompt instructs Claude to emit the MenuModel JSON shape directly
 * (categories in menu order, one variant per size, modifier blocks, and Open
 * Questions for anything ambiguous) — a richer target than the legacy
 * parse-menu-pdf flat-items prompt, aligned to MENU-INTAKE-STANDARD.md.
 *
 * Network access is required at runtime. `fetch` is injected so this module has
 * no hard dependency on Deno or Node globals and can be unit-tested with a stub.
 */

import type { MenuModel } from "../core/types.ts";
import type { MenuFrontEnd, MenuSource } from "../core/parse.ts";

export const CLAUDE_MODEL = "claude-sonnet-4-6";
export const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

export const EXTRACTION_PROMPT =
  `You are Sprint's menu intake parser. Convert this restaurant menu into a single
JSON object matching the MenuModel schema below. This feeds an automated ordering
agent, so be EXHAUSTIVE and NEVER invent data.

Return ONLY the JSON object (no markdown fences, no commentary):

{
  "menuName": string,                       // restaurant/menu name if visible, else ""
  "categoryOrder": string[],                // section names in the EXACT order they appear
  "items": [
    {
      "category": string,                   // the menu section, verbatim
      "name": string,                       // clean, title-cased item name
      "size": string,                       // size label incl. measurement e.g. "Large (16\\")"; "" if no size
      "price": number | null,               // ABSOLUTE dollars (e.g. 12.95). null ONLY if genuinely unknown
      "description": string,                // lead with "Served with ..." if the menu states included sides
      "promptFor": string[],                // REQUIRED free choices, each a phrase w/ options inline,
                                            //   e.g. "which pasta (spaghetti, penne, angel hair, or linguine)"
      "upsell": string[]                    // OPTIONAL add-ons w/ price hints, e.g. "add a protein (chicken +$4, shrimp +$6)"
                                            //   DO NOT include a category cross-sell nudge; the system appends it.
    }
  ],
  "modifierBlocks": [
    {
      "label": string,                      // e.g. "Pizza Toppings - Regular", "Salad Dressings", "Wing Flavors"
      "options": [ { "name": string, "priceDelta": number | null } ]
                                            // priceDelta: 0 for free required answers (dressings, sauces, pasta),
                                            //   positive for paid add-ons (toppings, proteins),
                                            //   null when an upcharge exists but the amount is unknown (flag it)
    }
  ],
  "openQuestions": [
    { "area": string, "issue": string, "question": string }
  ]
}

GOLDEN RULES (non-negotiable):
1. EXHAUSTIVE: every size, topping, sauce, add-on, dressing, side sub, protein. Missing one is a defect.
2. NEVER invent a price or option. Illegible / missing / "market price" => price/priceDelta null AND an openQuestions entry. Do not guess, average, or infer.
3. FLAG, DON'T SMOOTH: anything ambiguous, suspicious (e.g. every specialty pizza small is the same price), or interpreted rather than read => an openQuestions entry with a specific question.
4. ONE VARIANT PER SIZE: each size of a pizza, each cup/bowl of soup = its own item entry, same description repeated.
5. prices are dollars as numbers (12.95), not strings, not cents, no symbol.
6. promptFor = FREE required choices only. Paid add-ons go in upsell (with +$) AND in a modifierBlock.
7. Half/whole pricing => separate options in the block with portion in the name, e.g. "Pepperoni (Whole pizza)" / "Pepperoni (Half pizza)".
8. Every option you name in a promptFor and every +$ add-on in upsell MUST also appear in a modifierBlock (referential integrity).
9. If there are zero open questions, return "openQuestions": [].

Walk the menu section by section. Then re-check: did I capture every priced line, every size, every topping/sauce/dressing, and flag everything I wasn't 100% sure I read directly?`;

interface ClaudeFrontEndDeps {
  apiKey: string;
  /** Injected fetch (globalThis.fetch in Deno/Node 18+). */
  fetchFn?: typeof fetch;
}

/** Build the Claude content blocks for a given source. */
function buildContent(source: MenuSource): unknown[] {
  switch (source.kind) {
    case "pdf":
      return [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: source.base64 } },
        { type: "text", text: EXTRACTION_PROMPT },
      ];
    case "image":
      return [
        { type: "image", source: { type: "base64", media_type: source.mediaType, data: source.base64 } },
        { type: "text", text: EXTRACTION_PROMPT },
      ];
    case "text":
      return [{ type: "text", text: `${EXTRACTION_PROMPT}\n\n--- MENU TEXT ---\n${source.text}` }];
    case "html":
      return [{ type: "text", text: `${EXTRACTION_PROMPT}\n\n--- MENU HTML ---\n${source.html}` }];
    default:
      throw new Error(`Claude front-end cannot handle source kind "${(source as { kind: string }).kind}"`);
  }
}

function defaultMenuName(source: MenuSource): string {
  return "menuName" in source && source.menuName ? source.menuName : "Menu";
}

export function makeClaudeFrontEnd(deps: ClaudeFrontEndDeps): MenuFrontEnd {
  const fetchFn = deps.fetchFn ?? fetch;
  return {
    handles: (s) => s.kind === "pdf" || s.kind === "image" || s.kind === "html" || s.kind === "text",
    extract: async (source) => {
      if (!deps.apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key": deps.apiKey,
        "anthropic-version": "2023-06-01",
      };
      if (source.kind === "pdf") headers["anthropic-beta"] = "pdfs-2024-09-25";

      const res = await fetchFn(CLAUDE_API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 32768,
          temperature: 0,
          messages: [{ role: "user", content: buildContent(source) }],
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Claude API error ${res.status}: ${body}`);
      }
      const data = await res.json() as { content?: Array<{ text?: string }> };
      const raw = data?.content?.[0]?.text ?? "";
      const model = parseModelJson(raw);
      if (!model.menuName) model.menuName = defaultMenuName(source);
      return model;
    },
  };
}

/** Parse + normalize the MenuModel JSON Claude returns. Exported for testing. */
export function parseModelJson(raw: string): MenuModel {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Claude returned unparseable MenuModel JSON. First 500 chars: ${cleaned.slice(0, 500)}`);
  }
  const obj = parsed as Partial<MenuModel>;
  if (!Array.isArray(obj.items)) throw new Error("MenuModel.items missing or not an array");
  return {
    menuName: typeof obj.menuName === "string" ? obj.menuName : "",
    categoryOrder: Array.isArray(obj.categoryOrder) ? obj.categoryOrder.map(String) : [],
    items: (obj.items as MenuModel["items"]).map((it) => ({
      category: String(it.category ?? ""),
      name: String(it.name ?? ""),
      size: String(it.size ?? ""),
      price: it.price === null || it.price === undefined ? null : Number(it.price),
      description: String(it.description ?? ""),
      promptFor: Array.isArray(it.promptFor) ? it.promptFor.map(String) : [],
      upsell: Array.isArray(it.upsell) ? it.upsell.map(String) : [],
    })),
    modifierBlocks: Array.isArray(obj.modifierBlocks)
      ? obj.modifierBlocks.map((b) => ({
        label: String(b.label ?? ""),
        options: Array.isArray(b.options)
          ? b.options.map((o) => ({
            name: String(o.name ?? ""),
            priceDelta: o.priceDelta === null || o.priceDelta === undefined ? null : Number(o.priceDelta),
          }))
          : [],
      }))
      : [],
    openQuestions: Array.isArray(obj.openQuestions)
      ? obj.openQuestions.map((q) => ({
        area: String(q.area ?? ""),
        issue: String(q.issue ?? ""),
        question: String(q.question ?? ""),
      }))
      : [],
  };
}
