import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, UtensilsCrossed, ShoppingBag, Settings, Gift, DollarSign } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase, supabaseAnonKey } from '../lib/supabase'
import ShopHeader from '../components/shop/ShopHeader'
import MenuTab from '../components/shop/MenuTab'
import OrdersTab from '../components/shop/OrdersTab'
import SettingsTab from '../components/shop/SettingsTab'
import ChatAdminTab from '../components/shop/ChatAdminTab'
import QRCodesTab from '../components/shop/QRCodesTab'

interface Shop {
  id: string
  name: string
  slug: string
  phone_number_e164: string | null
  timezone: string
  email_ticket_recipient: string | null
  is_paused: boolean
  pause_message: string | null
  open_hours: Record<string, Array<{ open: string; close: string }>>
  website_url: string | null
  shop_context: string | null
  ai_instructions: string | null
  toast_client_id: string | null
  has_toast_secret: boolean
  toast_location_guid: string | null
  has_merchant_pin: boolean
  latitude: number | null
  longitude: number | null
  delivery_radius_mi: number | null
}

interface MenuItem {
  id: string
  name: string
  price_cents: number
  category: string
  description: string | null
  active: boolean
  modifiers_json: Array<{ name: string; price_cents: number }> | null
  flag_review?: boolean | null
  flag_reason?: string | null
}

interface OrderCart {
  id: string
  phase: string
  total_cents: number | null
  created_at: string
  cart_json: Array<{ name: string; quantity: number; price_cents: number }>
  pickup_name: string | null
  order_number: number | null
}

type Tab = 'menu' | 'orders' | 'settings' | 'chat' | 'qr'

// Every `shops` column except toast_client_secret, merchant_pin, and
// onboarding_token — their real values must never reach the browser.
// has_toast_secret / has_merchant_pin (generated columns) tell the UI
// whether one is configured without exposing what it is. onboarding_token
// (resume-link auth) isn't rendered or edited anywhere in this UI, so it's
// simply excluded rather than replaced with a presence flag nobody needs.
const SHOP_SELECT_COLUMNS = 'id, tenant_id, name, slug, phone_number_e164, twilio_number_sid, open_hours, timezone, email_ticket_recipient, stripe_connect_account_id, is_paused, pause_message, created_at, updated_at, shop_context, website_url, ai_instructions, toast_client_id, toast_location_guid, stripe_connected_account_id, stripe_platform_customer_id, connect_account_type, charges_enabled, payouts_enabled, connect_requirements_due, connect_status, onboarding_step, display_name, reply_from_e164, tax_rate_bps, cash_discount_mode, catering_mode, wing_flavors_included, wing_mix_extra, subscription_status, subscription_pm_set, stripe_subscription_id, optin_language, stop_help_wording, delivery_enabled, delivery_paused_until, delivery_pause_reason, delivery_fee_cents, protected, owner_name, ein, is_test, about, menu_links, crawl_status, crawl_error, delivery_hours, google_place_id, formatted_address, google_rating, google_review_count, business_status, latitude, longitude, delivery_radius_mi, telnyx_number_id, telnyx_messaging_profile_id, campaign_assignment_status, campaign_assignment_checked_at, campaign_id, welcome_email_status, welcome_email_error, welcome_email_last_attempt_at, founding_promo, onboarding_complete, onboarding_complete_at, first_delivery_test_passed_at, first_delivery_test_recorded_by, owner_mobile, ticket_destination_type, ticket_destination_detail, compiled_ordering_engine_enabled, menu_extraction_incomplete, menu_extraction_note, customer_personalization_enabled, sms_provider, prompt_version, upsell_enabled, turn_engine_enabled, has_toast_secret, has_merchant_pin'

