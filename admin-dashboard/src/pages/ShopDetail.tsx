import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, UtensilsCrossed, ShoppingBag, Settings } from 'lucide-react'
import { supabase, supabaseAnonKey } from '../lib/supabase'
import ShopHeader from '../components/shop/ShopHeader'
import MenuTab from '../components/shop/MenuTab'
import OrdersTab from '../components/shop/OrdersTab'
import SettingsTab from '../components/shop/SettingsTab'
import ChatAdminTab from '../components/shop/ChatAdminTab'

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
}

interface MenuItem {
  id: string
  name: string
  price_cents: number
  category: string
  description: string | null
  active: boolean
  modifiers_json: Array<{ name: string; price_cents: number }> | null
}

interface OrderCart {
  id: string
  phase: string
  total_cents: number | null
  created_at: string
  cart_json: Array<{ name: string; quantity: number; price_cents: number }>
  pickup_name: string | null
}

type Tab = 'menu' | 'orders' | 'settings' | 'chat'

export default function ShopDetail() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState<Tab>('chat')
  const [editingShop, setEditingShop] = useState(false)
  const [shopForm, setShopForm] = useState<Partial<Shop>>({})
  const [isScraping, setIsScraping] = useState(false)
  const [scrapeError, setScrapeError] = useState<string | null>(null)
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

  const today = new Date().toISOString().split('T')[0]

  const { data: shop, isLoading } = useQuery<Shop>({
    queryKey: ['shop', id],
    queryFn: async () => {
      const { data, error } = await supabase.from('shops').select('*').eq('id', id!).single()
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

  const togglePause = useMutation({
    mutationFn: async (pause: boolean) => {
      await supabase.from('shops').update({ is_paused: pause }).eq('id', id!)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shop', id] }),
  })

  const saveShop = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('shops').update({
        name: shopForm.name,
        email_ticket_recipient: shopForm.email_ticket_recipient,
        pause_message: shopForm.pause_message,
        timezone: shopForm.timezone,
      }).eq('id', id!)
      if (error) throw error
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shop', id] }); setEditingShop(false) },
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
    },
  })

  const editMenuItem = useMutation({
    mutationFn: async ({ itemId, form }: { itemId: string; form: typeof editItemForm }) => {
      const priceCents = Math.round(parseFloat(form.price_cents_str) * 100)
      const { error } = await supabase.from('menu_items').update({
        name: form.name,
        price_cents: isNaN(priceCents) ? 0 : priceCents,
        description: form.description || null,
        category: form.category,
      }).eq('id', itemId)
      if (error) throw error
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['menu-items', id] }); setEditingItemId(null) },
  })

  const deleteMenuItem = useMutation({
    mutationFn: async (itemId: string) => {
      const { error } = await supabase.from('menu_items').delete().eq('id', itemId)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu-items', id] }),
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
  })

  const scrapeFromChatTab = async () => {
    if (!id) return
    setIsScraping(true)
    setScrapeError(null)
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
        body: JSON.stringify({ shop_id: id }),
      })
      const result = await res.json()
      if (result.ok) {
        if (result.context) setContextDraft(result.context)
        qc.invalidateQueries({ queryKey: ['shop', id] })
      } else {
        setScrapeError(result.error ?? 'Scraping failed')
      }
    } catch (err) {
      setScrapeError((err as Error).message)
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
        setUploadStatus(`Parsed ${result.items_parsed} items successfully`)
        setTimeout(() => setUploadStatus(''), 8000)
      } else {
        setUploadStatus(`Upload failed: ${result.error ?? 'Unknown error'}`)
      }
    } catch (err) {
      setUploadStatus(`Upload failed: ${(err as Error).message}`)
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
  ]

  return (
    <div className={activeTab === 'chat' ? 'flex flex-col h-screen overflow-hidden' : 'p-8 max-w-5xl mx-auto'}>
      {/* Header */}
      <div className={`flex items-center gap-4 flex-shrink-0 ${activeTab === 'chat' ? 'px-8 pt-8 pb-0' : 'mb-6'}`}>
        <ShopHeader shop={shop} togglePause={togglePause} />
      </div>

      {/* Tabs */}
      <div className={`flex gap-1 border-b border-gray-200 flex-shrink-0 ${activeTab === 'chat' ? 'mx-8 mt-6' : 'mb-6'}`}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
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
        />
      )}

      {activeTab === 'orders' && <OrdersTab orders={orders} />}

      {activeTab === 'settings' && (
        <SettingsTab
          shop={shop}
          editingShop={editingShop}
          shopForm={shopForm}
          onEditChange={setEditingShop}
          onFormChange={(field, value) => setShopForm(prev => ({ ...prev, [field]: value }))}
          onFormReset={() => setShopForm(shop)}
          onSave={saveShop}
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
          scrapeError={scrapeError}
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
        />
      )}
    </div>
  )
}
