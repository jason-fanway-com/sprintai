import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Store, UtensilsCrossed, Settings, MessageSquare } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useRole } from '../lib/RoleContext'
import { useView } from '../lib/ViewContext'
import MenuBulkEditor, { type MenuItemRow, type OptionGroupWithChoices } from '../components/shop/MenuBulkEditor'
import OwnerSettingsPanel, { type OwnerShopSettings } from '../components/shop/OwnerSettingsPanel'
import ConversationalAdminChat from '../components/shop/ConversationalAdminChat'

/**
 * Owner-facing Menu & Settings editor.
 *
 * Same frame as ShopOwnerDemoKit: scopes to the signed-in owner's shop, or — for a
 * super-admin in owner-preview mode — the shop they picked in the "View as" selector.
 * There is no separate admin-only version of this screen.
 *
 * The chat panel on the right calls the exact same admin-chat operations registry the
 * structured list below calls (see lib/shopOps.ts) — both are parsers over one apply().
 * Any executed chat action invalidates the same queries this page renders from, so a
 * change made by typing "add hot, mild and BBQ to wings" appears in the list immediately.
 */

type Tab = 'menu' | 'settings'

interface ShopRow {
  id: string
  name: string
  slug: string
  tenant_id: string
}

export default function ShopOwnerMenuSettings() {
  const { tenantId, isShopOwner, isSuperAdmin } = useRole()
  const { mode, previewTenantId, setMode, setPreview } = useView()
  const [searchParams] = useSearchParams()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('menu')
  const [showChat, setShowChat] = useState(false)

  const previewing = isSuperAdmin && mode === 'owner'
  const effTenant = previewing ? previewTenantId : tenantId
  const asOwner = isShopOwner || previewing

  useEffect(() => {
    if (isSuperAdmin && mode !== 'owner') setMode('owner')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin])

  const { data: shops } = useQuery<ShopRow[]>({
    queryKey: ['menu-settings-shops', effTenant],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shops')
        .select('id, name, slug, tenant_id')
        .eq('tenant_id', effTenant!)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data ?? []
    },
    enabled: !!effTenant && asOwner,
  })

  const [shopId, setShopId] = useState<string | null>(null)
  const shop = useMemo(() => {
    if (!shops || shops.length === 0) return null
    return shops.find(s => s.id === shopId) ?? shops[0]
  }, [shops, shopId])

  useEffect(() => {
    const shopParam = searchParams.get('shop')
    if (!shopParam) return
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shopParam)
    if (isUuid) setShopId(shopParam)
    supabase.from('shops').select('id, tenant_id, name')
      .eq(isUuid ? 'id' : 'slug', shopParam).single()
      .then(({ data, error }) => {
        if (error || !data) return
        setShopId(data.id)
        if (isSuperAdmin) {
          setPreview(data.tenant_id, data.name ?? null)
          if (mode !== 'owner') setMode('owner')
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, isSuperAdmin])

  const activeShopId = shop?.id ?? null

  // ── Menu + options (bulk-friendly single list; needs-answers and low-confidence
  // items surface via the same rows, not a second screen) ──────────────────────────
  const { data: menuId } = useQuery<string | null>({
    queryKey: ['menu-settings-menu-id', activeShopId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('menus').select('id').eq('shop_id', activeShopId!)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (error) throw error
      return data?.id ?? null
    },
    enabled: !!activeShopId,
  })

  const { data: menuItems, isLoading: itemsLoading } = useQuery<MenuItemRow[]>({
    queryKey: ['menu-settings-items', menuId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('menu_items')
        .select('id, name, price_cents, description, category, active, prompt_for, flag_review, flag_reason, display_order')
        .eq('menu_id', menuId!)
        .order('display_order', { ascending: true })
      if (error) throw error
      return data ?? []
    },
    enabled: !!menuId,
  })

  const itemIds = useMemo(() => (menuItems ?? []).map(i => i.id), [menuItems])

  const { data: optionGroupsByItem } = useQuery<Record<string, OptionGroupWithChoices[]>>({
    queryKey: ['menu-settings-options', menuId, itemIds.join(',')],
    queryFn: async () => {
      if (itemIds.length === 0) return {}
      const { data: groups, error: gErr } = await supabase
        .from('option_groups')
        .select('id, menu_item_id, name, required, min_select, max_select')
        .in('menu_item_id', itemIds)
        .order('display_order', { ascending: true })
      if (gErr) throw gErr
      const groupIds = (groups ?? []).map(g => g.id)
      let choices: { id: string; option_group_id: string; name: string; price_cents: number }[] = []
      if (groupIds.length > 0) {
        const { data: choiceRows, error: cErr } = await supabase
          .from('option_choices')
          .select('id, option_group_id, name, price_cents')
          .in('option_group_id', groupIds)
          .order('display_order', { ascending: true })
        if (cErr) throw cErr
        choices = choiceRows ?? []
      }
      const byGroup: Record<string, typeof choices> = {}
      for (const c of choices) byGroup[c.option_group_id] = [...(byGroup[c.option_group_id] ?? []), c]
      const byItem: Record<string, OptionGroupWithChoices[]> = {}
      for (const g of groups ?? []) {
        byItem[g.menu_item_id] = [...(byItem[g.menu_item_id] ?? []), { ...g, choices: byGroup[g.id] ?? [] }]
      }
      return byItem
    },
    enabled: !!menuId,
  })

  // ── Shop settings (hours, delivery, instructions, wing policy) ───────────────────
  const { data: shopSettings } = useQuery<(OwnerShopSettings & { timezone?: string | null }) | null>({
    queryKey: ['menu-settings-shop-config', activeShopId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shops')
        .select('id, name, timezone, open_hours, delivery_hours, delivery_enabled, ai_instructions, wing_flavors_included, wing_mix_extra')
        .eq('id', activeShopId!).single()
      if (error) throw error
      return data
    },
    enabled: !!activeShopId,
  })

  // ── Today's 86 list — same-day sold-out marks, so the list can offer a quick
  // "86 tonight" / "un-86" toggle without a second screen ───────────────────────────
  const businessDate = useMemo(() => {
    const tz = shopSettings?.timezone || 'America/New_York'
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    } catch {
      return new Date().toISOString().slice(0, 10)
    }
  }, [shopSettings?.timezone])

  const { data: eightySixedIds } = useQuery<Set<string>>({
    queryKey: ['menu-settings-86', activeShopId, businessDate],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('availability_overrides')
        .select('menu_item_id')
        .eq('shop_id', activeShopId!)
        .eq('business_date', businessDate)
      if (error) throw error
      return new Set((data ?? []).map(r => r.menu_item_id as string))
    },
    enabled: !!activeShopId,
  })

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['menu-settings-items', menuId] })
    qc.invalidateQueries({ queryKey: ['menu-settings-options'] })
    qc.invalidateQueries({ queryKey: ['menu-settings-shop-config', activeShopId] })
    qc.invalidateQueries({ queryKey: ['menu-settings-86', activeShopId] })
  }

  if (!asOwner) {
    return <div className="p-8 flex justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
  }
  if (previewing && !effTenant) {
    return (
      <div className="p-8 text-center py-16 text-gray-400">
        <Store className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="font-medium">Owner preview</p>
        <p className="text-sm mt-1">Pick a shop in the “View as” selector above.</p>
      </div>
    )
  }
  if (shops && shops.length === 0) {
    return (
      <div className="p-8 text-center py-16 text-gray-400">
        <Store className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="font-medium">No shop assigned</p>
      </div>
    )
  }
  if (!shop) {
    return <div className="p-8 flex justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
  }

  return (
    <div className="flex flex-col lg:flex-row h-full min-h-0">
      <div className="flex-1 min-w-0 overflow-y-auto p-4 md:p-6 space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Menu &amp; Settings</h1>
            <div className="flex items-center gap-2 text-sm text-gray-400 mt-0.5">
              {shops && shops.length > 1 ? (
                <select
                  value={shop.id}
                  onChange={e => setShopId(e.target.value)}
                  className="bg-transparent border border-gray-200 rounded-md px-2 py-0.5 text-sm text-gray-600"
                >
                  {shops.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              ) : (
                <span>{shop.name}</span>
              )}
            </div>
          </div>
          <button
            onClick={() => setShowChat(s => !s)}
            className="lg:hidden flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            <MessageSquare className="w-4 h-4" />
            {showChat ? 'Hide chat' : 'Talk to your menu'}
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setTab('menu')}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === 'menu' ? 'border-brand-600 text-brand-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <UtensilsCrossed className="w-4 h-4" />
            Menu
          </button>
          <button
            onClick={() => setTab('settings')}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === 'settings' ? 'border-brand-600 text-brand-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Settings className="w-4 h-4" />
            Settings
          </button>
        </div>

        {tab === 'menu' ? (
          <MenuBulkEditor
            shopId={shop.id}
            items={menuItems ?? []}
            isLoading={itemsLoading}
            optionGroupsByItem={optionGroupsByItem ?? {}}
            eightySixedIds={eightySixedIds ?? new Set()}
            onSaved={invalidateAll}
          />
        ) : (
          <OwnerSettingsPanel
            shopId={shop.id}
            settings={shopSettings ?? null}
            onSaved={invalidateAll}
          />
        )}
      </div>

      {/* Chat panel — same admin-chat operations registry as the form above */}
      <div className={`lg:w-[380px] lg:flex-shrink-0 lg:flex lg:flex-col border-t lg:border-t-0 lg:border-l border-gray-200 overflow-hidden ${showChat ? 'flex flex-col' : 'hidden lg:flex'}`} style={{ minHeight: showChat ? 420 : undefined }}>
        <ConversationalAdminChatWithInvalidate shopId={shop.id} onExecuted={invalidateAll} />
      </div>
    </div>
  )
}

// Thin wrapper: invalidate the structured list's queries whenever the chat executes a
// write, so a chat-issued change ("add hot, mild and BBQ to wings") appears in the list
// on this same screen with no manual refresh. ConversationalAdminChat itself has no
// opinion on what a shop's other panels render, so the invalidation lives here.
function ConversationalAdminChatWithInvalidate({ shopId, onExecuted }: { shopId: string; onExecuted: () => void }) {
  useEffect(() => {
    const handler = () => onExecuted()
    window.addEventListener('sprintai:admin-chat-executed', handler)
    return () => window.removeEventListener('sprintai:admin-chat-executed', handler)
  }, [onExecuted])
  return <ConversationalAdminChat shopId={shopId} />
}
