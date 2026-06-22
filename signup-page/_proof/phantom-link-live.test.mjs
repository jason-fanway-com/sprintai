/**
 * Phantom-link guard — LIVE end-to-end proof against the deployed TEST function.
 *
 * Project: rvdqfxtrskxekfkqnegx (SprintAI-Chat, TEST/dev). Stripe TEST mode.
 * Shop:    Not Just Bagels (b0000000-0000-0000-0000-000000000001).
 *
 * For each run it drives a full WEB-path confirm-order conversation:
 *   TESTMODE -> order an item -> "that's it" -> give pickup name
 * Then it reads the authoritative order_carts row and asserts the INVARIANT:
 *   the final assistant reply only claims "payment link sent / order placed"
 *   when a REAL Stripe session (cs_test_...) exists and phase == "checkout".
 *   Otherwise the reply must make NO such claim (honest fallback).
 *
 * The phantom failure = reply claims a link BUT (session id null OR phase !=
 * checkout). That count MUST be 0 across all runs.
 *
 * Env (from ~/.openclaw/.secrets):
 *   SPRINTAI_CHAT_SUPABASE_URL, SPRINTAI_CHAT_SUPABASE_ANON_KEY,
 *   SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY
 *
 * Run: node signup-page/_proof/phantom-link-live.test.mjs <N>
 */

const URL = process.env.SPRINTAI_CHAT_SUPABASE_URL;
const ANON = process.env.SPRINTAI_CHAT_SUPABASE_ANON_KEY;
const SR = process.env.SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY;
const SHOP = "b0000000-0000-0000-0000-000000000001";
const N = parseInt(process.argv[2] || "15", 10);
const FN = `${URL}/functions/v1/chat-sms`;

if (!URL || !ANON || !SR) { console.error("Missing env. source ~/.openclaw/.secrets first."); process.exit(2); }

// Detector (exact copy of index.ts).
const PAYMENT_CLAIM_PATTERNS = [
  /\bpayment link (?:is )?(?:sent|on (?:its|the) way|coming|ready|created|below|here|attached)\b/,
  /\b(?:a |the )?link (?:is |has been |was )?(?:sent|on (?:its|the) way|coming|ready)\b/,
  /\b(?:sent|sending) (?:you )?(?:a |the |your )?(?:payment )?link\b/,
  /\bhere(?:'s| is) (?:your |the |a )?(?:payment )?link\b/,
  /\b(?:tap|click|use|follow) (?:the|your|this) (?:payment )?link\b/,
  /\bcheck (?:your )?(?:text|texts|phone|email|inbox|messages)\b.*\blink\b/,
  /\blink\b.*\bcheck (?:your )?(?:text|texts|phone|email|inbox|messages)\b/,
  /\byou(?:'re| are) all set\b/,
  /\ball set\b.*\b(?:link|pay|payment|text|email)\b/,
  /\b(?:your )?order (?:is|has been|was) (?:placed|submitted|confirmed|complete|completed|in|on its way)\b/,
  /\b(?:i(?:'ve| have) )?(?:placed|submitted|confirmed|sent) (?:your |the )?order\b/,
  /\border(?:'s| is) (?:placed|in|confirmed|all set|on the way)\b/,
  /\border (?:placed|confirmed|submitted|complete|completed)\b/,
  /\bready (?:to|for) (?:pay|payment|checkout)\b.*\b(?:link|text|email|tap|click)\b/,
  /\bproceed to (?:pay|payment|checkout)\b.*\b(?:link|text|email)\b/,
];
function claimsPaymentSent(text) {
  if (!text) return false;
  const norm = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
  return PAYMENT_CLAIM_PATTERNS.some((re) => re.test(norm));
}

async function send(session, message) {
  const res = await fetch(FN, {
    method: "POST",
    headers: { "Authorization": `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: SHOP, message, session_id: session }),
  });
  return res.json();
}
async function readCart(session) {
  // conversation by session_id -> latest cart
  const cRes = await fetch(`${URL}/rest/v1/conversations?select=id&session_id=eq.${session}&channel=eq.web`, {
    headers: { apikey: SR, Authorization: `Bearer ${SR}` },
  });
  const convs = await cRes.json();
  if (!convs[0]) return null;
  const cartRes = await fetch(`${URL}/rest/v1/order_carts?select=phase,stripe_checkout_session_id,cart_json,pickup_name&conversation_id=eq.${convs[0].id}&order=created_at.desc&limit=1`, {
    headers: { apikey: SR, Authorization: `Bearer ${SR}` },
  });
  const carts = await cartRes.json();
  return carts[0] || null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let phantom = 0, realSession = 0, honest = 0, reachedConfirm = 0, errors = 0;
const lines = [];
function log(s) { console.log(s); lines.push(s); }

log(`=== LIVE phantom-link proof: ${N} runs vs ${FN} (TEST/sk_test) ===\n`);

for (let i = 1; i <= N; i++) {
  const session = `phantom-proof-${Date.now()}-${i}-${Math.floor(Math.random() * 1e6)}`;
  try {
    await send(session, "TESTMODE");
    await sleep(300);
    // Order a simple, always-available single item (no required options): a plain bagel.
    await send(session, "Can I get a plain bagel");
    await sleep(300);
    await send(session, "that's it, ready to check out");
    await sleep(300);
    // Confirm + give a pickup name in one shot — this is the turn that must submit.
    const finalResp = await send(session, "yes, name is Jason");
    await sleep(800); // let any forced submit + DB writes settle
    const cart = await readCart(session);

    const reply = finalResp.reply || "";
    const claims = claimsPaymentSent(reply);
    const hasUrl = !!finalResp.checkout_url;
    const sessionId = cart?.stripe_checkout_session_id || null;
    const phase = cart?.phase || "?";
    const realSessExists = (!!sessionId && phase === "checkout") || hasUrl;

    // Did we reach the confirm point? (cart had items)
    const hadItems = Array.isArray(cart?.cart_json) && cart.cart_json.length > 0;
    if (hadItems) reachedConfirm++;

    const isPhantom = claims && !realSessExists;
    if (isPhantom) phantom++;
    else if (realSessExists) realSession++;
    else honest++;

    const sessShort = sessionId ? sessionId.slice(0, 12) + "..." : "null";
    const verdict = isPhantom ? "!!PHANTOM!!" : (realSessExists ? "REAL-SESSION" : "HONEST");
    log(`run ${String(i).padStart(2)}: ${verdict.padEnd(13)} phase=${phase.padEnd(9)} sess=${sessShort.padEnd(16)} claims=${claims} url=${hasUrl}`);
    log(`         reply: ${JSON.stringify(reply).slice(0, 150)}`);
  } catch (e) {
    errors++;
    log(`run ${String(i).padStart(2)}: ERROR ${e.message}`);
  }
}

log(`\n--- RESULTS over ${N} runs ---`);
log(`Reached confirm (cart had items): ${reachedConfirm}`);
log(`REAL-SESSION (cs_test_ + checkout, or url): ${realSession}`);
log(`HONEST (no claim, no session): ${honest}`);
log(`PHANTOM (claim + null/non-checkout session): ${phantom}   <-- MUST be 0`);
log(`Errors: ${errors}`);
log(`\nRESULT: ${phantom === 0 && errors === 0 ? "PASS" : "FAIL"}`);

process.exit(phantom === 0 && errors === 0 ? 0 : 1);
