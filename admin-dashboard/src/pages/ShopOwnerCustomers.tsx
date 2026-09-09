import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Users, Search, Repeat, Star, PhoneOff, Store } from 'lucide-react'
import { supabase, getAuthHeaders } from '../lib/supabase'
import { useEffectiveTenant } from '../lib/useOwnerTenant'

const CUSTOMER_CRM_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/customer-crm`

/**
 * Owner-facing Customer CRM — "who comes back and what do they get."
 *
 * Same frame as FinancialReporting: scopes to the signed-in owner's shop via
 * useEffectiveTenant(), and the actual `customers` row data comes from the
 * customer-crm edge function (never a direct client query — that table is
 * service-role-only, see supabase/functions/customer-crm/index.ts). The edge
 * function has already turned every row's raw identity into either a clean
 * display phone or "No phone on file" — this page never sees or renders a raw
 * customer_phone string.
 *
 * Read-only by design: no messaging, no export, no editing. See
 * docs/specs/2026-09-03-customer-crm.md — those are explicitly out of scope
 * for this screen.
 */

interface Shop { id: string; name: string }

interface FavoriteItem { name: string; count: number }

interface CustomerRow {
  id: string
  name: string | null
  phone_display: string
  order_count: number
  total_spent_cents: number
  last_order_at: string | null
  top_item: string | null
  favorite_items: FavoriteItem[]
  is_returning: boolean
  is_regular: boolean
  opted_out: boolean
}

interface CustomersResponse {
  customers: CustomerRow[]
  summary: { total: number; returning: number; regulars: number }
}

type SortField = 'last_order_at' | 'order_count' | 'total_spent_cents'

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function SummaryTile({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm flex items-center justify-between">
      <div>
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">{label}</p>
        <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      </div>
      {icon}
    </div>
  )
}

function CustomerCard({ c }: { c: CustomerRow }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-gray-900 truncate">{c.name ?? 'Guest'}</p>
            {c.is_regular && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700 font-medium">
                <Star className="w-3 h-3" /> Regular
              </span>
            )}
            {!c.is_regular && c.is_returning && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-brand-50 text-brand-600 font-medium">
                <Repeat className="w-3 h-3" /> Returning
              </span>
            )}
            {c.opted_out && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">
                <PhoneOff className="w-3 h-3" /> Opted out of texts
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mt-0.5">{c.phone_display}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="font-bold text-gray-900">{money(c.total_spent_cents)}</p>
          <p className="text-xs text-gray-400">{c.order_count} order{c.order_count === 1 ? '' : 's'}</p>
        </div>
      </div>
      <div className="flex items-center justify-between text-sm">
        <p className="text-gray-600 truncate">
          {c.top_item ? <>Usually gets: <span className="font-medium">{c.top_item}</span></> : 'No favorite item yet'}
        </p>
        <p className="text-xs text-gray-400 shrink-0">
          {c.last_order_at ? `Last order ${new Date(c.last_order_at).toLocaleDateString()}` : 'No orders yet'}
        </p>
      </div>
    </div>
  )
}

export default function ShopOwnerCustomers() {
  const { isOwnerView, effTenant } = useEffectiveTenant()
  const [shopId, setShopId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortField>('last_order_at')

  const { data: shops, isLoading: shopsLoading } = useQuery<Shop[]>({
    queryKey: ['customers-owner-shops', effTenant],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shops')
        .select('id, name')
        .eq('tenant_id', effTenant)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data ?? []
    },
    enabled: !isOwnerView || !!effTenant,
  })

  const shop = useMemo(() => {
    if (!shops || shops.length === 0) return null
    return shops.find(s => s.id === shopId) ?? shops[0]
  }, [shops, shopId])

  const { data, isLoading, error } = useQuery<CustomersResponse>({
    queryKey: ['customer-crm', shop?.id, search, sort],
    queryFn: async () => {
      const headers = await getAuthHeaders()
      const params = new URLSearchParams({ sort, dir: 'desc' })
      if (search.trim()) params.set('search', search.trim())
      const res = await fetch(`${CUSTOMER_CRM_URL}/${shop!.id}/customers?${params}`, { headers })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error ?? 'Failed to fetch customers')
      }
      return res.json()
    },
    enabled: !!shop?.id,
  })

  if (isOwnerView && !effTenant) {
    return <div className="p-8 text-gray-500">Pick a shop to view its customers.</div>
  }
  if (shopsLoading) {
    return <div className="p-8 flex justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
  }
  if (!shop) {
    return (
      <div className="p-8 text-center py-16 text-gray-400">
        <Store className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="font-medium">No shop assigned</p>
      </div>
    )
  }

  const customers = data?.customers ?? []
  const summary = data?.summary

  return (
    <div className="p-6 md:p-8 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-brand-50 flex items-center justify-center">
            <Users className="w-6 h-6 text-brand-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
            {shops && shops.length > 1 ? (
              <select
                value={shop.id}
                onChange={e => setShopId(e.target.value)}
                className="bg-transparent border border-gray-200 rounded-md px-2 py-0.5 text-sm text-gray-600"
              >
                {shops.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : (
              <p className="text-sm text-gray-400">{shop.name}</p>
            )}
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryTile label="Total Customers" value={String(summary?.total ?? '—')} icon={<Users className="w-5 h-5 text-gray-300" />} />
        <SummaryTile label="Returning (2+ orders)" value={String(summary?.returning ?? '—')} icon={<Repeat className="w-5 h-5 text-gray-300" />} />
        <SummaryTile label="Have a Regular" value={String(summary?.regulars ?? '—')} icon={<Star className="w-5 h-5 text-gray-300" />} />
      </div>

      {/* Search + sort */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or phone"
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          {([
            ['last_order_at', 'Recent'],
            ['order_count', 'Orders'],
            ['total_spent_cents', 'Spent'],
          ] as Array<[SortField, string]>).map(([field, label]) => (
            <button
              key={field}
              onClick={() => setSort(field)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                sort === field ? 'bg-brand-600 text-white font-medium' : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="p-8 flex justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
      ) : error ? (
        <div className="text-sm text-red-500">{(error as Error).message}</div>
      ) : customers.length === 0 ? (
        <div className="p-8 text-center py-16 text-gray-400">
          <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">{search ? 'No matching customers' : 'No customers yet'}</p>
          <p className="text-sm mt-1">{search ? 'Try a different name or phone.' : 'Profiles appear here after a diner’s first paid order.'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {customers.map(c => <CustomerCard key={c.id} c={c} />)}
        </div>
      )}
    </div>
  )
}
