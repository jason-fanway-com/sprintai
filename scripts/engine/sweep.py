#!/usr/bin/env python3
"""sweep.py — drive every harvested customer phrasing through the deployed engine as a full
conversation with a simple scripted customer, and grade the outcome from the database.

usage: sweep.py --shop <uuid> [--runs 1] [--limit N] [--source harvest|matrix|handwritten|all] [--verbose]
Customer policy after the opening phrase: answer the engine's question with a fixed rule until
the readback appears, then say yes. Grades per conversation:
  landed      a checkout session exists
  invented    a cart line whose display name shares no content word with anything the customer typed
  dropped     a customer item mention (lexicon scan is not available here, so: a harvested
              phrasing tagged multi-item that ended with fewer lines than expected adds)
  loops       the same bot question text three times in a row
"""
import argparse, functools, json, os, sys, time, uuid, urllib.request, re, collections
print = functools.partial(print, flush=True)
sys.path.insert(0, os.path.dirname(__file__))
from e2e import load_secrets, post, get, say, cart_for  # noqa: E402

STOP = set("a an the of with and please some order side one two three for me get want like id i can have to my on it that just thanks thank you pls plz".split())
def cw(s): return [w for w in re.sub(r"[^a-z0-9 ]", " ", s.lower()).split() if w not in STOP]

def answer_for(reply):
    reply = reply.split("Msg & data rates")[0]
    r = reply.lower()
    if "anything else" in r or "what can i get" in r or "what would you like" in r or "reply done" in r: return "thats it"
    if "reply yes" in r: return "yes"
    if "pickup or delivery" in r: return "pickup"
    if "delivery address" in r: return "3300 Hamilton Blvd, Allentown, PA 18103"
    if "tip" in r and ("percent" in r or "driver" in r): return "0"
    if "did you also want" in r: return "yes"
    if "what size" in r:
        m = re.search(r"\? ([A-Za-z]+),? ", reply.split("What size")[1]); return m.group(1).lower() if m else "large"
    if re.search(r"\n1\) ", reply): return "1"
    if "which" in r or "what kind" in r or "how would you like" in r or "options:" in r or " or " in r:
        # take the last question's option list ("A, B, or C?") and answer with the first option
        qs = [q for q in re.split(r"\?", reply) if " or " in q]
        if qs:
            opts = re.split(r",\s*|\s+or\s+", qs[-1].split(":")[-1])
            first = re.sub(r"\(.*?\)", "", opts[0]).strip().strip(".").lower()
            first = re.sub(r"^(options|for example)\s*", "", first).strip()
            if first: return first
        return "large"
    if "anything else" in r or "what can i get" in r or "what would you like" in r: return "thats it"
    if "how many of each" in r: return "all plain"
    return "thats it"

def run_one(shop, case, verbose):
    session = str(uuid.uuid4()); transcript = []; last = None; loops = 0
    msg = case["message"]
    for turn in range(12):
        reply, dt = say(shop, session, msg)
        transcript.append((msg, reply, dt))
        if reply == last: loops += 1
        last = reply
        if "pay here" in reply.lower() or "payment link" in reply.lower() and "pay here" in reply.lower(): break
        if loops >= 2: break
        msg = answer_for(reply)
    cart = cart_for(shop, session) or {}
    lines = cart.get("cart_json") or []
    typed = set(); [typed.update(cw(m)) for m, _, _ in transcript if m not in ("yes", "pickup", "thats it", "0", "1", "large", "all plain")]
    invented = [l["name"] for l in lines if not (set(cw(l["name"])) & typed)]
    expected_adds = sum(1 for m in case.get("expected", []) if m.get("kind") == "add_line")
    landed = bool(cart.get("stripe_checkout_session_id"))
    money_ok = (not lines) or cart.get("total_cents") == cart.get("subtotal_cents", 0) + cart.get("service_fee_cents", 0) + cart.get("delivery_fee_cents", 0) + cart.get("driver_tip_cents", 0) + cart.get("tax_cents", 0)
    verdict = {"id": case["id"], "landed": landed, "lines": len(lines), "expected_adds": expected_adds, "invented": invented, "loops": loops >= 2, "money_ok": money_ok, "turns": len(transcript), "ms": [round(d, 1) for _, _, d in transcript]}
    if verbose or not landed or invented or loops >= 2 or not money_ok:
        print(f"[{case['id']}] {'OK' if landed and not invented and loops < 2 and money_ok else 'BAD'} lines={len(lines)}/{expected_adds} invented={invented} loops={loops>=2}")
        for m, r, dt in transcript: print(f"    C: {m}\n    B: {r.replace(chr(10), ' / ')[:220]}  ({dt:.1f}s)")
    return verdict

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--shop", required=True); ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--limit", type=int, default=0); ap.add_argument("--source", default="harvest"); ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--cases", default=os.path.join(os.path.dirname(__file__), "../../supabase/functions/chat-sms/engine/tests/eval/moves.jsonl"))
    a = ap.parse_args()
    cases = [json.loads(l) for l in open(a.cases) if l.strip()]
    # first-turn ordering messages only: open is null or items, and the expected moves add something
    cases = [c for c in cases if (a.source == "all" or c["source"] == a.source) and (c["context"].get("open") in (None, {"kind": "items"})) and not c["context"].get("lines") and any(m.get("kind") == "add_line" for m in c["expected"])]
    if a.limit: cases = cases[:a.limit]
    print(f"{len(cases)} opening phrasings x {a.runs} runs")
    verdicts = []
    for c in cases:
        for _ in range(a.runs): verdicts.append(run_one(a.shop, c, a.verbose))
    n = len(verdicts); landed = sum(v["landed"] for v in verdicts); inv = sum(1 for v in verdicts if v["invented"]); loops = sum(v["loops"] for v in verdicts); money = sum(1 for v in verdicts if not v["money_ok"])
    short = sum(1 for v in verdicts if v["lines"] < v["expected_adds"])
    allms = sorted(x for v in verdicts for x in v["ms"])
    print(f"\n{n} conversations: landed {landed} ({100*landed/n:.0f}%), fewer lines than expected {short}, invented-line convos {inv}, loops {loops}, money mismatches {money}; turn p50 {allms[len(allms)//2]:.1f}s p95 {allms[int(len(allms)*0.95)-1]:.1f}s")
    json.dump(verdicts, open(os.path.expanduser(f"~/po-scratch/sweep-{time.strftime('%H%M')}.json"), "w"))

if __name__ == "__main__": main()
