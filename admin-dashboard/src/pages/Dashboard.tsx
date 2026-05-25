import { useQuery } from '@tanstack/react-query'
import { Users, MessageSquare, ShoppingBag, Store, Activity } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useNavigate } from 'react-router-dom'

interface PlatformStats {
  total_tenants: number
  total_shops: number
  total_conversations: number
  total_messages: number
  total_orders: number
  total_menu_items: number
}

interface StatCardProps {
  label: string
  value: number | string
  icon: React.ElementType
  color: string
  sub?: string
}

function StatCard({ label, value, icon: Icon, color, sub }: StatCardProps) {
  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-medium text-gray-500">{label}</span>
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
      </div>
      <p className="text-3xl font-bold text-gray-900">{typeof value === 'number' ? value.toLocaleString() : value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

async function fetchStats(): Promise<PlatformStats> {
  const [tenants, shops, conversations, messages, orders, menuItems] = await Promise.all([
    supabase.from('tenants').select('id', { count: 'exact', head: true }),
    supabase.from('shops').select('id', { count: 'exact', head: true }),
    supabase.from('conversations').select('id', { count: 'exact', head: true }),
    supabase.from('messages').select('id', { count: 'exact', head: true }),
    supabase.from('order_carts').select('id', { count: 'exact', head: true }).eq('payment_status', 'paid'),
    supabase.from('menu_items').select('id', { count: 'exact', head: true }).eq('active', true),
  ])
  return {
    total_tenants: tenants.count ?? 0,
    total_shops: shops.count ?? 0,
    total_conversations: conversations.count ?? 0,
    total_messages: messages.count ?? 0,
    total_orders: orders.count ?? 0,
    total_menu_items: menuItems.count ?? 0,
  }
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { data: stats, isLoading, error } = useQuery<PlatformStats>({
    queryKey: ['platform-stats'],
    queryFn: fetchStats,
    refetchInterval: 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="p-8">
        <div className="h-8 bg-gray-200 rounded w-48 mb-6 animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card p-6 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-32 mb-4" />
              <div className="h-8 bg-gray-200 rounded w-24" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="card p-6 bg-red-50 border-red-200">
          <p className="text-red-700">Failed to load stats: {(error as Error).message}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Platform Overview</h1>
        <p className="text-gray-500 mt-1">SprintAI Ordering Platform</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        <StatCard
          label="Shops"
          value={stats?.total_shops ?? 0}
          icon={Store}
          color="bg-brand-600"
        />
        <StatCard
          label="Menu Items"
          value={stats?.total_menu_items ?? 0}
          icon={Activity}
          color="bg-green-600"
          sub="Active items across all shops"
        />
        <StatCard
          label="Conversations"
          value={stats?.total_conversations ?? 0}
          icon={MessageSquare}
          color="bg-purple-600"
        />
        <StatCard
          label="Paid Orders"
          value={stats?.total_orders ?? 0}
          icon={ShoppingBag}
          color="bg-orange-500"
        />
        <StatCard
          label="Messages"
          value={stats?.total_messages ?? 0}
          icon={MessageSquare}
          color="bg-pink-600"
          sub="Total across all conversations"
        />
        <StatCard
          label="Tenants"
          value={stats?.total_tenants ?? 0}
          icon={Users}
          color="bg-teal-600"
        />
      </div>

      <div className="card p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Quick Links</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <button onClick={() => navigate('/shops')} className="btn-secondary justify-center">
            <Store className="w-4 h-4" />
            Shops
          </button>
          <button onClick={() => navigate('/chat-test')} className="btn-secondary justify-center">
            <MessageSquare className="w-4 h-4" />
            Chat Test
          </button>
          <a
            href="https://dashboard.stripe.com"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary justify-center"
          >
            Stripe
          </a>
          <a
            href="https://supabase.com/dashboard/project/rvdqfxtrskxekfkqnegx"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary justify-center"
          >
            Supabase
          </a>
        </div>
      </div>
    </div>
  )
}
