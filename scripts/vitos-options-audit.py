import csv, collections, os, sys, re, json
sys.path.insert(0, os.path.expanduser("~/sprintai-uber/scripts/engine")); import e2e
rows=list(csv.DictReader(open(os.path.expanduser("~/sprintai-uber/menu-pipeline/fixtures/jacks-slice-menu.csv"))))
opt=collections.defaultdict(dict)
for r in rows: opt[r["category"]][r["name"]]=r["price"]
def S(cat, only=None): return {n for n in opt[cat] if not only or n.lower() in only}
def expected(r):
    E=[]; pf=(r["prompt_for"] or "").lower(); up=(r["upsell"] or "").lower()
    if "which dressing" in pf: E.append(("Dressing (required)", S("Salad Dressings")))
    if "steak or chicken" in pf: E.append(("Steak or chicken (required)", {"Steak","Chicken"}))
    if "beef or chicken" in pf: E.append(("Beef or chicken (required)", {"Beef","Chicken"}))
    m=re.search(r"which sauce \(([^)]*)\)", pf)
    if m: E.append(("Sauce (required)", {x.strip().replace("or ","").strip().title().replace("Bbq","BBQ") for x in m.group(1).split(",")}))
    if "bleu cheese or ranch" in pf: E.append(("Bleu cheese or ranch (required)", {"Bleu Cheese","Ranch"}))
    if "which pasta" in pf: E.append(("Pasta (required)", S("Pasta Choices")))
    if "wing flavor" in pf: E.append(("Wing flavor (required)", S("Wing Flavors")))
    if "extra toppings" in up or "add toppings" in up or "gourmet toppings" in up: E.append(("Toppings (optional)", None))
    if "extra dressing" in up: E.append(("Extra dressing (optional)", {"Extra Dressing"}))
    m=re.search(r"add (?:a protein \(([^)]*)\)|shrimp \+\$6)", up)
    if m:
        names=m.group(1) or "shrimp"
        E.append(("Protein add-on (optional)", {{"chicken":"Chicken","shrimp":"Shrimp","salmon":"Blackened Salmon","steak":"Black Diamond Steak"}[w] for w in re.findall(r"chicken|shrimp|salmon|steak", names)}))
    if "extra dip or celery" in up: E.append(("Wing extras (optional)", S("Wing Extras")))
    if "upgrade the side" in up: E.append(("Side upgrade (optional, price TBD)", {"Sweet Potato Fries","Pierogies","Sauteed Pierogies","Mozzarella Sticks","Onion Rings","Side Salad"} if "kids" not in r["category"].lower() else {"Pierogies","Sauteed Pierogies","Onion Rings"}))
    return E
src={}
for r in rows:
    if r["category"] in opt and r["price"] and not any(k in r["category"] for k in ("Toppings","Flavors","Extras","Dressing","Add-ons","Choices","Options","Finish","Choice","Substitutions")):
        src.setdefault((r["category"], r["name"]), r)
M="54a42842-32be-43b5-9e0c-00fae0ce48fc"
items=e2e.get("menu_items?menu_id=eq.%s&active=eq.true&is_derived=eq.false&select=id,name,category,size_label&limit=1000"%M)
ids=[i["id"] for i in items]; groups=[]
for k in range(0,len(ids),80): groups+=e2e.get("option_groups?menu_item_id=in.(%s)&select=id,menu_item_id,name,required"%",".join(ids[k:k+80]))
gids=[g["id"] for g in groups]; ch=collections.defaultdict(set)
for k in range(0,len(gids),15):
    for c in e2e.get("option_choices?option_group_id=in.(%s)&select=option_group_id,name"%",".join(gids[k:k+15])): ch[c["option_group_id"]].add(re.sub(r" \((Whole|Half) pizza\)","",c["name"]))
cur=collections.defaultdict(list)
for g in groups: cur[g["menu_item_id"]].append((g["name"], g["required"], ch[g["id"]]))
out=collections.defaultdict(list); nomatch=[]
seen=set()
for it in items:
    key=(it["category"], it["name"].split(" - ")[0])
    r=src.get(key) or next((v for (c,n),v in src.items() if c==it["category"] and n.lower()==it["name"].lower()), None)
    if not r: nomatch.append(key); continue
    if key in seen: continue
    seen.add(key)
    E=expected(r); C=cur[it["id"]]; used=set(); probs=[]
    for lab,es in E:
        best=None
        for j,(n,req,cs) in enumerate(C):
            if j in used: continue
            if es is None and ("topping" in n.lower()): best=j; break
            if es and cs and len(es & cs) >= max(1, len(es)//2): best=j; break
        if best is None: probs.append("MISSING "+lab+(": "+", ".join(sorted(es)) if es else ""))
        else:
            used.add(best); n,req,cs=C[best]
            if es and es!=cs: probs.append("DIFF %s: ours has %s; Jack's has %s"%(lab, sorted(cs-es) and "extra "+", ".join(sorted(cs-es)) or "", sorted(es-cs) and "missing "+", ".join(sorted(es-cs)) or ""))
    for j,(n,req,cs) in enumerate(C):
        if j not in used: probs.append("NOT ON JACK'S: %s%s [%s]"%(n, " (required)" if req else "", ", ".join(sorted(cs))[:90]))
    for p in probs: out[it["category"]].append("%s — %s"%(key[1], p))
for cat in sorted(out):
    print("##", cat)
    for l in out[cat]: print("  ", l)
print("unmatched items:", nomatch[:20])
