# Rules for anyone (or any agent) working in this repo

These are non-negotiable, regardless of how urgent a fix looks. Read this before doing
anything with git or a deploy in this repo. Set by the PO, 2026-09-20, after a fix that
merged and deployed itself turned out to still have the bug it was meant to fix, and
broke a separate working flow at the same time.

1. **Only the PO deploys.** The crew never runs `scripts/deploy-function.sh` or
   `supabase functions deploy`, for any reason, including a P0. If a fix is urgent, say so
   in your report and wait — do not decide this yourself.
2. **Merges to main only inside a PO merge window.** Commit your work on a branch and
   stop. Do not merge to main outside a window the PO has explicitly opened.
3. **A recompile is a deploy.** Live behavior changes the moment the lexicon recompiles.
   Only recompile on the PO's explicit GO.
4. **"LANDED" requires proof, not a claim.** A fix is not "landed" until `deno check` and
   the full test suite are green on main, AND your reply includes a live `convo.sh`
   transcript run against the actually-deployed build. One quick pass is not proof — run
   the real scenario multiple times before calling something fixed.
5. **"MCP down" gets checked, not asserted.** Before reporting MCP/tooling as down, check
   with `ps` and the gateway log first.
