import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Store, DollarSign, MessageSquare, UtensilsCrossed, Settings } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useRole } from '../lib/RoleContext'

interface Shop {
  id: string
  name: string
  slug: string
  is_paused: boolean
  timezone: string
  created_at: string
}

/**
 * Shop-owner landing: lists only the shops belonging to their tenant_id.
 * No global stats, no tenant switcher, no cross-tenant views.
 * Super-admins never see this page (they get redirected from /shop-owner to /dashboard).
 */
export default function ShopOwnerDashboard() {
  const { tenantId, isShopOwner } = useRole()

  const { data: shops, isLoading, error } = useQuery<Shop[]>({
    queryKey: ['shop-owner-shops', tenantId],
    queryFn: async () => {
      if (!tenantId) throw new Error('No tenant_id in session')
      const { data, error } = await supabase
        .from('shops')
        .select('id, name, slug, is_paused, timezone, created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data ?? []
    },
    enabled: !!tenantId && isShopOwner,
  })

  // Super-admins shouldn't land here — redirect handled by App.tsx route guards.
  // If somehow they do, show a fallback.
  if (!isShopOwner) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="card p-6 bg-red-50 border-red-200">
          <p className="text-red-700">Failed to load shops: {(error as Error).message}</p>
        </div>
      </div>
    )
  }

  if (!shops || shops.length === 0) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">My Shops</h1>
        <div className="text-center py-16 text-gray-400">
          <Store className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No shops assigned</p>
          <p className="text-sm mt-1">Contact SprintAI support to set up your restaurant.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">My Shops</h1>
        <p className="text-gray-500 mt-1">Manage your restaurant{shops.length > 1 ? 's' : ''}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {shops.map((shop) => (
          <div key={shop.id} className="card p-6 hover:shadow-md transition-shadow">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0">
                  <Store className="w-5 h-5 text-brand-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">{shop.name}</h3>
                  <p className="text-xs text-gray-400">{shop.slug}</p>
                </div>
              </div>
              {shop.is_paused ? (
                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700">
                  Paused
                </span>
              ) : (
                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                  Active
                </span>
              )}
            </div>

            <div className="border-t border-gray-100 pt-4 grid grid-cols-2 gap-2">
              <Link
                to={`/shops/${shop.id}`}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
              >
                <Settings className="w-4 h-4 text-gray-400" />
                Settings
              </Link>
              <Link
                to={`/shops/${shop.id}`}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
              >
                <UtensilsCrossed className="w-4 h-4 text-gray-400" />
                Menu
              </Link>
              <Link
                to={`/shops/${shop.id}`}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
              >
                <MessageSquare className="w-4 h-4 text-gray-400" />
                Chat
              </Link>
              <Link
                to={`/shop/${shop.id}/financials`}
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
              >
                <DollarSign className="w-4 h-4" />
                Financials
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}