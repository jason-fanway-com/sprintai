#!/usr/bin/env python3
"""
End-to-end harness: parse-menu-pdf accuracy on Jack's Slice.

Seeds a test shop, POSTs the menu PDF to the DEPLOYED function, retrieves the
resulting menu_items from Supabase, and scores against the golden flat CSV.

Usage:
  SUPABASE_URL=https://xxx PROJECT_ID=xxx ANON_KEY=xxx SERVICE_KEY=xxx \\
    python3 tests/harness/menu-intake-e2e.py

Requires:
  - supabase CLI already linked and logged in
  - parse-menu-pdf function deployed to $SUPABASE_URL
  - tests/fixtures/menu-intake/jacks_slice_flat.csv (golden)

Prints: item recall, modifier coverage, price mismatches, hallucination count.
"""

import os, sys, hashlib, json, csv, time, io, tempfile, re as _re, unicodedata, uuid
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

REPO_ROOT    = Path(__file__).resolve().parents[2]
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures" / "menu-intake"
GOLDEN_CSV   = FIXTURES_DIR / "jacks_slice_flat.csv"
PDF_FILE     = FIXTURES_DIR / "jacks-slice-menu.pdf"

SUPABASE_URL   = os.environ.get("SUPABASE_URL",   "https://rvdqfxtrskxekfkqnegx.supabase.co")
ANON_KEY       = os.environ.get("ANON_KEY",       os.environ.get("SPRINTAI_CHAT_SUPABASE_ANON_KEY", ""))
SERVICE_KEY    = os.environ.get("SERVICE_KEY",    os.environ.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY", ""))

# --- Helpers ------------------------------------------------------------------

def supabase_api(path, method="GET", body=None, key=None, prefer_return=True):
    key = key or SERVICE_KEY or ANON_KEY
    url  = f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path.lstrip('/')}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer_return and method in ("POST", "PATCH"):
        headers["Prefer"] = "return=representation"
    data = json.dumps(body).encode() if body else None
    req   = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req) as res:
            raw = res.read()
            if not raw:
                return {}
            return json.loads(raw)
    except HTTPError as e:
        body_text = e.read().decode()
        return {"error": e.code, "body": body_text}


TENANT_ID = "e51e809f-ac3e-49a9-a6b9-50e06bcca639"  # E2E Menu Intake 2026-08-09


def create_test_shop(name="Harness Test Shop"):
    result = supabase_api("shops", "POST", {
        "name": name,
        "tenant_id": TENANT_ID,
        "email_ticket_recipient": "harness@test.com",
        "slug": f"e2e-test-{int(time.time())}",
        "onboarding_step": "menu",
    })
    if "error" in result:
        # Maybe shop already exists — find it
        shops = supabase_api(f'shops?name=eq.{name.replace(" ", "%20")}')
        if isinstance(shops, list) and len(shops) > 0:
            return shops[0]
        raise RuntimeError(f"Failed to create/find test shop: {result}")
    # POST with return=representation returns a list
    if isinstance(result, list) and len(result) > 0:
        return result[0]
    return result


def delete_test_shop(shop_id):
    supabase_api(f"shops?id=eq.{shop_id}", "DELETE")


def extract_pdf_text(pdf_path):
    """Extract text from PDF using pypdf."""
    from pypdf import PdfReader
    reader = PdfReader(pdf_path)
    all_text = []
    for page in reader.pages:
        t = page.extract_text()
        if t:
            all_text.append(t)
    text = "\n".join(all_text)
    print(f"  Extracted: {len(text)} chars from {len(reader.pages)} pages")
    return text


def call_parse_function(shop_id, pdf_path):
    """Extract PDF text client-side, then POST JSON to the edge function."""
    menu_text = extract_pdf_text(pdf_path)
    if not menu_text:
        return {"error": "pdf-extraction-failed", "body": "Could not extract text from PDF"}

    url = f"{SUPABASE_URL.rstrip('/')}/functions/v1/parse-menu-pdf"
    # Use service key for function auth (anon key may not pass JWT verification)
    auth_key = SERVICE_KEY or ANON_KEY
    body = json.dumps({"shop_id": shop_id, "text": menu_text}).encode()
    headers = {
        "Authorization": f"Bearer {auth_key}",
        "Content-Type": "application/json",
    }
    req = Request(url, data=body, headers=headers, method="POST")
    try:
        with urlopen(req, timeout=600) as res:  # 10 min timeout — Opus can be slow
            return json.loads(res.read())
    except HTTPError as e:
        return {"error": e.code, "body": e.read().decode()}


