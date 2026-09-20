TASK: whole-term-match-and-rejections — MONEY BUG, live conv 087abb8d (#41): a which-one list open for
      "shrimp" was declined ("I didn't ask for any of those! ... Let's stick to that, thanks!") and the bot
      added Mozzarella Sticks (6) instead, one leg of a real $107.43-vs-~$85 overcharge. Plus a same-family
      quantity-drop follow-up, confirmed on HEAD after tonight's separate "none of those" fix landed.
BRANCH: fix/whole-term-match-and-rejections-20260919 (merged main first — fast-forward, picked up tonight's
        "none of those"/quantity/bleu-cheese fix at 05f6970d, no conflicts)

INVESTIGATION:
  Queried Vito's live menu + lexicon directly (SPRINTAI_CHAT_SUPABASE_URL, shop
  e0000000-0000-0000-0000-000000000001): Southwest Shrimp (Wraps, $12.99, id 15d09f9d-...), Boom Boom Shrimp
  (Appetizers, $11.99, id 31b9e812-...), Mozzarella Sticks (6) (Appetizers, $8.99, id 4ff5efef-...). "shrimp"
  is an active lexicon term for BOTH shrimp items (a genuine tie -> disambiguation, matches the live
  transcript). "sticks" is an active lexicon term for Mozzarella Sticks alone.

  RULE 1+2 root cause (same turn, two independent gaps that both had to fire):
  - isPendingDisambiguationDeclined's DECLINE_CUES regex matched the contraction "don't" but not "didn't" —
    "I didn't ask for any of those" never registered as a decline at all, so it fell through to the free-text
    new-item resolver instead of being dropped.
  - That resolver (messageNamesItemOutsideCandidates, turn-engine.ts) ran the text through a typo-correction
    pass (fuzzyCorrectAgainstLexicon) before resolving it. That pass's fuzzy matcher (guard19-fuzzy-item-
    match.ts's fuzzyWordMatch) has a prefix rule meant for real truncations ("pepp"/"pepperoni") — but "sticks"
    is just "stick" + a plain "s", so ANY standalone word that happens to be the singular of an active lexicon
    plural collides the same way. "stick" (from "let's stick to that" — declining, not ordering) matched
    "sticks" (Mozzarella Sticks) this way and got silently added. Confirmed directly against the pre-fix code
    (not guessed): the exact same call returns `disambiguation_new_item_added` -> Mozzarella Sticks, quantity
    1, before this fix; `closure`, cart untouched, after.
  - Fix: DECLINE_CUES now also matches "didn'?t" (pending-disambiguation.ts). resolveItem (resolve-item.ts)
    gained an optional 4th param `allowFuzzyFallback = true`; messageNamesItemOutsideCandidates
    (turn-engine.ts) now calls it with `false` and no longer runs the typo-correction pass at all (removed
    fuzzyCorrectAgainstLexicon entirely — it had no other caller). Every other resolveItem caller (fresh adds,
    replacements, the which-one/resolved-path lexicon lookup) is completely unaffected — this only tightens
    the ONE deterministic "does an answer-turn's free text name something new" gate to exact whole-word/whole-
    term matching. "sticks" as a genuine standalone word still resolves exactly as before (regression-tested).

  RULE 3 root cause (real conv 087abb8d, later in the same transcript): "take it off, just the original order
  please! no extras!" arrived while a slot question was open ("what type of wrap for the Southwest Shrimp?").
  answer()'s "slot" case tried applyCompiledModifyItem, then a direct choice match against the open step —
  neither matched — and fell through to UNRESOLVED, at which point turn-engine-runner.ts's own
  extractSlotChoiceWords echoed a stripped fragment of the customer's decline back as if it were an attempted
  (wrong) slot value: "We don't have "please! no extras" for Southwest Shrimp." Verified this exact string
  directly (extractSlotChoiceWords("take it off, just the original order please! no extras!") ===
  "please! no extras", byte-for-byte the live wording).
  - Fix: a new DECLINE_OPEN_ITEM_RE (`take it off` / `remove it`, with "it"/"that"/"this" as the object —
    "take the cheese off" is a real modifier and stays untouched) is checked FIRST in the "slot" case, before
    any slot-value matching runs — matched, it removes the cart line and returns a new outcome kind
    (`slot_item_declined`), same mutate-in-place / "nothing else to persist" convention as `slot_resolved`.
    Also wired into the "category_confirm" (keep-or-drop) case alongside the existing `impliesUpsellDecline`
    check, per the rule's own generality — "take it off" declines that question exactly like a bare "no".

  RULE 4 root cause: the SAME defect DEFECT 2 fixed tonight for the which-one/resolved path
  (extractAnswerQuantity, scoped to the answer clause) exists on the sibling "new item resolved from an
  answer turn's free text" path (messageNamesItemOutsideCandidates) — its quantity came only from
  extractLeadingClauseCount, which requires the count to be the very FIRST token ("2 Large Pepperoni
  pizzas"); the "Nx" shape ("2x Large Pepperoni pizzas") matched nothing there and silently fell back to 1.
  - Fix: messageNamesItemOutsideCandidates now tries extractAnswerQuantity against the answer clause first,
    falling back to the existing leading-count `count` only when the clause states no explicit "Nx" — same
    scoping discipline as the which-one path, so a LATER unrelated item's own "2x" elsewhere in a restated
    order can never be misread as this item's count.
  - SCOPE BOUNDARY (flagging honestly rather than overclaiming): the PO's own probe example restates a full
    THREE-item order in one message ("...2x Chicken Alfredo with linguine, 2x Large Pepperoni pizzas, and 1x
    bleu cheese"), with the Alfredo expected to open its own fresh which-one question. messageNamesItemOutsideCandidates
    is, and was, a SINGLE-target resolver — it returns at most one item per call by design (see its own
    header: a genuine multi-item restatement is deliberately left to the remainder mechanism / a fresh
    PROPOSE call, never parsed here, so it doesn't eat a different mechanism's job). Making it split a
    free-text list into several independently-resolved items with per-clause disambiguation is a real,
    separate capability — not a quantity-regex fix — and reaches into the outcome shape at all three of this
    function's call sites. I did not build that tonight: it's a materially bigger change than "apply the same
    extractAnswerQuantity logic," and I was not going to ship a half-tested multi-item resolver at this hour.
    What IS fixed and tested: the concrete, code-fixable half — an explicit "Nx" on a single new item named
    during a decline/rejection no longer drops to 1 on this path, mirroring the which-one path exactly as
    asked. Recommend a follow-up item if Jason wants full multi-item-list support on this specific gate.

COMMIT: (pending — see below)
TEST RESULT: ok | 1898 passed | 0 failed | 7 ignored (baseline 1890 tonight; 8 new tests, all in the new file
             shrimp-stick-rejection-20260919.test.ts)

ACCEPTANCE:
  1. PRIMARY — probe-narrow2 exact #41 repro -> cart empty, pending list cleared, no item line at all:
     PASS — answer (rule 1+2, real conv 087abb8d, PRIMARY ACCEPTANCE): 'I didn't ask for any of those! ...
     Let's stick to that, thanks!' adds NOTHING and clears the list ... ok
     Real output: `{ resolved: true, outcome: { kind: "closure" }, cartChanged: false }`, cart.length === 0.
     BEFORE this fix (re-ran the identical call against the pre-fix code, not guessed): `{ resolved: true,
     outcome: { kind: "disambiguation_new_item_added", menuItemId: "4ff5efef-4552-46e7-89ac-93218f218c65",
     quantity: 1 } }` — Mozzarella Sticks (6), $8.99, added to the cart. AFTER: no propose/model call needed
     either way — both runs are pure calls into answer().

  2. Standalone "sticks" (not inside "stick to") on a fresh-add turn still correctly resolves to Mozzarella
     Sticks — regression test:
     PASS — answer (rule 1 regression): standalone 'sticks' still resolves to Mozzarella Sticks ... ok
     outcome.kind === "disambiguation_new_item_added", menuItemId === Mozzarella Sticks id, cart[0].quantity
     === 1. Confirms rule 1 tightened the SUBSTRING/STEM match on an unrelated word, not "sticks" itself.

  3. "no wraps or whatever" / "no extras" family, as standalone rejection language, adds nothing:
     PASS — answer (rule 2 regression): 'no wraps or whatever' adds nothing ... ok (resolves to `closure`,
     cart stays empty — "no wraps" itself is a separate, already-being-fixed defect in a parallel worktree;
     this only re-confirms the money-safe half: nothing is ever added here)
     PASS — answer (rule 2 regression): 'no extras' adds nothing ... ok (returns UNRESOLVED — the
     disambiguation stays open rather than closing, but nothing is added either way; cart.length === 0 in
     both cases)

  4. "take it off, just the original order please! no extras!" while a slot question is open -> decline the
     item, never fed into the slot as a literal value — real before/after, actual reply text:
     PASS — answer (rule 3, real conv 087abb8d): 'take it off, ...' while the wrap-type slot is open declines
     the item, never feeds the slot ... ok
     `{ resolved: true, outcome: { kind: "slot_item_declined" }, cartChanged: true }`, cart.length === 0.
     PASS — render (rule 3, real conv 087abb8d): BEFORE vs AFTER reply text for the exact live message ... ok
     BEFORE (real render() output, same fixture, same message, the state/context turn-engine-runner.ts would
     actually build on an UNRESOLVED slot answer):
       "We don't have "please! no extras" for Southwest Shrimp. The options are: Flour Tortilla, Spinach
       Tortilla, or Wheat Tortilla.\n\nSubtotal: $12.99\nService fee: $0.99\nTotal: $13.98"
     AFTER (real render() output, post-fix):
       "Southwest Shrimp removed.\n\nAnything else?"
     PASS — answer (rule 3 generalization): 'take it off' declines a keep-or-drop (category_confirm) question
     the same way a bare 'no' does ... ok (bonus coverage for the rule's own stated generality, not in the
     original 7-point list — verifies the category_confirm wiring I also touched doesn't regress and actually
     works)

  5. "None of those. I wanted ... 2x Chicken Alfredo with linguine, 2x Large Pepperoni pizzas, and 1x bleu
     cheese" -> 2x Large Pepperoni lands, alfredo asked about (not lost):
     PARTIAL PASS, scope boundary flagged above — PASS — answer (rule 4, real conv 087abb8d follow-up): an
     explicit 'Nx' quantity on a fresh item named during a decline is honored, not dropped to 1 ... ok
     Used a single-new-item probe against the same real fixture ("None of those, I want 2x Mozzarella Sticks
     instead") to isolate the quantity mechanism cleanly: outcome.quantity === 2, cart[0].quantity === 2.
     BEFORE this fix (re-ran against the pre-fix code): quantity came back 1 — the "2x" silently dropped,
     same shape as the reported "1x Large Pepperoni $21.00" undercharge. The THREE-item, cross-category
     restatement with a fresh which-one question for the alfredo is a separate multi-item-list capability
     this single-target resolver doesn't have — see the SCOPE BOUNDARY note above. Not silently declared done.

  6. Full suite: `deno test --allow-all supabase/functions/chat-sms/ supabase/functions/_shared/`:
     PASS — ok | 1898 passed | 0 failed | 7 ignored (7s)

  7. All prior freeze-queue item tests (grep "freeze-queue item" in turn-engine.test.ts) pass unchanged:
     PASS — `--filter "freeze-queue item"`: ok | 15 passed | 0 failed | 179 filtered out (9ms)

Did not touch supabase/functions/chat-sms/index.ts (frozen, untouched). No deploy, no recompile, no merge to
main — commit only, on branch fix/whole-term-match-and-rejections-20260919, merged forward from main at
05f6970d (fast-forward, no conflicts).
