/**
 * Faithful local replication of selectCandidates()'s ORDERING + INCLUSION logic
 * (the only thing this fix changes). It mirrors, step for step:
 *   - the idle query: filter last_message_at < cutoff, ORDER BY last_message_at
 *     <dir>, id ASC, LIMIT cap*3
 *   - the terminal-cart force-include: phase IN (<set>)
 *   - Map insertion (idle first, then terminal), defining stable base order
 *   - the cart-bearing stable partition
 *   - the final .slice(0, cap)
 *
 * We run it BOTH ways (OLD: oldest-first + ["confirmed","expired"]; NEW:
 * newest-first + ["confirmed","expired","checkout"]) over the SAME fixture and
 * show that the newest conversation (simulating be210325, checkout cart) is
 * EXCLUDED under OLD and SELECTED (and at the front) under NEW.
 *
 * Run: deno run --allow-none proof-eval-sweep-recent-first/replicate-select.ts
 */

const MAX_CONVERSATIONS_PER_SWEEP = 50; // prod default
const IDLE_MINUTES = 10;

type Conv = { id: string; tenant_id: string; last_message_at: string };
type Cart = { conversation_id: string; phase: string };

// ── Fixture: >150 idle conversations + one freshly-active checkout cart ────────
// All belong to one tenant for clarity. Times descend so older = earlier index.
const TENANT = "11111111-1111-1111-1111-111111111111";
const SHOP = "b0000000-0000-0000-0000-000000000001";
const NEWEST_ID = "be210325-54fb-4e19-a465-025ab294337e"; // the real NJB test conv

const now = Date.now();
const idleCutoff = new Date(now - IDLE_MINUTES * 60_000).toISOString();

const conversations: Conv[] = [];
const carts: Cart[] = [];

// 200 OLD idle conversations: last_message_at from 200..1 hours ago (all idle).
for (let i = 200; i >= 1; i--) {
  const id = `old-${String(i).padStart(3, "0")}-0000-0000-0000-000000000000`;
  conversations.push({
    id,
    tenant_id: TENANT,
    last_message_at: new Date(now - i * 3600_000).toISOString(), // i hours ago
  });
  // give a few of them carts so cart-bearing partition is exercised
  if (i % 50 === 0) carts.push({ conversation_id: id, phase: "expired" });
}

// The NEWEST conversation: idle by ~11 min (just past the 10-min cutoff), has a
// checkout-phase cart on the shop. This simulates be210325 right after a test.
conversations.push({
  id: NEWEST_ID,
  tenant_id: TENANT,
  last_message_at: new Date(now - 11 * 60_000).toISOString(), // 11 min ago → idle
});
carts.push({ conversation_id: NEWEST_ID, phase: "checkout" });

// ── Replicated selection ──────────────────────────────────────────────────────
function selectCandidatesLocal(
  opts: { idleAscending: boolean; terminalPhases: string[] },
): { id: string; tenant_id: string }[] {
  // 1) idle query: filter, sort, limit cap*3
  const idle = conversations
    .filter((c) => c.last_message_at < idleCutoff)
    .sort((a, b) => {
      const cmp = a.last_message_at < b.last_message_at ? -1
        : a.last_message_at > b.last_message_at ? 1 : 0;
      const primary = opts.idleAscending ? cmp : -cmp;
      if (primary !== 0) return primary;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // id ASC tiebreak
    })
    .slice(0, MAX_CONVERSATIONS_PER_SWEEP * 3);

  // 2) terminal-phase force-include
  const terminalCarts = carts.filter((c) => opts.terminalPhases.includes(c.phase));

  // 3) Map insertion: idle first (defines base order), then terminal convs
  const ids = new Map<string, { id: string; tenant_id: string }>();
  for (const c of idle) ids.set(c.id, { id: c.id, tenant_id: c.tenant_id });
  const termConvIds = [...new Set(terminalCarts.map((c) => c.conversation_id))];
  for (const cid of termConvIds) {
    const conv = conversations.find((c) => c.id === cid);
    if (conv) ids.set(conv.id, { id: conv.id, tenant_id: conv.tenant_id });
  }
  const candidates = [...ids.values()];

  // 4) cart-bearing stable partition (any cart at all)
  const cartBearing = new Set(carts.map((c) => c.conversation_id));
  const prioritized = [
    ...candidates.filter((c) => cartBearing.has(c.id)),
    ...candidates.filter((c) => !cartBearing.has(c.id)),
  ];

  // 5) cap
  return prioritized.slice(0, MAX_CONVERSATIONS_PER_SWEEP);
}

