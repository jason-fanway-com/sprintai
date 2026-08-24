import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Store, DollarSign, MessageSquare, UtensilsCrossed, Settings,
  TrendingUp, TrendingDown, ShoppingBag, Activity, CheckCircle2,
  Flame, Ghost, ArrowRight,
} from 'lucide-react'
import { supabase, getAuthHeaders } from '../lib/supabase'
import { useRole } from '../lib/RoleContext'
import { useView } from '../lib/ViewContext'
import ShopChatTest from '../components/ShopChatTest'

const SHOP_FINANCIALS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/shop-financials`

// ─── Types ───────────────────────────────────────────────────────────────────
interface Shop {
  id: string
  name: string
  slug: string
  is_paused: boolean
  timezone: string
  created_at: string
}

interface Summary {
  order_count: number
  gross_sales: string
  gross_sales_cents: number
  net_revenue: string
  avg_ticket: string
  avg_ticket_cents: number
}

type Period = 'today' | 'week' | 'month' | 'quarter' | 'ytd'

interface CartRow {
  phase: string
  total_cents: number | null
  cart_json: Array<{ name?: string; quantity?: number; price_cents?: number }> | null
}

// ─── Date helpers (owner-local) ──────────────────────────────────────────────
function ymd(d: Date): string {
  return d.toISOString().split('T')[0]
}
function startOfWeek(d: Date): Date {
  const x = new Date(d)
  const day = (x.getDay() + 6) % 7 // Monday = 0
  x.setDate(x.getDate() - day)
  return x
}
function startOfQuarter(d: Date): Date {
  const x = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1)
  return x
}
/** {from,to} for a period, plus the immediately-preceding period of equal length. */
function rangeFor(period: Period): { from: string; to: string; prevFrom: string; prevTo: string } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let from: Date
  switch (period) {
    case 'today': from = today; break
    case 'week': from = startOfWeek(today); break
    case 'month': from = new Date(today.getFullYear(), today.getMonth(), 1); break
    case 'quarter': from = startOfQuarter(today); break
    case 'ytd': from = new Date(today.getFullYear(), 0, 1); break
  }
  const spanDays = Math.max(1, Math.round((today.getTime() - from.getTime()) / 86400000) + 1)
  const prevTo = new Date(from); prevTo.setDate(prevTo.getDate() - 1)
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (spanDays - 1))
  return { from: ymd(from), to: ymd(today), prevFrom: ymd(prevFrom), prevTo: ymd(prevTo) }
}

async function fetchSummary(shopId: string, from: string, to: string): Promise<Summary> {
  const headers = await getAuthHeaders()
  const params = new URLSearchParams({ from, to })
  const res = await fetch(`${SHOP_FINANCIALS_URL}/${shopId}/summary?${params}`, { headers })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? 'Failed to fetch summary')
  }
  return res.json()
}

const PERIOD_LABEL: Record<Period, string> = {
  today: 'Today', week: 'This Week', month: 'This Month', quarter: 'This Quarter', ytd: 'Year to Date',
}

// ─── Small UI atoms ──────────────────────────────────────────────────────────
function Delta({ curr, prev }: { curr: number; prev: number }) {
  if (prev <= 0 && curr <= 0) return null
  if (prev <= 0) return <span className="text-xs font-medium text-green-600">new</span>
  const pct = Math.round(((curr - prev) / prev) * 100)
  if (pct === 0) return <span className="text-xs text-gray-400">flat</span>
  const up = pct > 0
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${up ? 'text-green-600' : 'text-red-500'}`}>
      {up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {Math.abs(pct)}%
    </span>
  )
}

function KpiCard({ label, value, sub, delta, icon }: {
  label: string; value: string; sub?: string; delta?: React.ReactNode; icon?: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">{label}</p>
        {icon}
      </div>
      <div className="flex items-end gap-2">
        <p className="text-2xl font-bold text-gray-900 leading-none">{value}</p>
        {delta}
      </div>
      {sub && <p className="text-xs text-gray-400">{sub}</p>}
    </div>
  )
}

