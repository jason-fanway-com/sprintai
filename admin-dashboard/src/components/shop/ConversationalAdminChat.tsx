import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, RefreshCw, MessageSquare, Sparkles, Mic, MicOff, Undo2, X, Check } from 'lucide-react'
import { supabase, supabaseUrl } from '../../lib/supabase'

// Web Speech API type declarations (not in standard TS lib)
interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognition
}
interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  confirmationCard?: ConfirmationCard
  executedResult?: ExecutedResult
}

interface ConfirmationCard {
  type: 'confirmation_card'
  action_id: string
  intent: string
  summary: string
  details: Record<string, unknown>
  cancel_label: string
  confirm_label: string
}

interface ExecutedResult {
  type: 'executed'
  action_id: string
  result: string
  intent: string
  undo_token: string
  status_header: StatusHeader
}

interface StatusHeader {
  delivery_enabled: boolean
  items_86d_today: number
  active_specials_count: number
  items_86d_names: string[]
  active_specials_names: string[]
}

interface Props {
  shopId: string
}

function makeStorageKey(shopId: string) {
  return `admin-chat-history-${shopId}`
}

// Quick-action chips
const QUICK_ACTIONS = [
  { label: '86 an item', message: '86 an item' },
  { label: 'Add special', message: 'add a special' },
  { label: 'Pause delivery', message: 'pause delivery' },
  { label: "What's 86'd?", message: "what's 86'd right now?" },
]

