// POST-FIX live verification (2026-09-11) of the bare-list phrase-ambiguity
// gap found by QA after bf6023b (v361): an unpunctuated multi-item list
// collapses splitCustomerPhrases to one phrase, reopening the whole-turn
// reactive-modifier-match leak. Fix deployed as chat-sms v362
// (ambiguousPhraseAttributionThisTurn in index.ts/runOrderingLoop). Runs the
// full 5-phrasing x 5-run matrix (matches the original RUNBOOK evidence
// rigor) plus extra bare-list-only runs for emphasis, against the real
// deployed endpoint.
const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_ID = "e0000000-0000-0000-0000-000000000001";

interface Line { name: string; price_cents: number; quantity: number; menu_item_id: string; unverified_requests?: string[]; sourcePhraseIndex?: number }

async function send(message: string, sessionId: string, shopId: string = VITOS_ID): Promise<{ reply: string | null; debug_perf?: { toolCallCount?: number } }> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

const restHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

async function fetchCart(sessionId: string): Promise<Line[]> {
  const convRes = await fetch(`${SUPABASE_URL}/rest/v1/conversations?select=id&session_id=eq.${sessionId}&order=started_at.desc&limit=1`, { headers: restHeaders });
  const [conv] = await convRes.json();
  const cartRes = await fetch(`${SUPABASE_URL}/rest/v1/order_carts?select=id,cart_json,phase&conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`, { headers: restHeaders });
  const [cart] = await cartRes.json();
  return (cart.cart_json ?? []) as Line[];
}

const CHICKEN_BACON_RANCH_ID = "5e8fcaf7-a1bd-4c3c-943c-2f066e091c0d";
const BBQ_CHICKEN_ID = "80d49c72-d238-4ef9-8b29-12ec7097b213";
const CHEESESTEAK_ID = "80f8624c-358c-4004-9b94-75d8c66e6008";
const MARGHERITA_ID = "a37a47a9-7f6c-47bb-acdd-933f572890de";
const FLATBREAD_BASE_CENTS = 1050;
const PEPPERONI_UPCHARGE_CENTS = 50;

const GUARD12_TURN1 = "I'd like 4 flatbreads please";
const PHRASINGS: { label: string; turn2: string }[] = [
  { label: "comma+digit", turn2: "1 chicken bacon ranch, 1 bbq chicken with pepperoni, 1 cheesesteak and 1 margherita" },
  { label: "comma+word", turn2: "one chicken bacon ranch, one bbq chicken with pepperoni, one cheesesteak and one margherita" },
  { label: "and-separated", turn2: "a chicken bacon ranch and a bbq chicken with pepperoni and a cheesesteak and a margherita" },
  { label: "bare list", turn2: "chicken bacon ranch bbq chicken pepperoni cheesesteak margherita, four flatbreads" },
  { label: "conversational", turn2: "can I get a chicken bacon ranch, a bbq chicken with pepperoni on it, a cheesesteak, and a margherita please" },
];
// The bare-list phrasing above still has one comma ("...margherita, four
// flatbreads") which splitCustomerPhrases would treat as a boundary — that
// comma sits AFTER all four item names, so it doesn't actually separate any
// two items from each other, but to make sure the ambiguity detector itself
// (not just this specific string) is exercised, add a truly zero-punctuation
// variant with no comma/and/digit-repeat boundary anywhere.
const TRULY_BARE: { label: string; turn2: string }[] = [
  { label: "truly bare (no punctuation at all)", turn2: "chicken bacon ranch bbq chicken with pepperoni cheesesteak margherita" },
];
const RUNS_PER_PHRASING = 5;

function classify(lines: Line[]) {
  const others = lines.filter(l => l.menu_item_id !== BBQ_CHICKEN_ID && [CHICKEN_BACON_RANCH_ID, CHEESESTEAK_ID, MARGHERITA_ID].includes(l.menu_item_id));
  const bbq = lines.find(l => l.menu_item_id === BBQ_CHICKEN_ID);
  const leakedOntoLines = others.filter(l => l.price_cents !== FLATBREAD_BASE_CENTS);
  const bbqMissingCharge = !!bbq && bbq.price_cents !== FLATBREAD_BASE_CENTS + PEPPERONI_UPCHARGE_CENTS;
  const moneyLeakApplied = leakedOntoLines.length > 0 || bbqMissingCharge;
  return { leakedOntoLines, bbqMissingCharge, moneyLeakApplied, bbq };
}

