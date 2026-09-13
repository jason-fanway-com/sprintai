// Structural tests verifying that error_log wiring (migration 137) is present
// and correctly ordered in index.ts. These tests read the source directly
// (same pattern as e1-guard-crash-20260907.test.ts) and assert:
//
// 1. The tool_loop catch calls logError with stage "tool_loop" BEFORE rethrowing.
// 2. The outer catch (render path) calls logError with stage "render".
// 3. saveMessage (assistant) appears BEFORE the sendSms call in the source —
//    ensuring the reply is persisted even when outbound send subsequently fails.
//    (The mandatory product requirement from migration-137 task: a failed SMS
//    send must never prevent the assistant's reply from being recorded.)
//
// If index.ts changes these paths, update this file.
import { assert, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

let src = "";

async function loadSrc() {
  if (!src) src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
}

// ─── tool_loop catch ─────────────────────────────────────────────────────────

Deno.test("index.ts tool_loop catch: logError is called with stage 'tool_loop'", async () => {
  await loadSrc();
  // Find the catch block around runOrderingLoop and assert it calls logError
  // with stage: "tool_loop".  The block ends by rethrowing (throw loopErr).
  const catchBlock = src.match(/catch\s*\(loopErr\)\s*\{[\s\S]*?throw loopErr;?\s*\}/)?.[0];
  assert(catchBlock, "tool_loop catch block not found in index.ts — update this test if it moved");
  assert(catchBlock.includes("logError"), "tool_loop catch does not call logError");
  assert(catchBlock.includes('"tool_loop"') || catchBlock.includes("'tool_loop'"), "tool_loop catch does not set stage: 'tool_loop'");
  assert(catchBlock.includes("throw loopErr"), "tool_loop catch must rethrow after logging");
});

Deno.test("index.ts tool_loop catch: sets __errorLogged on the error before rethrowing", async () => {
  await loadSrc();
  const catchBlock = src.match(/catch\s*\(loopErr\)\s*\{[\s\S]*?throw loopErr;?\s*\}/)?.[0] ?? "";
  assert(
    catchBlock.includes("__errorLogged"),
    "tool_loop catch must mark the error __errorLogged so the outer catch does not double-log it",
  );
});

// ─── outer catch (render path) ───────────────────────────────────────────────

Deno.test("index.ts outer catch: logError is called with stage 'render' (skipped if already logged)", async () => {
  await loadSrc();
  // The outer catch block around the full turn uses stage "render".
  assertMatch(
    src,
    /stage:\s*["']render["']/,
    "index.ts outer catch must call logError with stage 'render'",
  );
  // It must also guard against double-logging via the __errorLogged flag.
  assertMatch(
    src,
    /__errorLogged/,
    "index.ts outer catch must check __errorLogged to avoid double-logging",
  );
});

// ─── saveMessage ordering (mandatory product requirement) ────────────────────

Deno.test("index.ts: saveMessage(assistant) appears before sendSms in the main turn path", async () => {
  await loadSrc();
  // The critical invariant: even if sendSms throws, the assistant's reply must
  // already be in the messages table.  This is ensured by positioning the
  // saveMessage call before the sendSms call in source order.
  const saveIdx = src.lastIndexOf("await saveMessage(supabase, conversation.id, shop.tenant_id, \"assistant\", safeReply)");
  const sendIdx  = src.lastIndexOf("await sendSms(supabase, shop.tenant_id, inboundReplyCtx, replyProvider, shop.phone_number_e164!");
  assert(saveIdx !== -1, "saveMessage(assistant, safeReply) call not found — did the variable name change?");
  assert(sendIdx  !== -1, "sendSms call not found — did the SMS send call change?");
  assert(
    saveIdx < sendIdx,
    `saveMessage(assistant) must appear BEFORE sendSms in index.ts ` +
    `(saveIdx=${saveIdx}, sendIdx=${sendIdx}) — a failed SMS send would otherwise ` +
    `leave the assistant reply unrecorded (conversation 439d23a2 incident).`,
  );
});
