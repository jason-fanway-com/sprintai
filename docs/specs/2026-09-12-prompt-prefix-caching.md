# Prompt prefix caching — restructure the system prompt so it can be cached

**Status:** QUEUED — starts after the CRM returning-customer work
(`2026-09-12-returning-customer-delivery-memory.md`). CRM is next; this follows.
**Requested by:** Jason, 2026-09-12.
**Primary benefit: latency.** Cost saving is real but small. Do not sell this
internally as a cost project or it will be deprioritised for the wrong reason.

## Why this is not a flag

`buildSystemPrompt()` (index.ts:683) takes, among others:

    phase, menu, cart, currentTime, orderTypeStr, deliveryAddress,
    driverTipCents, deliveryFeeCents, soldOutNames, customerContext

The system prompt is therefore **rebuilt from scratch every turn with live
mutable state baked into it**. `currentTime` alone guarantees two otherwise
identical turns a minute apart produce different bytes.

Prefix caching — automatic or explicit — only pays when the START of the prompt
is byte-identical between calls. Today nothing is stable, so adding
`cache_control` would buy a cache WRITE on every call and never a read: strictly
worse than doing nothing. **The flag is the last step, not the first.**

## Current shape (measured 2026-09-12)

- Endpoint: `CHAT_API = https://openrouter.ai/api/v1/messages` — OpenRouter's
  **Anthropic-format** endpoint (the body uses `system:`, the response has
  `stop_reason` and `content` blocks). Caching on this format is EXPLICIT, via
  `cache_control: { type: "ephemeral" }` breakpoints.
- Model: `deepseek/deepseek-v4-flash`.
- Largest prompt template literal: ~24,140 chars, roughly **6,000 tokens**.
- `grep -c "cache_control|prompt_cache|cached" index.ts` → **0**. No caching of
  any kind today.
- ~10 LLM calls per completed order, so roughly 60,000 input tokens per order
  are re-sent uncached.
- Per-order variable cost: ~$0.017 LLM vs ~$0.078 SMS (6 segments x $0.0130).
  LLM is 18% of variable cost. Latency, not dollars, is the reason to do this.

## The work

1. **Split the prompt into stable and volatile.**
   - STABLE (cacheable): ordering rules, the MONEY/SCOPE rule, tool contracts,
     the compiled menu for this shop. Per-shop, so three prefixes in practice.
   - VOLATILE: cart contents, `currentTime`, phase, order type, delivery
     address, tip, fees, sold-out names, customer context.

2. **Move the volatile half out of `system`.** Put it in the `messages` array as
   a state block immediately before the customer turn. The `system` field then
   ends on a clean, stable boundary. This is the actual engineering work; steps
   3 and 4 are small.

3. **Mark the prefix.** Convert `system: string` to the block form and put
   `cache_control: { type: "ephemeral" }` on the last stable block.

4. **VERIFY EMPIRICALLY — do not trust the flag.** Read the response `usage`:
   `cache_creation_input_tokens` on the first call, `cache_read_input_tokens` on
   every subsequent call in the same order. Log the ratio. A flag that is set
   and never reads is exactly the "committed is not deployed" failure in a new
   costume; this project has produced four of those in two days.

5. **Measure latency before and after.** Record per-turn `debugAttemptMs`
   (already collected, index.ts:2692) for a 10-case run before the change and
   after. That number, not the bill, is the success criterion.

## Watch-outs

- **Byte-stability is absolute.** Any interpolation into the stable half — a
  timestamp, a count, a re-ordered menu — silently kills every cache hit with no
  error. Add a test that builds the stable prefix twice with different volatile
  inputs and asserts the two strings are identical.
- **Menu ordering must be deterministic.** If the compiled menu is rendered from
  an unordered query result, the prefix changes run to run. Sort explicitly.
- **The MONEY/SCOPE rule must stay in the stable half and stay intact.** It is
  what stops the model quoting a total it was never shown. Do not let the split
  strand it.
- **Cache TTL is short** (minutes). It helps within one conversation, not across
  customers. Expect hits on turns 2..N of an order, never turn 1. That is still
  90% of calls.
- `buildSystemPromptV2` (index.ts:1025) is the instruction-layer renderer and is
  now live on all three shops. Do this work against V2, not the legacy builder.

## Acceptance

- `cache_read_input_tokens` > 0 on turns 2+ of a live order, shown in a log line.
- A unit test proves the stable prefix is byte-identical across two builds with
  different cart/time inputs.
- Median per-turn latency drops measurably on a 10-case run; report before/after.
- Vito's canary unchanged: one line, Temp: Medium, $8.49 + $0.99 = $9.48.
- No change to what the model is told — same rules, same tools, same menu, only
  reordered.

## How the cached prefix gets updated (Jason's question, 2026-09-12)

**There is no invalidation mechanism, and none is needed.** Prefix caching is
content-addressed: the cache key IS the exact bytes of the prefix.

When an owner 86s an item, changes a price, or adds one:
1. `admin-chat` / `compile-menu` update `menu_items` (`bot_state`, price,
   `display_name`, `ask_plan`).
2. The next turn calls `buildSystemPromptV2` with the new menu and the new
   `soldOutNames`, producing different bytes.
3. Those bytes match no existing cache entry. It is a MISS. That call writes a
   new entry; subsequent turns hit the new one.

**A stale cache can never serve an old menu.** An entry is only read when the
bytes match exactly, so a changed menu makes the old entry unreachable rather
than wrong. The failure mode of caching here is "we paid full price again",
never "the bot quoted last week's price or sold an 86'd item".

Cost of a menu change: one cache-write on the next order, then hits resume.
Because TTL is minutes, a change made between conversations costs nothing at
all — the entry would have expired anyway.

### The actual danger is non-determinism, not staleness

If the compiled menu is rendered from a query without an explicit, stable
`ORDER BY`, the prefix bytes shuffle between calls. The result is a 0% hit rate
with **no error and no symptom except the bill** — the same silent-failure shape
as the `--cases` filter and the inert delivery guard. Hence the mandatory test:
build the stable prefix twice, with different cart/time inputs, and assert the
two strings are byte-identical.

### Mid-conversation 86

If an item is 86'd *during* a conversation, the prefix changes on the next turn
and the rest of that conversation misses. That is correct and desirable — the
customer must not be sold something the kitchen just turned off (bar item 3).
Do not "optimise" this by holding a menu snapshot for the life of a conversation.

