# SPEC — Capture human test conversations

**From:** Claude (outside PO) → OrderFare
**Authority:** Jason, 2026-09-05, after running an order through the Expo Screen.

## Why

Jason's two human test orders found eleven real defects. Months of AI-to-AI testing found
none of them. Those two transcripts exist only because he pasted them into a chat window —
if that window closes, the evidence is gone.

This makes human testing cheap to capture and permanent. It also lets Erin report from the
field with one tap instead of writing anything up.

## What to build

Two buttons beneath the chat simulator in each shop's **Chat Test** tab.

### Button 1 — "Copy transcript"

Copies the full conversation to the clipboard as plain text: every customer message and
every bot reply in order, including the cart footer lines, plus a header naming the shop,
the model, and the timestamp. Formatted to be pasted somewhere and read by a person. No
markdown tables — plain text.

### Button 2 — "Send for review"

The important one. On click:

1. Prompt for **one short free-text answer**: *"What felt wrong?"* — with a Skip option.
   This is the whole point. The transcript is data; Jason's or Erin's one-line judgement is
   what turns it into a labelled example. Do not make it a required field and do not make it
   longer than one line.
2. Persist the conversation to a new table (below).
3. Confirm on screen: "Sent for review."

## Data model

New table `test_transcripts`, and add it to the `qa_ro` read-only schema so the product
owner can read it:

- `id` uuid pk
- `shop_id` uuid
- `shop_name` text (denormalised — shops get deleted, transcripts should outlive them)
- `model` text — which model served the conversation
- `messages` jsonb — ordered array of `{role, text, at}` covering BOTH directions, verbatim,
  including cart footers exactly as sent
- `final_cart` jsonb — item list and total at the end of the conversation
- `reporter_note` text nullable — the "what felt wrong" answer
- `source` text — 'simulator' | 'field' (Erin's demos will be 'field' later)
- `created_at` timestamptz

Verbatim matters. Do not summarise, truncate, or reformat the messages — every defect we
found this week was visible in the exact wording and would have been lost in a summary.

## Acceptance

1. Running a conversation in the simulator and pressing Copy puts the full readable
   transcript on the clipboard.
2. Pressing Send for review, answering the prompt, and skipping the prompt all persist a
   row with complete verbatim messages.
3. `qa_ro.test_transcripts` is readable by the read-only role.
4. A transcript survives its shop being deleted.

## Explicitly not in scope

Do not build any automatic analysis, scoring, or LLM judging of these transcripts. Capture
and store only. Judgement stays with the product owner.

## Note on volume

These accumulate and become the regression corpus we do not currently have. Do not add a
retention policy or auto-cleanup.
