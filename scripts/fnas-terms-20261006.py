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
CHICKEN_CS = ["chicken cheesesteak", "chicken cheese steak", "chicken steak"]
TERMS = {
    "Cooper Cheese Steak": CHEESESTEAK + CHICKEN_CS + ["cooper cheesesteak", "cooper steak", "cooper chicken", "cooper chicken cheesesteak",
                            "chicken cooper cheesesteak", "cooper chicken cheese steak", "cooper sharp cheesesteak"],
    "LV Cheese Steak": CHEESESTEAK + CHICKEN_CS + ["lv cheesesteak", "lv chicken", "lv chicken cheesesteak", "chicken lv cheesesteak"],
    "Beer Cheese Steak": CHEESESTEAK + CHICKEN_CS + ["beer cheesesteak", "beer cheese chicken", "beer cheese chicken cheesesteak", "beer chicken cheesesteak"],
    "Black Diamond Cheese Steak": CHEESESTEAK + ["black diamond cheesesteak", "mushroom cheesesteak"],
    "The Philly Special": ["philly burger", "philly special burger", "philly cheesesteak burger", "cheesesteak burger"],
    "Chix Bacon Ranch Hoagie": ["chicken bacon ranch hoagie", "chicken bacon ranch", "chicken bacon ranch sandwich", "chicken bacon ranch sub", "cbr hoagie", "cbr"],
    "Chix Bacon Ranch Salad": ["chicken bacon ranch salad", "chicken bacon ranch", "cbr salad", "cbr"],
    "Bacon n Bleu Burger": ["bacon blue cheese burger", "bacon bleu cheese burger", "bacon blue burger", "bacon and blue burger",
                            "bacon and bleu burger", "bacon blue cheeseburger", "bacon cheeseburger"],
    "Bacon Cooper Burger": ["bacon cheeseburger", "bacon cooper cheeseburger"],
    "49ers Cheese Burger": ["cheeseburger", "49ers cheeseburger", "niners burger", "niners cheeseburger", "49er cheeseburger"],
    "Bone In Wings (8)": ["buffalo wings", "traditional wings", "bone in"],
    "Boneless Wing Basket": ["wings", "boneless", "boneless wing"],
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
}
menu = e2e.get(f"menus?shop_id=eq.{SHOP}&source=eq.csv&select=id")[0]["id"]
items = {i["name"]: i["id"] for i in e2e.get(f"menu_items?menu_id=eq.{menu}&active=eq.true&select=id,name")}
missing = [n for n in TERMS if n not in items]
assert not missing, f"not on the menu: {missing}"
rows = []
for name, terms in TERMS.items():
    for term in terms:
        q = urllib.parse.quote(term)
        if not e2e.get(f"lexicon?menu_id=eq.{menu}&term=eq.{q}&target_id=eq.{items[name]}&active=eq.true&select=id"):
            rows.append({"shop_id": SHOP, "menu_id": menu, "term": term, "target_type": "item", "target_id": items[name],
                         "provenance": "owner_confirmed", "weight": 1, "active": True})
print(f"{len(rows)} new term rows")
if "--apply" in sys.argv and rows:
    r = urllib.request.Request(f"{e2e.U}/rest/v1/lexicon", method="POST", data=json.dumps(rows).encode(),
        headers={"apikey": e2e.K, "Authorization": f"Bearer {e2e.K}", "Content-Type": "application/json", "Prefer": "return=minimal"})
    urllib.request.urlopen(r, timeout=60); print("inserted", len(rows))
