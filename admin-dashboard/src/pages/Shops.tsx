import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Store, ChevronRight, PlusCircle, Pause } from 'lucide-react'
import { supabase } from '../lib/supabase'

interface Shop {
  id: string
  name: string
  slug: string
  phone_number_e164: string | null
  is_paused: boolean
  timezone: string
  created_at: string
}

interface ShopWithStats extends Shop {
  menuItemCount: number
  orderCount: number
}

export default function Shops() {
  const navigate = useNavigate()

  const { data: shops, isLoading, error } = useQuery<ShopWithStats[]>({
    queryKey: ['shops'],
    queryFn: async () => {
      const { data: shopRows, error: shopErr } = await supabase
        .from('shops')
        .select('id, name, slug, phone_number_e164, is_paused, timezone, created_at')
        .order('created_at', { ascending: false })

      if (shopErr) throw shopErr

      const enriched = await Promise.all(
        (shopRows ?? []).map(async (shop: Shop) => {
          // Get menu IDs for this shop first
          const { data: menuRows } = await supabase
            .from('menus')
            .select('id')
            .eq('shop_id', shop.id)
          const menuIds = (menuRows ?? []).map((m: { id: string }) => m.id)

          let menuCount = 0
          if (menuIds.length > 0) {
            const { count } = await supabase
              .from('menu_items')
              .select('*', { count: 'exact', head: true })
              .in('menu_id', menuIds)
            menuCount = count ?? 0
          }

          const { count: orderCount } = await supabase
            .from('order_carts')
            .select('*', { count: 'exact', head: true })
            .eq('shop_id', shop.id)
            .eq('phase', 'confirmed')

          return { ...shop, menuItemCount: menuCount, orderCount: orderCount ?? 0 }
        })
      )
      return enriched
    },
    refetchInterval: 30_000,
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Shops</h1>
          <p className="text-sm text-gray-500 mt-1">Manage restaurant locations and menus</p>
        </div>
        <button
          onClick={() => navigate('/shops/new')}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
        >
          <PlusCircle className="w-4 h-4" />
          New Shop
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          Failed to load shops: {(error as Error).message}
        </div>
      )}

      {shops && shops.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <Store className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No shops yet</p>
          <p className="text-sm mt-1">Create your first shop to get started</p>
        </div>
      )}

      {shops && shops.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Shop</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Phone</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Items</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Orders</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {shops.map(shop => (
                <tr
                  key={shop.id}
                  onClick={() => navigate(`/shops/${shop.id}`)}
                  className="hover:bg-gray-50 cursor-pointer transition-colors"
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0">
                        <Store className="w-4 h-4 text-brand-600" />
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{shop.name}</p>
                        <p className="text-xs text-gray-400">{shop.slug}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {shop.phone_number_e164 ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-6 py-4 text-gray-600">{shop.menuItemCount}</td>
                  <td className="px-6 py-4 text-gray-600">{shop.orderCount}</td>
                  <td className="px-6 py-4">
                    {shop.is_paused ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700">
                        <Pause className="w-3 h-3" />
                        Paused
                      </span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                        Active
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-gray-400">
                    <ChevronRight className="w-4 h-4" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
