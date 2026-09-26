#!/usr/bin/env python3
"""endgame.py — 20 scripted end-of-order edits against the LIVE engine (Jason, 2026-09-26): removes, adds after the
pay link, add-remove-add, repeated adds, quantity changes, tip and address changes, cancel. Each scenario asserts the
final cart, that a change after the link produced a NEW link and a NEW session, and that the money adds up.
usage (on the Air): python3 scripts/engine/endgame.py   — ~140 turns, about 30 cents all-in. Runs once; no schedule."""
import os, sys, time, uuid, re
sys.path.insert(0, os.path.dirname(__file__))
from e2e import say, cart_for  # noqa: E402
SHOP = os.environ.get("SHOP_ID", "e0000000-0000-0000-0000-000000000001")
ADDR = "5620 cetronia rd allentown pa 18106"
LINK = re.compile(r"https://pay\.getsprintai\.com/o/\w+")

def L(c): return sorted((l["name"], l["quantity"]) for l in (c or {}).get("cart_json") or [])
def money_ok(c):
    if not c: return "no cart"
    t = c["subtotal_cents"] + c["tax_cents"] + c["service_fee_cents"] + c["delivery_fee_cents"] + c["driver_tip_cents"]
    return None if t == c["total_cents"] else f"total {c['total_cents']} != parts {t}"

# (name, turns, expected final lines, expected count of distinct pay links seen, post_link_changes_expected)
S = [
 ("add after link", ["pickup", "garlic knots and a hot dog", "thats it", "yes", "wait add a sausage roll"], [("Garlic Knots (6)",1),("Hot Dog",1),("Sausage Roll",1)], 2),
 ("remove after link", ["pickup", "garlic knots and a hot dog", "thats it", "yes", "actually take off the hot dog"], [("Garlic Knots (6)",1)], 2),
 ("add, remove it, add again", ["pickup", "garlic knots", "thats it", "yes", "add a hot dog", "never mind, no hot dog", "ok add the hot dog after all"], [("Garlic Knots (6)",1),("Hot Dog",1)], 4),
 ("three adds in a row", ["pickup", "garlic knots", "thats it", "yes", "add a hot dog", "and a sausage roll", "and a coke"], [("Coke",1),("Garlic Knots (6)",1),("Hot Dog",1),("Sausage Roll",1)], 4),
 ("qty up after link", ["pickup", "a hot dog", "thats it", "yes", "make it 3 hot dogs"], [("Hot Dog",3)], 2),
 ("take one off after link", ["pickup", "3 hot dogs", "thats it", "yes", "thats one too many, take one off"], [("Hot Dog",2)], 2),
 ("remove all but one", ["pickup", "garlic knots, a hot dog and a coke", "thats it", "yes", "remove the knots and the coke"], [("Hot Dog",1)], 2),
 ("remove everything", ["pickup", "garlic knots", "thats it", "yes", "remove the garlic knots"], [], None),
 ("cancel after link", ["pickup", "garlic knots", "thats it", "yes", "cancel the order"], None, None),
 ("add needing a question", ["pickup", "garlic knots", "thats it", "yes", "add some fries", "french"], [("French Fries",1),("Garlic Knots (6)",1)], 2),
 ("add with a slot", ["pickup", "garlic knots", "thats it", "yes", "add a cheesesteak sandwich", "white"], [("Cheesesteak Sandwich",1),("Garlic Knots (6)",1)], 2),
 ("add then never mind", ["pickup", "garlic knots", "thats it", "yes", "add a coke", "actually scratch the coke"], [("Garlic Knots (6)",1)], 3),
 ("remove at the read-back", ["pickup", "garlic knots and a hot dog", "thats it", "remove the hot dog", "yes"], [("Garlic Knots (6)",1)], 1),
 ("two adds at the read-back", ["pickup", "garlic knots", "thats it", "add a hot dog", "and a coke", "yes"], [("Coke",1),("Garlic Knots (6)",1),("Hot Dog",1)], 1),
 ("resend without change", ["pickup", "garlic knots", "thats it", "yes", "resend the link", "send it again"], [("Garlic Knots (6)",1)], 1),
 ("total after link", ["pickup", "garlic knots and a hot dog", "thats it", "yes", "whats my total"], [("Garlic Knots (6)",1),("Hot Dog",1)], 1),
 ("tip change after link", ["delivery", ADDR, "garlic knots and a hot dog", "thats it", "0", "yes", "actually make the tip 20%"], [("Garlic Knots (6)",1),("Hot Dog",1)], 2),
 ("merge same item after link", ["pickup", "a hot dog", "thats it", "yes", "add another hot dog"], [("Hot Dog",2)], 2),
 ("swap after link", ["pickup", "a cheesesteak sandwich on white", "thats it", "yes", "swap the cheesesteak for a chicken cheesesteak sandwich", "white"], [("Chicken Cheesesteak Sandwich",1)], 2),
 ("thats it after a post-link add", ["pickup", "garlic knots", "thats it", "yes", "add a hot dog", "thats it"], [("Garlic Knots (6)",1),("Hot Dog",1)], 2),
]
results = []
if sys.argv[1:]: S = [x for x in S if any(a.lower() in x[0].lower() for a in sys.argv[1:])]  # rerun a subset by name
for name, turns, want, links_want in S:
    s = str(uuid.uuid4()); links = []; sessions = []; log = []; loops = 0; last = None
    for t in turns:
        r, dt = say(SHOP, s, t); log.append((t, r.replace("\n", " / "), dt))
        for u in LINK.findall(r):
            if u not in links: links.append(u)
        c = cart_for(SHOP, s); sid = (c or {}).get("stripe_checkout_session_id")
        if sid and sid not in sessions: sessions.append(sid)
        if last is not None and r == last: loops += 1
        last = r
    c = cart_for(SHOP, s); got = L(c); bad = []
    if want is not None and got != want: bad.append(f"lines {got} != {want}")
    if links_want is not None and len(links) != links_want: bad.append(f"{len(links)} links, expected {links_want}")
    if links_want and len(sessions) != links_want: bad.append(f"{len(sessions)} sessions for {links_want} links")
    m = money_ok(c) if want else None
    if m: bad.append(m)
    if any("didn't catch" in r or "didn't follow" in r or "don't see" in r for _, r, _ in log): bad.append("a 'didn't catch' / 'don't see' reply")
    if loops: bad.append(f"{loops} identical consecutive replies")
    results.append((name, bad, log, links, sessions, c))
    print(f"[{len(results)}/{len(S)}] {name}: {'OK' if not bad else 'FAIL ' + '; '.join(bad)}", flush=True)

out = os.path.expanduser("~/po-scratch/endgame-%s.md" % time.strftime("%Y%m%d-%H%M"))
with open(out, "w") as f:
    f.write(f"# End-of-order edits — {time.strftime('%Y-%m-%d %H:%M')} — {sum(1 for r in results if not r[1])}/{len(results)} clean\n\n")
    for name, bad, log, links, sessions, c in results:
        f.write(f"## {name} — {'OK' if not bad else 'FAIL: ' + '; '.join(bad)}\n")
        f.write(f"links {len(links)}, sessions {len(sessions)}, final {L(c)}, total {(c or {}).get('total_cents')}\n\n")
        for t, r, dt in log: f.write(f"**C:** {t}\n\n**B:** {r}  _({dt:.1f}s)_\n\n")
print("\n==", sum(1 for r in results if not r[1]), "of", len(results), "clean;", sum(len(r[2]) for r in results), "turns; transcript:", out)
