#!/usr/bin/env python3
"""jason.py — a one-shot pass of customer conversations in Jason's texting style, against the DEPLOYED
engine, written to a transcript file for a human (or Fable) to read reply by reply.

This is not a scorer. It supplies conversations shaped like the ones that find bugs: casual phrasing
with typos, several items with counts in one line, a vague item ("some fries"), a question in the middle
("wait, what is crazy fries?"), a change of mind, an off-menu ask, and a remark after the pay link.
Each pass is a FIXED count — it starts by hand and ends when the count is done. Cost is printed.

usage: jason.py --shop vitos|njb|zio|all --n 20 [--seed 7] [--out ~/po-scratch/jason]
"""
import argparse, functools, json, os, random, re, sys, time, urllib.request, uuid, collections
print = functools.partial(print, flush=True)
sys.path.insert(0, os.path.dirname(__file__))
from e2e import get, say, cart_for  # noqa: E402  (loads secrets)

SHOPS = {"vitos": "e0000000-0000-0000-0000-000000000001", "njb": "b0000000-0000-0000-0000-000000000001", "zio": "2cba7b51-211c-4437-8910-1af4dcc03498"}
ADDRESSES = ["5620 Cetronia Rd Allentown pa 18106", "3300 Hamilton Blvd, Allentown, PA 18103", "2222 w union st allentown", "1901 hamilton st allentown pa"]
OR_KEY = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("SPRINTAI_CHAT_OPENROUTER_API_KEY")
TESTER_MODEL = "anthropic/claude-haiku-4.5"

STYLE = """You are Jason, a real person texting a local food shop to place an order. Write ONLY the next text
message you would send, nothing else. Texting style, exactly like these real examples of yours:
- "yo can i get 2 lg pepperoni pies n a 2 liter coke"
- "Four large pizzas. Chicken parm. And some fries"
- "One meat lover, one plain, one pepperoni and one Hawaiian"
- "Some fries"  /  "Mmmmmm bacon cheese"
- "Wait, what is crazy fries?"  /  "What kind of toppings and seasonings?"
- "actually cancel the fries"  /  "make the coke a diet"  /  "whats my total"
- "do you have gluten free crust"  /  "Hmmm bummer.  Ok, thats all"
- "2 chicken parm sandwiches one on white one on wheat and a side of fries extra crispy"
- "You dont have to text me when it's ready, it will just show up at my house"
Rules: short (under 25 words). Casual, sometimes lowercase, sometimes a typo, sometimes a period-separated
run of items. Answer the shop's question like a person would, sometimes with extra words around it. Do not
repeat yourself. Never invent a menu item that is not in your plan. When the shop shows the order summary
and asks for YES, say yes in your own words. After you receive the payment link, send exactly one natural
remark or question (or "<END>" if you have nothing to say), then reply "<END>" to everything after that."""

QUIRKS = [
    ("question_mid", "at some point before you finish, ask what one of the menu items is or what comes on it"),
    ("change_mind", "after adding something, change your mind about one item (cancel it or swap it for something similar)"),
    ("off_menu", "at some point ask for something the shop probably does not have, then move on when told"),
    ("vague_item", "ask for one of your items vaguely at first (e.g. 'some fries', 'a pie', 'a salad') and pick a kind only when asked"),
    ("counts_one_line", "order several different items with counts in a single message"),
    ("total_check", "at some point ask what your total is"),
    ("late_add", "after saying you are done, remember one more item"),
    ("remark_after_pay", "after the pay link, send a remark about the wait or the driver"),
    ("typo", "misspell one of your item names the way a fast thumb would (drop or swap one letter), and do not correct it unless asked"),
    ("kinds_list", "order several of one thing at once ('4 large pizzas', '3 subs') and when asked what kind, answer with 'one X, one Y, one Z' naming real kinds from the list you are shown"),
    ("one_of_each", "order 'some' of one thing that comes in kinds, and when asked what kind say you'll take one of each except one kind you name from the list"),
    ("complain", "if the shop ever says it could not find something you know is on the menu, push back in one short annoyed sentence"),
]

