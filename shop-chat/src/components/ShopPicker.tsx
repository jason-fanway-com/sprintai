import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Store, ChevronRight } from 'lucide-react'

interface Shop {
  id: string
  name: string
  slug: string
}

interface ShopPickerProps {
  tenantId: string
  onSelect: (shop: Shop) => void
}

export default function ShopPicker({ tenantId, onSelect }: ShopPickerProps) {
  const [shops, setShops] = useState<Shop[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function fetchShops() {
      const { data, error } = await supabase
        .from('shops')
        .select('id, name, slug')
        .eq('tenant_id', tenantId)
        .order('name')

      if (error) {
        setError('Failed to load shops: ' + error.message)
      } else if (!data || data.length === 0) {
        setError('No shops found for your account.')
      } else {
        setShops(data)
      }
      setLoading(false)
    }
    fetchShops()
  }, [tenantId])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-50">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-brand-600 animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-2.5 h-2.5 rounded-full bg-brand-600 animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-2.5 h-2.5 rounded-full bg-brand-600 animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-50 px-4">
        <p className="text-sm text-red-600 text-center">{error}</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-6">
          <Store className="w-7 h-7 text-brand-600" />
          <span className="text-xl font-bold text-gray-900">Select a Shop</span>
        </div>
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {shops.map((shop) => (
            <button
              key={shop.id}
              onClick={() => onSelect(shop)}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-b-0"
              style={{ minHeight: 56 }}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-brand-100 flex items-center justify-center">
                  <Store className="w-5 h-5 text-brand-600" />
                </div>
                <span className="text-sm font-medium text-gray-900">{shop.name}</span>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400" />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
