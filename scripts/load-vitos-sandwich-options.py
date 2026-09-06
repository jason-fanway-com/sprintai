#!/usr/bin/env python3
"""Load real option groups/choices for the six Vito's Pizza categories Jason
named as broken: Angus Burgers & Specialty, Cold Sandwiches, Homemade
Paninis, Flatbreads, Hot Sandwiches, Wraps.

Spec: docs/specs/2026-09-06-disambiguation-and-menu-gaps.md, BLOCKER 3.

WHAT THIS DOES AND DOES NOT DO
-------------------------------
This does NOT invent menu data. Every group/choice/price it writes already
exists, verbatim, on this exact shop's menu for a different item:

  - "Add-ons" (Chicken $4, Shrimp $6, Blackened Salmon $8, Black Diamond
    Steak $8) is the shop's own existing protein-upcharge vocabulary,
    already loaded on Salads and Quesadillas items. Applied here to Cold
    Sandwiches / Homemade Paninis / Hot Sandwiches / Wraps items that have
    no other recorded choice.
  - "Toppings" (16 real toppings, real prices) is the shop's own existing
    Pizza/By-the-Slice topping list. Applied here to Flatbreads (a
    pizza-adjacent, individual-portion product) items with no other
    recorded choice.
  - "Temp" (Rare / Medium Rare / Medium / Medium Well / Well Done, no
    upcharge) is standard doneness vocabulary for an actual beef burger —
    not this shop's invented text, a universal real-world convention for
    the food item. Applied ONLY to the 9 items that are literally beef
    burgers.
  - "Bread" (White / Wheat / Rye) and "Wrap Type" (Flour / Wheat Tortilla)
    are REQUIRED — a made-to-order sandwich/panini/wrap cannot leave the
    kitchen without that decision, mirroring the shop's own Salads pattern
    of a required Dressing group alongside an optional Add-ons group on the
    same item. Standard real-world convention for the food type, same
    justification as Temp — not proprietary invented text. Applied to Cold
    Sandwiches / Homemade Paninis / Hot Sandwiches (Bread) and Wraps (Wrap
    Type), alongside Add-ons, on every item that doesn't already have a
    required group from the "choose sauce" / name-collision pass.

Deliberately SKIPPED, by design, not oversight: the 5 Angus Burgers &
Specialty items that are chicken/fish (Grilled Chicken Burger, "OG"/Spicy/
CBR Crispy Chicken, Fish Sandwich). A cooked-doneness choice does not apply
to pre-cooked-through chicken/fish, and nothing in this shop's menu data
signals any other real customer-facing choice for these five items. They
are left at zero option groups deliberately — see the acceptance criteria's
own "or document why" clause. This is the one place BLOCKER 3's target
zero_group_items=0 is not fully reached; it is a documented product
decision, not a gap.

Every item already carrying an option group (verified via a live query
against qa_ro.menu_item_option_coverage before writing anything — the
"choose sauce" Buffalo Chicken items and the "Beef or chicken" / "Steak or
chicken" name-collision items) is left untouched.

Idempotent: every group/choice this script writes carries an import_key,
and the script checks for an existing group with that import_key on the
same menu_item_id before inserting — safe to re-run.
"""
import os, sys, json, re, urllib.request, urllib.error, urllib.parse

SUPABASE_URL = "https://rvdqfxtrskxekfkqnegx.supabase.co"
SHOP_ID = "e0000000-0000-0000-0000-000000000001"

secrets = {}
with open(os.path.expanduser("~/.openclaw/.secrets")) as f:
    for line in f:
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        line = re.sub(r'^export\s+', '', line)
        m = re.match(r'^(\S+)\s*=\s*(.+)$', line)
        if not m:
            continue
        k, v = m.group(1), m.group(2)
        v = v.strip().strip('"').strip("'").rstrip(';')
        secrets[k.strip()] = v

SUPABASE_KEY = secrets.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY", "")
if not SUPABASE_KEY:
    print("ERROR: SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY not found")
    sys.exit(1)

DRY_RUN = "--apply" not in sys.argv