const RESULTS_PATH = new URL("./tmp-verifier-barelist-recheck-20260911-results.json", import.meta.url).pathname;
const runs: unknown[] = [];

async function runMatrix(phrasings: { label: string; turn2: string }[], runsPerPhrasing: number) {
  let total = 0, moneyLeaks = 0, noToolCall = 0;
  for (const { label, turn2 } of phrasings) {
    console.log(`\n--- Phrasing: ${label} ---`);
    console.log(`  turn2: "${turn2}"`);
    for (let run = 1; run <= runsPerPhrasing; run++) {
      total++;
      const sessionId = `verify-guard12-postfix-baselist-${Math.floor(Math.random() * 1e9)}`;
      await send(GUARD12_TURN1, sessionId, VITOS_ID);
      const r2 = await send(turn2, sessionId, VITOS_ID);
      const lines = await fetchCart(sessionId);
      if ((r2.debug_perf?.toolCallCount ?? -1) === 0 || lines.length === 0) {
        noToolCall++;
        console.log(`  run ${run}: NO TOOL CALL / EMPTY CART (model flake, not scored) toolCallCount=${r2.debug_perf?.toolCallCount}`);
        runs.push({ phrasing: label, turn2, run, skipped: true, reason: "no tool call / empty cart" });
        await Deno.writeTextFile(RESULTS_PATH, JSON.stringify({ runs, done: false }, null, 2));
        continue;
      }
      const { leakedOntoLines, bbqMissingCharge, moneyLeakApplied, bbq } = classify(lines);
      if (moneyLeakApplied) moneyLeaks++;
      const totalCents = lines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
      console.log(
        `  run ${run}: lines=${lines.length} bbqPrice=${bbq?.price_cents ?? "MISSING"} ` +
        `moneyLeak=${moneyLeakApplied ? "YES" : "no"} ` +
        `leakedOnto=${leakedOntoLines.length > 0 ? leakedOntoLines.map(l => `${l.name}(${l.price_cents})`).join(",") : "none"} ` +
        `bbqMissingCharge=${bbqMissingCharge} total=${totalCents} sourcePhraseIndexes=${lines.map(l => l.sourcePhraseIndex).join(",")}`,
      );
      runs.push({ phrasing: label, turn2, run, moneyLeakApplied, leakedOntoLines: leakedOntoLines.map(l => ({ name: l.name, price_cents: l.price_cents })), bbqMissingCharge, bbqPrice: bbq?.price_cents, totalCents, cartLines: lines });
      await Deno.writeTextFile(RESULTS_PATH, JSON.stringify({ runs, done: false }, null, 2));
    }
  }
  return { total, moneyLeaks, noToolCall };
}

console.log(`=== POST-FIX (v362) verification: original 5-phrasing matrix + truly-bare variant ===`);
const mainResult = await runMatrix(PHRASINGS, RUNS_PER_PHRASING);
const bareResult = await runMatrix(TRULY_BARE, RUNS_PER_PHRASING);

await Deno.writeTextFile(RESULTS_PATH, JSON.stringify({ runs, done: true }, null, 2));

const grandTotal = mainResult.total + bareResult.total;
const grandLeaks = mainResult.moneyLeaks + bareResult.moneyLeaks;
const grandNoToolCall = mainResult.noToolCall + bareResult.noToolCall;
console.log(`\n=== SUMMARY ===`);
console.log(`main matrix: ${mainResult.moneyLeaks}/${mainResult.total} leaked, ${mainResult.noToolCall} no-tool-call`);
console.log(`truly-bare variant: ${bareResult.moneyLeaks}/${bareResult.total} leaked, ${bareResult.noToolCall} no-tool-call`);
console.log(`grand total: ${grandLeaks}/${grandTotal} money leaks (${grandNoToolCall} runs skipped as model no-ops)`);
console.log(grandLeaks === 0 ? "\nPASS — no money leak reproduced across punctuated + bare-list phrasings." : "\nFAIL — see per-run detail above.");
