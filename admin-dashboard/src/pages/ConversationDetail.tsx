import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, User, Bot } from 'lucide-react'
import { supabase } from '../lib/supabase'

interface Message {
  id: string
  role: 'customer' | 'assistant' | 'system'
  content: string
  tokens_used: number
  created_at: string
}

interface Conversation {
  id: string
  tenant_id: string
  customer_phone: string
  status: string
  started_at: string
  last_message_at: string
}

export default function ConversationDetail() {
  const { id } = useParams<{ id: string }>()

  const { data: conversation } = useQuery<Conversation>({
    queryKey: ['conversation', id],
    queryFn: async () => {
      const { data } = await supabase
        .from('conversations')
        .select('*')
        .eq('id', id)
        .single()
      return data as Conversation
    },
  })

  const { data: messages, isLoading } = useQuery<Message[]>({
    queryKey: ['messages', id],
    queryFn: async () => {
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', id)
        .order('created_at', { ascending: true })
      return (data ?? []) as Message[]
    },
    refetchInterval: 10 * 1000, // refresh every 10s for live view
  })

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-center gap-4 mb-6">
        <Link to="/conversations" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            Conversation — {conversation?.customer_phone ?? '...'}
          </h1>
          {conversation && (
            <p className="text-sm text-gray-500 mt-0.5">
              Started {new Date(conversation.started_at).toLocaleString()} ·{' '}
              <span className={`badge-${conversation.status}`}>{conversation.status}</span>
            </p>
          )}
        </div>
      </div>

      <div className="space-y-4">
        {isLoading ? (
          [...Array(4)].map((_, i) => (
            <div key={i} className={`flex ${i % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
              <div className="h-12 bg-gray-100 rounded-xl w-64 animate-pulse" />
            </div>
          ))
        ) : messages?.length === 0 ? (
          <div className="text-center text-gray-400 py-12">No messages yet</div>
        ) : (
          messages?.filter((m) => m.role !== 'system').map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 ${msg.role === 'customer' ? 'justify-start' : 'justify-end'}`}
            >
              {msg.role === 'customer' && (
                <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 mt-1">
                  <User className="w-4 h-4 text-gray-500" />
                </div>
              )}
              <div
                className={`max-w-sm lg:max-w-md px-4 py-3 rounded-2xl text-sm ${
                  msg.role === 'customer'
                    ? 'bg-white border border-gray-200 text-gray-700'
                    : 'bg-brand-600 text-white'
                }`}
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>
                <p className={`text-xs mt-1 ${msg.role === 'customer' ? 'text-gray-400' : 'text-blue-200'}`}>
                  {new Date(msg.created_at).toLocaleTimeString()}
                  {msg.role === 'assistant' && msg.tokens_used > 0 && (
                    <span className="ml-2">{msg.tokens_used} tokens</span>
                  )}
                </p>
              </div>
              {msg.role === 'assistant' && (
                <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0 mt-1">
                  <Bot className="w-4 h-4 text-white" />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