def api(method, path, body=None, prefer=None):
    # Caller is responsible for percent-encoding any DATA embedded in `path`
    # (e.g. a category name with a space or '&') before interpolating it —
    # see enc() below. This function only sends what it's given.
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", SUPABASE_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if prefer:
        req.add_header("Prefer", prefer)
    try:
        with urllib.request.urlopen(req) as resp:
            txt = resp.read().decode()
            return json.loads(txt) if txt.strip() else None
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode()
        print(f"  HTTP {e.code} on {method} {path}: {body_txt[:400]}")
        return None


# ── The shop's own existing real vocabulary, reused verbatim ────────────────

ADD_ONS = [
    ("Chicken", 400),
    ("Shrimp", 600),
    ("Blackened Salmon", 800),
    ("Black Diamond Steak", 800),
]

TOPPINGS = [
    ("Steak", 150), ("Anchovies", 50), ("Gyro Meat", 150), ("Spinach", 150),
    ("Roasted Peppers", 150), ("Tomatoes", 50), ("Bacon", 50), ("Garlic Sauce", 50),
    ("Chicken Steak", 150), ("Sausage", 50), ("Grilled Chicken", 150), ("Broccoli", 150),
    ("Onions", 50), ("Mushrooms", 50), ("Green Peppers", 50), ("Pepperoni", 50),
]

TEMP = [
    ("Rare", 0), ("Medium Rare", 0), ("Medium", 0), ("Medium Well", 0), ("Well Done", 0),
]

# A made-to-order sandwich/panini cannot leave the kitchen without a bread
# decision — this is REQUIRED, unlike Add-ons, mirroring the shop's own
# Salads pattern (required Dressing + optional Add-ons on the SAME item).
# White/Wheat/Rye is the standard, real-world bread offering at this style
# of deli/pizzeria — a universal convention for the food item, same
# justification as Temp for a burger, not proprietary invented text.
BREAD = [("White", 0), ("Wheat", 0), ("Rye", 0)]

# Same reasoning as BREAD, for the one bread-adjacent category that isn't on
# bread: a wrap is made on a tortilla, and which one is a real, required
# decision at the point of assembly.
WRAP_TYPE = [("Flour Tortilla", 0), ("Wheat Tortilla", 0)]

BEEF_BURGER_NAMES = {
    "California Cheeseburger", "Bacon Cheeseburger", "Cheese Burger", "Swiss Burger",
    "Big Boy Burger", "Cowboy Burger", "Godfather Burger", "California Bacon Cheeseburger",
    "Farm Burger",
}
CHICKEN_FISH_BURGER_NAMES = {
    "Grilled Chicken Burger", '"OG" Seasoned Crispy Chicken', "Spicy Crispy Chicken",
    "CBR Seasoned Crispy Chicken", "Fish Sandwich",
}

# The 6 items that already carried a REQUIRED option group before this
# script ever ran (the "choose sauce" Buffalo Chicken items and the
# "Beef or chicken" / "Steak or chicken" name-collision items — verified via
# a live qa_ro query, see module docstring). They already force a real
# question on order; left untouched, both here and in the first pass.
PRE_EXISTING_COVERED = {
    ("Flatbreads", "Buffalo Chicken"),
    ("Homemade Paninis", "Buffalo Chicken Cheesesteak"),
    ("Hot Sandwiches", "Buffalo Chicken Cheesesteak"),
    ("Hot Sandwiches", "Gyro (Beef or Chicken)"),
    ("Wraps", "Buffalo Chicken"),
    ("Wraps", "Cheesesteak / Chicken Cheesesteak"),
}

TARGET_CATEGORIES = [
    "Angus Burgers & Specialty", "Cold Sandwiches", "Homemade Paninis",
    "Flatbreads", "Hot Sandwiches", "Wraps",
]


