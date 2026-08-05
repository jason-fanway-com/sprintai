import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

interface Shop {
  id: string
  name: string
}

interface ChatTranscript {
  id: string
  shop_id: string
  user_id: string
  session_id: string
  turn_type: string
  parsed_intent: string | null
  outcome: string
  latency_ms: number | null
  created_at: string
}

const OUTCOMES = [
  'confirmation_card',
  'clarification',
  'executed',
  'query_status',
  'out_of_scope',
  'no_tool_call',
  'validation_error',
  'api_error',
  'error',
] as const

const outcomeColors: Record<string, string> = {
  confirmation_card: 'bg-green-100 text-green-800',
  executed: 'bg-green-100 text-green-800',
  query_status: 'bg-green-100 text-green-800',
  clarification: 'bg-yellow-100 text-yellow-800',
  out_of_scope: 'bg-yellow-100 text-yellow-800',
  no_tool_call: 'bg-yellow-100 text-yellow-800',
  validation_error: 'bg-red-100 text-red-800',
  api_error: 'bg-red-100 text-red-800',
  error: 'bg-red-100 text-red-800',
}

function truncateUserId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) + '…' : id
}

export default function ShopChatTranscripts() {
  const [page, setPage] = useState(1)
  const [shopFilter, setShopFilter] = useState<string>('all')
  const [outcomeFilter, setOutcomeFilter] = useState<string>('all')

  const { data: shops } = useQuery<Shop[]>({
    queryKey: ['shops-list'],
    queryFn: async () => {
      const { data } = await supabase.from('shops').select('id, name').order('name')
      return (data ?? []) as Shop[]
    },
  })

  const { data, isLoading } = useQuery({
    queryKey: ['shop-chat-transcripts', page, shopFilter, outcomeFilter],
    queryFn: async () => {
      let q = supabase
        .from('admin_chat_transcripts')
        .select(
          'id, shop_id, user_id, session_id, turn_type, parsed_intent, outcome, latency_ms, created_at',
          { count: 'exact' },
        )
        .order('created_at', { ascending: false })
        .range((page - 1) * 25, page * 25 - 1)

      if (shopFilter !== 'all') q = q.eq('shop_id', shopFilter)
      if (outcomeFilter !== 'all') q = q.eq('outcome', outcomeFilter)

      const { data: rows, count } = await q
      return { transcripts: (rows ?? []) as ChatTranscript[], total: count ?? 0 }
    },
  })

  const shopName = (id: string) => shops?.find((s) => s.id === id)?.name ?? id.slice(0, 8)

  function latencyColor(ms: number | null): string {
    if (ms == null) return 'text-gray-400'
    if (ms > 10000) return 'text-red-600'
    if (ms > 5000) return 'text-yellow-600'
    return 'text-gray-500'
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Shop Chats</h1>
          <p className="text-gray-500 mt-1">{data?.total ?? 0} total transcripts</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <select
          value={shopFilter}
          onChange={(e) => { setShopFilter(e.target.value); setPage(1) }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
        >
          <option value="all">All shops</option>
          {shops?.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select
          value={outcomeFilter}
          onChange={(e) => { setOutcomeFilter(e.target.value); setPage(1) }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
        >
          <option value="all">All outcomes</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-6 py-3 font-medium text-gray-500">Shop</th>
              <th className="text-left px-6 py-3 font-medium text-gray-500">User</th>
              <th className="text-left px-6 py-3 font-medium text-gray-500">Outcome</th>
              <th className="text-left px-6 py-3 font-medium text-gray-500">Intent</th>
              <th className="text-left px-6 py-3 font-medium text-gray-500">Latency</th>
              <th className="text-left px-6 py-3 font-medium text-gray-500">Time</th>
              <th className="px-6 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              [...Array(8)].map((_, i) => (
                <tr key={i}>
                  <td colSpan={7} className="px-6 py-4">
                    <div className="h-4 bg-gray-100 rounded animate-pulse" />
                  </td>
                </tr>
              ))
            ) : data?.transcripts.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-gray-400">
                  No transcripts yet
                </td>
              </tr>
            ) : (
              data?.transcripts.map((t) => (
                <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 font-medium text-gray-700">{shopName(t.shop_id)}</td>
                  <td className="px-6 py-4">
                    <span className="font-mono text-xs" title={t.user_id}>{truncateUserId(t.user_id)}</span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${outcomeColors[t.outcome] ?? 'bg-gray-100 text-gray-600'}`}>
                      {t.outcome.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    {t.parsed_intent ?? '—'}
                  </td>
                  <td className={`px-6 py-4 font-mono text-xs ${latencyColor(t.latency_ms)}`}>
                    {t.latency_ms != null ? `${t.latency_ms} ms` : '—'}
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    {new Date(t.created_at).toLocaleString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link to={`/shop-chats/${t.id}`} className="btn-secondary text-xs py-1.5">
                      View
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && data.total > 25 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-gray-500">
            Showing {(page - 1) * 25 + 1}–{Math.min(page * 25, data.total)} of {data.total}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn-secondary disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page * 25 >= data.total}
              className="btn-secondary disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
