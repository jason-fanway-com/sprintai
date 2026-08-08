#!/usr/bin/env python3
"""Check flagged tables for tenant data exposure."""
import json, requests, sys

# Get secrets
def get_secret(var):
    import subprocess
    r = subprocess.run(['bash', '-c', f'source /Users/joestrazza/.openclaw-sprintai/.secrets 2>/dev/null; echo -n "${{{var}}}"'],
                       capture_output=True, text=True)
    return r.stdout.strip()

ACCESS_TOKEN = get_secret('SUPABASE_ACCESS_TOKEN')
PROJECT_REF = 'rvdqfxtrskxekfkqnegx'

def sql(query):
    payload = json.dumps({"query": query})
    r = requests.post(
        f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query",
        headers={"Authorization": f"Bearer {ACCESS_TOKEN}", "Content-Type": "application/json"},
        data=payload
    )
    if r.status_code not in (200, 201):
        return {"error": r.status_code, "body": r.text[:500]}
    return r.json()

for table in ["number_provision_log", "outbound_queue", "stripe_webhook_events"]:
    print(f"\n=== {table} ===")
    cols = sql(f"SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}' ORDER BY ordinal_position")
    if isinstance(cols, list):
        col_info = [(c["column_name"], c["data_type"]) for c in cols]
        print(f"  Columns ({len(cols)}): {col_info}")
        has_tid = any(c["column_name"] == "tenant_id" for c in cols)
        has_shop = any(c["column_name"] == "shop_id" for c in cols)
        print(f"  Has tenant_id: {has_tid}, has shop_id: {has_shop}")
    else:
        print(f"  Schema error: {cols}")
    
    count = sql(f"SELECT count(*) as cnt FROM {table}")
    if isinstance(count, list):
        print(f"  Row count: {count[0]['cnt'] if count else 0}")
    
    samples = sql(f"SELECT * FROM {table} LIMIT 3")
    if isinstance(samples, list):
        print(f"  {len(samples)} sample rows:")
        for row in samples:
            short = {k: (str(v)[:60] if v is not None else None) for k, v in row.items()}
            print(f"    {json.dumps(short, default=str)}")
    else:
        print(f"  Sample error: {samples}")

# Summary
print("\n=== ASSESSMENT ===")
print("Tables without RLS: number_provision_log, outbound_queue, stripe_webhook_events")
print("These must be evaluated for tenant data exposure risk.")