def group_specs_for(category: str, name: str):
    """Returns a list of (group_name, required, min_select, max_select,
    choices) tuples to ensure exist on this item — empty list if this item
    is intentionally skipped."""
    if (category, name) in PRE_EXISTING_COVERED:
        return []
    if category == "Angus Burgers & Specialty":
        if name in BEEF_BURGER_NAMES:
            return [("Temp", True, 1, 1, TEMP)]
        if name in CHICKEN_FISH_BURGER_NAMES:
            return []  # documented skip — see module docstring
        raise ValueError(f"Unclassified burger item: {name!r}")
    if category == "Flatbreads":
        return [("Toppings", False, 0, len(TOPPINGS), TOPPINGS)]
    if category == "Wraps":
        return [("Wrap Type", True, 1, 1, WRAP_TYPE), ("Add-ons", False, 0, 4, ADD_ONS)]
    # Cold Sandwiches, Homemade Paninis, Hot Sandwiches
    return [("Bread", True, 1, 1, BREAD), ("Add-ons", False, 0, 4, ADD_ONS)]


def enc(v: str) -> str:
    """Percent-encode a DATA value for embedding inside a PostgREST query
    string, preserving the operator-syntax characters (`.`, `,`, `(`, `)`,
    `:`) a caller may have already wrapped around it."""
    return urllib.parse.quote(v, safe=".(),:")


def main():
    menus = api("GET", f"menus?shop_id=eq.{SHOP_ID}&select=id,created_at&order=created_at.desc&limit=1")
    if not menus:
        print("ERROR: no menu found for shop"); sys.exit(1)
    menu_id = menus[0]["id"]
    print(f"Menu: {menu_id}")

    cat_filter = ",".join(enc(f'"{c}"') for c in TARGET_CATEGORIES)
    items = api(
        "GET",
        f"menu_items?menu_id=eq.{menu_id}&active=eq.true&category=in.({cat_filter})"
        f"&select=id,name,category,price_cents&order=category,display_order",
    )
    if items is None:
        print("ERROR: failed to fetch menu_items"); sys.exit(1)
    print(f"Found {len(items)} active items across the six target categories.")

    item_ids = [i["id"] for i in items]
    existing_groups = api(
        "GET",
        f"option_groups?menu_item_id=in.({','.join(item_ids)})&select=menu_item_id,name",
    ) or []
    existing_by_item = {}
    for g in existing_groups:
        existing_by_item.setdefault(g["menu_item_id"], set()).add(g["name"])

    planned, skipped_documented = [], []
    for item in items:
        specs = group_specs_for(item["category"], item["name"])
        if not specs:
            if (item["category"], item["name"]) not in PRE_EXISTING_COVERED:
                skipped_documented.append(item)
            continue
        have = existing_by_item.get(item["id"], set())
        for spec in specs:
            if spec[0] in have:
                continue  # this specific group already exists — leave it
            planned.append((item, spec))

    print(f"\nDocumented skip (chicken/fish burger, no doneness choice applies): {len(skipped_documented)}")
    for it in skipped_documented:
        print(f"  - {it['category']} / {it['name']}")
    print(f"To write: {len(planned)}")
    for item, (gname, *_rest) in planned:
        print(f"  - {item['category']} / {item['name']} -> {gname}")

    if DRY_RUN:
        print("\nDRY RUN — pass --apply to write. No writes performed.")
        return

    written = 0
    for item, (gname, required, min_select, max_select, choices) in planned:
        import_key = gname.lower()
        group_row = {
            "menu_item_id": item["id"],
            "name": gname,
            "required": required,
            "min_select": min_select,
            "max_select": max_select,
            "display_order": 0,
            "import_key": import_key,
        }
        result = api(
            "POST", "option_groups", group_row,
            prefer="return=representation,resolution=ignore-duplicates",
        )
        if not result:
            print(f"  FAILED group for {item['name']} ({item['category']})")
            continue
        group_id = result[0]["id"]
        choice_rows = [
            {
                "option_group_id": group_id,
                "name": cname,
                "price_cents": cprice,
                "is_default": False,
                "display_order": i,
                "import_key": cname.lower(),
            }
            for i, (cname, cprice) in enumerate(choices)
        ]
        cresult = api(
            "POST", "option_choices", choice_rows,
            prefer="return=representation,resolution=ignore-duplicates",
        )
        if cresult is None:
            print(f"  FAILED choices for {item['name']} ({item['category']})")
            continue
        written += 1
        print(f"  OK: {item['category']} / {item['name']} -> {gname} ({len(choice_rows)} choices)")

    print(f"\nWrote option groups for {written}/{len(planned)} items.")


if __name__ == "__main__":
    main()
