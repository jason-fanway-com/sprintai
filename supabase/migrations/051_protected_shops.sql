-- 051_protected_shops.sql
-- Prevent accidental destruction of a real/demo shop's menu (see docs/specs/2026-08-12-prod-data-safety-and-njb-restore.md).
-- Root cause of the 2026-08-09 NJB wipe: a test parse ran against a real shop_id and hard-deleted its menu.
-- Defense at the DATA layer so it holds regardless of which code path (or test) attempts the delete.

-- 1. Protected flag on shops
alter table shops add column if not exists protected boolean not null default false;

-- 2. Mark the demo/reference shops protected. NJB is the primary demo shop.
update shops set protected = true
where id = 'b0000000-0000-0000-0000-000000000001';  -- Not Just Bagels

-- 3. Trigger: block DELETE on menus / menu_items for protected shops,
--    unless an explicit per-transaction override is set (for legitimate admin re-imports).
create or replace function guard_protected_menu_delete() returns trigger
language plpgsql as $$
declare
  v_shop uuid;
  v_protected boolean;
begin
  -- Legitimate admin/onboarding flows may opt in per-transaction:
  --   set local app.allow_protected_delete = 'on';
  if current_setting('app.allow_protected_delete', true) = 'on' then
    return old;
  end if;

  if tg_table_name = 'menus' then
    v_shop := old.shop_id;
  elsif tg_table_name = 'menu_items' then
    select m.shop_id into v_shop from menus m where m.id = old.menu_id;
  end if;

  if v_shop is not null then
    select protected into v_protected from shops where id = v_shop;
    if coalesce(v_protected, false) then
      raise exception
        'Protected shop % — menu deletes are blocked. This shop is a real/demo shop; set app.allow_protected_delete=on for an intentional admin re-import.',
        v_shop;
    end if;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_guard_menus_delete on menus;
create trigger trg_guard_menus_delete before delete on menus
  for each row execute function guard_protected_menu_delete();

drop trigger if exists trg_guard_menu_items_delete on menu_items;
create trigger trg_guard_menu_items_delete before delete on menu_items
  for each row execute function guard_protected_menu_delete();
