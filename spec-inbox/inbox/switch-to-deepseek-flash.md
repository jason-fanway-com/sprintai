# Switch chat-sms + eval-sweep to DeepSeek V4 Flash via OpenRouter

**Date:** 2026-07-03
**Goal:** Replace Claude Haiku with DeepSeek V4 Flash for customer chat (chat-sms) and eval judge (eval-sweep). Route through the existing OpenRouter API key. Keep parse-menu-pdf on its current path for now (needs PDF beta support).

**Why:** DeepSeek Flash is 40-90x cheaper than Haiku, handles tool calling and structured JSON well, and is more than capable for SMS ordering + conversation judging in a narrow domain.

## Pre-mortem

1. **OpenRouter response format differs** → The existing code parses `content[].type === "tool_use"` and `"text"`. OpenRouter returns `"thinking"` blocks too — these are already correctly ignored by the existing filter. No change needed.
2. **Tool loop multi-turn breaks** → OpenRouter already tested returning proper `tool_use` content blocks with IDs. The existing loop (`messages.push({role: "assistant", content})` → `tool_result` blocks → next fetch) should work. Need to verify the full loop with a real multi-turn test after deploy.
3. **Judge structured JSON flakes** → Flash returned valid JSON in tests. But if it hallucinates markdown fences, the existing `parseJudgeJson()` handles that. Cost is low enough that a few retries don't matter.
4. **Thinking blocks waste tokens on judge** → Flash emits `thinking` blocks by default. For the judge, these are wasted tokens. Disable reasoning (`reasoning: {enabled: false}`) to save ~$0.00002/call.
5. **parse-menu-pdf breaks on DeepSeek** → It uses `anthropic-beta: pdfs-2024-09-25`. DeepSeek doesn't support this. Leave parse-menu-pdf untouched (it still points to `api.anthropic.com`). It will use whatever `ANTHROPIC_API_KEY` is deployed — currently the dead hex key. This needs a separate fix; not part of this change.
6. **scrape-shop breaks on DeepSeek** → It also hits `api.anthropic.com` directly. Same situation as parse-menu-pdf. Fix in a follow-up.
7. **OpenRouter rate limits / downtime** → OpenRouter is a single point of failure vs going to DeepSeek directly. Mitigation: OpenRouter has been reliable. If it becomes an issue, we swap to DeepSeek's native API later (minor code change).

## Implementation Plan

### 1. chat-sms/index.ts — Customer chat (NJB-critical)

Changes:
- `HAIKU_MODEL`: `"claude-haiku-4-5"` → `"deepseek/deepseek-v4-flash"`
- `CLAUDE_API`: `"https://api.anthropic.com/v1/messages"` → `"https://openrouter.ai/api/v1/messages"`
- Auth: `"x-api-key": apiKey` → `"Authorization": "Bearer ${apiKey}"`
- Add OpenRouter required headers: `"HTTP-Referer": "https://getsprintai.com"`, `"X-Title": "SprintAI"`
- Remove `"anthropic-version"` header (not needed by OpenRouter)
- No content parsing changes needed — existing filter already ignores `thinking` blocks

### 2. eval-sweep/index.ts — Conversation judge

Changes:
- `JUDGE_MODEL` default: `"claude-haiku-4-5"` → `"deepseek/deepseek-v4-flash"`
- `CLAUDE_API`: same endpoint swap as chat-sms
- Auth: same `x-api-key` → `Authorization: Bearer` swap
- Headers: add `HTTP-Referer` + `X-Title`, remove `anthropic-version`
- Disable reasoning: add `"reasoning": {"enabled": false}` to body
- `estimateCostCents()`: update to DeepSeek Flash pricing ($0.14/$0.28 per MTok)
- `DAILY_SPEND_CEILING_CENTS`: reduce from current value to reflect lower cost (was set for Haiku pricing; Flash is ~90x cheaper on output)

### 3. Deploy ANTHROPIC_API_KEY

Set the deployed secret `ANTHROPIC_API_KEY` to the OpenRouter key (env var `OPENROUTER_API_KEY`). All three functions read `ANTHROPIC_API_KEY`.

### 4. Acceptance criteria

- [ ] chat-sms returns a text response for a test message
- [ ] chat-sms correctly calls tools (add_item) in a multi-turn exchange
- [ ] eval-sweep runs against a test conversation and writes a valid `conversation_evals` row
- [ ] judge output contains valid JSON (verdict + flags)
- [ ] No errors from `thinking` content blocks
- [ ] parse-menu-pdf and scrape-shop are NOT changed (not in scope)