def fetch_menu_items(shop_id):
    """Get menu_items for this shop's current menu."""
    menus = supabase_api(f"menus?shop_id=eq.{shop_id}&order=created_at.desc&limit=1")
    if not isinstance(menus, list) or len(menus) == 0:
        return []
    menu_id = menus[0]["id"]
    items = supabase_api(f"menu_items?menu_id=eq.{menu_id}&order=display_order")
    return items if isinstance(items, list) else []


def fetch_menu_data(shop_id):
    """Get menu + items + open_questions for scoring."""
    menus = supabase_api(f"menus?shop_id=eq.{shop_id}&order=created_at.desc&limit=1")
    if not isinstance(menus, list) or len(menus) == 0:
        return None
    menu = menus[0]
    items = supabase_api(f"menu_items?menu_id=eq.{menu['id']}&order=display_order")
    items = items if isinstance(items, list) else []
    return {"menu": menu, "items": items}


# --- Scoring ------------------------------------------------------------------

def load_golden():
    """Load the golden CSV into a list of dicts."""
    golden = []
    with open(GOLDEN_CSV) as f:
        reader = csv.DictReader(f)
        for row in reader:
            golden.append({
                "category":    row.get("category", "").strip(),
                "name":        row.get("name", "").strip(),
                "size":        row.get("size", "").strip(),
                "price":       row.get("price", "").strip(),
                "description": row.get("description", "").strip(),
                "prompt_for":  row.get("prompt_for", "").strip(),
                "upsell":      row.get("upsell", "").strip(),
            })
    return golden


# --- CANONICAL NORMALIZATION (applied to BOTH sides before scoring) ---

# Size token map for abbreviation expansion
SIZE_ABBREV = {
    'sm': 'small', 'md': 'medium', 'lg': 'large',
    'small': 'small', 'medium': 'medium', 'large': 'large',
}

def _norm_part(text: str) -> str:
    """Canonicalize a single field: lowercase, collapse whitespace, strip punctuation,
    normalize size abbreviations, strip quotes from dimensions, strip accents."""
    s = text.lower().strip()
    # Unicode normalization: strip accent marks (é→e, ñ→n, etc.)
    s = ''.join(c for c in unicodedata.normalize('NFKD', s) if not unicodedata.combining(c))
    # Strip inch quotes: 10" → 10
    s = _re.sub(r'(\d+)"', r'\1', s)
    s = _re.sub(r'"', '', s)
    # Normalize size abbreviations within words: SM→small, etc.
    words = s.split()
    for i, w in enumerate(words):
        clean = _re.sub(r'[^a-z]', '', w)
        if clean in SIZE_ABBREV:
            words[i] = SIZE_ABBREV[clean]
        elif w in SIZE_ABBREV:
            words[i] = SIZE_ABBREV[w]
    s = ' '.join(words)
    # Strip apostrophes from names (Mike's → Mikes)
    s = s.replace("'", "")
    # Collapse parentheses and punctuation for matching
    s = _re.sub(r'[^a-z0-9]', '', s)
    # "onesizemadetoorder" → "onesize"
    if s.startswith("onesize"):
        s = "onesize"
    # "none" size → empty
    if s == "none":
        s = ""
    # Normalize number-piece patterns: "10pieces", "10piece" etc.
    s = _re.sub(r'(\d+)pieces?', r'\1pieces', s)
    return s

def _strip_category_suffix(name: str) -> str:
    """Strip common category-label suffixes from names for cross-match.
    e.g., 'Thin Sicilian Pizza' → 'Thin Sicilian'
          'Cheesesteak / Chicken Cheesesteak' → 'Cheesesteak / Chicken Cheesesteak' (no suffix match)"""
    suffixes = [' pizza', ' burger', ' wrap', ' sub', ' hoagie', ' salad',
                ' sandwich', ' calzone', ' stromboli', ' pasta', ' quesadilla',
                ' fries', ' wings', ' cheesesteak']
    n = name.lower().strip()
    for sfx in suffixes:
        if n.endswith(sfx) and len(n) > len(sfx) + 2:
            return n[:-len(sfx)]
    return n

