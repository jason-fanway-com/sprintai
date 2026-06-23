import { useState, useRef, useEffect } from 'react'
import { Send, RefreshCw, MessageSquare, ShoppingCart, X } from 'lucide-react'
import { supabase, supabaseAnonKey } from '../lib/supabase'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

interface CartItem {
  menu_item_id: string
  name: string
  quantity: number
  price_cents: number
  modifiers: string[]
}

interface Props {
  shopId: string
  shopName: string
}

function makeStorageKey(shopId: string) {
  return `chat-test-session-${shopId}`
}

// Gated test-mode affordance: when the admin dashboard is opened with ?test=1
// in the page URL, the chat test sends `test: true` to chat-sms, which puts the
// cart in test mode (bypasses business hours, routes payment to the test
// success page). The normal customer-facing widget never sets this flag, so
// real diners are unaffected. Read once at module load.
const WEB_TEST_MODE =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('test') === '1'

function getOrCreateSessionId(shopId: string): string {
  const key = makeStorageKey(shopId)
  let id = localStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(key, id)
  }
  return id
}

export default function ShopChatTest({ shopId, shopName }: Props) {
  const [messages, setMessages]       = useState<ChatMessage[]>([])
  const [inputValue, setInputValue]   = useState('')
  const [isLoading, setIsLoading]     = useState(false)
  const [sessionId, setSessionId]     = useState(() => getOrCreateSessionId(shopId))
  const [cart, setCart]               = useState<CartItem[]>([])
  const [phase, setPhase]             = useState<string>('greeting')
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null)
  const [showCart, setShowCart]       = useState(false)
  const messagesEndRef   = useRef<HTMLDivElement>(null)
  const pollStartTimeRef = useRef<string | null>(null)
  const inputRef         = useRef<HTMLInputElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    newConversation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId])

  // Poll for payment status changes while in checkout phase
  useEffect(() => {
    if (phase !== 'checkout') return

    pollStartTimeRef.current = new Date().toISOString()
    let convId: string | null = null
    let stopped = false

    const poll = async () => {
      if (stopped) return
      try {
        if (!convId) {
          const { data: conv } = await supabase
            .from('conversations')
            .select('id')
            .eq('session_id', sessionId)
            .eq('channel', 'web')
            .single()
          if (conv) convId = conv.id
        }
        if (!convId) return

        const { data: cartData } = await supabase
          .from('order_carts')
          .select('phase')
          .eq('conversation_id', convId)
          .order('created_at', { ascending: false })
          .limit(1)
          .single()
        if (!cartData) return

        if (cartData.phase === 'confirmed') {
          stopped = true
          setPhase('confirmed')
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: 'Payment received! Your order is confirmed.',
            timestamp: new Date(),
          }])
          const { data: newMsgs } = await supabase
            .from('messages')
            .select('role, content, inserted_at')
            .eq('conversation_id', convId)
            .eq('role', 'assistant')
            .gt('inserted_at', pollStartTimeRef.current!)
            .order('inserted_at', { ascending: true })
          if (newMsgs?.length) {
            setMessages(prev => [
              ...prev,
              ...newMsgs.map((m: { role: string; content: string; inserted_at: string }) => ({
                role: 'assistant' as const,
                content: m.content,
                timestamp: new Date(m.inserted_at),
              })),
            ])
          }
        } else if (cartData.phase === 'expired') {
          stopped = true
          setPhase('expired')
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: 'Payment link expired. Say restart to try again.',
            timestamp: new Date(),
          }])
        }
      } catch (err) {
        console.error('[ShopChatTest] Polling error:', err)
      }
    }

    const intervalId = setInterval(poll, 3000)
    return () => {
      stopped = true
      clearInterval(intervalId)
    }
  }, [phase, sessionId])

  const sendMessage = async () => {
    if (!inputValue.trim() || isLoading) return

    const userMsg = inputValue.trim()
    setInputValue('')
    setMessages(prev => [...prev, { role: 'user', content: userMsg, timestamp: new Date() }])
    setIsLoading(true)

    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string

      const res = await fetch(`${supabaseUrl}/functions/v1/chat-sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseAnonKey}`,
        },
        body: JSON.stringify({
          shop_id:    shopId,
          message:    userMsg,
          session_id: sessionId,
          ...(WEB_TEST_MODE ? { test: true } : {}),
        }),
      })

      const data = await res.json()
      if (data.reply) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply, timestamp: new Date() }])
      }
      if (data.cart)         setCart(data.cart)
      if (data.phase)        setPhase(data.phase)
      if (data.checkout_url) setCheckoutUrl(data.checkout_url)
      if (data.session_id)   localStorage.setItem(makeStorageKey(shopId), data.session_id)
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : 'Failed to connect'}`,
        timestamp: new Date(),
      }])
    } finally {
      setIsLoading(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  const newConversation = () => {
    const newId = crypto.randomUUID()
    localStorage.setItem(makeStorageKey(shopId), newId)
    setSessionId(newId)
    setMessages([])
    setCart([])
    setPhase('greeting')
    setCheckoutUrl(null)
  }

  const cartSubtotal = cart.reduce((s, i) => s + i.price_cents * i.quantity, 0)
  const cartCount    = cart.reduce((s, i) => s + i.quantity, 0)

  const phaseColors: Record<string, string> = {
    greeting:  'bg-gray-100 text-gray-600',
    building:  'bg-blue-100 text-blue-700',
    review:    'bg-yellow-100 text-yellow-700',
    checkout:  'bg-purple-100 text-purple-700',
    confirmed: 'bg-green-100 text-green-700',
    expired:   'bg-red-100 text-red-700',
  }

  return (
    <div className="inline-flex flex-col bg-[#1a1a1a] rounded-[40px] p-3 shadow-2xl">
      <div className="bg-gray-100 rounded-[32px] overflow-hidden flex flex-col w-[300px] h-[580px] relative">

        {/* Header */}
        <div className="bg-white border-b border-gray-200 px-3 py-2.5 flex items-center gap-2 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate leading-tight">{shopName}</p>
            <span className={`inline-flex px-1.5 py-0.5 rounded-full text-xs font-medium leading-none mt-0.5 ${phaseColors[phase] ?? 'bg-gray-100 text-gray-600'}`}>
              {phase}
            </span>
          </div>
          <button
            onClick={() => setShowCart(v => !v)}
            title={showCart ? 'Hide cart' : 'Show cart'}
            className={`relative p-1.5 rounded-lg transition-colors flex-shrink-0 ${
              showCart ? 'bg-brand-50 text-brand-600' : 'text-gray-400 hover:bg-gray-100'
            }`}
          >
            <ShoppingCart className="w-4 h-4" />
            {cartCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-brand-600 text-white text-xs font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                {cartCount}
              </span>
            )}
          </button>
          <button
            onClick={newConversation}
            title="New conversation"
            className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg transition-colors flex-shrink-0"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-gray-400">
              <MessageSquare className="w-8 h-8 mb-2 opacity-30" />
              <p className="font-medium text-xs">Start a conversation</p>
              <p className="text-xs mt-1 text-center opacity-70">Type a message below</p>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] px-3 py-2 rounded-2xl text-xs whitespace-pre-wrap break-words ${
                  msg.role === 'user'
                    ? 'bg-brand-600 text-white rounded-br-sm'
                    : 'bg-white text-gray-900 border border-gray-200 rounded-bl-sm shadow-sm'
                }`}
              >
                {msg.content}
                <p className={`text-xs mt-1 opacity-70 ${msg.role === 'user' ? 'text-brand-100' : 'text-gray-400'}`}>
                  {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-sm px-3 py-2.5 shadow-sm">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input bar */}
        <div className="bg-white border-t border-gray-200 p-2 flex gap-1.5 flex-shrink-0">
          <input
            ref={inputRef}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
            placeholder="Type as the customer..."
            disabled={isLoading}
            autoFocus
            className="flex-1 px-3 py-1.5 text-xs border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50 min-w-0"
          />
          <button
            onClick={sendMessage}
            disabled={!inputValue.trim() || isLoading}
            className="px-2.5 py-1.5 bg-brand-600 text-white rounded-xl hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Cart slide-over panel */}
        {showCart && (
          <div className="absolute inset-0 bg-white rounded-[32px] flex flex-col z-10">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
              <div className="flex items-center gap-2">
                <ShoppingCart className="w-4 h-4 text-gray-400" />
                <span className="text-sm font-semibold text-gray-900">Cart</span>
              </div>
              <button
                onClick={() => setShowCart(false)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              {cart.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-400">
                  <ShoppingCart className="w-8 h-8 mb-2 opacity-30" />
                  <p className="text-xs">Cart is empty</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {cart.map((item, i) => (
                    <div key={i} className="bg-gray-50 rounded-xl p-2.5">
                      <div className="flex items-start justify-between gap-1">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-900 leading-tight">{item.name}</p>
                          {item.modifiers?.length > 0 && (
                            <p className="text-xs text-gray-500 mt-0.5 truncate">{item.modifiers.join(', ')}</p>
                          )}
                        </div>
                        <span className="text-xs text-gray-500 flex-shrink-0">x{item.quantity}</span>
                      </div>
                      <p className="text-xs text-gray-600 mt-1">
                        ${((item.price_cents * item.quantity) / 100).toFixed(2)}
                      </p>
                    </div>
                  ))}

                  <div className="pt-2 border-t border-gray-200">
                    <div className="flex justify-between text-xs font-semibold text-gray-900">
                      <span>Subtotal</span>
                      <span>${(cartSubtotal / 100).toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              )}

              {checkoutUrl && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-gray-500 mb-1">Payment Link</p>
                  <a
                    href={checkoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-xs text-brand-600 hover:text-brand-700 break-all underline"
                  >
                    {checkoutUrl}
                  </a>
                </div>
              )}

              <div className="mt-3 pt-3 border-t border-gray-100">
                <p className="text-xs font-medium text-gray-500 mb-1.5">Debug</p>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">Phase</span>
                    <span className="font-mono text-gray-600">{phase}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">Session</span>
                    <span className="font-mono text-gray-400 truncate ml-2 max-w-20" title={sessionId}>
                      {sessionId.substring(0, 8)}...
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
