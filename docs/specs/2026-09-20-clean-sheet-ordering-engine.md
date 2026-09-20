# OrderFare Ordering Engine — Clean-Sheet Design

2026-09-20 · Fable · written from the original intent only, not from the current code.

## 0. The one-paragraph version

An order is a **form** with a fixed set of fields. The conversation exists to fill the form.
Code owns the form, decides which field is open, resolves words to menu rows, does all
arithmetic, and decides what to say. The model does exactly one job per turn: translate one
customer message into a short list of typed **moves** against that form. It never sees prices,
never sees the transcript, never decides the next question, and never writes the reply. Every
one of the four failures you listed is the model being asked to hold state or make decisions.
Take those away and the failures have no place to live.

| Symptom | Cause in any design that shows it | What this design does instead |
|---|---|---|
| Asks the same question repeatedly | Model infers "what is still open" from prose | Open question is computed from the form; a field asked and answered cannot be asked again |
| Drops items in multi-item messages | Extraction and state update are one probabilistic step | Model emits a list of moves; a second, deterministic reader scans the same message; any mention neither reader accounts for becomes a question, never silence |
| Adds items nobody asked for | Model composes or guesses identity | Model emits verbatim spans; code resolves against the shop lexicon; 0 or >1 matches means ASK |
| Wrong totals | Model computes or restates numbers | Money is a pure function of form + menu, integer cents, rendered by a template |

## 1. Scope and intent

**In scope.** A customer texts a shop's number. The engine resolves, in a natural exchange:

