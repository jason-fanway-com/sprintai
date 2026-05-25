import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Save, Upload, ToggleLeft, ToggleRight, ShoppingBag, Settings, UtensilsCrossed, Pause, Play, Globe, MessageSquare, Pencil, Trash2, Plus } from 'lucide-react'
import { supabase, supabaseAnonKey } from '../lib/supabase'
import ShopChatTest from '../components/ShopChatTest'

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
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [activeTab, setActiveTab]     = useState<Tab>('chat')
  const [editingShop, setEditingShop] = useState(false)
  const [shopForm, setShopForm]       = useState<Partial<Shop>>({})
  const [isScraping, setIsScraping]   = useState(false)
  const [scrapeError, setScrapeError] = useState<string | null>(null)
  const [editingContext, setEditingContext] = useState(false)
  const [contextForm, setContextForm] = useState('')

  // Chat tab left-panel state
  const [urlDraft, setUrlDraft]           = useState('')
  const [contextDraft, setContextDraft]   = useState('')
  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [savingInstructions, setSavingInstructions] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState('')
  const [activeMenuId, setActiveMenuId]   = useState<string | null>(null)

  // Menu item CRUD state
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editItemForm, setEditItemForm]   = useState({ name: '', price_cents_str: '', description: '', category: '' })
  const [addingToCategory, setAddingToCategory] = useState<string | null>(null)
  const [addItemForm, setAddItemForm]     = useState({ name: '', price_cents_str: '', description: '' })
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

  // Sync chat-tab drafts when shop first loads (do not overwrite edits in progress)
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
        name:                   shopForm.name,
        email_ticket_recipient: shopForm.email_ticket_recipient,
        pause_message:          shopForm.pause_message,
        timezone:               shopForm.timezone,
        website_url:            shopForm.website_url ?? null,
      }).eq('id', id!)
      if (error) throw error
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shop', id] }); setEditingShop(false) },
  })

  const saveContext = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('shops').update({ shop_context: contextForm }).eq('id', id!)
      if (error) throw error
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shop', id] }); setEditingContext(false) },
  })

  // Chat tab: save URL + context together
  const saveChatContext = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('shops').update({
        website_url:  urlDraft || null,
        shop_context: contextDraft,
      }).eq('id', id!)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shop', id] }),
  })

  // Chat tab: edit a menu item
  const editMenuItem = useMutation({
    mutationFn: async ({ itemId, form }: { itemId: string; form: typeof editItemForm }) => {
      const priceCents = Math.round(parseFloat(form.price_cents_str) * 100)
      const { error } = await supabase.from('menu_items').update({
        name:        form.name,
        price_cents: isNaN(priceCents) ? 0 : priceCents,
        description: form.description || null,
        category:    form.category,
      }).eq('id', itemId)
      if (error) throw error
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['menu-items', id] }); setEditingItemId(null) },
  })

  // Chat tab: delete a menu item
  const deleteMenuItem = useMutation({
    mutationFn: async (itemId: string) => {
      const { error } = await supabase.from('menu_items').delete().eq('id', itemId)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu-items', id] }),
  })

  // Chat tab: add a menu item
  const addMenuItem = useMutation({
    mutationFn: async ({ category, form }: { category: string; form: typeof addItemForm }) => {
      if (!activeMenuId) throw new Error('No active menu - upload a PDF first')
      const priceCents = Math.round(parseFloat(form.price_cents_str) * 100)
      const { error } = await supabase.from('menu_items').insert({
        menu_id:     activeMenuId,
        name:        form.name,
        price_cents: isNaN(priceCents) ? 0 : priceCents,
        description: form.description || null,
        category,
        active:        true,
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

  const scrapeWebsite = async () => {
    if (!id) return
    setIsScraping(true)
    setScrapeError(null)
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scrape-shop`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${supabaseAnonKey}`,
        },
        body: JSON.stringify({ shop_id: id }),
      })
      const result = await res.json()
      if (result.ok) {
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

  // Chat tab scrape: saves urlDraft first, then scrapes, then updates contextDraft
  const scrapeFromChatTab = async () => {
    if (!id) return
    setIsScraping(true)
    setScrapeError(null)
    try {
      // Persist the URL if it changed
      if (urlDraft !== (shop?.website_url ?? '')) {
        const { error } = await supabase.from('shops').update({ website_url: urlDraft || null }).eq('id', id)
        if (error) throw error
      }

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scrape-shop`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
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

  const categoryGroups = (menuItems ?? []).reduce<Record<string, MenuItem[]>>((acc, item) => {
    const cat = item.category ?? 'Other'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(item)
    return acc
  }, {})

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
        <button onClick={() => navigate('/shops')} className="text-gray-400 hover:text-gray-600 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900">{shop.name}</h1>
          <p className="text-sm text-gray-400">{shop.slug} &middot; {shop.phone_number_e164 ?? 'No phone'}</p>
        </div>
        <button
          onClick={() => togglePause.mutate(!shop.is_paused)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            shop.is_paused
              ? 'bg-green-100 text-green-700 hover:bg-green-200'
              : 'bg-orange-100 text-orange-700 hover:bg-orange-200'
          }`}
        >
          {shop.is_paused ? <><Play className="w-4 h-4" /> Resume Orders</> : <><Pause className="w-4 h-4" /> Pause Orders</>}
        </button>
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

      {/* Menu tab */}
      {activeTab === 'menu' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-gray-500">
              {(soldOutIds?.size ?? 0) > 0
                ? `${soldOutIds?.size} item(s) sold out today`
                : 'All items available'}
            </p>
            <div className="flex gap-2">
              {(soldOutIds?.size ?? 0) > 0 && (
                <button
                  onClick={() => resetAll.mutate()}
                  disabled={resetAll.isPending}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Reset All
                </button>
              )}
              <label className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors cursor-pointer ${isUploading ? 'bg-gray-400 cursor-wait' : 'bg-brand-600 hover:bg-brand-700'} text-white`}>
                {isUploading ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Upload className="w-4 h-4" />}
                {isUploading ? 'Parsing...' : 'Upload Menu PDF'}
                <input type="file" accept=".pdf" className="hidden" onChange={uploadPdf} disabled={isUploading} />
              </label>
            </div>
            {uploadStatus && (
              <div className={`mt-3 flex items-center gap-2 text-sm ${isUploading ? 'text-brand-600' : uploadStatus.startsWith('Upload failed') ? 'text-red-600' : 'text-green-600'}`}>
                {isUploading && <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-brand-600 flex-shrink-0" />}
                {!isUploading && !uploadStatus.startsWith('Upload failed') && <span>✓</span>}
                {!isUploading && uploadStatus.startsWith('Upload failed') && <span>✗</span>}
                {uploadStatus}
              </div>
            )}
          </div>

          {Object.keys(categoryGroups).length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <UtensilsCrossed className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p>No menu items yet. Upload a PDF to get started.</p>
            </div>
          )}

          {Object.entries(categoryGroups).map(([category, items]) => (
            <div key={category} className="mb-6">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{category}</h3>
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {items.map((item, idx) => {
                  const soldOut = soldOutIds?.has(item.id) ?? false
                  return (
                    <div
                      key={item.id}
                      className={`flex items-center gap-4 px-4 py-3 ${idx < items.length - 1 ? 'border-b border-gray-50' : ''} ${soldOut ? 'opacity-60' : ''}`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium ${soldOut ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                          {item.name}
                        </p>
                        {item.description && (
                          <p className="text-xs text-gray-400 truncate">{item.description}</p>
                        )}
                      </div>
                      <span className={`text-sm font-medium ${soldOut ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                        ${(item.price_cents / 100).toFixed(2)}
                      </span>
                      <button
                        onClick={() => toggleSoldOut.mutate({ menuItemId: item.id, currentlySoldOut: soldOut })}
                        className="flex-shrink-0"
                        title={soldOut ? 'Mark available' : 'Mark sold out'}
                      >
                        {soldOut
                          ? <ToggleLeft className="w-8 h-8 text-red-400 hover:text-red-600 transition-colors" />
                          : <ToggleRight className="w-8 h-8 text-green-500 hover:text-green-700 transition-colors" />}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Orders tab */}
      {activeTab === 'orders' && (
        <div>
          {(!orders || orders.length === 0) && (
            <div className="text-center py-12 text-gray-400">
              <ShoppingBag className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p>No confirmed orders yet.</p>
            </div>
          )}
          {orders && orders.length > 0 && (
            <div className="space-y-3">
              {orders.map(order => (
                <div key={order.id} className="bg-white rounded-xl border border-gray-200 p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="font-medium text-gray-900">{order.pickup_name ?? 'No name'}</p>
                      <p className="text-xs text-gray-400">{new Date(order.created_at).toLocaleString()}</p>
                    </div>
                    <span className="text-sm font-semibold text-gray-900">
                      ${((order.total_cents ?? 0) / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {order.cart_json.map((item, i) => (
                      <p key={i} className="text-xs text-gray-500">
                        {item.quantity}x {item.name}
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Settings tab */}
      {activeTab === 'settings' && (
        <div className="space-y-6 max-w-lg">
          {/* Main settings card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-semibold text-gray-900">Shop Settings</h3>
              {!editingShop ? (
                <button onClick={() => setEditingShop(true)} className="text-sm text-brand-600 hover:text-brand-700">Edit</button>
              ) : (
                <div className="flex gap-2">
                  <button onClick={() => { setEditingShop(false); setShopForm(shop) }} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
                  <button
                    onClick={() => saveShop.mutate()}
                    disabled={saveShop.isPending}
                    className="flex items-center gap-1 text-sm text-white bg-brand-600 px-3 py-1 rounded-lg hover:bg-brand-700 transition-colors"
                  >
                    <Save className="w-3 h-3" />
                    Save
                  </button>
                </div>
              )}
            </div>
            <div className="space-y-4">
              {[
                { label: 'Shop Name', field: 'name' as const },
                { label: 'Timezone', field: 'timezone' as const },
                { label: 'Order Email Recipient', field: 'email_ticket_recipient' as const },
                { label: 'Pause Message', field: 'pause_message' as const },
              ].map(({ label, field }) => (
                <div key={field}>
                  <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
                  {editingShop ? (
                    <input
                      value={(shopForm[field] ?? '') as string}
                      onChange={e => setShopForm(prev => ({ ...prev, [field]: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                  ) : (
                    <p className="text-sm text-gray-700">{(shop[field] ?? '') as string || <span className="text-gray-300">Not set</span>}</p>
                  )}
                </div>
              ))}

              {/* Website URL with Scrape button */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Website URL</label>
                {editingShop ? (
                  <input
                    type="url"
                    value={(shopForm.website_url ?? '') as string}
                    onChange={e => setShopForm(prev => ({ ...prev, website_url: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="https://example.com"
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-gray-700 flex-1 min-w-0 truncate">
                      {shop.website_url || <span className="text-gray-300">Not set</span>}
                    </p>
                    {shop.website_url && (
                      <button
                        onClick={scrapeWebsite}
                        disabled={isScraping}
                        className="flex-shrink-0 flex items-center gap-1.5 text-xs text-brand-600 border border-brand-200 px-2.5 py-1 rounded-lg hover:bg-brand-50 transition-colors disabled:opacity-50"
                      >
                        {isScraping
                          ? <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-brand-600" />
                          : <Globe className="w-3 h-3" />}
                        {isScraping ? 'Scraping...' : 'Scrape Website'}
                      </button>
                    )}
                  </div>
                )}
                {scrapeError && <p className="text-xs text-red-600 mt-1">{scrapeError}</p>}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Phone Number (SMS)</label>
                <p className="text-sm text-gray-700">{shop.phone_number_e164 ?? <span className="text-gray-300">Not configured</span>}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Shop ID</label>
                <p className="text-xs font-mono text-gray-400">{shop.id}</p>
              </div>
            </div>
          </div>

          {/* Shop Context card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-gray-900">Shop Context</h3>
                <p className="text-xs text-gray-400 mt-0.5">AI-generated summary used to answer customer questions</p>
              </div>
              {!editingContext ? (
                <button
                  onClick={() => { setEditingContext(true); setContextForm(shop.shop_context ?? '') }}
                  className="text-sm text-brand-600 hover:text-brand-700"
                >
                  Edit
                </button>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditingContext(false)}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => saveContext.mutate()}
                    disabled={saveContext.isPending}
                    className="flex items-center gap-1 text-sm text-white bg-brand-600 px-3 py-1 rounded-lg hover:bg-brand-700 transition-colors"
                  >
                    <Save className="w-3 h-3" />
                    Save
                  </button>
                </div>
              )}
            </div>
            {editingContext ? (
              <textarea
                value={contextForm}
                onChange={e => setContextForm(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                rows={8}
                placeholder="AI-generated context will appear here after scraping the website..."
              />
            ) : (
              <p className="text-sm text-gray-600 whitespace-pre-wrap leading-relaxed">
                {shop.shop_context || (
                  <span className="text-gray-300">
                    No context yet. Set a Website URL above and click Scrape Website to generate it.
                  </span>
                )}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Chat tab - split screen */}
      {activeTab === 'chat' && (
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
          {/* Left panel: knowledge base (2/3 on desktop) */}
          <div className="lg:w-2/3 overflow-y-auto border-b border-gray-200 lg:border-b-0 lg:border-r max-h-64 lg:max-h-none">
            <div className="p-4 space-y-6">

              {/* AI Training Instructions */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                  <Settings className="w-4 h-4 text-gray-400" />
                  AI Training Instructions
                </h3>
                <p className="text-xs text-gray-400 mb-2">Behavior corrections and rules for this shop. These override default behavior.</p>
                <textarea
                  value={instructionsDraft}
                  onChange={e => setInstructionsDraft(e.target.value)}
                  rows={4}
                  placeholder="Example: When a customer orders a dozen bagels, ask them what kinds they want until they reach 12. Never default to plain."
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
                />
                <div className="flex justify-end mt-2">
                  <button
                    onClick={async () => {
                      setSavingInstructions(true)
                      await supabase.from('shops').update({ ai_instructions: instructionsDraft || null }).eq('id', id!)
                      setSavingInstructions(false)
                    }}
                    disabled={savingInstructions}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {savingInstructions ? 'Saving...' : 'Save Instructions'}
                  </button>
                </div>
              </div>

              {/* Shop Context section */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                  <Globe className="w-4 h-4 text-gray-400" />
                  Shop Context
                </h3>
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="url"
                      value={urlDraft}
                      onChange={e => setUrlDraft(e.target.value)}
                      placeholder="https://example.com"
                      className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <button
                      onClick={scrapeFromChatTab}
                      disabled={isScraping || !urlDraft.trim()}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm border border-brand-200 text-brand-600 rounded-lg hover:bg-brand-50 transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      {isScraping
                        ? <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-brand-600" />
                        : <Globe className="w-3.5 h-3.5" />}
                      {isScraping ? 'Scraping...' : 'Scrape'}
                    </button>
                  </div>
                  {scrapeError && <p className="text-xs text-red-600">{scrapeError}</p>}
                  <textarea
                    value={contextDraft}
                    onChange={e => setContextDraft(e.target.value)}
                    rows={5}
                    placeholder="AI-generated summary will appear here after scraping..."
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
                  />
                  <div className="flex justify-end">
                    <button
                      onClick={() => saveChatContext.mutate()}
                      disabled={saveChatContext.isPending}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {saveChatContext.isPending ? 'Saving...' : 'Save Context'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Menu section */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <UtensilsCrossed className="w-4 h-4 text-gray-400" />
                    Menu
                  </h3>
                  <label className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors cursor-pointer ${isUploading ? 'bg-gray-400 cursor-wait' : 'bg-brand-600 hover:bg-brand-700'} text-white`}>
                    {isUploading ? <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" /> : <Upload className="w-3.5 h-3.5" />}
                    {isUploading ? 'Parsing...' : 'Upload PDF'}
                    <input type="file" accept=".pdf" className="hidden" onChange={uploadPdf} disabled={isUploading} />
                  </label>
                </div>
                {uploadStatus && (
                  <div className={`mb-3 flex items-center gap-2 text-xs ${isUploading ? 'text-brand-600' : uploadStatus.startsWith('Upload failed') ? 'text-red-600' : 'text-green-600'}`}>
                    {isUploading && <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-brand-600 flex-shrink-0" />}
                    {uploadStatus}
                  </div>
                )}

                {Object.keys(categoryGroups).length === 0 && (
                  <div className="text-center py-8 text-gray-400">
                    <UtensilsCrossed className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">No menu items yet. Upload a PDF to get started.</p>
                  </div>
                )}

                {Object.entries(categoryGroups).map(([category, items]) => (
                  <div key={category} className="mb-4">
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{category}</h4>
                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      {items.map((item, idx) => {
                        const soldOut    = soldOutIds?.has(item.id) ?? false
                        const isEditing  = editingItemId === item.id
                        return (
                          <div key={item.id} className={idx < items.length - 1 ? 'border-b border-gray-100' : ''}>
                            {isEditing ? (
                              <div className="p-3 space-y-2 bg-blue-50">
                                <div className="flex gap-2">
                                  <input
                                    value={editItemForm.name}
                                    onChange={e => setEditItemForm(prev => ({ ...prev, name: e.target.value }))}
                                    placeholder="Item name"
                                    className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                                    autoFocus
                                  />
                                  <input
                                    value={editItemForm.price_cents_str}
                                    onChange={e => setEditItemForm(prev => ({ ...prev, price_cents_str: e.target.value }))}
                                    placeholder="Price"
                                    className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                                  />
                                </div>
                                <input
                                  value={editItemForm.description}
                                  onChange={e => setEditItemForm(prev => ({ ...prev, description: e.target.value }))}
                                  placeholder="Description (optional)"
                                  className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                                />
                                <div className="flex gap-2 justify-end">
                                  <button
                                    onClick={() => setEditingItemId(null)}
                                    className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={() => editMenuItem.mutate({ itemId: item.id, form: editItemForm })}
                                    disabled={editMenuItem.isPending || !editItemForm.name.trim()}
                                    className="px-3 py-1 text-xs text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
                                  >
                                    {editMenuItem.isPending ? 'Saving...' : 'Save'}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className={`flex items-start gap-2 px-3 py-2.5 ${soldOut ? 'opacity-60' : ''}`}>
                                {soldOut && (
                                  <span className="w-2 h-2 rounded-full bg-red-500 mt-1.5 flex-shrink-0" title="Sold out today" />
                                )}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-baseline gap-2 flex-wrap">
                                    <p className={`text-sm font-medium leading-snug ${soldOut ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                                      {item.name}
                                    </p>
                                    <span className={`text-xs flex-shrink-0 ${soldOut ? 'line-through text-gray-400' : 'text-gray-500'}`}>
                                      ${(item.price_cents / 100).toFixed(2)}
                                    </span>
                                  </div>
                                  {item.description && (
                                    <p className="text-xs text-gray-400 truncate">{item.description}</p>
                                  )}
                                  {item.modifiers_json && item.modifiers_json.length > 0 && (
                                    <p className="text-xs text-gray-400 truncate">
                                      {item.modifiers_json.map(m => m.name).join(', ')}
                                    </p>
                                  )}
                                </div>
                                <div className="flex items-center gap-0.5 flex-shrink-0">
                                  <button
                                    onClick={() => {
                                      setEditingItemId(item.id)
                                      setEditItemForm({
                                        name:            item.name,
                                        price_cents_str: (item.price_cents / 100).toFixed(2),
                                        description:     item.description ?? '',
                                        category:        item.category,
                                      })
                                    }}
                                    className="p-1.5 text-gray-400 hover:text-brand-600 transition-colors rounded"
                                    title="Edit item"
                                  >
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => {
                                      if (window.confirm(`Delete "${item.name}"?`)) {
                                        deleteMenuItem.mutate(item.id)
                                      }
                                    }}
                                    disabled={deleteMenuItem.isPending}
                                    className="p-1.5 text-gray-400 hover:text-red-600 transition-colors rounded disabled:opacity-50"
                                    title="Delete item"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}

                      {/* Add item to this category */}
                      {addingToCategory === category ? (
                        <div className="p-3 space-y-2 bg-green-50 border-t border-gray-100">
                          <div className="flex gap-2">
                            <input
                              value={addItemForm.name}
                              onChange={e => setAddItemForm(prev => ({ ...prev, name: e.target.value }))}
                              placeholder="Item name"
                              className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                              autoFocus
                            />
                            <input
                              value={addItemForm.price_cents_str}
                              onChange={e => setAddItemForm(prev => ({ ...prev, price_cents_str: e.target.value }))}
                              placeholder="Price"
                              className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                          </div>
                          <input
                            value={addItemForm.description}
                            onChange={e => setAddItemForm(prev => ({ ...prev, description: e.target.value }))}
                            placeholder="Description (optional)"
                            className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={() => { setAddingToCategory(null); setAddItemForm({ name: '', price_cents_str: '', description: '' }) }}
                              className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => addMenuItem.mutate({ category, form: addItemForm })}
                              disabled={addMenuItem.isPending || !addItemForm.name.trim()}
                              className="px-3 py-1 text-xs text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
                            >
                              {addMenuItem.isPending ? 'Adding...' : 'Add'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="border-t border-gray-100">
                          <button
                            onClick={() => {
                              setAddingToCategory(category)
                              setAddItemForm({ name: '', price_cents_str: '', description: '' })
                            }}
                            className="w-full px-3 py-2 text-xs text-gray-400 hover:text-brand-600 hover:bg-gray-50 transition-colors flex items-center gap-1"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Add item
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {/* Add item to a new category */}
                {activeMenuId && (
                  addingToCategory === '__new__' ? (
                    <div className="mt-2 p-3 bg-green-50 rounded-xl border border-gray-200 space-y-2">
                      <input
                        value={addItemCategory}
                        onChange={e => setAddItemCategory(e.target.value)}
                        placeholder="Category name (e.g. Desserts)"
                        className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <input
                          value={addItemForm.name}
                          onChange={e => setAddItemForm(prev => ({ ...prev, name: e.target.value }))}
                          placeholder="Item name"
                          className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                        <input
                          value={addItemForm.price_cents_str}
                          onChange={e => setAddItemForm(prev => ({ ...prev, price_cents_str: e.target.value }))}
                          placeholder="Price"
                          className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      </div>
                      <input
                        value={addItemForm.description}
                        onChange={e => setAddItemForm(prev => ({ ...prev, description: e.target.value }))}
                        placeholder="Description (optional)"
                        className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => { setAddingToCategory(null); setAddItemCategory(''); setAddItemForm({ name: '', price_cents_str: '', description: '' }) }}
                          className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => addMenuItem.mutate({ category: addItemCategory.trim() || 'Other', form: addItemForm })}
                          disabled={addMenuItem.isPending || !addItemForm.name.trim()}
                          className="px-3 py-1 text-xs text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
                        >
                          {addMenuItem.isPending ? 'Adding...' : 'Add'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setAddingToCategory('__new__'); setAddItemCategory(''); setAddItemForm({ name: '', price_cents_str: '', description: '' }) }}
                      className="mt-3 w-full py-2 text-xs text-gray-400 hover:text-brand-600 border border-dashed border-gray-200 rounded-lg hover:border-brand-300 transition-colors flex items-center justify-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add item to new category
                    </button>
                  )
                )}
              </div>
            </div>
          </div>

          {/* Right panel: phone mockup (1/3 on desktop) */}
          <div className="lg:w-1/3 flex-shrink-0 flex justify-center items-start pt-6 pb-6 border-t border-gray-200 lg:border-t-0 lg:border-l overflow-hidden">
            <ShopChatTest shopId={shop.id} shopName={shop.name} />
          </div>
        </div>
      )}
    </div>
  )
}
