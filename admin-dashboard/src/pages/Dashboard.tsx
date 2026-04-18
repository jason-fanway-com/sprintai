import { useQuery } from '@tanstack/react-query'
import { Users, MessageSquare, ShoppingBag, TrendingUp, Activity } from 'lucide-react'
import { adminFetch } from '../lib/supabase'

interface PlatformStats {
  total_tenants: number
  active_tenants: number
  total_conversations: number
  total_messages: number
  total_orders: number
  messages_last_7_days: number
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
      <p className="text-3xl font-bold text-gray-900">{value.toLocaleString()}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

export default function Dashboard() {
  const { data: stats, isLoading, error } = useQuery<PlatformStats>({
    queryKey: ['platform-stats'],
    queryFn: () => adminFetch<PlatformStats>('/stats'),
    refetchInterval: 60 * 1000, // refresh every minute
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

  const activeRate = stats && stats.total_tenants > 0
    ? Math.round((stats.active_tenants / stats.total_tenants) * 100)
    : 0

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Platform Overview</h1>
        <p className="text-gray-500 mt-1">SprintAI — all tenants, all conversations</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        <StatCard
          label="Total Tenants"
          value={stats?.total_tenants ?? 0}
          icon={Users}
          color="bg-brand-600"
          sub={`${stats?.active_tenants ?? 0} active (${activeRate}%)`}
        />
        <StatCard
          label="Total Conversations"
          value={stats?.total_conversations ?? 0}
          icon={MessageSquare}
          color="bg-purple-600"
        />
        <StatCard
          label="Total Messages"
          value={stats?.total_messages ?? 0}
          icon={Activity}
          color="bg-green-600"
          sub={`${stats?.messages_last_7_days ?? 0} in last 7 days`}
        />
        <StatCard
          label="Orders Placed"
          value={stats?.total_orders ?? 0}
          icon={ShoppingBag}
          color="bg-orange-500"
        />
        <StatCard
          label="Messages / 7d"
          value={stats?.messages_last_7_days ?? 0}
          icon={TrendingUp}
          color="bg-pink-600"
          sub="Inbound customer messages"
        />
        <StatCard
          label="Active Rate"
          value={`${activeRate}%`}
          icon={Activity}
          color="bg-teal-600"
          sub="Tenants currently active"
        />
      </div>

      <div className="card p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Quick Links</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <a href="/tenants" className="btn-secondary justify-center">
            <Users className="w-4 h-4" />
            View Tenants
          </a>
          <a href="/conversations" className="btn-secondary justify-center">
            <MessageSquare className="w-4 h-4" />
            Conversations
          </a>
          <a
            href="https://dashboard.stripe.com"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary justify-center"
          >
            💳 Stripe
          </a>
          <a
            href="https://supabase.com/dashboard"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary justify-center"
          >
            🗄️ Supabase
          </a>
        </div>
      </div>
    </div>
  )
}
