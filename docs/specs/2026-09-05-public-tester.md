# SPEC — Public tester link

**From:** Claude (outside PO) → OrderFare · 2026-09-05
**Authority:** Jason. Extends the test-capture work already shipped.

## Why

Jason's three human test orders have found more real defects than every automated test
combined. He has friends and family willing to test. The constraint is that testing
currently requires admin access to the dashboard.

Goal: a link he can text to a group. They open it on a phone, order pretend pizza, hit a
button, and leave a comment. Their transcripts land in `test_transcripts` alongside his.

## What to build

A standalone page — **no login, no account, works on a phone browser.**

- Opens straight into the chat simulator against a **test shop** (the Vito's QA clone,
  never a live shop, never a real phone number).
- Brief framing at the top, one or two lines: this is a test of a text-message ordering
  system, order like you would from a real pizzeria, nothing is charged and no food comes.
- The existing **Send for review** button, with the same one-line "what felt wrong?"
  prompt, plus an optional first-name field so we can tell testers apart.
- On submit: thank them, and let them start a fresh conversation.

Reuse the simulator component and the capture path already built. This is a thin public
wrapper, not a second implementation.

## Data

Write to the same `test_transcripts` table. Set `source = 'public-tester'` so these are
distinguishable from Jason's `simulator` runs and Erin's future `field` reports.
Add `tester_name` text nullable.

## Guard rails — this is a public endpoint

- **Rate limit per browser session and per IP.** A handful of conversations per hour is
  plenty for a friend testing pizza; anything above that is abuse or a loop.
- **Cap conversation length** — some sensible number of turns, then invite them to submit
  and start over. Prevents a single session running up cost.
- **Never point at a live shop.** Test shop only, no real number, no real Stripe path.
- **A kill switch** — one config flag that disables the page instantly if it is abused or
  gets expensive.

## Report before building

Tell me the estimated cost per conversation at current model pricing, and what a hundred
testers doing three orders each would cost. Jason should know the number before he sends
the link, not after.

## Explicitly not in scope

No scoring, no LLM judging, no auto-fixing from tester input. Capture and store only.
Judgement stays with Jason and the product owner.
