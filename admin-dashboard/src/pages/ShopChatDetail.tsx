import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, User, Bot, Clock, Zap } from 'lucide-react'
import { supabase } from '../lib/supabase'

interface ChatTranscript {
  id: string
  shop_id: string
  user_id: string
  session_id: string
  turn_type: string
  raw_message: string
  message_history: unknown
  llm_raw_response: unknown
  parsed_intent: string | null
  parsed_proposal: unknown
  outcome: string
  response_sent: unknown
  error_message: string | null
  latency_ms: number | null
  created_at: string
}

interface Shop {
  id: string
  name: string
}

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

function formatJson(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2)
  } catch {
    return String(obj)
  }
}

function extractResponseMessage(responseSent: unknown): string | null {
  if (!responseSent) return null
  if (typeof responseSent === 'string') {
    // could be a JSON string — try parse
    try {
      const parsed = JSON.parse(responseSent)
      return extractResponseMessage(parsed)
    } catch {
      return responseSent
    }
  }
  if (typeof responseSent === 'object' && responseSent !== null) {
    const obj = responseSent as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
    // If there's no message field, just return null — raw JSON will render below
    return null
  }
  return null
}

function hasStructuredResponse(responseSent: unknown): boolean {
  if (!responseSent || typeof responseSent !== 'object') return false
  // Check for confirmation_card or proposal at any level
  const json = JSON.stringify(responseSent)
  return json.includes('confirmation_card') || json.includes('"proposal"')
}

export default function ShopChatDetail() {
  const { id } = useParams<{ id: string }>()

  const { data: transcript, isLoading } = useQuery<ChatTranscript>({
    queryKey: ['shop-chat', id],
    queryFn: async () => {
      const { data } = await supabase
        .from('admin_chat_transcripts')
        .select('*')
        .eq('id', id)
        .single()
      return data as ChatTranscript
    },
  })

  const { data: shops } = useQuery<Shop[]>({
    queryKey: ['shops-list'],
    queryFn: async () => {
      const { data } = await supabase.from('shops').select('id, name')
      return (data ?? []) as Shop[]
    },
  })

  const shopName = (shopId: string) => shops?.find((s) => s.id === shopId)?.name ?? shopId.slice(0, 8)

  const responseMsg = transcript ? extractResponseMessage(transcript.response_sent) : null
  const showStructuredResponse = transcript ? hasStructuredResponse(transcript.response_sent) : false

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-center gap-4 mb-6">
        <Link to="/shop-chats" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            Shop Chat — {transcript ? shopName(transcript.shop_id) : '...'}
          </h1>
          {transcript && (
            <p className="text-sm text-gray-500 mt-0.5">
              {shopName(transcript.shop_id)} · {transcript.user_id} ·{' '}
              {new Date(transcript.created_at).toLocaleString()} ·{' '}
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${outcomeColors[transcript.outcome] ?? 'bg-gray-100 text-gray-600'}`}>
                {transcript.outcome.replace(/_/g, ' ')}
              </span>
            </p>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-12 bg-gray-100 rounded-xl w-64 animate-pulse" />
          ))}
        </div>
      ) : !transcript ? (
        <div className="text-center text-gray-400 py-12">Transcript not found</div>
      ) : (
        <div className="space-y-6">
          {/* Chat bubbles */}
          <div className="space-y-4">
            {/* User message */}
            <div className="flex gap-3 justify-start">
              <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 mt-1">
                <User className="w-4 h-4 text-gray-500" />
              </div>
              <div className="max-w-sm lg:max-w-md px-4 py-3 rounded-2xl text-sm bg-white border border-gray-200 text-gray-700">
                <p className="whitespace-pre-wrap">{transcript.raw_message || '(no message)'}</p>
              </div>
            </div>

            {/* AI response */}
            <div className="flex gap-3 justify-end">
              <div className="max-w-sm lg:max-w-md px-4 py-3 rounded-2xl text-sm bg-brand-600 text-white">
                {responseMsg ? (
                  <p className="whitespace-pre-wrap">{responseMsg}</p>
                ) : (
                  <p className="whitespace-pre-wrap text-blue-100 text-xs font-mono">{formatJson(transcript.response_sent)}</p>
                )}
              </div>
              <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0 mt-1">
                <Bot className="w-4 h-4 text-white" />
              </div>
            </div>

            {/* Structured response (confirmation_card / proposal) rendered below bubbles */}
            {showStructuredResponse && responseMsg && (
              <div className="ml-11">
                <pre className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-xs font-mono text-gray-600 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
                  {formatJson(transcript.response_sent)}
                </pre>
              </div>
            )}
          </div>

          {/* Metadata panel */}
          <div className="card p-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Metadata</h3>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <span className="text-gray-500">Turn type</span>
                <p className="font-medium text-gray-700">{transcript.turn_type}</p>
              </div>
              <div>
                <span className="text-gray-500">Parsed intent</span>
                <p className="font-medium text-gray-700">{transcript.parsed_intent ?? '—'}</p>
              </div>
              <div>
                <span className="text-gray-500">Outcome</span>
                <p>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${outcomeColors[transcript.outcome] ?? 'bg-gray-100 text-gray-600'}`}>
                    {transcript.outcome.replace(/_/g, ' ')}
                  </span>
                </p>
              </div>
              <div>
                <span className="text-gray-500">Latency</span>
                <p className="font-mono text-xs font-medium text-gray-700">
                  {transcript.latency_ms != null ? `${transcript.latency_ms} ms` : '—'}
                </p>
              </div>
              {transcript.parsed_proposal != null && (
                <div className="col-span-2">
                  <span className="text-gray-500">Parsed proposal</span>
                  <pre className="mt-1 bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs font-mono text-gray-600 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {formatJson(transcript.parsed_proposal)}
                  </pre>
                </div>
              )}
              {transcript.error_message && (
                <div className="col-span-2">
                  <span className="text-gray-500">Error</span>
                  <p className="text-red-600 font-medium">{transcript.error_message}</p>
                </div>
              )}
            </div>
          </div>

          {/* Message history (collapsible) */}
          <details className="card p-4">
            <summary className="cursor-pointer text-sm font-semibold text-gray-900 select-none">
              <span className="inline-flex items-center gap-2">
                <Clock className="w-4 h-4 text-gray-400" />
                Message History (LLM context)
              </span>
            </summary>
            <pre className="mt-3 bg-gray-50 border border-gray-200 rounded-lg p-4 text-xs font-mono text-gray-600 overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
              {formatJson(transcript.message_history)}
            </pre>
          </details>

          {/* LLM raw response (collapsible) */}
          <details className="card p-4">
            <summary className="cursor-pointer text-sm font-semibold text-gray-900 select-none">
              <span className="inline-flex items-center gap-2">
                <Zap className="w-4 h-4 text-gray-400" />
                LLM Raw Response
              </span>
            </summary>
            <pre className="mt-3 bg-gray-50 border border-gray-200 rounded-lg p-4 text-xs font-mono text-gray-600 overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
              {formatJson(transcript.llm_raw_response)}
            </pre>
          </details>
        </div>
      )}
    </div>
  )
}