export default function ShopDetail() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState<Tab>('chat')
  const [editingShop, setEditingShop] = useState(false)
  const [shopForm, setShopForm] = useState<Partial<Shop>>({})
  const [isScraping, setIsScraping] = useState(false)
  const [editingContext, setEditingContext] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const [contextDraft, setContextDraft] = useState('')
  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState('')
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null)
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editItemForm, setEditItemForm] = useState({ name: '', price_cents_str: '', description: '', category: '' })
  const [addingToCategory, setAddingToCategory] = useState<string | null>(null)
  const [addItemForm, setAddItemForm] = useState({ name: '', price_cents_str: '', description: '' })
  const [addItemCategory, setAddItemCategory] = useState('')
  const [chatDirty, setChatDirty] = useState(false)
  const [toastSecretDraft, setToastSecretDraft] = useState('')
  const [merchantPinDraft, setMerchantPinDraft] = useState('')

  const today = new Date().toISOString().split('T')[0]

  const { data: shop, isLoading } = useQuery<Shop>({
    queryKey: ['shop', id],
    queryFn: async () => {
      const { data, error } = await supabase.from('shops').select(SHOP_SELECT_COLUMNS).eq('id', id!).single()
      if (error) throw error
      setShopForm(data)
      return data
    },
    enabled: !!id,
  })

  // Sync chat-tab drafts when shop first loads
  useEffect(() => {
    if (shop) {
      setUrlDraft(prev => prev || (shop.website_url ?? ''))
      setContextDraft(prev => prev || (shop.shop_context ?? ''))
      setInstructionsDraft(prev => prev || (shop.ai_instructions ?? ''))
    }
  }, [shop?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: menuItems } = useQuery<MenuItem[]>({
    queryKey: ['menu-items', id],
    queryFn: async () => {
      const { data: menus } = await supabase.from('menus').select('id').eq('shop_id', id!).order('created_at', { ascending: false }).limit(1)
      if (!menus?.length) { setActiveMenuId(null); return [] }
      setActiveMenuId(menus[0].id)
      const { data, error } = await supabase.from('menu_items').select('*').eq('menu_id', menus[0].id).eq('active', true).order('display_order', { ascending: true })
      if (error) throw error
      return data ?? []
    },
    enabled: !!id,
  })

  const { data: soldOutIds } = useQuery<Set<string>>({
    queryKey: ['availability', id, today],
    queryFn: async () => {
      const { data } = await supabase.from('availability_overrides').select('menu_item_id').eq('shop_id', id!).eq('business_date', today)
      return new Set((data ?? []).map((r: { menu_item_id: string }) => r.menu_item_id))
    },
    enabled: !!id,
  })

  const { data: orders } = useQuery<OrderCart[]>({
    queryKey: ['orders', id],
    queryFn: async () => {
      const { data, error } = await supabase.from('order_carts').select('*').eq('shop_id', id!).eq('phase', 'confirmed').order('created_at', { ascending: false }).limit(50)
      if (error) throw error
      return data ?? []
    },
    enabled: !!id && activeTab === 'orders',
  })

  const toggleSoldOut = useMutation({
    mutationFn: async ({ menuItemId, currentlySoldOut }: { menuItemId: string; currentlySoldOut: boolean }) => {
      if (currentlySoldOut) {
        await supabase.from('availability_overrides').delete().eq('shop_id', id!).eq('menu_item_id', menuItemId).eq('business_date', today)
      } else {
        await supabase.from('availability_overrides').insert({ shop_id: id!, menu_item_id: menuItemId, business_date: today, source: 'admin' })
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['availability', id, today] }),
  })

  const resetAll = useMutation({
    mutationFn: async () => {
      await supabase.from('availability_overrides').delete().eq('shop_id', id!).eq('business_date', today)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['availability', id, today] }),
  })

  // Item F: owner confirms a flagged item → clear the flag so it moves to the confident set
  const clearFlag = useMutation({
    mutationFn: async ({ menuItemId }: { menuItemId: string }) => {
      const { error } = await supabase.from('menu_items').update({ flag_review: false, flag_reason: null }).eq('id', menuItemId)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu-items', id] }),
    onError: (err) => toast.error((err as Error).message),
  })

  const togglePause = useMutation({
    mutationFn: async (pause: boolean) => {
      await supabase.from('shops').update({ is_paused: pause }).eq('id', id!)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shop', id] }),
  })

  const saveShop = useMutation({
    mutationFn: async () => {
      const updates: Record<string, unknown> = {
        name: shopForm.name,
        email_ticket_recipient: shopForm.email_ticket_recipient,
        pause_message: shopForm.pause_message,
        timezone: shopForm.timezone,
        phone_number_e164: shopForm.phone_number_e164 ?? null,
        toast_client_id: shopForm.toast_client_id ?? null,
        toast_location_guid: shopForm.toast_location_guid ?? null,
        delivery_radius_mi: shopForm.delivery_radius_mi ?? null,
      }
      // toastSecretDraft only ever holds a newly-typed value — the real
      // stored secret is never loaded into the browser to round-trip here.
      // Leaving it blank must not clear an existing secret.
      if (toastSecretDraft.trim() !== '') {
        updates.toast_client_secret = toastSecretDraft.trim()
      }
      // Same write-only handling as the Toast secret: merchantPinDraft only
      // ever holds a newly-typed PIN, and leaving it blank must not clear
      // an existing one.
      if (merchantPinDraft.trim() !== '') {
        updates.merchant_pin = merchantPinDraft.trim()
      }
      const { error } = await supabase.from('shops').update(updates).eq('id', id!)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shop', id] })
      setEditingShop(false)
      setToastSecretDraft('')
      setMerchantPinDraft('')
      toast.success('Settings saved')
    },
    onError: (err) => toast.error((err as Error).message),
  })

  const saveChatContext = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('shops').update({
        website_url: urlDraft || null,
        shop_context: contextDraft,
        ai_instructions: instructionsDraft || null,
      }).eq('id', id!)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shop', id] })
      setEditingContext(false)
      toast.success('Saved')
    },
    onError: (err) => toast.error((err as Error).message),
  })

  const editMenuItem = useMutation({
    mutationFn: async ({ itemId, form }: { itemId: string; form: typeof editItemForm }) => {
      const priceCents = Math.round(parseFloat(form.price_cents_str) * 100)
      const { error } = await supabase.rpc('owner_update_menu_item', {
        p_item_id: itemId,
        p_fields: {
          name: form.name,
          price_cents: isNaN(priceCents) ? 0 : priceCents,
          description: form.description || null,
          category: form.category,
        },
      })
      if (error) throw error
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['menu-items', id] }); setEditingItemId(null) },
    onError: (err) => toast.error((err as Error).message),
  })

  const deleteMenuItem = useMutation({
    mutationFn: async (itemId: string) => {
      const { error } = await supabase.rpc('owner_delete_menu_item', { p_item_id: itemId })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu-items', id] }),
    onError: (err) => toast.error((err as Error).message),
  })

  const addMenuItem = useMutation({
    mutationFn: async ({ category, form }: { category: string; form: typeof addItemForm }) => {
      if (!activeMenuId) throw new Error('No active menu - upload a PDF first')
      const priceCents = Math.round(parseFloat(form.price_cents_str) * 100)
      const { error } = await supabase.from('menu_items').insert({
        menu_id: activeMenuId,
        name: form.name,
        price_cents: isNaN(priceCents) ? 0 : priceCents,
        description: form.description || null,
        category,
        active: true,
        display_order: 9999,
      })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu-items', id] })
      setAddingToCategory(null)
      setAddItemCategory('')
      setAddItemForm({ name: '', price_cents_str: '', description: '' })
    },
    onError: (err) => toast.error((err as Error).message),
  })

  const scrapeFromChatTab = async () => {
    if (!id) return
    setIsScraping(true)
    try {
      if (urlDraft !== (shop?.website_url ?? '')) {
        const { error } = await supabase.from('shops').update({ website_url: urlDraft || null }).eq('id', id)
        if (error) throw error
      }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scrape-shop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseAnonKey}`,
        },
        body: JSON.stringify({ shop_id: id, force: true }),
      })
      const result = await res.json()
      if (result.ok) {
        if (result.context) setContextDraft(result.context)
        qc.invalidateQueries({ queryKey: ['shop', id] })
        // "partial" means the site read fine but no menu with prices was found. Reporting
        // that as an unqualified success is the false-green this whole fix exists to kill.
        if (result.crawl_status === 'partial') {
          // react-hot-toast has no .warning — use the base call with an icon.
          toast(`Read ${result.pages_scraped ?? 0} pages, but found no menu with prices — the menu needs to be added another way.`, { icon: '⚠️', duration: 6000 })
        } else {
          toast.success(`Website scraped — ${result.pages_scraped ?? ''} pages`)
        }
      } else {
        toast.error(result.error ?? 'Scraping failed')
      }
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setIsScraping(false)
    }
  }

  const uploadPdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !id) return
    setIsUploading(true)
    setUploadStatus(`Parsing ${file.name} with AI... this takes 30-60 seconds`)
    const form = new FormData()
    form.append('file', file)
    form.append('shop_id', id)
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-menu-pdf`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${supabaseAnonKey}` },
        body: form,
      })
      const result = await res.json()
      if (result.ok) {
        qc.invalidateQueries({ queryKey: ['menu-items', id] })
        toast.success(`Parsed ${result.items_parsed} items`)
        setUploadStatus('')
      } else {
        toast.error(result.error ?? 'Unknown error')
      }
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setIsUploading(false)
      e.target.value = ''
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    )
  }

  if (!shop) return <div className="p-8 text-gray-500">Shop not found.</div>

  const tabs: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
    { id: 'chat', label: 'Chat Admin', icon: MessageSquare },
    { id: 'menu', label: 'Menu', icon: UtensilsCrossed },
    { id: 'orders', label: 'Orders', icon: ShoppingBag },
    { id: 'settings', label: 'Settings', icon: Settings },
    { id: 'qr', label: 'Demo Kit', icon: Gift },
  ]

  return (
    <div className={activeTab === 'chat' ? 'flex flex-col h-full overflow-hidden' : 'p-4 sm:p-8 max-w-5xl mx-auto'}>
      {/* Header */}
      <div className={`flex items-center gap-4 flex-shrink-0 ${activeTab === 'chat' ? 'px-4 sm:px-8 pt-4 sm:pt-8 pb-0' : 'mb-6'}`}>
        <ShopHeader shop={shop} togglePause={togglePause} />
      </div>

      {/* Tabs */}
      <div className={`flex gap-1 border-b border-gray-200 flex-shrink-0 ${activeTab === 'chat' ? 'mx-4 sm:mx-8 mt-4 sm:mt-6' : 'mb-6 overflow-x-auto'} `}>
        <Link
          to={`/shop/${id}/financials`}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px border-transparent text-gray-500 hover:text-gray-700"
        >
          <DollarSign className="w-4 h-4" />
          Financials
        </Link>
        <Link
          to={`/shop/${id}/expo`}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px border-transparent text-gray-500 hover:text-gray-700"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="text-sm">📺</span>
          Expo Screen
        </Link>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => {
              if (activeTab === 'chat' && chatDirty && tab.id !== 'chat') {
                if (!window.confirm('You have unsaved changes. Discard?')) return
                setChatDirty(false)
              }
              setActiveTab(tab.id)
            }}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === tab.id
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'menu' && (
        <MenuTab
          menuItems={menuItems}
          soldOutIds={soldOutIds}
          isUploading={isUploading}
          uploadStatus={uploadStatus}
          onUploadPdf={uploadPdf}
          onToggleSoldOut={toggleSoldOut}
          onResetAll={resetAll}
          onClearFlag={clearFlag}
        />
      )}

      {activeTab === 'orders' && <OrdersTab orders={orders} />}

      {activeTab === 'qr' && <QRCodesTab shop={shop} />}

      {activeTab === 'settings' && (
        <SettingsTab
          shop={shop}
          editingShop={editingShop}
          shopForm={shopForm}
          onEditChange={setEditingShop}
          onFormChange={(field, value) => setShopForm(prev => ({ ...prev, [field]: value }))}
          onFormReset={() => { setShopForm(shop); setToastSecretDraft(''); setMerchantPinDraft('') }}
          onSave={saveShop}
          toastSecretDraft={toastSecretDraft}
          onToastSecretDraftChange={setToastSecretDraft}
          merchantPinDraft={merchantPinDraft}
          onMerchantPinDraftChange={setMerchantPinDraft}
        />
      )}

      {activeTab === 'chat' && (
        <ChatAdminTab
          shopId={shop.id}
          shopName={shop.name}
          shop={shop}
          menuItems={menuItems}
          soldOutIds={soldOutIds}
          activeMenuId={activeMenuId}
          urlDraft={urlDraft}
          contextDraft={contextDraft}
          instructionsDraft={instructionsDraft}
          editingContext={editingContext}
          isScraping={isScraping}
          isUploading={isUploading}
          uploadStatus={uploadStatus}
          editingItemId={editingItemId}
          editItemForm={editItemForm}
          addingToCategory={addingToCategory}
          addItemForm={addItemForm}
          addItemCategory={addItemCategory}
          onUrlDraftChange={setUrlDraft}
          onContextDraftChange={setContextDraft}
          onInstructionsDraftChange={setInstructionsDraft}
          onEditingContextChange={setEditingContext}
          onUploadPdf={uploadPdf}
          onScrapeFromChatTab={scrapeFromChatTab}
          onSaveChatContext={() => saveChatContext.mutate()}
          onEditItemIdChange={setEditingItemId}
          onEditItemFormChange={setEditItemForm}
          onDeleteMenuItem={deleteMenuItem}
          onEditMenuItem={editMenuItem}
          onAddMenuItem={addMenuItem}
          onAddingToCategoryChange={setAddingToCategory}
          onAddItemFormChange={setAddItemForm}
          onAddItemCategoryChange={setAddItemCategory}
          saveChatContext={saveChatContext}
          onDirtyChange={setChatDirty}
        />
      )}
    </div>
  )
}