def canonical_key(cat: str, name: str, size: str) -> str:
    """Fully canonicalized key: category|name|size."""
    return f"{_norm_part(cat)}|{_norm_part(name)}|{_norm_part(size)}"

def canonical_name_size_key(name: str, size: str) -> str:
    """Canonical key by name+size only (for cross-category matching)."""
    return f"{_norm_part(name)}|{_norm_part(size)}"

def canonical_merged_key(name: str, size: str) -> str:
    """Sorted token-bag of name+size tokens (resilient to size-in-name vs size-in-column).
    Removes filler tokens ('none', numbers-only) for matching robustness."""
    def prep(s):
        s = (s or '').lower().strip()
        s = ''.join(c for c in unicodedata.normalize('NFKD', s) if not unicodedata.combining(c))
        s = _re.sub(r'[^a-z0-9 ]', ' ', s)
        return s
    n = prep(name)
    s = prep(size)
    # Extract number-piece patterns from name as size tokens
    s_from_name = ''
    for m in _re.finditer(r'(\d+)\s*pieces?', n):
        s_from_name += ' ' + m.group(1) + 'pieces'
    n = _re.sub(r'(\d+)\s*pieces?', '', n).strip()
    # Extract number-piece patterns from size
    s = _re.sub(r'(\d+)\s*pieces?', r'\1pieces', s)
    # Combine, normalize "none" away
    merged = n + ' ' + s + ' ' + s_from_name
    # Remove filler tokens
    tokens = [t for t in merged.split() if t not in ('none',)]
    # Filter pure numbers (leftover size values like "10")
    tokens = sorted(set(t for t in tokens if not _re.match(r'^\d+$', t)))
    return ' '.join(tokens)

def item_key(item):
    """Canonical key from a DB row dict."""
    cat  = item.get("category", "") or ""
    name = item.get("name", "") or ""
    size = item.get("size_label", "") or item.get("size", "") or ""
    return canonical_key(cat, name, size)

def golden_key(row):
    """Canonical key from golden row dict."""
    return canonical_key(row.get("category",""), row.get("name",""), row.get("size",""))


def is_modifier_row(row):
    """Check if a golden row is a modifier block entry."""
    cat = (row["category"] or "").lower()
    mod_keywords = ["topping", "wing flavor", "wing extra", "dressing", "sauce",
                    "add-on", "substitut", "choice", "finish", "protein"]
    return any(kw in cat for kw in mod_keywords)


