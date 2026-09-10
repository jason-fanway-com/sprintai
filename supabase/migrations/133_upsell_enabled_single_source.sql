-- 133_upsell_enabled_single_source.sql
--
-- chat-sms/index.ts:1266 already reads shopSettings?.upsell_enabled ?? true
-- in buildSystemPromptV2 (live for all shops — every shop is on
-- prompt_version=1), but shop_settings.upsell_enabled has never had an
-- owner-facing writer: admin-chat has no SET_UPSELL_ENABLED op and
-- OwnerSettingsPanel has no control for it. It was set once at row
-- creation (migration 124's default) and has been frozen ever since.
--
-- This follows the same pattern migrations 130/131 established for
-- delivery_enabled/open_hours/delivery_radius_mi: shops is the single
-- writable home the owner console and admin-chat touch, shop_settings is a
-- trigger-derived projection with no independent write path (already
-- enforced by migration 124's `REVOKE ALL ON shop_settings FROM anon,
-- authenticated`). Do not add a second writer for shop_settings.upsell_enabled
-- anywhere — extend this trigger if another fact needs the same treatment.

alter table shops add column if not exists upsell_enabled boolean not null default true;

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

  insert into shop_settings (shop_id, hours_line, fulfilment_modes, delivery_radius_miles, upsell_enabled)
  values (
    new.id,
    v_hours_line,
    case when coalesce(new.delivery_enabled, false) then array['pickup','delivery'] else array['pickup'] end,
    new.delivery_radius_mi,
    new.upsell_enabled
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
    upsell_enabled = excluded.upsell_enabled,
    updated_at = now();

  return new;
end;
$function$;

drop trigger if exists trg_sync_shop_settings_from_shop on shops;
create trigger trg_sync_shop_settings_from_shop
after update of delivery_enabled, open_hours, delivery_paused_until, delivery_pause_reason, delivery_radius_mi, upsell_enabled
on shops
for each row
execute function sync_shop_settings_from_shop();

-- Backfill: shops.upsell_enabled defaults true, matching chat-sms's existing
-- `?? true` fallback, so this is a true no-op for current bot behavior — it
-- just makes the two columns agree by design going forward instead of by
-- coincidence of matching defaults.
update shop_settings ss
set upsell_enabled = s.upsell_enabled,
    updated_at = now()
from shops s
where s.id = ss.shop_id
  and ss.upsell_enabled is distinct from s.upsell_enabled;