function HealthRing({ score }: { score: number }) {
  const r = 46, c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score))
  const color = pct >= 85 ? '#16a34a' : pct >= 60 ? '#eab308' : '#ef4444'
  const grade = pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'F'
  return (
    <div className="relative w-32 h-32">
      <svg className="w-32 h-32 -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="#f1f5f9" strokeWidth="10" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="10"
          strokeDasharray={c} strokeDashoffset={c - (pct / 100) * c} strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold text-gray-900">{Math.round(pct)}</span>
        <span className="text-xs font-semibold" style={{ color }}>{grade}</span>
      </div>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function ShopOwnerDashboard() {
  const { tenantId, isShopOwner, isSuperAdmin } = useRole()
  const { mode, previewTenantId, setMode, setPreview } = useView()
  const [searchParams] = useSearchParams()
  const [period, setPeriod] = useState<Period>('today')

  const previewing = isSuperAdmin && mode === 'owner'
  const effTenant = previewing ? previewTenantId : tenantId
  const asOwner = isShopOwner || previewing

  const { data: shops } = useQuery<Shop[]>({
    queryKey: ['owner-shops', effTenant],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shops')
        .select('id, name, slug, is_paused, timezone, created_at')
        .eq('tenant_id', effTenant)
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

  const range = useMemo(() => rangeFor(period), [period])

  // All revenue tiles in one shot (day/week/month/quarter/ytd/lifetime).
  const { data: tiles } = useQuery<Record<string, Summary>>({
    queryKey: ['owner-tiles', shop?.id],
    queryFn: async () => {
      const id = shop!.id
      const now = new Date()
      const today = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate()))
      const specs: Array<[string, string, string]> = [
        ['today', today, today],
        ['week', ymd(startOfWeek(now)), today],
        ['month', ymd(new Date(now.getFullYear(), now.getMonth(), 1)), today],
        ['quarter', ymd(startOfQuarter(now)), today],
        ['ytd', ymd(new Date(now.getFullYear(), 0, 1)), today],
        ['lifetime', '2000-01-01', today],
      ]
      const results = await Promise.all(specs.map(([, f, t]) => fetchSummary(id, f, t)))
      const out: Record<string, Summary> = {}
      specs.forEach(([k], i) => { out[k] = results[i] })
      return out
    },
    enabled: !!shop?.id,
  })

  // Selected period current + prior (for hero delta).
  const { data: sel } = useQuery<{ curr: Summary; prev: Summary }>({
    queryKey: ['owner-sel', shop?.id, period],
    queryFn: async () => {
      const id = shop!.id
      const [curr, prev] = await Promise.all([
        fetchSummary(id, range.from, range.to),
        fetchSummary(id, range.prevFrom, range.prevTo),
      ])
      return { curr, prev }
    },
    enabled: !!shop?.id,
  })

  // Carts in selected range → completion + top/dead sellers.
  const { data: carts } = useQuery<CartRow[]>({
    queryKey: ['owner-carts', shop?.id, range.from, range.to],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('order_carts')
        .select('phase, total_cents, cart_json')
        .eq('shop_id', shop!.id)
        .gte('created_at', range.from)
        .lte('created_at', `${range.to}T23:59:59`)
      if (error) throw error
      return (data ?? []) as CartRow[]
    },
    enabled: !!shop?.id,
  })

  // Active menu items (for dead-item detection).
  const { data: menuItems } = useQuery<string[]>({
    queryKey: ['owner-menu-items', shop?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('menu_items')
        .select('name, active, menus!inner(shop_id)')
        .eq('menus.shop_id', shop!.id)
        .eq('active', true)
      if (error) throw error
      return (data ?? []).map((r: { name: string }) => r.name)
    },
    enabled: !!shop?.id,
  })

  // Last 5 conversations (tenant-scoped).
  const { data: convos } = useQuery<Array<{ id: string; customer_phone: string; last_message_at: string }>>({
    queryKey: ['owner-convos', effTenant],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select('id, customer_phone, last_message_at')
        .eq('tenant_id', effTenant)
        .order('last_message_at', { ascending: false })
        .limit(5)
      if (error) throw error
      return data ?? []
    },
    enabled: !!effTenant && asOwner,
  })

  // Quality pass rate (selected range).
  const { data: quality } = useQuery<{ clean: number; flagged: number }>({
    queryKey: ['owner-quality', shop?.id, range.from, range.to],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('conversation_evals')
        .select('verdict')
        .eq('shop_id', shop!.id)
        .gte('judged_at', range.from)
        .lte('judged_at', `${range.to}T23:59:59`)
      if (error) throw error
      let clean = 0, flagged = 0
      for (const r of (data ?? []) as Array<{ verdict: string }>) {
        if (r.verdict === 'clean') clean++
        else if (r.verdict === 'flagged') flagged++
      }
      return { clean, flagged }
    },
    enabled: !!shop?.id,
  })

  // Latest readiness run.
  const { data: readiness } = useQuery<{ pct: number | null; passed: number; total: number } | null>({
    queryKey: ['owner-readiness', shop?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('test_runs')
        .select('overall_pass_pct, passed, total, started_at')
        .eq('shop_id', shop!.id)
        .order('started_at', { ascending: false })
        .limit(1)
      if (error) throw error
      const r = (data ?? [])[0]
      return r ? { pct: r.overall_pass_pct, passed: r.passed, total: r.total } : null
    },
    enabled: !!shop?.id,
  })

  // ── Derived metrics ──────────────────────────────────────────────────────
  const derived = useMemo(() => {
    // Completion: confirmed / (carts that reached checkout or beyond).
    let reachedCheckout = 0, confirmed = 0
    const soldQty: Record<string, number> = {}
    for (const c of carts ?? []) {
      if (['checkout', 'payment', 'confirmed'].includes(c.phase)) reachedCheckout++
      if (c.phase === 'confirmed') {
        confirmed++
        for (const it of c.cart_json ?? []) {
          if (!it?.name) continue
          soldQty[it.name] = (soldQty[it.name] ?? 0) + (it.quantity ?? 1)
        }
      }
    }
    const completion = reachedCheckout > 0 ? Math.round((confirmed / reachedCheckout) * 100) : null
    const topSellers = Object.entries(soldQty).sort((a, b) => b[1] - a[1]).slice(0, 5)
    const soldNames = new Set(Object.keys(soldQty))
    const deadItems = (menuItems ?? []).filter(n => !soldNames.has(n)).slice(0, 8)
    const qtot = (quality?.clean ?? 0) + (quality?.flagged ?? 0)
    const qualityPct = qtot > 0 ? Math.round(((quality!.clean) / qtot) * 100) : null

    // Health = weighted blend of available drivers (renormalized).
    const drivers: Array<{ label: string; val: number; weight: number }> = []
    if (completion != null) drivers.push({ label: 'Checkout completion', val: completion, weight: 0.35 })
    if (qualityPct != null) drivers.push({ label: 'Conversation quality', val: qualityPct, weight: 0.35 })
    if (readiness?.pct != null) drivers.push({ label: 'Store readiness', val: Number(readiness.pct), weight: 0.30 })
    const wsum = drivers.reduce((s, d) => s + d.weight, 0)
    const health = wsum > 0 ? drivers.reduce((s, d) => s + d.val * (d.weight / wsum), 0) : null

    return { completion, topSellers, deadItems, qualityPct, health, drivers }
  }, [carts, menuItems, quality, readiness])

  // ── Auto-enable owner preview for super-admins landing on this route ────
  useEffect(() => {
    if (isSuperAdmin && mode !== 'owner') setMode('owner')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin])

  // ── Deep-link from signup "Go to my Shop" (reads ?shop= param) ─────────
  useEffect(() => {
    const shopParam = searchParams.get('shop')
    if (!shopParam) return
    setShopId(shopParam)
    // For super-admins previewing, resolve the shop's tenant so the tenant-scoped
    // query fires with the correct effTenant.
    if (isSuperAdmin) {
      supabase
        .from('shops')
        .select('id, tenant_id, name')
        .eq('id', shopParam)
        .single()
        .then(({ data, error }) => {
          if (error || !data) return
          setPreview(data.tenant_id, data.name ?? null)
          if (mode !== 'owner') setMode('owner')
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, isSuperAdmin])

  // ── Guards ───────────────────────────────────────────────────────────────
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
        <p className="text-sm mt-1">Contact SprintAI support to set up your restaurant.</p>
      </div>
    )
  }
  if (!shop) {
    return <div className="p-8 flex justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
  }

  const todayRev = tiles?.today?.gross_sales ?? '—'
  const selCurr = sel?.curr
  const selPrev = sel?.prev

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto">
      <div className="flex flex-col lg:flex-row gap-6">
        {/* LEFT: At a Glance (~2/3) */}
        <div className="flex-1 min-w-0 space-y-6">

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-brand-50 flex items-center justify-center">
            <Store className="w-6 h-6 text-brand-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">At a Glance</h1>
            <div className="flex items-center gap-2 text-sm text-gray-400">
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
              {shop.is_paused && <span className="px-2 py-0.5 rounded-full text-xs bg-orange-100 text-orange-700">Paused</span>}
            </div>
          </div>
        </div>
        {/* Time-range toggle */}
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          {(Object.keys(PERIOD_LABEL) as Period[]).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                period === p ? 'bg-brand-600 text-white font-medium' : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              {p === 'ytd' ? 'YTD' : PERIOD_LABEL[p].replace('This ', '')}
            </button>
          ))}
        </div>
      </div>

      {/* Hero: today's revenue + health */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-2xl bg-gradient-to-br from-brand-600 to-brand-500 text-white p-6 shadow-sm flex flex-col justify-between">
          <p className="text-sm font-medium opacity-80 uppercase tracking-wider">Today's Revenue</p>
          <p className="text-5xl font-bold mt-2">${todayRev}</p>
          <p className="text-sm opacity-80 mt-2">
            {tiles?.today?.order_count ?? 0} orders today · {PERIOD_LABEL[period]}: ${selCurr?.gross_sales ?? '—'}
          </p>
        </div>
        <div className="rounded-2xl bg-white border border-gray-100 p-6 shadow-sm flex items-center gap-4">
          <HealthRing score={derived.health ?? 0} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 flex items-center gap-1"><Activity className="w-4 h-4 text-brand-600" /> Store Health</p>
            <div className="mt-2 space-y-1">
              {derived.drivers.length === 0 && <p className="text-xs text-gray-400">Not enough data yet.</p>}
              {derived.drivers.map(d => (
                <div key={d.label} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-gray-500 truncate">{d.label}</span>
                  <span className="font-medium text-gray-800">{Math.round(d.val)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label={`Orders · ${PERIOD_LABEL[period]}`}
          value={String(selCurr?.order_count ?? 0)}
          delta={selCurr && selPrev ? <Delta curr={selCurr.order_count} prev={selPrev.order_count} /> : undefined}
          icon={<ShoppingBag className="w-4 h-4 text-gray-300" />}
        />
        <KpiCard
          label="Revenue"
          value={`$${selCurr?.gross_sales ?? '—'}`}
          delta={selCurr && selPrev ? <Delta curr={selCurr.gross_sales_cents} prev={selPrev.gross_sales_cents} /> : undefined}
          icon={<DollarSign className="w-4 h-4 text-gray-300" />}
        />
        <KpiCard
          label="Avg Order"
          value={`$${selCurr?.avg_ticket ?? '—'}`}
          sub="per order"
          icon={<TrendingUp className="w-4 h-4 text-gray-300" />}
        />
        <KpiCard
          label="Checkout Rate"
          value={derived.completion != null ? `${derived.completion}%` : '—'}
          sub={derived.completion != null ? 'carts → paid' : 'no carts yet'}
          icon={<CheckCircle2 className="w-4 h-4 text-gray-300" />}
        />
      </div>

      {/* Revenue tiles (all periods) */}
      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-2">Revenue</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {([['today', 'Today'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['ytd', 'YTD'], ['lifetime', 'Lifetime']] as const).map(([k, label]) => (
            <div key={k} className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
              <p className="text-xs text-gray-400">{label}</p>
              <p className="text-lg font-bold text-gray-900">${tiles?.[k]?.gross_sales ?? '—'}</p>
              <p className="text-[11px] text-gray-400">{tiles?.[k]?.order_count ?? 0} orders</p>
            </div>
          ))}
        </div>
      </div>

      {/* Top sellers + dead items */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-3"><Flame className="w-4 h-4 text-orange-500" /> Top Sellers · {PERIOD_LABEL[period]}</h3>
          {derived.topSellers.length === 0 ? (
            <p className="text-sm text-gray-400">No sales in this period yet.</p>
          ) : (
            <ul className="space-y-2">
              {derived.topSellers.map(([name, qty], i) => (
                <li key={name} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 text-gray-700 truncate">
                    <span className="w-5 h-5 rounded bg-gray-100 text-gray-500 text-xs flex items-center justify-center">{i + 1}</span>
                    {name}
                  </span>
                  <span className="font-medium text-gray-900">{qty} sold</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-3"><Ghost className="w-4 h-4 text-gray-400" /> No Sales · {PERIOD_LABEL[period]}</h3>
          {derived.deadItems.length === 0 ? (
            <p className="text-sm text-gray-400">Every menu item sold — nice.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {derived.deadItems.map(name => (
                <span key={name} className="px-2.5 py-1 rounded-full text-xs bg-gray-50 border border-gray-100 text-gray-500">{name}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Last 5 conversations */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><MessageSquare className="w-4 h-4 text-brand-600" /> Recent Conversations</h3>
          <Link to="/conversations" className="text-xs text-brand-600 hover:underline flex items-center gap-1">View all <ArrowRight className="w-3 h-3" /></Link>
        </div>
        {(!convos || convos.length === 0) ? (
          <p className="text-sm text-gray-400">No conversations yet.</p>
        ) : (
          <ul className="divide-y divide-gray-50">
            {convos.map(c => (
              <li key={c.id}>
                <Link to={`/conversations/${c.id}`} className="flex items-center justify-between py-2.5 hover:bg-gray-50 -mx-2 px-2 rounded-lg">
                  <span className="font-mono text-sm text-gray-700">{c.customer_phone ?? 'unknown'}</span>
                  <span className="text-xs text-gray-400">{new Date(c.last_message_at).toLocaleString()}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

        {/* Quick actions */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Link to={`/shops/${shop.id}`} className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-100 rounded-xl text-sm text-gray-700 hover:shadow-sm transition-shadow">
          <UtensilsCrossed className="w-4 h-4 text-gray-400" /> Menu
        </Link>
        <Link to={`/shops/${shop.id}`} className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-100 rounded-xl text-sm text-gray-700 hover:shadow-sm transition-shadow">
          <Settings className="w-4 h-4 text-gray-400" /> Settings
        </Link>
        <Link to="/shop-chats" className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-100 rounded-xl text-sm text-gray-700 hover:shadow-sm transition-shadow">
          <MessageSquare className="w-4 h-4 text-gray-400" /> Chat with your shop
        </Link>
          <Link to={`/shop/${shop.id}/financials`} className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-100 rounded-xl text-sm font-medium text-brand-600 hover:shadow-sm transition-shadow">
            <DollarSign className="w-4 h-4" /> Financials
          </Link>
        </div>

        </div>
        {/* END LEFT */}

        {/* RIGHT: Test Chat Panel (~1/3) */}
        <div className="w-full lg:w-[340px] flex-shrink-0">
          <div className="bg-white rounded-2xl border border-amber-200 shadow-sm overflow-hidden lg:sticky lg:top-6">
            <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-amber-600" />
              <span className="text-sm font-semibold text-amber-800">Test your assistant</span>
            </div>
            <div className="px-4 py-2 bg-amber-50/50 border-b border-amber-100">
              <p className="text-xs text-amber-700">
                Test mode — orders placed here are practice, not real.
              </p>
            </div>
            <div className="flex justify-center py-4">
              <ShopChatTest shopId={shop.id} shopName={shop.name} forceTest />
            </div>
          </div>
        </div>
        {/* END RIGHT */}

      </div>
    </div>
  )
}