def score(golden, menu_data):
    """Score DB results against golden. Returns scorecard dict."""
    items = menu_data["items"]
    menu  = menu_data["menu"]
    open_questions = menu.get("open_questions", [])
    if isinstance(open_questions, str):
        try: open_questions = json.loads(open_questions)
        except: open_questions = []

    # Build lookup from DB results — multi-key: by canonical key, by name+size key, by merged token-bag
    db_by_key = {}
    db_name_size_map = {}  # name|size → list of items (for cross-category matching)
    db_merged_map = {}     # merged token-bag key → list of items
    for item in items:
        key = item_key(item)
        db_by_key[key] = item
        nsk = canonical_name_size_key(item.get("name","") or "", item.get("size_label","") or item.get("size","") or "")
        if nsk not in db_name_size_map:
            db_name_size_map[nsk] = []
        db_name_size_map[nsk].append(item)
        mk = canonical_merged_key(item.get("name","") or "", item.get("size_label","") or item.get("size","") or "")
        if mk not in db_merged_map:
            db_merged_map[mk] = []
        db_merged_map[mk].append(item)

    def match_db(golden_row):
        """Try to find a DB match for a golden row. Tiers:
        1. Exact canonical key (cat|name|size)
        2. Same-category fuzzy name+size match (avoids cross-cat false positives)
        3. Name+size cross-category match (last resort)
        4. Strip category suffix from name, try name+size again
        5. Merged token-bag key (size-in-name resilient)
        Returns matched DB item or None."""
        gk = golden_key(golden_row)
        if gk in db_by_key:
            return db_by_key[gk]
        # Same-category fuzzy: match name+size within rows of the same category.
        # Uses word-level Jaccard (≥0.4) on original-name tokens (not _norm_part run-ons).
        gold_cat_norm = _norm_part(golden_row["category"])
        gold_name_norm = _norm_part(golden_row["name"])
        gold_size_norm = _norm_part(golden_row["size"])
        STOP_WORDS = {"or", "and", "with", "without", "of", "in", "the", "a", "an", "on", "to", "for",
                      "our", "half", "whole", "large", "regular", "small", "personal", "extra"}
        def _word_tokens(text):
            """Tokenize a name into normalized words, preserving word boundaries."""
            t = (text or "").lower().strip()
            t = "".join(c for c in unicodedata.normalize("NFKD", t) if not unicodedata.combining(c))
            t = _re.sub(r"[^a-z0-9 ]", " ", t)  # keep word boundaries
            return set(w for w in t.split() if len(w) > 0 and w not in STOP_WORDS)
        gold_word_tokens = _word_tokens(golden_row["name"])
        best_same_cat = None
        best_overlap = 0
        for key, row in db_by_key.items():
            if _norm_part(row.get("category", "") or "") == gold_cat_norm:
                rn = _norm_part(row.get("name", "") or "")
                rs = _norm_part(row.get("size_label", "") or row.get("size", "") or "")
                if gold_size_norm != rs:
                    continue
                if gold_name_norm in rn or rn in gold_name_norm:
                    return row
                row_word_tokens = _word_tokens(row.get("name", "") or "")
                total = len(gold_word_tokens | row_word_tokens)
                overlap = len(gold_word_tokens & row_word_tokens)
                if total > 0 and overlap / total >= 0.4 and overlap > best_overlap:
                    best_overlap = overlap
                    best_same_cat = row
        if best_same_cat is not None:
            return best_same_cat
        # Cross-category: match on name+size alone
        nsk = canonical_name_size_key(golden_row["name"], golden_row["size"])
        if nsk in db_name_size_map:
            return db_name_size_map[nsk][0]
        # Strip category suffix from name
        stripped_name = _strip_category_suffix(golden_row["name"])
        nsk2 = canonical_name_size_key(stripped_name, golden_row["size"])
        if nsk2 in db_name_size_map:
            return db_name_size_map[nsk2][0]
        # Merged token-bag: handles size-in-name vs size-in-column mismatch
        mk = canonical_merged_key(golden_row["name"], golden_row["size"])
        if mk in db_merged_map:
            return db_merged_map[mk][0]
        # Also try matching golden's stripped name against DB names
        db_nsk2 = _norm_part(stripped_name)
        for dk, dbs in db_name_size_map.items():
            db_name = dk.split("|")[0] if "|" in dk else ""
            if db_nsk2 in db_name or db_name in db_nsk2:
                return dbs[0]
        return None

    # Partition golden into items and modifiers
    golden_items = [r for r in golden if not is_modifier_row(r)]
    golden_mods  = [r for r in golden if is_modifier_row(r)]

    # --- Item recall ---
    total_items = len(golden_items)
    matched_items = 0
    missed_items = []
    for g in golden_items:
        db_match = match_db(g)
        if db_match:
            matched_items += 1
        else:
            missed_items.append(f'{g["category"]}|{g["name"]}|{g["size"]}')

    item_recall = matched_items / total_items if total_items > 0 else 0

    # --- Modifier block coverage ---
    # Group golden modifiers by normalized category → list of option names
    golden_mod_blocks = {}
    for g in golden_mods:
        ncat = _norm_part(g["category"])
        if ncat not in golden_mod_blocks:
            golden_mod_blocks[ncat] = []
        golden_mod_blocks[ncat].append(_norm_part(g["name"]))

    # Group DB modifiers by normalized category
    db_mod_blocks = {}
    for item in items:
        if item.get("row_type") == "modifier":
            ncat = _norm_part(item.get("category", "") or "Uncategorized")
            if ncat not in db_mod_blocks:
                db_mod_blocks[ncat] = []
            db_mod_blocks[ncat].append(_norm_part(item.get("name", "")))

    total_mod_blocks = len(golden_mod_blocks)
    covered_blocks = 0
    empty_blocks = 0
    mod_coverage_detail = {}
    for gcat_norm, gnames in golden_mod_blocks.items():
        # Direct lookup by normalized key
        db_names = db_mod_blocks.get(gcat_norm, [])
        if db_names:
            # Match each golden name
            matched_names = 0
            for gn in gnames:
                if gn in db_names:
                    matched_names += 1
            block_coverage = matched_names / len(gnames) if gnames else 0
            # Find the original golden category label for display
            gcat_display = next((g["category"] for g in golden_mods if _norm_part(g["category"]) == gcat_norm), gcat_norm)
            db_cat_display = next((item.get("category","") for item in items if item.get("row_type") == "modifier" and _norm_part(item.get("category","")) == gcat_norm), gcat_norm)
            mod_coverage_detail[gcat_display] = {
                "matched": matched_names,
                "total": len(gnames),
                "db_mod_block": db_cat_display,
                "db_total_names": len(db_names),
            }
            if matched_names > 0:
                covered_blocks += 1
            elif len(db_names) == 0:
                empty_blocks += 1
        else:
            gcat_display = next((g["category"] for g in golden_mods if _norm_part(g["category"]) == gcat_norm), gcat_norm)
            mod_coverage_detail[gcat_display] = {"matched": 0, "total": len(gnames), "db_mod_block": "NONE", "db_total_names": 0}

    mod_coverage = covered_blocks / total_mod_blocks if total_mod_blocks > 0 else 0

    # --- Price mismatches ---
    price_errors = 0
    price_flagged = 0
    for g in golden:
        db = match_db(g)
        if db and g["price"]:
            gp = float(g["price"]) if g["price"] else 0
            dbp = (db.get("price_cents") or 0) / 100
            if abs(gp - dbp) > 0.005:
                price_errors += 1
                # Check if flagged in open questions
                flagged = any(
                    (_norm_part(g["name"]) in _norm_part(q.get("item_ref", "")))
                    for q in open_questions
                ) if open_questions else False
                if flagged:
                    price_flagged += 1

    silent_price_errors = price_errors - price_flagged

    # --- Hallucinations ---
    # DB item rows with no match in golden (using multi-tier matching)
    db_item_rows = [i for i in items if i.get("row_type") != "modifier"]
    hallucinations = 0
    hallucination_names = []
    # Build reverse lookup: golden name+size keys
    golden_ns_keys = {canonical_name_size_key(g["name"], g["size"]) for g in golden_items}
    golden_ns_stripped = {canonical_name_size_key(_strip_category_suffix(g["name"]), g["size"]) for g in golden_items}
    for row in db_item_rows:
        nsk = canonical_name_size_key(row.get("name","") or "", row.get("size_label","") or row.get("size","") or "")
        found = nsk in golden_ns_keys or nsk in golden_ns_stripped
        if not found:
            # Try substring
            db_name_norm = _norm_part(row.get("name","") or "")
            db_name_stripped = _norm_part(_strip_category_suffix(row.get("name","") or ""))
            for gnsk in golden_ns_keys | golden_ns_stripped:
                gn = gnsk.split("|")[0] if "|" in gnsk else ""
                if db_name_norm in gn or gn in db_name_norm or db_name_stripped in gn or gn in db_name_stripped:
                    found = True
                    break
        if not found:
            hallucinations += 1
            hallucination_names.append(f'{row.get("category","")}|{row.get("name","")}|{row.get("size_label","")}')

    hallucination_rate = hallucinations / len(db_item_rows) * 100 if db_item_rows else 0

    # --- Modifier blocks total ---
    db_modifier_count = len([i for i in items if i.get("row_type") == "modifier"])
    modifier_blocks_detected = len(db_mod_blocks)

    return {
        "item_recall": {
            "matched": matched_items,
            "total": total_items,
            "rate": f"{item_recall:.1%}",
            "missed": missed_items[:20],  # first 20 misses
            "missed_full_count": len(missed_items),
        },
        "modifier_coverage": {
            "covered_blocks": covered_blocks,
            "total_blocks": total_mod_blocks,
            "rate": f"{mod_coverage:.1%}",
            "empty_blocks": empty_blocks,
            "detail": mod_coverage_detail,
        },
        "price_errors": {
            "total": price_errors,
            "flagged": price_flagged,
            "silent": silent_price_errors,
        },
        "hallucinations": {
            "count": hallucinations,
            "rate": f"{hallucination_rate:.1f}%",
            "names": hallucination_names[:20],
        },
        "db_stats": {
            "total_items": len(db_item_rows),
            "total_modifier_options": db_modifier_count,
            "modifier_blocks_detected": modifier_blocks_detected,
        },
        "open_questions": {
            "count": len(open_questions) if open_questions else 0,
        },
        "validation": {
            "passed": menu.get("validated"),
            "content_hash": menu.get("content_hash"),
        },
    }