function report(label: string, sel: { id: string }[]) {
  const ids = sel.map((s) => s.id);
  const idx = ids.indexOf(NEWEST_ID);
  console.log(`\n=== ${label} ===`);
  console.log(`  selected count: ${ids.length} (cap=${MAX_CONVERSATIONS_PER_SWEEP}, honored=${ids.length <= MAX_CONVERSATIONS_PER_SWEEP})`);
  console.log(`  NEWEST (${NEWEST_ID}) selected? ${idx >= 0 ? "YES" : "NO"}${idx >= 0 ? ` at position ${idx}` : ""}`);
  console.log(`  first 3 selected: ${ids.slice(0, 3).join(", ")}`);
  return idx;
}

console.log(`Fixture: ${conversations.length} conversations (${conversations.length - 1} old idle + 1 fresh checkout), idleCutoff=${idleCutoff}`);

// OLD behavior (origin/main): oldest-first, no 'checkout' force-include
const oldSel = selectCandidatesLocal({
  idleAscending: true,
  terminalPhases: ["confirmed", "expired"],
});
const oldIdx = report("OLD (oldest-first, phases=confirmed,expired)", oldSel);

// NEW behavior (this fix): newest-first, includes 'checkout'
const newSel = selectCandidatesLocal({
  idleAscending: false,
  terminalPhases: ["confirmed", "expired", "checkout"],
});
const newIdx = report("NEW (newest-first, phases=confirmed,expired,checkout)", newSel);

// Determinism: run NEW twice, compare order
const newSel2 = selectCandidatesLocal({
  idleAscending: false,
  terminalPhases: ["confirmed", "expired", "checkout"],
});
const deterministic = JSON.stringify(newSel.map((s) => s.id)) === JSON.stringify(newSel2.map((s) => s.id));

// ── checkout-force-include-when-NOT-idle proof ────────────────────────────────
// Add a checkout cart whose conversation is NOT idle (active 1 min ago) and show
// NEW selects it (via terminal-phase branch) while OLD does not.
const ACTIVE_CHECKOUT = "active-ck-0000-0000-0000-000000000000";
conversations.push({ id: ACTIVE_CHECKOUT, tenant_id: TENANT, last_message_at: new Date(now - 60_000).toISOString() });
carts.push({ conversation_id: ACTIVE_CHECKOUT, phase: "checkout" });
const oldSelB = selectCandidatesLocal({ idleAscending: true, terminalPhases: ["confirmed", "expired"] });
const newSelB = selectCandidatesLocal({ idleAscending: false, terminalPhases: ["confirmed", "expired", "checkout"] });
const oldHasActive = oldSelB.some((s) => s.id === ACTIVE_CHECKOUT);
const newHasActive = newSelB.some((s) => s.id === ACTIVE_CHECKOUT);

console.log(`\n=== checkout force-include when NOT idle (active 1 min ago) ===`);
console.log(`  OLD includes active-checkout conv? ${oldHasActive ? "YES" : "NO"} (expected NO)`);
console.log(`  NEW includes active-checkout conv? ${newHasActive ? "YES" : "NO"} (expected YES)`);

console.log(`\n=== SUMMARY ===`);
console.log(`  determinism (NEW == NEW2): ${deterministic ? "PASS" : "FAIL"}`);
console.log(`  bug reproduced (OLD excludes newest): ${oldIdx < 0 ? "PASS" : "FAIL"}`);
console.log(`  fix works (NEW selects newest): ${newIdx >= 0 ? "PASS" : "FAIL"}`);
console.log(`  cap honored: ${newSel.length <= MAX_CONVERSATIONS_PER_SWEEP ? "PASS" : "FAIL"}`);
console.log(`  checkout force-include (not idle): ${(!oldHasActive && newHasActive) ? "PASS" : "FAIL"}`);

const allPass = deterministic && oldIdx < 0 && newIdx >= 0 && newSel.length <= MAX_CONVERSATIONS_PER_SWEEP && !oldHasActive && newHasActive;
console.log(`\n  ALL CHECKS: ${allPass ? "PASS ✅" : "FAIL ❌"}`);
if (!allPass) Deno.exit(1);
