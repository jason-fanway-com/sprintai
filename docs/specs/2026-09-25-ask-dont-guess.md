# Ask, don't guess — the floor under the engine (2026-09-25)

Jason, 2026-09-24: "Are we putting too much pressure on the engine to understand EVERYTHING? Should we not be
teaching it how to politely ask for clarification when it doesn't know what the customer is asking for? That would
put a floor on the bottomless pit. Does a waitress know everything?"

## What went wrong before this

Ten tester passes found ~25 classes in a day. Only a third were resolver work. The rest were the engine learning the
model's move shapes (the same intent arrives as "qty 2 + add", as a mis-pointed line id, as "remove large" with no
"medium") and guards against compiler data. In every expensive failure the engine was confident and wrong: two larges
billed, three white hoagies, a paid Chicken add-on nobody ordered, twelve flavors collapsed to one. Each time there
were customer words the engine could not fully place, and it guessed, noted, or dropped them instead of asking.

## The rules

1. **Never act on a reading that conflicts with itself.** Two different choices landing on one single-select slot in
   one turn is a question between them, never the last one wins.
2. **While we are asking a question, an answer we cannot read is not a kitchen note.** It is a re-ask that names what
   we heard: "Sorry, I didn't catch 'buffalo flavor' as the flavor."
3. **Never ask the same question twice the same way.** First time: the question. Second: what we heard, and the
   choices. Third: a numbered list, reply a number. Fourth: the existing escalation (leave it off / pickup / no tip).
4. **The customer confirms the whole order before money.** The read-back says plainly that a robot made it and can be
   wrong, lists every line with its options, and takes corrections at that step and after the pay link (a change
   re-shows the read-back for a fresh YES).
5. **Warmth is free.** Politeness and a little self-deprecation live in templates.ts only; no engine risk.
6. **Measure the words we could not place.** Every turn logs the content words no move, mention, closed answer or
   filler accounted for (`unaccounted_words`). That number, not the tester's flags, says whether the floor holds.

## What this is not

Not a new heuristic layer. The deterministic reads that already work (kind splits, counted options, routed answers)
stay. The floor catches what they miss. Tester findings from here are fixed only when they touch money or the kitchen
ticket; oddities are logged. No tester pass runs without Jason's count-and-cost go.

## Out of scope for now

Leftover span words that match a paid add-on ("burger with bacon" as one span) still apply; the read-back is the
backstop. A question type for "did you want X (+$2)?" is a later decision.

## Landed 2026-09-25 (v648–v654)

Rules 1–6 above, plus Jason's finer touches after his phone test that morning: identical lines merge into one ticket
row; "take one off" lowers a count instead of dropping the line; the robot line is said once per conversation, then
"Here's the updated order"; "do you have hot dogs?" is answered ("Yes, we do. Hot Dog: served with fries. Want one?")
and YES adds it; "did you add a hot dog?" is answered from the cart even when the model shrugs; an unknown word the
customer explains ("glizzies means hot dog") gets "Oh, gotcha", the count carries over, and the word is saved to the
shop's lexicon (provenance stated, evidence source customer) so the next customer is understood; short replies read
as one message instead of a blank-line printout. Verified live: a second conversation's "two glizzies please" added
two hot dogs.

## The voice layer (landed v655–v657)

The engine builds the same plan and renders the same draft. `voice.ts` (the third and last model adapter) asks Haiku to
say the draft the way the person at the counter would; `normalize.faithfulRewrite` then checks the rewrite against the
draft (every number, digits or words, survives and none appears; every mid-sentence name survives and none appears,
plurals allowed; the question stays; no wait times or contact promises; a length cap) and the runner adds one more check
with the menu itself (a menu item the draft never named is invented, whatever its casing). Any doubt, timeout (2.5 s) or
failure sends the draft. Lists, links and long read-backs are never voiced. `ENGINE_VOICE=off` kills it without a deploy;
`ENGINE_VOICE_MODEL` swaps the model. Every turn logs `voice_rephrased` or `voice_kept_draft` with the reason, so the
checker's false rejections can be read and fixed from data. Cost: about a twentieth of a cent per turn; latency +0.8–1.5 s.

Live on v656, Jason's own conversation replayed:
"Yeah we got hot dogs, they come with fries. You want one?" / "Got you down for 1 hot dog. Anything else?" /
"Yep, we got the 1 Hot Dog on there. Anything else or are we all set?"