# --- Report ------------------------------------------------------------------

def print_scorecard(sc):
    print("\n" + "=" * 72)
    print("  🍕  PARSE-MENU-PDF ACCURACY SCORECARD — Jack's Slice")
    print("=" * 72)

    ir = sc["item_recall"]
    mc = sc["modifier_coverage"]
    pe = sc["price_errors"]
    h  = sc["hallucinations"]
    ds = sc["db_stats"]
    oq = sc["open_questions"]
    v  = sc["validation"]

    print(f"\n  ITEM RECALL:       {ir['matched']:>4}/{ir['total']:<4}  ({ir['rate']})")
    print(f"  MODIFIER COVERAGE: {mc['covered_blocks']:>4}/{mc['total_blocks']:<4}  ({mc['rate']})")
    if mc["empty_blocks"] > 0:
        print(f"    ⚠  {mc['empty_blocks']} empty (zero-option) modifier blocks")
    print(f"  PRICE ERRORS:      {pe['total']} total, {pe['flagged']} flagged, {pe['silent']} SILENT")
    print(f"  HALLUCINATIONS:    {h['count']}  ({h['rate']})")
    print(f"  OPEN QUESTIONS:    {oq['count']}")
    print(f"  VALIDATOR:         {'PASSED' if v['passed'] else 'FAILED'}")
    print(f"  CONTENT HASH:      {v['content_hash']}")

    print(f"\n  DB: {ds['total_items']} items, {ds['total_modifier_options']} modifier options ({ds['modifier_blocks_detected']} blocks)")

    if ir["missed_full_count"] > 0:
        print(f"\n  {'─'*60}")
        print(f"  MISSED ITEMS ({ir['missed_full_count']} total, showing first {len(ir['missed'])}):")
        for m in ir["missed"]:
            print(f"    ✗ {m}")

    if pe["total"] > 0:
        print(f"\n  {'─'*60}")
        print(f"  PRICE ERRORS: {pe['total']} total, {pe['silent']} silent (not flagged in Open Questions)")

    if h["count"] > 0:
        print(f"\n  {'─'*60}")
        print(f"  HALLUCINATIONS ({h['count']}):")
        for hn in h["names"][:10]:
            print(f"    ✗ {hn}")

    print(f"\n  {'─'*60}")
    print(f"  MODIFIER BLOCK DETAIL:")
    for gcat, detail in mc["detail"].items():
        status = "✓" if detail["matched"] == detail["total"] else "⚠"
        print(f"    {status} {gcat}: {detail['matched']}/{detail['total']} options → DB block \"{detail['db_mod_block']}\" ({detail['db_total_names']} options)")

    print("\n" + "=" * 72)

    # Acceptance checks
    print("  ACCEPTANCE GATES:")
    item_ok = float(ir['rate'].rstrip('%')) / 100 >= 0.95
    mod_ok  = float(mc['rate'].rstrip('%')) / 100 >= 0.90 and mc['covered_blocks'] >= 16
    price_ok = pe['silent'] == 0
    hall_ok = float(h['rate'].rstrip('%')) < 5.0

    print(f"    Item recall ≥95%:           {'✅ PASS' if item_ok else '❌ FAIL'} ({ir['rate']})")
    print(f"    Modifier coverage ≥90%:     {'✅ PASS' if mod_ok else '❌ FAIL'} ({mc['rate']})")
    print(f"    ≥16/17 modifier blocks:     {'✅ PASS' if mc['covered_blocks'] >= 16 else '❌ FAIL'} ({mc['covered_blocks']})")
    print(f"    Zero silent price errors:   {'✅ PASS' if price_ok else '❌ FAIL'} ({pe['silent']} silent)")
    print(f"    Hallucination <5%:          {'✅ PASS' if hall_ok else '❌ FAIL'} ({h['rate']})")
    print("=" * 72 + "\n")

    # OQ breakdown
    if oq['count'] > 0:
        print("  OPEN QUESTION BREAKDOWN:")
        from collections import Counter
        oq_list = oq.get('items', [])
        issues = Counter(q.get('issue','?') for q in oq_list)
        for iss, cnt in sorted(issues.items(), key=lambda x: -x[1]):
            print(f"    {iss}: {cnt}")
            if cnt <= 3:
                for q in oq_list:
                    if q.get('issue') == iss:
                        ref = q.get('item_ref','')[:70]
                        print(f"      → {ref}")
        print()

    return item_ok and mod_ok and price_ok and hall_ok


