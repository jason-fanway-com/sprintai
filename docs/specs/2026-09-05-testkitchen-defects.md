# Test Kitchen defects — Jason's 2026-09-05 16:27 UTC transcript

Source of truth: `test_transcripts` row, source `public-tester`, shop Vito's Pizza (QA).
All three root causes below were located in the code and confirmed against the stored cart.

**Do not regress what now works:** multi-item add, compliance footer last, no upsell garbage,
no "check with the kitchen" promise.

---

## DEFECT 1 — truncated reply

Turn 4 shipped literally: `the meantime. What flavor were you thinking?`

**Root cause:** `chat-sms/invented-action-guard.ts`. `stripInventedActions()` removes the
offending clause/sentence, but nothing validates the REMAINDER. Both removal paths can leave
a dangling fragment as the new first sentence — `TRAILING_CLAUSE` (a `gi` replace that eats
from a mid-sentence dash/comma to the end of the sentence) and the sentence filter
(`split(/(?<=[.!?\n])\s+/)` treats an abbreviation or stray period as a boundary, so the tail
of a promise sentence survives on its own).

**Required behaviour:** the guard must never ship a reply that begins mid-sentence.

- After stripping, if the result was modified AND its first sentence looks like a fragment —
  begins with a lowercase letter, or with a connective (`the/and/but/so/in/on/at/to/for/with/
  meantime/then/while`) — drop that leading fragment and keep the rest.
- If nothing survives, fall back to the existing safe sentence.
- Apply ONLY when the guard actually changed the text, so untouched replies are unaffected.
- Add cases to `guard-defects-20260905.test.ts` including the exact observed output, and a
  case proving a normal reply starting with a lowercase word is untouched when the guard
  did not fire.

---

## DEFECT 2 — a fabricated modifier reached a real ticket

Customer said `Boosenberry`; the bot replied "Boosenberry bone-in wings — noted!" and the
stored cart row is:

    Wings (Bone-In) - 10 Pieces | mods [] | options {"Flavor": ["Boosenberry"]}

**Root cause:** in `add_item` (and the same shape in `modify_item`), `modifiers` are validated
against `validMods` and rejected when unknown — but `options` are NOT. The validation loop
iterates `itemGroups` (groups that EXIST). An option KEY the model invents matches no group,
is never inspected, and is copied verbatim into `normalizedOptions` and saved. This item has
`prompt_for` set with no recorded choices, so every key is unknown and everything passes.

**Required behaviour:**

1. **Reject unknown option keys**, symmetric with `invalidMods`: any key in `options` that is
   not a real option group for that item (after the existing modifier-misroute normalisation)
   returns `{ok:false, error:...}` naming the item's real groups, or stating it has none
   recorded. A fabricated selection must never be stored as if validated.
2. **Do not lose the customer's request.** When the item has `prompt_for` and the customer
   names something we cannot validate, record it on the cart item as
   `unverified_requests: string[]` (e.g. `"Flavor: Boosenberry"`) — NEVER as `options` or
   `modifiers`, and it must not affect price.
3. **It must render as unverified** everywhere the cart is shown to a human — the chat cart
   line and the kitchen ticket — as a customer request that is not a menu option
   (e.g. `Wings (Bone-In) — customer asked for: Boosenberry (not a menu option)`).
4. **The reply must be honest**: say the request will be passed to the shop, or ask them to
   choose once the list exists. It must not imply the flavor was selected from a menu.
   "Noted!" on an unvalidated value is the failure being fixed.

Prompt rules alone are insufficient — the guarantee is the tool rejecting the write.

---

## DEFECT 3 — the fee breakdown repeats every turn (Jason product call)

Every turn ends with `(subtotal $X + $0.99 service fee)`. Jason: show the running item count
and total each turn; state the service fee breakdown ONCE when it first applies, and again at
checkout. **The fee must still be disclosed before payment** — this is a noise fix, not a
disclosure removal.

**Where:** `renderLedgerFooter()` — line 1 always, line 2 conditional.

- Disclose the breakdown on the first turn the fee applies (cart first becomes non-empty),
  and at checkout.
- Persist that it has been disclosed on `order_carts` (new column, migration 099 — e.g.
  `fee_disclosed_at timestamptz`). Do not infer it from message history.
- Verify the existing checkout disclosure ("includes $0.99 service fee") still fires; if the
  checkout path relies on the footer's line 2, keep it there.

---

## Acceptance — drive the LIVE public path, do not assert from code

Use `https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/public-tester`
(`start` → `send`), anon key in `test-kitchen.html`, `Origin: https://getsprintai.com`.

1. Replay Jason's exact sequence: `Large cheese pizza and a side of garlic knots` → `Fries`
   → `Wings` → `Bone in and what flavors are there?` → `What flavors are there?` →
   `Boosenberry`. Paste every verbatim reply.
2. No reply begins mid-sentence.
3. After `Boosenberry`, query the stored cart: NO `options` key on the wings item; the
   request appears only as `unverified_requests`, and the price is unchanged.
4. The fee breakdown appears exactly once before checkout, and again at checkout.
5. Item count and total still appear every turn.
6. Multi-item add still works (2 items, $23.48) and the compliance footer is still last and
   first-message-only.
7. `deno check` on changed files. NOTE: `chat-sms/index.ts` has 5 PRE-EXISTING type errors —
   confirm the count is unchanged, do not fix them here.

Delete your own test rows from `public_tester_sessions` scoped BY SESSION ID. Never a blanket
delete: a live tester's row must not be destroyed mid-conversation.
