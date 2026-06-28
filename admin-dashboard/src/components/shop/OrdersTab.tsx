import { ShoppingBag } from 'lucide-react'

interface OrderCart {
  id: string
  order_number: number | null
  phase: string
  total_cents: number | null
  created_at: string
  cart_json: Array<{ name: string; quantity: number; price_cents: number }>
  pickup_name: string | null
}

interface OrdersTabProps {
  orders: OrderCart[] | undefined
}

export default function OrdersTab({ orders }: OrdersTabProps) {
  return (
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
                  <p className="font-medium text-gray-900">
                    {order.order_number ? `#${order.order_number} — ` : ''}{order.pickup_name ?? 'No name'}
                  </p>
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
  )
}