# --- Main ---

def run_one_parse(run_label):
    """Run one full parse+score cycle. Returns (scorecard, all_pass)."""
    shop_name = f"E2E Jack's Pass5-{run_label}-{int(time.time())}"
    shop = create_test_shop(shop_name)
    shop_id = shop["id"]

    try:
        print(f"\n  [{run_label}] Parsing Jack's Slice menu PDF...")
        t0 = time.time()
        result = call_parse_function(shop_id, str(PDF_FILE))
        elapsed = time.time() - t0
        if "error" in result:
            print(f"  [{run_label}] PARSE FAILED: {result}")
            return None
        print(f"  [{run_label}] ok={result.get('ok')}, items={result.get('items_parsed')}, "
              f"mod_blocks={result.get('modifier_blocks')}, oq={result.get('open_questions')}, "
              f"{elapsed:.1f}s")
        if isinstance(result.get("extraction_metadata"), dict):
            em = result["extraction_metadata"]
            print(f"  [{run_label}] model={em.get('model')}, confirmed_prices={result.get('confirmed_prices')}, "
                  f"flagged={result.get('flagged_prices')}, text_chars={em.get('text_chars')}")

        print(f"  [{run_label}] Fetching DB results...")
        menu_data = fetch_menu_data(shop_id)
        if not menu_data:
            print(f"  [{run_label}] ERROR: No menu data found after parsing")
            return None
        print(f"  [{run_label}] menu_id={menu_data['menu']['id']}, "
              f"item_rows={len(menu_data['items'])}, "
              f"validated={menu_data['menu'].get('validated')}")

        golden = load_golden()
        return score(golden, menu_data)
    finally:
        if "--keep" not in sys.argv:
            delete_test_shop(shop_id)


