# SPEC — Review panel under the simulator, plus a scroll bug

**From:** Claude (outside PO) → OrderFare · 2026-09-05
**Authority:** Jason. Extends `2026-09-05-test-capture.md` — same buttons, same storage.

---

## PART 1 — the scroll bug (do this first, it is small)

**Symptom, from Jason:** typing in the simulator and pressing Enter yanks the whole page
upward, so the simulator scrolls off the top of the screen and he has to scroll back down
to keep working.

**Cause** — `admin-dashboard/src/components/ShopChatTest.tsx:63`:

```js
messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
```

No `block` option means `block: 'start'`, which scrolls that element to the top of the
viewport. Because it is the *end* marker of the message list, the browser scrolls the page
until the bottom of the chat is at the top of the screen.

**Fix:** scroll the message container, not the page. Prefer setting the container's own
`scrollTop` to `scrollHeight` so page scroll is never touched at all. If you keep
`scrollIntoView`, it must be `{ behavior: 'smooth', block: 'nearest' }`.

**Second contributor, same file:** the `focus()` at line 229 and `autoFocus` at line 341
both make the browser scroll the focused input into view. Use
`inputRef.current?.focus({ preventScroll: true })` and drop the `autoFocus` if it is
redundant.

**Acceptance:** send several messages in a row in the simulator with the page scrolled
part-way down. The page must not move. Only the message list scrolls.

---

## PART 2 — the review panel

A panel directly beneath the simulator that shows what the judge said about the
conversation just submitted. Jason's intent: a shop owner will sit and play with the
simulator before launching, and watching an intelligent critique of their own conversation
is what makes them trust it.

### Behaviour

1. Owner runs a conversation, presses **Send for review** (from the capture spec).
2. The panel below shows, in this order:
   - **What happened** — a plain-language read of the conversation. Where it went well,
     where it went wrong, naming the specific turn.
   - **A score**, clearly labelled advisory.
   - **Proposals** — concrete suggested improvements, each clearly marked
     **"Proposed — pending review"**.
3. Proposals are written to a queue for the product owner. **They never touch the live
   engine.**

### The hard constraint

**Nothing an owner does in this panel may change the ordering engine, that shop's prompt,
or any shared configuration.** Ten owners independently mutating the prompt is how a bot
starts promising things a kitchen cannot make — we shipped exactly that defect this week.

The judge observes and proposes. A human approves. Build the queue; do not build any
auto-apply path, not even behind a flag.

This is consistent with the standing rule: an LLM judge is **advisory and never gates
launch**, while deterministic scoring gates. This is the advisory lane.

### Data

Extend `test_transcripts` from the capture spec:
- `judge_summary` text — the plain-language read
- `judge_score` integer nullable — advisory
- `judge_proposals` jsonb — array of `{title, rationale, target, status}` where `status`
  starts as `proposed`
- `judged_at` timestamptz

Expose in `qa_ro` so the product owner can read the proposal queue.

### Tone

The owner reading this is a restaurant owner, not an engineer. No jargon, no rule names,
no file paths. "It said the wings were added but they weren't" — not "phantom add guard
did not fire on turn 3."

### Acceptance

1. Submitting a conversation produces a visible critique in the panel within a few seconds.
2. Every proposal renders as pending review, never as applied.
3. No code path exists by which a proposal reaches the live prompt or config.
4. `qa_ro.test_transcripts` exposes the judge fields.
5. The critique for a conversation containing an obvious defect names that specific turn.
