#!/usr/bin/env python3
"""fnas-terms-20261006 — FNA's Grille: the ways people type these item names (one-word "cheesesteak", "chix"→chicken,
"stix"→sticks, "bacon blue cheese burger" which otherwise resolved to the 49ers Cheese Burger). Lexicon rows with
provenance owner_confirmed (the compiler never deactivates those). A term on several items makes the bot ask which.
usage: fnas-terms-20261006.py [--apply]"""
import json, os, sys, urllib.parse, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "engine"))
import e2e  # noqa: E402
SHOP = "3477b955-fef4-495f-a656-f75632cf4042"
CHEESESTEAK = ["cheesesteak", "cheesesteak sandwich"]
CHICKEN_CS = ["chicken cheesesteak", "chicken cheese steak", "chicken steak", "chicken cheesesteak sandwich"]
# steak or chicken is two rows each (the meat names the item), so "chicken" never reads as part of a steak row's name
TERMS = {
    "Cooper Cheese Steak": CHEESESTEAK + ["cooper cheesesteak", "cooper steak", "cooper sharp cheesesteak"],
    "Cooper Chicken Cheese Steak": CHICKEN_CS + ["cooper chicken cheesesteak", "chicken cooper cheesesteak", "chicken cooper cheese steak",
                                    "cooper cheesesteak chicken", "cooper cheese steak chicken", "cooper chicken", "chicken cooper"],
    "LV Cheese Steak": CHEESESTEAK + ["lv cheesesteak"],
    "LV Chicken Cheese Steak": CHICKEN_CS + ["lv chicken cheesesteak", "chicken lv cheesesteak", "chicken lv cheese steak",
                                "lv cheesesteak chicken", "lv cheese steak chicken", "lv chicken", "chicken lv"],
    "Beer Cheese Steak": CHEESESTEAK + ["beer cheesesteak"],
    "Beer Chicken Cheese Steak": CHICKEN_CS + ["beer cheese chicken cheesesteak", "beer chicken cheesesteak", "chicken beer cheesesteak",
                                  "chicken beer cheese steak", "beer cheese steak chicken", "beer cheesesteak chicken", "beer cheese chicken"],
    "Black Diamond Cheese Steak": CHEESESTEAK + ["black diamond cheesesteak", "mushroom cheesesteak"],
    "The Philly Special": ["philly burger", "philly special burger", "philly cheesesteak burger", "cheesesteak burger"],
    "Chix Bacon Ranch Hoagie": ["chicken bacon ranch hoagie", "chicken bacon ranch", "chicken bacon ranch sandwich", "chicken bacon ranch sub", "cbr hoagie", "cbr"],
    "Chix Bacon Ranch Salad": ["chicken bacon ranch salad", "chicken bacon ranch", "cbr salad", "cbr"],
    "Bacon n Bleu Burger": ["bacon blue cheese burger", "bacon bleu cheese burger", "bacon blue burger", "bacon and blue burger",
                            "bacon and bleu burger", "bacon blue cheeseburger", "bacon cheeseburger"],
    "Bacon Cooper Burger": ["bacon cheeseburger", "bacon cooper cheeseburger"],
    "49ers Cheese Burger": ["cheeseburger", "49ers cheeseburger", "niners burger", "niners cheeseburger", "49er cheeseburger"],
    "Bone In Wings (8)": ["wings", "chicken wings", "buffalo wings", "traditional wings", "bone in"],
    "Boneless Wing Basket": ["wings", "chicken wings", "boneless", "boneless wing"],
    "Chicken Finger Basket": ["chicken tenders", "tenders", "chicken strips", "chicken tender basket", "tender basket", "fingers"],
    "Pretzel Stix (3)": ["pretzel sticks", "pretzel stick", "pretzels", "soft pretzel"],
    "Mozz Stix (6)": ["mozz sticks", "mozzarella sticks", "mozzarella stix", "mozz stick", "mozzarella stick", "cheese sticks"],
    "Cheese Steak Egg Rolls": ["cheesesteak egg rolls", "cheesesteak egg roll", "cheese steak egg roll", "egg roll"],
    "Cheese Steak Flatbread": ["cheesesteak flatbread"],
    "Margherita Flatbread": ["margarita flatbread"],
    "Crab Cake BLT": ["crab cake sandwich", "crab cake blt sandwich"],
    "11oz Country Fried Steak": ["chicken fried steak", "country fried"],
    "Crab & Shrimp Capellini": ["crab and shrimp pasta", "crab and shrimp capellini", "crab shrimp pasta", "crab pasta"],
    "Vodka Chix Parm Pesto Pasta": ["vodka chicken parm", "chicken parm", "chicken parm pasta", "vodka chicken parm pesto pasta",
                                    "chicken parmesan", "chix parm", "vodka chix parm"],
    "Sesame Ginger Chicken Skewers": ["sesame chicken skewers", "ginger chicken skewers"],
    "French Onion Soup": ["onion soup"],
    # "i want pasta" listed only the three with pasta in the name (pass 10-10)
    "Pappardelle Bolognese": ["pasta", "pasta bolognese", "bolognese pasta"],
    "Crab & Shrimp Capellini": ["pasta", "seafood pasta", "shrimp pasta"],
    "Short Rib Ragu": ["pasta", "short rib pasta", "ragu pasta"],
}
for _n in ("Fantasy Chicken Pasta", "Rasta Chicken Pasta", "Vodka Chix Parm Pesto Pasta"): TERMS.setdefault(_n, []).append("pasta")  # added, never a second key that replaces the list
menu = e2e.get(f"menus?shop_id=eq.{SHOP}&source=eq.csv&select=id")[0]["id"]
items = {i["name"]: i["id"] for i in e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&select=id,name")}
missing = [n for n in TERMS if n not in items]
assert not missing, f"not on the menu: {missing}"
rows, revive = [], []
for name, terms in TERMS.items():
    for term in terms:
        q = urllib.parse.quote(term)
        if e2e.get(f"lexicon?menu_id=eq.{menu}&term=eq.{q}&target_id=eq.{items[name]}&active=eq.true&select=id"):
            continue
        off = e2e.get(f"lexicon?menu_id=eq.{menu}&term=eq.{q}&target_id=eq.{items[name]}&active=eq.false&select=id")
        if off:  # switched off earlier (stale once): switch it back on rather than insert a duplicate (409)
            revive.append(off[0]["id"]); continue
        if True:
            rows.append({"shop_id": SHOP, "menu_id": menu, "term": term, "target_type": "item", "target_id": items[name],
                         "provenance": "owner_confirmed", "weight": 1, "active": True})
# terms this script wrote earlier and no longer lists (or whose item left the menu) are switched off
want = {(t, items[n]) for n, ts in TERMS.items() for t in ts}
stale = [r["id"] for r in e2e.get(f"lexicon?shop_id=eq.{SHOP}&provenance=eq.owner_confirmed&active=eq.true&select=id,term,target_id")
         if (r["term"], r["target_id"]) not in want]
print(f"{len(rows)} new term rows, {len(stale)} stale")
if "--apply" in sys.argv and rows:
    r = urllib.request.Request(f"{e2e.U}/rest/v1/lexicon", method="POST", data=json.dumps(rows).encode(),
        headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": "return=minimal"})
    urllib.request.urlopen(r, timeout=60); print("inserted", len(rows))
if "--apply" in sys.argv and revive:
    r = urllib.request.Request("%s/rest/v1/lexicon?id=in.(%s)" % (e2e.U, ",".join(revive)), method="PATCH", data=json.dumps({"active": True, "provenance": "owner_confirmed"}).encode(),
        headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": "return=minimal"})
    urllib.request.urlopen(r, timeout=60); print("revived", len(revive))
if "--apply" in sys.argv:
    for i in range(0, len(stale), 50):
        ids = ",".join(stale[i:i + 50])
        r = urllib.request.Request(f"{e2e.U}/rest/v1/lexicon?id=in.({ids})", method="PATCH", data=json.dumps({"active": False}).encode(),
            headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": "return=minimal"})
        urllib.request.urlopen(r, timeout=60)
    print("deactivated", len(stale))