def main():
    if not SUPABASE_URL:
        print("ERROR: SUPABASE_URL not set. Export it and re-run.")
        print("Usage:")
        print("  SUPABASE_URL=https://xxx ANON_KEY=xxx SERVICE_KEY=xxx \\")
        print("    python3 tests/harness/menu-intake-e2e.py")
        sys.exit(1)

    if not PDF_FILE.exists():
        print(f"ERROR: PDF not found at {PDF_FILE}")
        sys.exit(1)
    if not GOLDEN_CSV.exists():
        print(f"ERROR: Golden CSV not found at {GOLDEN_CSV}")
        sys.exit(1)

    print(f"PDF:      {PDF_FILE}")
    print(f"Golden:   {GOLDEN_CSV}")
    print(f"Endpoint: {SUPABASE_URL}/functions/v1/parse-menu-pdf")
    print()

    NUM_RUNS = 3
    scorecards = []

    for i in range(1, NUM_RUNS + 1):
        label = f"R{i}"
        sc = run_one_parse(label)
        if sc is None:
            print(f"\n  ❌ Run {i} FAILED — aborting harness")
            sys.exit(1)
        scorecards.append((label, sc))
        # Brief summary after each run
        print(f"  [{label}] recall={sc['item_recall']['rate']} "
              f"mod={sc['modifier_coverage']['rate']} "
              f"silent={sc['price_errors']['silent']} "
              f"hall={sc['hallucinations']['rate']} "
              f"OQ={sc['open_questions']['count']}")

    # --- Print all 3 runs' scorecards ---
    print("\n")
    print("=" * 72)
    print("  ALL 3 RUNS — INDIVIDUAL SCORECARDS")
    print("=" * 72)
    for label, sc in scorecards:
        ir = sc["item_recall"]
        mc = sc["modifier_coverage"]
        pe = sc["price_errors"]
        h  = sc["hallucinations"]
        oq = sc["open_questions"]
        v  = sc["validation"]
        print(f"\n  [{label}] recall={ir['rate']} ({ir['matched']}/{ir['total']})  "
              f"mod={mc['rate']} ({mc['covered_blocks']}/{mc['total_blocks']} blocks)  "
              f"prices: {pe['total']} err, {pe['flagged']} flagged, {pe['silent']} SILENT  "
              f"hall={h['count']} ({h['rate']})  OQ={oq['count']}  "
              f"validator={'PASS' if v['passed'] else 'FAIL'}  "
              f"hash={v['content_hash'][:12]}...")

    # --- Worst-case summary ---
    print("\n")
    print("=" * 72)
    print("  🍕  WORST-CASE SUMMARY (min recall, min mod coverage, max silent errors)")
    print("=" * 72)

    # Extract numeric rates for comparison
    def _rate(d, key):
        return float(d[key]["rate"].rstrip("%")) / 100

    worst_recall = min(scorecards, key=lambda s: _rate(s[1], "item_recall"))[1]["item_recall"]
    worst_mod = min(scorecards, key=lambda s: _rate(s[1], "modifier_coverage"))[1]["modifier_coverage"]
    worst_silent = max(s[1]["price_errors"]["silent"] for s in scorecards)
    worst_hall = max(float(s[1]["hallucinations"]["rate"].rstrip("%")) for s in scorecards)
    worst_hall_count = max(s[1]["hallucinations"]["count"] for s in scorecards)
    worst_oq = min(s[1]["open_questions"]["count"] for s in scorecards)
    total_price_errs = max(s[1]["price_errors"]["total"] for s in scorecards)
    total_flagged = max(s[1]["price_errors"]["flagged"] for s in scorecards)

    # Find which run had worst
    ws_label = None
    for label, sc in scorecards:
        if sc["price_errors"]["silent"] == worst_silent:
            ws_label = label

    print(f"\n  ITEM RECALL (worst):       {worst_recall['rate']}  ({worst_recall['matched']}/{worst_recall['total']})")
    print(f"  MODIFIER COVERAGE (worst): {worst_mod['rate']}  ({worst_mod['covered_blocks']}/{worst_mod['total_blocks']} blocks)")
    print(f"  PRICE ERRORS (worst):      {total_price_errs} total, {total_flagged} flagged, {worst_silent} SILENT")
    print(f"  HALLUCINATIONS (worst):    {worst_hall_count} ({worst_hall:.1f}%)")
    print(f"  OPEN QUESTIONS (min):      {worst_oq}")

    # Find the worst-silent run and show its details
    worst_sc = None
    for label, sc in scorecards:
        if sc["price_errors"]["silent"] == worst_silent:
            worst_sc = (label, sc)
            break

    if worst_sc and worst_sc[1]["price_errors"]["total"] > 0:
        pe = worst_sc[1]["price_errors"]
        print(f"\n  PRICE ERRORS (worst run = {worst_sc[0]}): {pe['total']} total, {pe['flagged']} flagged, {pe['silent']} silent")

    print("\n" + "=" * 72)
    print("  ACCEPTANCE GATES (worst-case):")
    item_ok = float(worst_recall['rate'].rstrip('%')) / 100 >= 0.95
    mod_ok  = float(worst_mod['rate'].rstrip('%')) / 100 >= 0.90 and worst_mod['covered_blocks'] >= 16
    price_ok = worst_silent == 0
    hall_ok = worst_hall < 5.0

    print(f"    Item recall ≥95%:           {'✅ PASS' if item_ok else '❌ FAIL'} ({worst_recall['rate']})")
    print(f"    Modifier coverage ≥90%:     {'✅ PASS' if mod_ok else '❌ FAIL'} ({worst_mod['rate']})")
    print(f"    ≥16/17 modifier blocks:     {'✅ PASS' if worst_mod['covered_blocks'] >= 16 else '❌ FAIL'} ({worst_mod['covered_blocks']})")
    print(f"    Zero silent price errors:   {'✅ PASS' if price_ok else '❌ FAIL'} ({worst_silent} silent)")
    print(f"    Hallucination <5%:          {'✅ PASS' if hall_ok else '❌ FAIL'} ({worst_hall:.1f}%)")
    print("=" * 72 + "\n")

    # Consensus-specific breakdown on worst-silent run
    if worst_sc:
        label, sc = worst_sc
        oq = sc["open_questions"]
        if oq['count'] > 0:
            print(f"  CONSENSUS FLAGGING ({label}, worst silent=0):")
            from collections import Counter
            oq_list = oq.get('items', [])
            if oq_list:
                issues = Counter(q.get('issue','?') for q in oq_list)
                for iss, cnt in sorted(issues.items(), key=lambda x: -x[1]):
                    print(f"    {iss}: {cnt}")
                    if cnt <= 5 and iss.startswith("§B"):
                        for q in oq_list:
                            if q.get('issue') == iss:
                                ref = q.get('item_ref','')[:80]
                                print(f"      → {ref}")
            print()

    all_pass = item_ok and mod_ok and price_ok and hall_ok
    if not all_pass:
        sys.exit(1)


if __name__ == "__main__":
    main()