#!/usr/bin/env python3
"""Extract menu items from a shop's website via Firecrawl + OpenRouter, insert into Supabase."""
import requests, json, os, re, sys

FIRECRAWL = os.environ["FIRECRAWL_API_KEY"]
OPENROUTER = os.environ["OPENROUTER_API_KEY"]
SUPABASE_KEY = os.environ["SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY"]
SUPABASE_URL = "https://rvdqfxtrskxekfkqnegx.supabase.co"
SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498"
MENU_ID = "6c309547-dae1-4ac8-acb6-77f2354d6a59"
WEBSITE = "https://ziospizzalv.com"

# Step 1: Discover pages
print("=== Step 1: Discover pages ===", flush=True)
r = requests.post("https://api.firecrawl.dev/v1/map",
    headers={"Authorization": f"Bearer {FIRECRAWL}", "Content-Type": "application/json"},
    json={"url": WEBSITE}, timeout=30)
links = r.json().get("links", [])
menu_links = [l for l in links if re.search(r'menu|food|drink|order', l, re.I)]
print(f"Found {len(links)} links, {len(menu_links)} menu links: {menu_links}", flush=True)

# Step 2: Scrape menu page
print("\n=== Step 2: Scrape menu page ===", flush=True)
menu_page = menu_links[0]
r = requests.post("https://api.firecrawl.dev/v1/scrape",
    headers={"Authorization": f"Bearer {FIRECRAWL}", "Content-Type": "application/json"},
    json={"url": menu_page, "formats": ["markdown"], "waitFor": 3000}, timeout=120)
menu_md = r.json().get("data", {}).get("markdown", "")
print(f"Menu page markdown: {len(menu_md)} chars", flush=True)

# Step 3: LLM extraction
print("\n=== Step 3: LLM extraction ===", flush=True)
prompt = """You are a menu parser. Extract every menu item from the scraped website content below.
Return a JSON object with a single key "items" that is an array of objects.

Rules:
- name: exact item name from the menu (clean up whitespace, title case)
- price_cents: integer price in cents (e.g. 1599 for $15.99). If price is a range, use the lower price. If no price found, omit the item entirely.
- category: broad category like Pizza, Pasta, Appetizers, Salads, Subs, Desserts, Drinks, etc. Infer from menu section headers.
- description: short 1-line description if available, empty string otherwise
- size_label: if the same item has explicit size-specific prices (Small $12, Large $18, Family $24), create ONE row per size. If no explicit size variants, use null.

IMPORTANT: Return EXACTLY this format: {"items": [...]} with no markdown code fences, no explanation. Just pure JSON."""

content = menu_md[:50000]
print(f"Sending {len(content)} chars to OpenRouter...", flush=True)
r = requests.post("https://openrouter.ai/api/v1/chat/completions",
    headers={"Authorization": f"Bearer {OPENROUTER}", "Content-Type": "application/json"},
    json={
        "model": "anthropic/claude-sonnet-4.6",
        "max_tokens": 16384,
        "messages": [{"role": "user", "content": prompt + "\n\n" + content}],
    }, timeout=180)
d = r.json()
raw = d["choices"][0]["message"]["content"]
print(f"Raw response: {len(raw)} chars", flush=True)

raw = re.sub(r'^```json\s*\n?', '', raw.strip(), flags=re.I)
raw = re.sub(r'\n?```\s*$', '', raw)
print(f"Stripped: {len(raw)} chars, starts: {raw[:80]}", flush=True)

parsed = json.loads(raw)
items = parsed.get("items", []) if isinstance(parsed, dict) else (parsed if isinstance(parsed, list) else [])
print(f"Extracted {len(items)} items", flush=True)

if not items:
    print("FATAL: 0 items extracted. Raw:", raw[:500], flush=True)
    sys.exit(1)

cats = {}
for it in items:
    c = it.get("category", "Uncategorized")
    cats[c] = cats.get(c, 0) + 1
for c, n in sorted(cats.items(), key=lambda x: -x[1]):
    print(f"  {c}: {n}", flush=True)
for it in items[:5]:
    sl = f' [{it.get("size_label","")}]' if it.get("size_label") else ""
    print(f"  ${it['price_cents']/100:.2f} {it['name']} ({it['category']}){sl}", flush=True)

# Step 4: Insert into Supabase
print(f"\n=== Step 4: Insert {len(items)} items ===", flush=True)
rows = []
for idx, it in enumerate(items):
    rows.append({
        "menu_id": MENU_ID,
        "name": it["name"],
        "price_cents": it.get("price_cents", 0),
        "category": it.get("category", ""),
        "description": it.get("description", ""),
        "size_label": it.get("size_label") or None,
        "display_order": idx,
        "active": True,
        "is_available": True,
        "owner_edited": False,
    })

# Delete existing
requests.delete(f"{SUPABASE_URL}/rest/v1/menu_items?menu_id=eq.{MENU_ID}",
    headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Prefer": "return=minimal"})

for batch in [rows[i:i+100] for i in range(0, len(rows), 100)]:
    r = requests.post(f"{SUPABASE_URL}/rest/v1/menu_items",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=batch)
    print(f"  Batch {len(batch)}: {r.status_code}", flush=True)

# Update shop
requests.patch(f"{SUPABASE_URL}/rest/v1/shops?id=eq.{SHOP_ID}",
    headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
             "Content-Type": "application/json", "Prefer": "return=minimal"},
    json={"crawl_status": "done", "crawl_error": None})

print(f"\nDone! {len(items)} items inserted.", flush=True)