export default function ConversationalAdminChat({ shopId }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const stored = localStorage.getItem(makeStorageKey(shopId))
      return stored ? JSON.parse(stored) : []
    } catch { return [] }
  })
  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [statusHeader, setStatusHeader] = useState<StatusHeader | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  // Persist messages to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(makeStorageKey(shopId), JSON.stringify(messages))
    } catch { /* ignore */ }
  }, [messages, shopId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const clearHistory = () => {
    localStorage.removeItem(makeStorageKey(shopId))
    setMessages([])
    setStatusHeader(null)
  }

  const sendMessage = useCallback(async (text?: string) => {
    const messageText = text ?? inputValue.trim()
    if (!messageText || isLoading) return

    setInputValue('')
    setMessages(prev => [...prev, { role: 'user', content: messageText }])
    setIsLoading(true)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Please log in again.' }])
        setIsLoading(false)
        return
      }

      const history = messages.slice(-19).map(m => ({ role: m.role, content: m.content }))

      const res = await fetch(`${supabaseUrl}/functions/v1/admin-chat`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: messageText,
          message_history: history,
          shop_id: shopId,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.error ?? 'Something went wrong.' }])
      } else if (data.type === 'confirmation_card') {
        // Show confirmation card
        const card = data as ConfirmationCard
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: card.summary,
          confirmationCard: card,
        }])
      } else if (data.type === 'executed') {
        // Action was executed (undo or direct)
        const executed = data as ExecutedResult
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: executed.result,
          executedResult: executed,
        }])
        setStatusHeader(executed.status_header)
      } else {
        // Plain text reply (clarification, error, or QUERY_STATUS)
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply ?? 'Done.' }])
        if (data.status_header) {
          setStatusHeader(data.status_header as StatusHeader)
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Connection error. Try again.' }])
    } finally {
      setIsLoading(false)
    }
  }, [inputValue, isLoading, messages, shopId])

  const confirmAction = async (card: ConfirmationCard) => {
    setIsLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Please log in again.' }])
        setIsLoading(false)
        return
      }

      const history = messages.slice(-19).map(m => ({ role: m.role, content: m.content }))
      const proposalJson = JSON.stringify(card.details)

      const res = await fetch(`${supabaseUrl}/functions/v1/admin-chat`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: proposalJson,
          message_history: history,
          shop_id: shopId,
          confirmed_action_id: card.action_id,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.error ?? 'Action failed.' }])
      } else if (data.type === 'executed') {
        const executed = data as ExecutedResult
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: executed.result,
          executedResult: executed,
        }])
        setStatusHeader(executed.status_header)
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply ?? data.error ?? 'Done.' }])
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Connection error. Try again.' }])
    } finally {
      setIsLoading(false)
    }
  }

  const undoAction = async (undoToken: string) => {
    setIsLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Please log in again.' }])
        setIsLoading(false)
        return
      }

      const res = await fetch(`${supabaseUrl}/functions/v1/admin-chat`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'undo',
          message_history: messages.slice(-19).map(m => ({ role: m.role, content: m.content })),
          shop_id: shopId,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.error ?? 'Undo failed.' }])
      } else if (data.type === 'executed') {
        const executed = data as ExecutedResult
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: executed.result,
          executedResult: executed,
        }])
        setStatusHeader(executed.status_header)
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply ?? 'Undo failed.' }])
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Connection error. Try again.' }])
    } finally {
      setIsLoading(false)
    }
  }

  // Dictation: Web Speech API
  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop()
      setIsListening(false)
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser. Try Chrome or Safari.')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = 'en-US'

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript
      setInputValue(prev => prev ? `${prev} ${transcript}` : transcript)
      setIsListening(false)
    }

    recognition.onerror = () => {
      setIsListening(false)
    }

    recognition.onend = () => {
      setIsListening(false)
    }

    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
  }

  // Fallback: if Web Speech API not available, use input-based dictation
  const nativeDictation = () => {
    // On iOS, the "dictation" inputMode triggers the native keyboard mic
    inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Live Status Header */}
      {statusHeader && (
        <div className="px-3 sm:px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2 sm:gap-3 text-xs flex-wrap">
          <div className={`flex items-center gap-1.5 ${statusHeader.delivery_enabled ? 'text-green-700' : 'text-orange-600'}`}>
            <div className={`w-2 h-2 rounded-full ${statusHeader.delivery_enabled ? 'bg-green-500' : 'bg-orange-500'}`} />
            {statusHeader.delivery_enabled ? 'Delivery on' : 'Delivery off'}
          </div>
          <div className="text-gray-500">
            <span className="font-semibold text-red-600">{statusHeader.items_86d_today}</span> 86'd
          </div>
          <div className="text-gray-500">
            <span className="font-semibold text-brand-600">{statusHeader.active_specials_count}</span> specials
          </div>
          {statusHeader.items_86d_names.length > 0 && (
            <div className="text-gray-400 truncate flex-1 min-w-0 text-right" title={statusHeader.items_86d_names.join(', ')}>
              86'd: {statusHeader.items_86d_names.slice(0, 3).join(', ')}{statusHeader.items_86d_names.length > 3 ? '...' : ''}
            </div>
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-3 sm:px-4 py-2.5 sm:py-3 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-brand-600" />
          <h3 className="text-sm font-semibold text-gray-700">Talk to Your Menu</h3>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearHistory}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-600 transition-colors rounded"
            title="Clear chat history"
            style={{ minHeight: 44 }}
          >
            <RefreshCw className="w-3 h-3" />
            Clear
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 min-h-0">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <MessageSquare className="w-8 h-8 mx-auto mb-3 text-gray-300" />
            <p className="text-sm text-gray-400 mb-2">Chat with your menu</p>
            <div className="text-xs text-gray-400 space-y-1">
              <p>"86 the tuna melt"</p>
              <p>"Add a special: Friday Lobster Roll for $18"</p>
              <p>"Pause delivery for an hour — kitchen is slammed"</p>
              <p>"What's 86'd right now?"</p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => {
          const isUser = msg.role === 'user'
          const hasConfirmationCard = !!msg.confirmationCard
          const hasExecutedResult = !!msg.executedResult

          return (
            <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
              <div className="max-w-[85%] space-y-2">
                {/* Message bubble */}
                <div
                  className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                    isUser
                      ? 'bg-brand-600 text-white rounded-br-lg'
                      : 'bg-gray-100 text-gray-800 rounded-bl-lg'
                  }`}
                >
                  {msg.content.split('\n').map((line, j) => (
                    <span key={j}>
                      {j > 0 && <br />}
                      {line}
                    </span>
                  ))}
                </div>

                {/* Confirmation Card */}
                {hasConfirmationCard && (
                  <div className="bg-white border-2 border-brand-300 rounded-xl p-3 shadow-sm">
                    <p className="text-sm text-gray-700 mb-3 font-medium">{msg.confirmationCard!.summary}</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          // Remove the confirmation card (cancel)
                          setMessages(prev => prev.map((m, idx) => {
                            if (idx === i) {
                              const { confirmationCard, ...rest } = m
                              return { ...rest, content: m.confirmationCard!.summary + ' (cancelled)' }
                            }
                            return m
                          }))
                        }}
                        disabled={isLoading}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                        style={{ minHeight: 44 }}
                      >
                        <X className="w-3 h-3" />
                        Cancel
                      </button>
                      <button
                        onClick={() => confirmAction(msg.confirmationCard!)}
                        disabled={isLoading}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
                        style={{ minHeight: 44 }}
                      >
                        {isLoading ? (
                          <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" />
                        ) : (
                          <Check className="w-3 h-3" />
                        )}
                        Confirm
                      </button>
                    </div>
                  </div>
                )}

                {/* Inline Undo button for executed actions */}
                {hasExecutedResult && msg.executedResult!.undo_token && msg.executedResult!.intent !== 'QUERY_STATUS' && msg.executedResult!.intent !== 'UNDO' && (
                  <button
                    onClick={() => undoAction(msg.executedResult!.undo_token)}
                    disabled={isLoading}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-brand-600 border border-gray-200 rounded-md hover:border-brand-300 transition-colors"
                    style={{ minHeight: 44 }}
                  >
                    <Undo2 className="w-3 h-3" />
                    Undo
                  </button>
                )}
              </div>
            </div>
          )
        })}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-800 rounded-2xl rounded-bl-lg px-4 py-2.5">
              <div className="flex gap-1.5">
                <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick-action chips */}
      <div className="px-3 sm:px-4 py-2 flex gap-2 overflow-x-auto border-t border-gray-100">
        {QUICK_ACTIONS.map(action => (
          <button
            key={action.label}
            onClick={() => sendMessage(action.message)}
            disabled={isLoading}
            className="flex-shrink-0 px-3 py-1.5 text-xs bg-gray-100 text-gray-600 rounded-full hover:bg-brand-50 hover:text-brand-600 border border-transparent hover:border-brand-200 transition-colors disabled:opacity-50"
            style={{ minHeight: 36 }}
          >
            {action.label}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="px-3 sm:px-4 py-3 border-t border-gray-200">
        <form
          onSubmit={e => { e.preventDefault(); sendMessage() }}
          className="flex gap-2"
        >
          {/* Mic button */}
          <button
            type="button"
            onClick={toggleListening}
            disabled={isLoading}
            className={`flex items-center justify-center w-10 h-10 sm:w-9 sm:h-9 rounded-lg transition-colors flex-shrink-0 ${
              isListening
                ? 'bg-red-500 text-white animate-pulse'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
            title={isListening ? 'Stop listening' : 'Dictate'}
            style={{ minHeight: 44, minWidth: 44 }}
          >
            {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>

          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            placeholder="86 the tuna melt..."
            disabled={isLoading}
            className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
            style={{ minHeight: 44 }}
          />
          <button
            type="submit"
            disabled={isLoading || !inputValue.trim()}
            className="flex items-center gap-1 px-3 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors flex-shrink-0"
            style={{ minHeight: 44, minWidth: 44 }}
          >
            {isLoading ? (
              <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
          </button>
        </form>
      </div>
    </div>
  )
}