1. Pickup or delivery
2. If delivery: address (validated against the shop's delivery zone)
3. Items, one line at a time, each bound to one menu row with all required choices made
4. If delivery: tip
5. Read-back and confirmation
6. Hand-off to payment (a checkout link); the paid order becomes the kitchen ticket

**Out of scope.** Post-payment edits, loyalty, upsell, scheduling for later, multi-shop
routing, voice. Menu ingestion is a separate system; this document states only what the
engine requires from it (§4).

**Bar.** A stranger texts the number, places a multi-item order, pays, and the kitchen gets
the right ticket, three times running with nobody intervening.

## 2. Architecture

```
inbound SMS ──► [1 LOAD form] ──► [2 INTERPRET: one model call → moves]
                                          │
                     [3 CROSS-READ: deterministic lexicon scan of the same message]
                                          │
                        [4 APPLY: reducer writes moves to form + ledger]
                                          │
                        [5 RESOLVE: spans → menu rows; ambiguity → ask]
                                          │
                        [6 PRICE: pure function, integer cents]
                                          │
                        [7 NEXT: first unfilled required field → reply plan]
                                          │
                        [8 RENDER: template → text]  ──► outbound SMS
                                          │
                        [9 PERSIST form, ledger, reply; idempotent on message id]
```

Steps 1 and 3 through 9 are ordinary code with no model in them. Step 2 is the only
probabilistic component. Step 8 may optionally be voiced by a model under a fact-preservation
check (§8), but ships as templates first.

The whole engine is a pure function:

```
turn(form, menu, inbound_message, moves) -> (form', ledger_entries, reply_plan)
```

That signature is the design. Everything that makes the system testable, debuggable, and
boring follows from it.

## 3. The form (state)

One record per conversation. **The transcript is not the state.** The form is.

```
OrderForm {
  shop_id, customer_phone, menu_version          // pinned at first turn
  status: open | confirming | awaiting_payment | paid | abandoned

  fulfillment:   unset | pickup | delivery
  address:       unset | { text, validated: bool, zone_ok: bool }
  tip:           unset | { kind: percent|cents, value }
  items_done:    false | true                     // customer said "that's it"
  confirmed:     false | true                     // customer said yes to the read-back

  lines: [ Line ]
  focus: null | { line_id, slot }                 // the one thing we are currently asking about

  open_question: null | { field, line_id?, slot?, asked_count, last_asked_turn }
  turn_no
}

Line {
  line_id (1,2,3… stable, shown to the customer when >1 line)
  span            // verbatim customer text that created it
  item_id: null | menu row id
  qty
  choices: { slot_id -> choice_id }              // required slots (size, bread, …)
  modifiers: [ modifier_id ]                      // optional add-ons (extra cheese, no onions)
  note: free text passed to kitchen, never priced
  status: unresolved | ambiguous{candidates} | needs_slot{slot_id} | complete
}
```

**Ledger.** Append-only events: `{turn_no, message_id, move, source_span, result}`. Every
line in the form points to the customer words that created it. Every question asked is an
event. This is the audit trail for "why did it do that" and the input to the dropped/added
item assertions in §9.

**Required-field order** (data, per shop, default shown):

```
fulfillment → address(if delivery) → lines complete → items_done → tip(if delivery) → confirmed
```

Tip sits after the cart on purpose: a percentage tip needs a subtotal. The customer may
answer any field at any time and in any order; the sequence only decides what we *ask* next.

## 4. Menu contract (what the engine needs)

The engine reads a compiled, versioned, read-only menu. Nothing about how it was built
matters here; these are the requirements.

```
Item      { item_id, name, base_cents, slots: [Slot], allowed_modifiers: [modifier_id], facets: {kind, category, …}, available }
Slot      { slot_id, name, required: true, choices: [ {choice_id, name, delta_cents} ], ask_style: enumerate|open }
Modifier  { modifier_id, name, delta_cents }
Lexicon   { term (normalized surface form) -> target (item_id | choice_id | modifier_id) }   // unique per shop
Canon     { (base_item_id + modifier_id) -> derived item_id }                                // "cheese pizza + pepperoni" = "pepperoni pizza"
```

Rules the menu must satisfy before a shop is live (a gate, no model in it):

- Every orderable item has at least one lexicon term that resolves uniquely to it, including
  the bare, space-collapsed, and plural forms of its name.
- Lexicon collisions are dropped at compile time, never ranked at run time.
- Predictable compositions are **materialized** as derived rows with a canon entry, so the
  engine never prices a composition it has not seen as a row.
- Every required slot has a finite choice list and an `ask_style`: `enumerate` when 4 or fewer
  choices, `open` otherwise.
- Items carry facets sufficient to ask a narrowing question (`kind` at minimum).

## 5. INTERPRET — the one model call

**Input** (small; a few hundred tokens):

- The customer's message, verbatim.
- The last outbound message (so "yes", "the second one", "large" have a referent).
- The open question, as structured data: `{field, expected: enum|address|number|item-slot, choices?}`.
- The current lines, as `[{line_id, display_name_or_span, qty}]`. **No prices.**
- The focus line and slot, if any.
- Nothing else. No menu. No transcript. No shop instructions beyond a fixed system prompt.

**Output**: a JSON array of moves, schema-enforced. Every span is verbatim text from the
message. The model chooses **kinds and spans**, never ids, prices, or wording.

```
answer        { field: fulfillment|address|tip|items_done|confirmed, value_span }
add_line      { item_span, qty, choice_spans: [..], modifier_spans: [..], note_span? }
change_line   { ref: line_id | ordinal_span | item_span, qty? , add_modifier_spans?, remove_modifier_spans?, choice_spans? }
remove_line   { ref }
answer_slot   { ref?, value_span }            // "large" while focus is a size question
ask_menu      { about_span }                  // "what sizes?", "what's on the works?", "how much is…"
control       { kind: cancel | start_over | human | greeting | unclear }
```

A single message can yield several moves: "delivery to 12 Main St, 2 large pepperoni and
garlic knots" → `answer(fulfillment)`, `answer(address)`, `add_line(qty 2, "pepperoni",
["large"])`, `add_line(qty 1, "garlic knots")`.

Prompt discipline: temperature 0, schema-enforced output, ten or so worked examples covering
the phrasing matrix (comma+digit, comma+word, "and"-separated, bare list, conversational,
corrections). This prompt is global and does not change per shop. Shop voice lives in
templates (§8), not here.

## 6. CROSS-READ and APPLY — no silent drops, no silent adds

**Cross-read.** Independently of the model, code runs longest-match over the lexicon across
the whole normalized message. The result is a set of `{term, target, char_range}` hits.

**Reconciliation, in code:**

- A model `add_line`/`change_line` span that overlaps a lexicon hit: consistent. Proceed.
- A lexicon hit no move covers: the model may have dropped it. Do **not** add it. Record a
  `possible_omission` and ask: "Did you also want garlic knots?" One question, next turn.
- A model `add_line` span with no lexicon hit at all: goes to RESOLVE as `unresolved`
  (§7), which asks rather than guesses.

This is not a guard on prose. It is two readers of the same sentence that must agree before
the form changes, with disagreement routed to the customer.

**Apply** is a reducer: `apply(form, move) -> form'`. Rules:

- `answer` writes only its field. Validation is code (address geocode + zone; tip in range).
- `add_line` creates a line with `status: unresolved`.
- `change_line`/`remove_line` resolve `ref` deterministically: explicit `line_id` >
  ordinal against the last rendered numbered list > unique item-span match > the most
  recently added line **only if there is exactly one line**. Anything else is an ask:
  "Which one — 1) Pepperoni Pizza or 2) Garlic Knots?"
