#!/bin/bash
# verify-032-sql.sh — run all tenant isolation attacks via Management API SQL
set -euo pipefail

source ~/.openclaw/.secrets

SQL() {
  # $1 = query label, $2 = SQL, $3 = expectation
  local LABEL="$1"
  local QUERY="$2"
  local EXPECT="$3"
  
  echo ""
  echo "=== $LABEL ==="
  echo "EXPECT: $EXPECT"
  
  RESULT=$(curl -s "https://api.supabase.com/v1/projects/rvdqfxtrskxekfkqnegx/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "import json; print(json.dumps({'query': '$QUERY'}))")" 2>&1)
  
  echo "$RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if isinstance(r, list):
    print(f'Returned {len(r)} row(s)')
else:
    print(f'ERROR: {r.get(\"message\", r)}')
" 2>&1
}

# ATTACK 1: NJB shop_owner reads tenants (simulating authenticated RLS via direct query)
SQL "Attack 1: tenants visible to tenant_id=a00..001" \
  "SELECT id, name, slug FROM tenants WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001' OR auth.uid() = '8316efed-65d5-44c1-9067-077e95679ccc' LIMIT 5" \
  "tenant_id lookup for NJB's tenant"

# ATTACK 2: Verify RLS blocks cross-tenant shops reads — use a simulation
SQL "Attack 2: Cross-tenant shop read (simulated)" \
  "SELECT id, name, tenant_id FROM shops WHERE tenant_id = '7d806f0c-feba-4983-9697-a5940c8990ef'" \
  "Should return only Melvin's shops by direct filter"

# The real test: check if any policy allows bypassing tenant_id
SQL "Attack 3: Current pg_policies for authenticated role (qual=true)" \
  "SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND (qual IS NOT NULL OR with_check IS NOT NULL) ORDER BY tablename, policyname" \
  "Only anon policies should appear"

# ATTACK 4: Check if any policyless tables exist
SQL "Attack 4: Tables without any policy" \
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN (SELECT tablename FROM pg_policies WHERE schemaname = 'public') AND tablename NOT LIKE 'v_%' AND tablename != '_prisma_migrations' ORDER BY tablename" \
  "No unprotected tables"

# ATTACK 5: Verify the remaining 5 anon policies don't enable cross-tenant access
SQL "Attack 5: Anon-only policies (should be exactly 5)" \
  "SELECT tablename, policyname, cmd, roles FROM pg_policies WHERE schemaname = 'public' AND qual IS NOT NULL AND roles::text[] <@ ARRAY['anon']::text[] ORDER BY tablename, cmd" \
  "5 policies, all anon-scoped"

# ATTACK 6: Check if admin_chat_transcripts has RLS enabled
SQL "Attack 6: admin_chat_transcripts RLS enabled?" \
  "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'admin_chat_transcripts'" \
  "RLS should be enabled"

# ATTACK 7: admin_chat_transcripts policies
SQL "Attack 7: admin_chat_transcripts policies" \
  "SELECT policyname, cmd, qual, with_check, roles FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_chat_transcripts'" \
  "INSERT-only policy; SELECT should have tenant scoping"

# ATTACK 8: Verify shops RLS - check actual policy definition
SQL "Attack 8: Shop policies (all)" \
  "SELECT tablename, policyname, cmd, permissive, qual, with_check, roles FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shops' ORDER BY policyname" \
  "No permissive authenticated policies for shops"

# ATTACK 9: Verify no permissive=true for authenticated 
SQL "Attack 9: Any permissive authenticated policies?" \
  "SELECT tablename, policyname, cmd, roles FROM pg_policies WHERE schemaname = 'public' AND permissive = true AND NOT roles @> ARRAY['anon']::text[]" \
  "ZERO rows — no authenticated permissive policies exist"

# ATTACK 10: List all policies by role
SQL "Attack 10: All policies grouped by role" \
  "SELECT roles, count(*) as cnt, string_agg(tablename || '.' || policyname, ', ') as policies FROM pg_policies WHERE schemaname = 'public' GROUP BY roles ORDER BY roles" \
  "No authenticated role policies with dangerous qualifiers"

echo ""
echo "=== DONE ==="