// Independent pre-fix re-verification of the GUARD 12 (Vito's Flatbreads)
// pepperoni money leak documented in RUNBOOK.md ("OPEN, LIVE MONEY BUG").
// Standalone copy of the matrix logic from
// scripts/tmp-item4-f0ecf0fe-live-replay-20260910.ts's --guard12-only phase,
// with the phase-1/Zio's wait-for-prior-phase handoff removed since this run
// only needs the Vito's Flatbreads matrix, run fresh, against current prod.
const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_ID = "e0000000-0000-0000-0000-000000000001";

interface Line { name: string; price_cents: number; quantity: number; menu_item_id: string; unverified_requests?: string[] }

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
const BBQ_CHICKEN_ID = "80d49c72-d238-4ef9-8b29-12ec7097b213"; // the ONLY line pepperoni should ever attach to
const CHEESESTEAK_ID = "80f8624c-358c-4004-9b94-75d8c66e6008";
const MARGHERITA_ID = "a37a47a9-7f6c-47bb-acdd-933f572890de";
const FLATBREAD_BASE_CENTS = 1050;
const PEPPERONI_UPCHARGE_CENTS = 50;

const GUARD12_TURN1 = "I'd like 4 flatbreads please";
const GUARD12_PHRASINGS: { label: string; turn2: string }[] = [
  { label: "comma+digit", turn2: "1 chicken bacon ranch, 1 bbq chicken with pepperoni, 1 cheesesteak and 1 margherita" },
  { label: "comma+word", turn2: "one chicken bacon ranch, one bbq chicken with pepperoni, one cheesesteak and one margherita" },
  { label: "and-separated", turn2: "a chicken bacon ranch and a bbq chicken with pepperoni and a cheesesteak and a margherita" },
  { label: "bare list", turn2: "chicken bacon ranch bbq chicken pepperoni cheesesteak margherita, four flatbreads" },
  { label: "conversational", turn2: "can I get a chicken bacon ranch, a bbq chicken with pepperoni on it, a cheesesteak, and a margherita please" },
];
const RUNS_PER_PHRASING = 5;

function classify(lines: Line[]) {
  const others = lines.filter(l => l.menu_item_id !== BBQ_CHICKEN_ID && [CHICKEN_BACON_RANCH_ID, CHEESESTEAK_ID, MARGHERITA_ID].includes(l.menu_item_id));
  const bbq = lines.find(l => l.menu_item_id === BBQ_CHICKEN_ID);
  // Money leak: pepperoni upcharge landed on a non-BBQ-chicken line, OR BBQ
  // chicken itself did NOT get the upcharge it should have.
  const leakedOntoLines = others.filter(l => l.price_cents !== FLATBREAD_BASE_CENTS);
  const bbqMissingCharge = !!bbq && bbq.price_cents !== FLATBREAD_BASE_CENTS + PEPPERONI_UPCHARGE_CENTS;
  const moneyLeakApplied = leakedOntoLines.length > 0 || bbqMissingCharge;
  return { leakedOntoLines, bbqMissingCharge, moneyLeakApplied, bbq };
}

const RESULTS_PATH = new URL("./tmp-verify-guard12-pre-fix-results.json", import.meta.url).pathname;
const runs: unknown[] = [];

console.log(`=== PRE-FIX independent re-verification: GUARD 12 (Vito's Flatbreads) matrix, ${GUARD12_PHRASINGS.length} phrasings x ${RUNS_PER_PHRASING} runs ===\n`);
let total = 0, moneyLeaks = 0;
for (const { label, turn2 } of GUARD12_PHRASINGS) {
  console.log(`\n--- Phrasing: ${label} ---`);
  console.log(`  turn2: "${turn2}"`);
  for (let run = 1; run <= RUNS_PER_PHRASING; run++) {
    total++;
    const sessionId = `verify-guard12-prefix-${Math.floor(Math.random() * 1e9)}`;
    await send(GUARD12_TURN1, sessionId, VITOS_ID);
    const r2 = await send(turn2, sessionId, VITOS_ID);
    const lines = await fetchCart(sessionId);
    const { leakedOntoLines, bbqMissingCharge, moneyLeakApplied, bbq } = classify(lines);
    if (moneyLeakApplied) moneyLeaks++;
    const totalCents = lines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
    console.log(
      `  run ${run}: lines=${lines.length} bbqPrice=${bbq?.price_cents ?? "MISSING"} ` +
      `moneyLeak=${moneyLeakApplied ? "YES" : "no"} ` +
      `leakedOnto=${leakedOntoLines.length > 0 ? leakedOntoLines.map(l => `${l.name}(${l.price_cents})`).join(",") : "none"} ` +
      `bbqMissingCharge=${bbqMissingCharge} total=${totalCents}`,
    );
    runs.push({ phrasing: label, turn2, run, moneyLeakApplied, leakedOntoLines: leakedOntoLines.map(l => ({ name: l.name, price_cents: l.price_cents })), bbqMissingCharge, bbqPrice: bbq?.price_cents, totalCents, cartLines: lines });
    await Deno.writeTextFile(RESULTS_PATH, JSON.stringify({ runs, done: false }, null, 2));
  }
}
await Deno.writeTextFile(RESULTS_PATH, JSON.stringify({ runs, done: true }, null, 2));
console.log(`\n=== SUMMARY ===`);
console.log(`total runs: ${total}`);
console.log(`money leak: ${moneyLeaks}/${total}`);
console.log(moneyLeaks === 0 ? "\nPASS" : "\nFAIL — bug reproduces.");