- `answer_slot` writes to the focus line only.
- Any move that fails a rule becomes an ask. Nothing is dropped on the floor and nothing is
  guessed.

## 7. RESOLVE — words to rows

For each line not yet `complete`:

1. **Item.** Longest-match `item_span` against the lexicon.
   - 1 item target → bind `item_id`.
   - 0 targets → `unresolved`. Fuzzy suggestion allowed only as a **question** ("We don't
     have 'peproni' — did you mean Pepperoni Pizza?"). Never a silent bind.
   - >1 targets → `ambiguous`. Narrow by facet (§7.1).
2. **Canonicalize.** If `item_id + modifier` has a canon entry, rewrite to the derived row
   and drop the modifier. "Cheese pizza with pepperoni" becomes the Pepperoni Pizza row.
3. **Choices.** Each `choice_span` resolves against the bound item's slots only. Unmatched
   spans that match a modifier become modifiers; otherwise they go to the kitchen note and
   are reported back in the acknowledgement so the customer sees they were not priced.
4. **Required slots.** First unfilled required slot → `needs_slot`, and this line becomes
   `focus`.

### 7.1 Narrowing, not listing

Ambiguity is resolved the way a counter person does it: one facet at a time, against the
remaining candidate set.

- "a pizza" (76 candidates) → "What kind of pizza?" (`kind` facet, `open`)
- "pepperoni" → 3 candidates differing by size → "What size — small, medium, or large?" (`enumerate`)
- Enumerate the full candidate list only on an explicit `ask_menu`.

Each answer filters the candidate set; when it reaches 1 the line binds. The candidate set is
stored on the line, so the next answer is matched against those candidates only, never the
whole menu.

## 8. PRICE, NEXT, RENDER

**Price** — pure function, integer cents, recomputed on every render from the form and the
pinned menu version:

```
line_total = (base_cents + Σ choice.delta + Σ modifier.delta) × qty
subtotal   = Σ line_total over complete lines
fees       = shop fee schedule (delivery fee if delivery; platform fee)
tax        = shop tax rule on the taxable base
tip        = percent of subtotal, or fixed cents
total      = subtotal + fees + tax + tip
```

Lines that are not `complete` have no price and are not summed. Money appears in exactly one
place in the system: the renderer, reading this function's output.

**Next** — the single decision function:

```
next(form) -> ReplyPlan
  1. if any line.status == ambiguous|needs_slot|unresolved → ask about the focus line
  2. if a possible_omission is pending → ask it
  3. else first unfilled field in the shop's required-field order → ask it
  4. if items_done && all lines complete && tip settled → status=confirming, read back, ask confirmed
  5. if confirmed → status=awaiting_payment, emit handoff
```

Exactly one question per reply. Acknowledgements (what changed this turn) always precede it.

**Repeat detection is state, not hope.** When `next` picks a field whose `open_question`
already has `asked_count ≥ 1` and the customer's message produced no move for that field:

- count 2: re-ask with the choices spelled out ("I need pickup or delivery to continue.")
- count 3: switch to enumerated single-word answers ("Reply 1 for pickup, 2 for delivery.")
- count 4: offer a human / the shop's phone number and stop asking.

The same question can therefore never be asked the same way twice, and never more than
four times.

**Render** — `ReplyPlan` → text via templates. `ReplyPlan` is structured:

```
{ acks: [ {line_id, display_name, qty, choices, line_total_cents} | {field, value} ],
  question: { kind, text_key, choices?, line_id? } | readback{lines, subtotal, fees, tax, tip, total} | handoff{url},
  hints: [ possible_omission … ] }
```

Templates are per shop (voice, sign-off, name) over a global set of keys. The renderer is the
only code that formats money. Optional later step: a model "voicing" pass that rewrites the
template output, accepted only if every item name, quantity, and dollar amount in the plan
appears verbatim in its output; otherwise the template text is sent. Ship without it.

## 9. Correctness properties and how they are tested

The engine is a pure function, so most of this is unit tests with no model in the loop.

| # | Invariant | Test |
|---|---|---|
| I1 | Every line traces to a customer span; every lexicon hit in a message ends the turn as a line, an ask, or an explicit decline | Property test over the phrasing matrix × menu: no unaccounted hit |
| I2 | At most one question per reply; a field is never asked after it is filled; identical question text never sent twice in a row | Assert on `ReplyPlan` sequence across scripted conversations |
| I3 | Rendered total equals `price(form)`; two-sided (over **and** under) | Parse rendered text, compare to function |
| I4 | No `item_id` is written without a unique resolver result | Reducer test with ambiguous and zero-match fixtures |
| I5 | Same inbound message id twice → same form, one reply | Idempotency test |
| I6 | Derived canon: base+modifier never prices differently from its derived row | Menu gate + pricer test |

**Model evaluation is separate and offline.** A dataset of customer messages with context
(open question, lines) → expected moves. Score item recall (dropped), item precision
(invented), and field accuracy. Run on every prompt or model change. This is the only place
the model's behavior is measured, and it is measured against a fixed answer key, not by
reading replies.

**End-to-end acceptance**: simulated customers drive scripted orders through the real
stack to a real (test-mode) checkout session. Assertions read the DB, not the prose:
line ids and quantities equal the script, `stripe_checkout_session_id` present, total equal
to an independently computed expectation, and no extra lines. Five runs per scenario;
one clean run is a sample.

## 10. Worked conversation

```
C: hi
   moves: control(greeting). next: fulfillment.
B: Hi, this is Vito's. Pickup or delivery today?

C: delivery to 123 Main St, 2 large pepperoni and an order of garlic knots
   moves: answer(fulfillment,"delivery") answer(address,"123 Main St")
          add_line(2,"pepperoni",["large"]) add_line(1,"garlic knots")
   cross-read: hits {pepperoni→Pepperoni Pizza, large→size:L, garlic knots→Garlic Knots} all covered.
   resolve: line1 = Pepperoni Pizza (derived row), size L, complete. line2 = Garlic Knots, complete.
   address: geocoded, in zone.
   next: items_done unset.
B: Got it — delivery to 123 Main St.
   1) 2 × Large Pepperoni Pizza  $37.98
   2) 1 × Garlic Knots  $6.50
   Anything else?

C: make the knots 2 and add a small cheese
   moves: change_line(ref:"knots", qty 2) add_line(1,"cheese",["small"])
   resolve: "cheese" → ambiguous {Cheese Pizza, Cheese Fries, Cheesesteak}; "small" is a
            slot value, held. focus=line3. next: rule 1.
B: Updated: 2 × Garlic Knots $13.00. For the small cheese — cheese pizza, cheese fries, or cheesesteak?

C: pizza
   moves: answer_slot("pizza"). candidates filter to Cheese Pizza; held "small" now binds size S. complete.
B: Added 1 × Small Cheese Pizza $11.99. Anything else?

C: thats it
   moves: answer(items_done). next: tip (delivery).
B: Add a tip for your driver? Reply 15, 20, 25 for percent, a dollar amount, or 0.

C: 20
   moves: answer(tip,"20"). next: confirmed → readback.
B: Here's your order for delivery to 123 Main St:
   1) 2 × Large Pepperoni Pizza  $37.98
   2) 2 × Garlic Knots  $13.00
   3) 1 × Small Cheese Pizza  $11.99
   Subtotal $62.97 · Delivery $3.00 · Tax $4.16 · Tip $12.59 · Total $82.72
   Reply YES to get your payment link, or tell me what to change.

C: yes
B: Pay here: <link>. We'll text you when it's in the oven.
```

Every number above came out of `price()`. Every line came from a span. The model produced
five short JSON arrays and nothing else.

## 11. What this design forbids

These are design rules, not implementation advice. Any one of them broken re-creates a
failure mode from the top of this document.

1. The model never sees a price, a total, or the full menu.
2. The model never sees the transcript; it sees the open question and the lines.
3. The model never emits an id, a number of dollars, or reply text that reaches the customer.
4. Code never infers state from prose: no regex over replies, no "guards", no reconciler
   reading what the bot said.
5. Ambiguous means ask. No tiebreak, no popularity, no cheapest-wins, no default size.
6. No runtime composition of items that could have been rows.
7. One question per turn, derived from the form, with repeat escalation as state.
8. Shop differences live in data (menu, lexicon, templates, field order, fees), never in
   the prompt and never in code branches.

## 12. Size and effort

| Component | Nature | Rough size |
|---|---|---|
| Form + ledger schema | SQL | 2 tables |
| Interpret prompt + JSON schema | Prompt | ~150 lines, global |
| Cross-read + reducer | Code, pure | ~400 lines |
| Resolver + narrowing | Code, pure | ~300 lines |
| Pricer | Code, pure | ~80 lines |
| Next + repeat escalation | Code, pure | ~150 lines |
| Renderer + templates | Code + data | ~200 lines + per-shop template rows |
| Turn runner (load, call, persist, idempotency, SMS I/O) | Code | ~200 lines |
| Unit + property tests | Tests | as large as the engine |
| Move-extraction eval set | Data | 300–500 labelled messages |

About 1,500 lines of engine, most of it pure functions, plus a menu that satisfies §4.
A conversation turn is one small model call; latency should be a few seconds, dominated by
the SMS carrier, not the model.
