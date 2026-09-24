# Scaling backlog — what has to exist before many shops, not before the next one

**Not a task list for the current build.** Nothing here blocks Vito's, Zio's or Not Just
Bagels. Every item here is something that is survivable by hand at three shops and is not
survivable by hand at thirty. Add to it when a manual step is discovered that would not
scale; do not add ordinary bugs.

Started 2026-09-15.

---

## 1. Onboarding hardening agent (Jason, 2026-09-15)

**The ask:** during onboarding, an agent works out how people will actually ask for this
shop's items, and proves the bot handles it, before a real customer ever texts.

**The distinction that shapes the build.** Of the five defects found on the day the turn
engine first ran live, four were engine-general and one was language coverage:

| Defect | Shop-specific? |
|---|---|
| Lexicon query silently truncated at 1000 rows | No — engine, fixed once for everyone |
| "thats it" doubled the order | No — engine |
| subtotal_cents/total_cents not persisted | No — engine |
| Clarifying question opened with an apology | No — engine |
| Ambiguous surface forms deleted, so the bot could not ask | Global compiler rule, not per-shop |

So the hardening agent is NOT a general "the engine needs to settle in at each shop" tool.
Engine defects are fixed once. What is genuinely per-shop:

- **Collisions are a property of the menu.** `burger` matches 7 Vito's items and `fries`
  matches 10. A bagel shop's collisions will be entirely different words. The set of terms
  that must trigger a clarifying question can only be computed per menu.
- **Regional and shop slang.** What the neighbourhood calls a thing, what the owner's
  regulars call it, abbreviations printed on the shop's own board.
- **Owner shorthand** that never appears in the menu text at all.

**Shape it should take:**
1. Compile the menu, then enumerate the surface forms the compiler derived.
2. Generate the phrasings a person would plausibly type — not a matcher, generated data,
   per the standing rule that the compiler anticipates phrasing rather than reacting to it.
3. Run them against the engine before the shop is live, and assert the resolved item id and
   price, never schema validity.
4. Produce two lists for the owner: terms that resolve uniquely, and terms that will trigger
   a clarifying question — the second list is the one an owner can usefully correct.
5. Anything unresolved becomes an onboarding question, not a runtime failure.

**Do not** let it become a runtime matcher, a fallback to the model, or a tiebreak. Ambiguous
means ask; the agent's job is to know which words are ambiguous before a customer finds out.

**Open question worth measuring before building it:** how much per-shop hardening is actually
needed is unknown, because only Vito's has run on the engine. Flipping Zio's and Not Just
Bagels is the cheap experiment — if their first gate runs are clean, the per-shop surface is
small and this agent can be simple. Measure before scoping.

---

## 2. Lexicon compiler hygiene (Fable, 2026-09-24) — crew, not engine

Live Vito's lexicon rows the engine now has to defend against at load time. Each is a compiler
output shape, so fix the compiler and recompile (on the PO's GO), then delete the load-time guards.

1. **Squashed one-word rows.** `buffalochicken`, `buffalochicken-large16inch`, `cheesesteak/chickencheesesteaksalad`,
   `cheesesteakchickencheesesteak`. Nobody types these; they put fake words into the vocabulary
   (the engine's compound-join briefly turned "buffalo chicken cheesesteak" into the pizza because
   "buffalochicken" was a "known word"). Stop emitting them.
2. **Slash display names compiled as one run.** `cheesesteak chicken cheesesteak salad` for
   "Cheesesteak / Chicken Cheesesteak Salad". The slash means alternatives: emit `cheesesteak salad`
   and `chicken cheesesteak salad` (the engine does this from the display name at load; the
   compiler should too, and stop emitting the run).
3. **Size-suffixed duplicates.** `buffalo chicken - large 16 inch`, `buffalo chicken larges`,
   `buffalo chicken - medium 14 inches`. The size is a facet the engine already reads from the
   name; these rows only bloat the scan and the egress.
4. **Bare generic terms on specific items.** `chicken` → the quesadilla; `sandwich` → one
   cheesesteak. A word that names a category must be a category term or nothing.
5. **Items with no term at all** (NJB "Chicken Salad Sandwich" had none before the engine began
   adding the display name itself). Every orderable item must carry at least its display name.

Acceptance: `deno run -A scripts/engine/probe.ts --shop <id> "<span>"` on the Air shows the same
resolutions for `cheesesteak`, `buffalo chicken cheesesteak`, `chicken cheesesteak salad`,
`bacon cheese burger` before and after the recompile, and `menu.vocab` contains no word that is
two menu words glued together.

---

## 3. (next item goes here)
