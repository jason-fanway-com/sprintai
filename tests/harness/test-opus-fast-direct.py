"""Test opus-5-fast directly with high max_tokens to diagnose the 1-item problem."""
import json, time, os, subprocess, tempfile

# Extract PDF text
pdf_path = "tests/fixtures/menu-intake/jacks-slice-menu.pdf"
with open(pdf_path, "rb") as f:
    pdf_bytes = f.read()

with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
    tf.write(pdf_bytes)
    tmp_path = tf.name

result = subprocess.run(
    ["deno", "run", "--allow-read", "--allow-env", "tests/harness/extract-pdf-text.ts", tmp_path],
    capture_output=True, text=True, cwd="/Users/joestrazza/sprintai-ordering", timeout=30
)
os.unlink(tmp_path)

text = ""
for line in result.stdout.split("\n"):
    line = line.strip()
    if len(line) > 100:
        text = line
        break

if not text:
    print("FAILED to extract text:", result.stderr[:500])
    exit(1)

print(f"Extracted {len(text)} chars of text")

# Build prompt
prompt = f"""You are an expert menu parser. Extract ALL sellable items AND ALL modifier option-sets from this menu text.

Return ONLY a raw JSON object (no markdown fences, no code blocks):
{{"items": [...], "modifiers": [...]}}

Each element in both arrays has exactly 7 keys:
  category, name, size, price, description, prompt_for, upsell

=== ITEMS RULES ===
- SIZE VARIATIONS -> separate rows. Size goes in "size".
- PRICE: two decimals, no symbol. "12.95" not "$12.95". Missing/market-price -> "". NEVER guess.
- DESCRIPTION: ingredients + sides. Keep under 25 words.
- prompt_for: required choices (semicolon-separated). Keep brief.
- upsell: add-ons with +$ hints, plus short cross-sell nudge.
- EXHAUSTIVE: every priced item. Every size variation.
- CATEGORY: menu's own section names in display order.
- Do NOT include modifier options (toppings, dressings, sauces) in items.

=== MODIFIER RULES ===
- "category" = modifier block label: "Pizza Toppings - Regular", "Wing Flavors", "Salad Dressings", etc.
- "name" = option name. Half/whole: "Pepperoni (Whole pizza)".
- "size" = blank, "description" = blank, "prompt_for" = blank, "upsell" = blank.
- "price" = delta: free choices -> "0.00", paid -> "4.50", half -> half price.
- MISS NOTHING: toppings (half/whole), wing flavors, wing extras, dressings,
  protein add-ons, side subs, pasta choices, sauce choices, finish options.

Before outputting, verify against the menu. Every item section, every modifier list.

MENU TEXT:
{text[:120000]}"""

api_key = os.environ.get("OPENROUTER_API_KEY", "")
print(f"Calling anthropic/claude-opus-5-fast with prompt={len(prompt)} chars, max_tokens=80000...")
t0 = time.time()

import httpx
resp = httpx.post(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://getsprintai.com",
    },
    json={
        "model": "anthropic/claude-opus-5-fast",
        "max_tokens": 80000,
        "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
    },
    timeout=300,
)

elapsed = time.time() - t0
print(f"Response in {elapsed:.1f}s, status={resp.status_code}")

if resp.status_code == 200:
    data = resp.json()
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    print(f"Raw response length: {len(content)} chars")

    # Parse
    cleaned = content.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned.rsplit("\n", 1)[0]
    if cleaned.startswith("json"):
        cleaned = cleaned[4:].strip()

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        # Try to recover
        print(f"Raw first 500 chars: {cleaned[:500]}")
        print(f"Raw last 500 chars: {cleaned[-500:]}")
        exit(1)

    items = parsed.get("items", [])
    modifiers = parsed.get("modifiers", [])
    print(f"Items: {len(items)}, Modifiers: {len(modifiers)}")
    if items:
        print(f"Sample item 1: {json.dumps(items[0])[:200]}")
    if len(items) > 1:
        print(f"Sample item 2: {json.dumps(items[1])[:200]}")
    if modifiers:
        print(f"Modifier keys: {list(modifiers[0].keys()) if modifiers else 'N/A'}")
        for m in modifiers[:3]:
            print(f"  {json.dumps(m)[:150]}")

    # Save full response for analysis
    with open("/tmp/opus-fast-response.json", "w") as f:
        json.dump({"items": items, "modifiers": modifiers}, f, indent=2)
    print(f"Saved to /tmp/opus-fast-response.json")
else:
    print(f"ERROR: {resp.text[:1000]}")