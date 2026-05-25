import { ArrowLeft, Pause, Play } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { UseMutationResult } from '@tanstack/react-query'

interface Shop {
  id: string
  name: string
  slug: string
  phone_number_e164: string | null
  is_paused: boolean
}

interface ShopHeaderProps {
  shop: Shop
  togglePause: UseMutationResult<void, Error, boolean, unknown>
}

export default function ShopHeader({ shop, togglePause }: ShopHeaderProps) {
  const navigate = useNavigate()

  return (
    <div className="flex items-center gap-4">
      <button
        onClick={() => navigate('/shops')}
        className="text-gray-400 hover:text-gray-600 transition-colors"
      >
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
  )
}
