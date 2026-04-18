import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { MessageSquare, Phone } from 'lucide-react'
import { adminFetch, supabase } from '../lib/supabase'

interface Conversation {
  id: string
  tenant_id: string
  customer_phone: string
  status: string
  started_at: string
  last_message_at: string
  messages: [{ count: number }]
}

interface ConversationsResponse {
  conversations: Conversation[]
  total: number
}

// Fallback: load all from tenants, then list convs
// For simplicity this loads all conversations directly
export default function Conversations() {
  const [page, setPage] = useState(1)

  // We need to list conversations across all tenants
  // Admin API exposes /tenants/:id/conversations per tenant
  // For the global view we query via a special admin endpoint
  const { data, isLoading } = useQuery<ConversationsResponse>({
    queryKey: ['all-conversations', page],
    queryFn: async () => {
      const { data: convs, count } = await supabase
        .from('conversations')
        .select('*, messages(count)', { count: 'exact' })
        .order('last_message_at', { ascending: false })
        .range((page - 1) * 25, page * 25 - 1)

      return { conversations: (convs ?? []) as Conversation[], total: count ?? 0 }
    },
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Conversations</h1>
          <p className="text-gray-500 mt-1">{data?.total ?? 0} total conversations</p>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-6 py-3 font-medium text-gray-500">Customer</th>
              <th className="text-left px-6 py-3 font-medium text-gray-500">Status</th>
              <th className="text-left px-6 py-3 font-medium text-gray-500">Messages</th>
              <th className="text-left px-6 py-3 font-medium text-gray-500">Last Activity</th>
              <th className="px-6 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              [...Array(8)].map((_, i) => (
                <tr key={i}>
                  <td colSpan={5} className="px-6 py-4">
                    <div className="h-4 bg-gray-100 rounded animate-pulse" />
                  </td>
                </tr>
              ))
            ) : data?.conversations.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-gray-400">
                  No conversations yet
                </td>
              </tr>
            ) : (
              data?.conversations.map((conv) => (
                <tr key={conv.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
                        <Phone className="w-4 h-4 text-gray-500" />
                      </div>
                      <span className="font-mono text-sm">{conv.customer_phone}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`badge-${conv.status}`}>{conv.status}</span>
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    <div className="flex items-center gap-1">
                      <MessageSquare className="w-4 h-4" />
                      {conv.messages?.[0]?.count ?? 0}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    {new Date(conv.last_message_at).toLocaleString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link to={`/conversations/${conv.id}`} className="btn-secondary text-xs py-1.5">
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