def llm(messages, max_tokens=60):
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=json.dumps({"model": TESTER_MODEL, "max_tokens": max_tokens, "temperature": 0.9, "messages": messages}).encode(),
                                 headers={"Authorization": f"Bearer {OR_KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r: j = json.loads(r.read().decode())
    txt = (j["choices"][0]["message"]["content"] or "").strip().strip('"')
    u = j.get("usage", {}); return txt, u.get("prompt_tokens", 0), u.get("completion_tokens", 0)

def menu_names(shop_id):
    m = get(f"menus?shop_id=eq.{shop_id}&select=id&order=created_at.desc&limit=1")
    if not m: return []
    rows = get(f"menu_items?menu_id=eq.{m[0]['id']}&active=eq.true&is_derived=eq.false&select=display_name,category&limit=400")
    return [(r["display_name"], r.get("category") or "") for r in rows if r.get("display_name")]

def make_plan(rng, names, shop_key):
    k = rng.choice([2, 2, 3, 3, 4])
    items = rng.sample(names, k)
    quirks = rng.sample(QUIRKS, rng.choice([1, 2, 2]))
    delivery = rng.random() < 0.45 and shop_key != "njb"
    return {
        "items": [n for n, _ in items],
        "fulfillment": "delivery to " + rng.choice(ADDRESSES) if delivery else "pickup",
        "tip": rng.choice(["15%", "$5", "20", "0", "no tip"]) if delivery else None,
        "quirks": [q for q, _ in quirks], "quirk_text": [t for _, t in quirks],
    }

STOP = set("a an the of with and please some order side one two three for me get want like id i can have to my on it that just thanks thank you pls plz".split())
def cw(s): return {w for w in re.sub(r"[^a-z0-9 ]", " ", s.lower()).split() if w not in STOP and len(w) > 2}

def run_one(shop_key, shop_id, plan, verbose):
    session = str(uuid.uuid4()); transcript = []; tin = tout = 0
    plan_text = (f"Your plan: you want {', '.join(plan['items'])}. Fulfillment: {plan['fulfillment']}."
                 + (f" Tip when asked: {plan['tip']}." if plan['tip'] else "")
                 + " Extra behaviour for this conversation: " + " Also: ".join(plan["quirk_text"]) + ".")
    msgs = [{"role": "system", "content": STYLE + "\n\n" + plan_text}]
    last_reply = None; loops = 0; paid = False; after_pay = 0
    for turn in range(16):
        prompt = "Send your first message to the shop." if turn == 0 else f"The shop replied:\n{last_reply}\n\nYour next text:"
        msgs.append({"role": "user", "content": prompt})
        text, a, b = llm(msgs); tin += a; tout += b
        msgs.append({"role": "assistant", "content": text})
        if "<END>" in text or not text: break
        reply, dt = say(shop_id, session, text)
        clean = reply.split("Msg & data rates")[0].strip()
        transcript.append((text, clean, dt))
        if verbose: print(f"    C: {text}\n    B: {clean.replace(chr(10), ' / ')}  ({dt:.1f}s)")
        if clean == last_reply: loops += 1
        else: loops = 0
        last_reply = clean
        if "pay here" in clean.lower(): paid = True
        if paid: after_pay += 1
        if after_pay >= 2 or loops >= 2: break
    cart = cart_for(shop_id, session) or {}
    lines = cart.get("cart_json") or []
    typed = set().union(*[cw(c) for c, _, _ in transcript]) if transcript else set()
    invented = [l["name"] for l in lines if not (cw(l["name"]) & typed)]
    replies = " ".join(r for _, r, _ in transcript).lower()
    flags = {
        "landed": bool(cart.get("stripe_checkout_session_id")),
        "lines": len(lines), "invented": invented, "loops": loops >= 2,
        "didnt_follow": replies.count("didn't follow") + replies.count("didn't catch"),
        "also_want": replies.count("did you also want"),
        "which_one": replies.count("which one?"),
        "noted": replies.count("noted for the kitchen"),
        "couldnt_find": replies.count("couldn't find"),
        "slow_turns": sum(1 for _, _, dt in transcript if dt > 6),
        "total_cents": cart.get("total_cents"),
    }
    return {"shop": shop_key, "session": session, "plan": plan, "transcript": transcript, "cart": [(l["name"], l["quantity"], l["price_cents"]) for l in lines], "flags": flags, "tester_tokens": (tin, tout)}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--shop", default="all"); ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--seed", type=int, default=int(time.time()) % 10000); ap.add_argument("--out", default=os.path.expanduser("~/po-scratch/jason")); ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    if not OR_KEY: sys.exit("no OpenRouter key in env")
    rng = random.Random(a.seed)
    keys = list(SHOPS) if a.shop == "all" else [a.shop]
    names = {k: menu_names(SHOPS[k]) for k in keys}
    os.makedirs(a.out, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M"); results = []
    print(f"jason.py pass: {a.n} conversations, shops {keys}, seed {a.seed} — ends when the count is done")
    for i in range(a.n):
        k = keys[i % len(keys)]
        plan = make_plan(rng, names[k], k)
        print(f"[{i + 1}/{a.n}] {k} items={plan['items']} {plan['fulfillment']} quirks={plan['quirks']}")
        try: results.append(run_one(k, SHOPS[k], plan, a.verbose))
        except Exception as e: print("   !! error:", e); results.append({"shop": k, "plan": plan, "error": str(e), "transcript": [], "flags": {}, "cart": [], "tester_tokens": (0, 0)})
        f = results[-1]["flags"]; print("   ", {x: f.get(x) for x in ("landed", "lines", "invented", "didnt_follow", "also_want", "which_one", "noted", "couldnt_find", "slow_turns")})
    # transcript file for reading
    md = [f"# Jason-style pass {stamp} — {a.n} conversations, seed {a.seed}\n"]
    for i, r in enumerate(results, 1):
        p = r["plan"]; md.append(f"\n## {i}. {r['shop']} — wanted {', '.join(p['items'])}; {p['fulfillment']}; quirks {', '.join(p['quirks'])}\n")
        if r.get("error"): md.append(f"ERROR: {r['error']}\n")
        for c, b, dt in r["transcript"]:
            bb = b.replace("\n", "  \n")
            md.append(f"**C:** {c}\n\n**B:** {bb}  _({dt:.1f}s)_\n")
        odd = {k: v for k, v in r["flags"].items() if v and k not in ("landed", "lines", "total_cents")}
        md.append(f"\nCART: {r['cart']}  total {r['flags'].get('total_cents')}  landed={r['flags'].get('landed')}  flags={odd}\n")
    path = os.path.join(a.out, f"{stamp}.md"); open(path, "w").write("\n".join(md))
    open(os.path.join(a.out, f"{stamp}.json"), "w").write(json.dumps(results, indent=1))
    tin = sum(r["tester_tokens"][0] for r in results); tout = sum(r["tester_tokens"][1] for r in results)
    turns = sum(len(r["transcript"]) for r in results)
    agg = collections.Counter()
    for r in results:
        for k2, v in r["flags"].items():
            if isinstance(v, bool): agg[k2] += int(v)
            elif isinstance(v, int): agg[k2] += v
            elif isinstance(v, list): agg[k2] += len(v)
    print(f"\n== {len(results)} conversations, {turns} engine turns; landed {agg['landed']}; invented lines {agg['invented']}; 'didn't follow' {agg['didnt_follow']}; 'did you also want' {agg['also_want']}; which-one {agg['which_one']}; kitchen notes {agg['noted']}; couldn't find {agg['couldnt_find']}; slow turns {agg['slow_turns']}")
    print(f"== tester model tokens in/out {tin}/{tout} ≈ ${tin / 1e6 * 1.0 + tout / 1e6 * 5.0:.3f}; engine turns ≈ ${turns * 0.0015:.2f}")
    print(f"== transcript: {path}")

if __name__ == "__main__": main()
