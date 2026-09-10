-- Extends sync_shop_settings_from_shop() (applied directly against prod
-- 2026-09-10 ~12:01 UTC by a parallel build, not yet tracked in a migration
-- file — this migration documents that live definition and adds one thing
-- to its scope, rather than creating a second sync mechanism on the same
-- tables. Do not add another trigger/function pair for shops -> shop_settings
-- sync; extend this one.
--
-- Gap: buildSystemPromptV2 (chat-sms) reads shop.delivery_radius_mi directly
-- for its own delivery-zone gate (deliveryGeoAvailable) and for the
-- set_delivery_address zone check — that path already works and is
-- untouched here. But shop_settings.delivery_radius_miles is fetched into
-- ShopSettingsRow and never read anywhere, and the sync trigger never wrote
-- it (confirmed: Vito's Pizza has delivery_radius_mi = 5.00 on shops but
-- delivery_radius_miles = null on shop_settings). Keeping the shop_settings
-- copy in sync now, before anything is built to depend on it, so a future
-- caller of the shop_settings copy doesn't inherit a silent stale value.
create or replace function sync_shop_settings_from_shop()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_hours_line text;
begin
  v_hours_line := render_hours_line(new.open_hours);

  insert into shop_settings (shop_id, hours_line, fulfilment_modes, delivery_radius_miles)
  values (
    new.id,
    v_hours_line,
    case when coalesce(new.delivery_enabled, false) then array['pickup','delivery'] else array['pickup'] end,
    new.delivery_radius_mi
  )
  on conflict (shop_id) do update set
    hours_line = excluded.hours_line,
    -- Toggle 'delivery' in/out and keep 'pickup' always present, but
    -- preserve any other mode an owner/editor may have set (e.g.
    -- 'catering') rather than clobbering the whole array.
    fulfilment_modes = (
      select array(
        select distinct m from unnest(
          (case when coalesce(new.delivery_enabled, false)
             then array_append(array_remove(shop_settings.fulfilment_modes, 'delivery'), 'delivery')
             else array_remove(shop_settings.fulfilment_modes, 'delivery')
           end) || array['pickup']
        ) as m
      )
    ),
    delivery_radius_miles = excluded.delivery_radius_miles,
    updated_at = now();

  return new;
end;
$function$;

drop trigger if exists trg_sync_shop_settings_from_shop on shops;
create trigger trg_sync_shop_settings_from_shop
after update of delivery_enabled, open_hours, delivery_paused_until, delivery_pause_reason, delivery_radius_mi
on shops
for each row
execute function sync_shop_settings_from_shop();

-- Backfill: bring every existing shop_settings row's delivery_radius_miles
-- in line with its shop's current delivery_radius_mi right now (miles-to-
-- miles copy, same unit on both columns per the verified schema facts).
update shop_settings ss
set delivery_radius_miles = s.delivery_radius_mi,
    updated_at = now()
from shops s
where s.id = ss.shop_id
  and ss.delivery_radius_miles is distinct from s.delivery_radius_mi;
