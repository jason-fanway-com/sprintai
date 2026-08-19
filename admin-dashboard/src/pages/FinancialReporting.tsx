import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Store } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useEffectiveTenant } from '../lib/useOwnerTenant'
import ShopFinancialsPage from './shop-financials/ShopFinancialsPage'

interface Shop { id: string; name: string }

/**
 * Owner-facing Financial Reporting.
 *
 * Reuses the full ShopFinancialsPage experience (KPI cards, revenue chart,
 * QuickBooks-ready CSV export, paginated transaction ledger) but scopes it to
 * the owner's own shop via `useEffectiveTenant()` instead of a URL param.
 *
 * Tenant isolation: shop is resolved from effTenant → shops; the shop-financials
 * edge function independently enforces tenant access server-side.
 */
export default function FinancialReporting() {
  const { isOwnerView, effTenant } = useEffectiveTenant()
  const [shopId, setShopId] = useState<string | null>(null)

  const { data: shops, isLoading } = useQuery<Shop[]>({
    queryKey: ['fin-owner-shops', effTenant],
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

  if (isOwnerView && !effTenant) {
    return <div className="p-8 text-gray-500">Pick a shop to view its financials.</div>
  }

  if (isLoading) {
    return <div className="p-8 flex justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
  }

  if (!shop) {
    return (
      <div className="p-8 text-center py-16 text-gray-400">
        <Store className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="font-medium">No shop assigned</p>
        <p className="text-sm mt-1">Contact SprintAI support to set up your restaurant.</p>
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto">
      {shops && shops.length > 1 && (
        <div className="mb-4">
          <select
            value={shop.id}
            onChange={e => setShopId(e.target.value)}
            className="border border-gray-200 rounded-md px-3 py-1.5 text-sm text-gray-700"
          >
            {shops.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )}
      <ShopFinancialsPage shopId={shop.id} embedded />
    </div>
  )
}
