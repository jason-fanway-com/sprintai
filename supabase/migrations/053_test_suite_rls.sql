-- 053_test_suite_rls.sql
-- Read policies for the test-suite reporting UI. Matches the current pattern
-- (is_super_admin() / is_shop_owner_for(tenant_id)). Service role writes (bypasses RLS).
-- Super admin: full access. Shop owner: SELECT only, own tenant only. Tenant isolation preserved.

grant select on test_runs to authenticated;
grant select on test_case_results to authenticated;

-- test_runs
drop policy if exists "admins full access test_runs" on test_runs;
create policy "admins full access test_runs" on test_runs
  for all to authenticated using (is_super_admin()) with check (is_super_admin());

drop policy if exists "owners read own test_runs" on test_runs;
create policy "owners read own test_runs" on test_runs
  for select to authenticated using (is_shop_owner_for(tenant_id));

-- test_case_results (tenant derived via parent run)
drop policy if exists "admins full access test_case_results" on test_case_results;
create policy "admins full access test_case_results" on test_case_results
  for all to authenticated using (is_super_admin()) with check (is_super_admin());

drop policy if exists "owners read own test_case_results" on test_case_results;
create policy "owners read own test_case_results" on test_case_results
  for select to authenticated using (
    exists (select 1 from test_runs r where r.id = run_id and is_shop_owner_for(r.tenant_id))
  );
