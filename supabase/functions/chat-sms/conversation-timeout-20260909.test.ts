// Conversation-timeout fix (2026-09-09, final spec from Jason via PO
// session): a conversation is now expired by findActiveConversation() at
// read time — either 2h inactivity (app_config 'conversation_timeout_hours',
// migration 128) or a shop-close (local calendar day) boundary, whichever
// fires first. isConversationExpired() (index.ts) is the pure decision
// function that owns this logic; these tests exercise it directly against
// the four required scenarios so the exact rule is pinned down without
// needing a live DB or real elapsed time.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isConversationExpired } from "./index.ts";

const SHOP_TZ = "America/New_York";
const TIMEOUT_HOURS = 2;

Deno.test("conversation timeout: past the 2h window -> expired (new conversation, empty cart)", () => {
  const lastMessageAt = "2026-09-09T12:00:00.000Z";
  const now = new Date("2026-09-09T14:00:01.000Z"); // 2h 1s later, same ET day
  const result = isConversationExpired(lastMessageAt, now, SHOP_TZ, TIMEOUT_HOURS);
  assertEquals(result.expired, true);
  assertEquals(result.reason, "inactivity");
});

Deno.test("conversation timeout: under the 2h window (20 min) -> NOT expired (same conversation, cart intact)", () => {
  const lastMessageAt = "2026-09-09T12:00:00.000Z";
  const now = new Date("2026-09-09T12:20:00.000Z"); // 20 min later
  const result = isConversationExpired(lastMessageAt, now, SHOP_TZ, TIMEOUT_HOURS);
  assertEquals(result.expired, false);
  assertEquals(result.reason, null);
});

Deno.test("conversation timeout: shop-close boundary ends it even under the 2h window (11:50pm -> 12:10am ET)", () => {
  // 2026-09-09 23:50 ET = 2026-09-10 03:50 UTC (EDT, UTC-4).
  const lastMessageAt = "2026-09-10T03:50:00.000Z";
  // 2026-09-10 00:10 ET = 2026-09-10 04:10 UTC -- only 20 minutes later,
  // well inside the 2h inactivity window, but the shop's local calendar
  // date has rolled over from the 9th to the 10th.
  const now = new Date("2026-09-10T04:10:00.000Z");
  const result = isConversationExpired(lastMessageAt, now, SHOP_TZ, TIMEOUT_HOURS);
  assertEquals(result.expired, true);
  assertEquals(result.reason, "shop_close");
});

Deno.test("conversation timeout: exact real repro (c5a038f6, 19.6h across three sittings) -> three separate conversations under the new rule", () => {
  // Real timestamps from conversation c5a038f6-e839-408e-8b5e-b6bf6e91c47c
  // (see BLOCKED.txt): msg1 10:11pm ET Sep 8, msg2 7:12am ET Sep 9, msg3
  // 5:48pm ET Sep 9 -- all three landed in ONE conversation under the old
  // 24h-from-creation rule. Applying isConversationExpired() sequentially,
  // as findActiveConversation() does on each new inbound message, must
  // yield three separate conversations, not one.
  const msg1 = "2026-09-09T02:11:41.000Z"; // Mon 10:11pm ET
  const msg2 = "2026-09-09T11:12:25.000Z"; // Tue 7:12am ET
  const msg3 = "2026-09-09T21:48:00.000Z"; // Tue 5:48pm ET

  // Conversation 1 -> 2: message 2 arrives; is conversation 1 (last message
  // at msg1) expired by then?
  const check1to2 = isConversationExpired(msg1, new Date(msg2), SHOP_TZ, TIMEOUT_HOURS);
  assertEquals(check1to2.expired, true, "conversation 1 must be expired by the time message 2 arrives");

  // Conversation 2 -> 3: message 3 arrives; is conversation 2 (last message
  // at msg2) expired by then?
  const check2to3 = isConversationExpired(msg2, new Date(msg3), SHOP_TZ, TIMEOUT_HOURS);
  assertEquals(check2to3.expired, true, "conversation 2 must be expired by the time message 3 arrives");

  // Three messages, two expiries between them -> three distinct
  // conversations, confirming the old "one 19.6h conversation" outcome
  // cannot recur under the new rule.
});
