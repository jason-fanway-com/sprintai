# Clean-sheet ordering engine

Design: `docs/specs/2026-09-20-clean-sheet-ordering-engine.md`.
Plan and rules: `docs/specs/2026-09-20-compare-and-rebuild-plan.md` §5.

```
turn(form, menu, message, moves) -> { form', ledger, plan, reply }
```

| File | Role | Pure? |
|---|---|---|
| form.ts | OrderForm, Move, reducer `apply` | yes |
| normalize.ts | text normalization, the only place regexes touch customer text (with vocab.ts) | yes |
| menu.ts | compiled-menu view, adapter from DB rows, facets, canon map | yes |
| crossread.ts | second reader: lexicon scan reconciled against moves | yes |
| resolve.ts | span -> item, narrowing, slots, canon rewrite | yes |
| price.ts | the only money arithmetic | yes |
| next.ts | next question policy, repeat ladder | yes |
| templates.ts / render.ts | every customer-facing string / plan -> text | yes |
| vocab.ts | closed-vocabulary whole-message answers (no model) | yes |
| project.ts | form -> legacy cart_json projection | yes |
| turn.ts | one turn | yes |
| interpret.ts | the one model call (spans in, moves out) | I/O |
| address.ts | geocode + zone check | I/O |
| runner.ts | load, moves, turn, checkout, persist | I/O |

Tests: `scripts/engine-test.sh` (syncs to the Air worktree and runs deno there).
`tests/rules.test.ts` enforces the structural rules; a failure there blocks merge.
Interpreter eval: `tests/eval/run-eval.ts` against `tests/eval/moves.jsonl`.
Acceptance: `scripts/engine/e2e.py --shop <uuid>` asserts the DB over five runs per scenario.
