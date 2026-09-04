/**
 * ExpoScreen — live kitchen order board (INSTRUCTION-10 item G).
 *
 * Four states per paid order: new → acknowledged → preparing → done.
 * Advances on human action only — no auto-advance.
 * Holds state across a network drop via Supabase Realtime auto-reconnect.
 * Requests Wake Lock to keep the screen on.
 * Requires a user gesture before audio can play (start-shift unlock).
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useEffectiveTenant } from '../lib/useOwnerTenant'

type ExpoStatus = 'new' | 'acknowledged' | 'preparing' | 'done'

interface OrderCart {
  id: string
  shop_id: string
  order_number: number | null
  pickup_name: string | null
  pickup_time: string | null
  subtotal_cents: number | null
  total_cents: number | null
  notes: string | null
  cart_json: Array<{ name: string; quantity: number; price_cents: number; size_label?: string | null }>
  expo_status: ExpoStatus
  expo_acknowledged_at: string | null
  created_at: string
  payment_status: string
  order_type: string | null
}

const STATUS_LABELS: Record<ExpoStatus, string> = {
  new: 'New',
  acknowledged: 'Acknowledged',
  preparing: 'Preparing',
  done: 'Done',
}

const STATUS_NEXT: Record<ExpoStatus, ExpoStatus | null> = {
  new: 'acknowledged',
  acknowledged: 'preparing',
  preparing: 'done',
  done: null,
}

const STATUS_NEXT_LABEL: Record<ExpoStatus, string> = {
  new: 'Acknowledge',
  acknowledged: 'Start Preparing',
  preparing: 'Mark Done',
  done: '',
}

const ACTIVE_STATUSES: ExpoStatus[] = ['new', 'acknowledged', 'preparing']

function fmt(cents: number | null): string {
  if (cents == null) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

function minutesAgo(ts: string): number {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 60000)
}

export default function ExpoScreen() {
  const { shopId: shopIdParam } = useParams<{ shopId: string }>()
  const { effTenant } = useEffectiveTenant()
  const [resolvedShopId, setResolvedShopId] = useState<string | null>(null)
  const shopId = shopIdParam ?? resolvedShopId ?? undefined
  const [orders, setOrders] = useState<OrderCart[]>([])
  const [connected, setConnected] = useState(true)

  // When no shopId in URL (owner nav), resolve from tenant
  useEffect(() => {
    if (shopIdParam || !effTenant) return
    supabase
      .from('shops')
      .select('id')
      .eq('tenant_id', effTenant)
      .limit(1)
      .single()
      .then(({ data }) => { if (data) setResolvedShopId(data.id) })
  }, [shopIdParam, effTenant])
  const [audioReady, setAudioReady] = useState(false)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const prevOrderIdsRef = useRef<Set<string>>(new Set())

  // Activate Wake Lock
  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return
    try {
      wakeLockRef.current = await (navigator as Navigator & { wakeLock: { request(t: string): Promise<WakeLockSentinel> } }).wakeLock.request('screen')
      setWakeLockActive(true)
      wakeLockRef.current.addEventListener('release', () => setWakeLockActive(false))
    } catch {
      // Wake Lock denied (battery saver mode, etc.) — silent, non-fatal
    }
  }, [])

  // Re-acquire Wake Lock on visibility change (required by spec)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !wakeLockRef.current) {
        requestWakeLock()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    requestWakeLock()
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [requestWakeLock])

  // Audio unlock: requires a user gesture — play a silent beep to unlock AudioContext
  const unlockAudio = useCallback(() => {
    if (audioReady) return
    try {
      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      // Silent unlock oscillator
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      gain.gain.value = 0
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.001)
      ctx.resume().then(() => setAudioReady(true))
    } catch {
      setAudioReady(true)
    }
  }, [audioReady])

  // Beep on new order (after audio is unlocked)
  const playNewOrderSound = useCallback(() => {
    const ctx = audioCtxRef.current
    if (!ctx || !audioReady) return
    try {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.3, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.4)
    } catch { /* non-fatal */ }
  }, [audioReady])

  // Initial load
  useEffect(() => {
    if (!shopId) return
    supabase
      .from('order_carts')
      .select('id, shop_id, order_number, pickup_name, pickup_time, subtotal_cents, total_cents, notes, cart_json, expo_status, expo_acknowledged_at, created_at, payment_status, order_type')
      .eq('shop_id', shopId)
      .eq('payment_status', 'paid')
      .in('expo_status', ACTIVE_STATUSES)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        const rows = (data ?? []) as OrderCart[]
        setOrders(rows)
        prevOrderIdsRef.current = new Set(rows.map(r => r.id))
      })
  }, [shopId])

  // Realtime subscription — holds state across network drop via auto-reconnect
  useEffect(() => {
    if (!shopId) return

    const channel = supabase.channel(`expo-${shopId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'order_carts', filter: `shop_id=eq.${shopId}` },
        (payload) => {
          // A cart is created unpaid and later flipped to paid by the Stripe
          // webhook — so a *new* order arrives as an UPDATE, not an INSERT.
          // Treat every event the same: upsert when paid + active, drop otherwise.
          if (payload.eventType === 'DELETE') {
            const oldId = (payload.old as { id?: string })?.id
            if (oldId) setOrders(prev => prev.filter(o => o.id !== oldId))
            return
          }
          const row = payload.new as OrderCart
          if (!row?.id) return
          const isActivePaid = row.payment_status === 'paid' && ACTIVE_STATUSES.includes(row.expo_status)
          setOrders(prev => {
            const exists = prev.some(o => o.id === row.id)
            if (!isActivePaid) {
              return exists ? prev.filter(o => o.id !== row.id) : prev
            }
            if (exists) {
              return prev.map(o => o.id === row.id ? { ...o, ...row } : o)
            }
            // First time this order becomes visible on the board — announce it.
            if (!prevOrderIdsRef.current.has(row.id)) {
              playNewOrderSound()
              prevOrderIdsRef.current.add(row.id)
            }
            return [...prev, row].sort((a, b) => a.created_at.localeCompare(b.created_at))
          })
        }
      )
      .subscribe((status) => {
        setConnected(status === 'SUBSCRIBED')
      })

    return () => { supabase.removeChannel(channel) }
  }, [shopId, playNewOrderSound])

  // Advance state — human action only. Shop owners have SELECT-only on
  // order_carts (writes go through controlled paths), so the advance is done
  // via the SECURITY DEFINER RPC expo_advance_order, which re-checks ownership
  // and only touches expo_status / expo_acknowledged_at.
  const advance = useCallback(async (orderId: string, current: ExpoStatus) => {
    const next = STATUS_NEXT[current]
    if (!next) return
    const { error } = await supabase.rpc('expo_advance_order', {
      p_order_id: orderId,
      p_next: next,
    })
    if (error) {
      console.error('[expo] advance failed:', error.message)
      return
    }
    // Optimistic update (realtime will confirm)
    const patch: Partial<OrderCart> = { expo_status: next }
    if (next === 'acknowledged') patch.expo_acknowledged_at = new Date().toISOString()
    setOrders(prev =>
      prev
        .map(o => o.id === orderId ? { ...o, ...patch } : o)
        .filter(o => ACTIVE_STATUSES.includes(o.expo_status as ExpoStatus))
    )
  }, [])

  const grouped: Record<ExpoStatus, OrderCart[]> = { new: [], acknowledged: [], preparing: [], done: [] }
  for (const o of orders) grouped[o.expo_status]?.push(o)

  return (
    <div
      className="min-h-screen bg-gray-950 text-white select-none"
      onClick={unlockAudio}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-800">
        <span className="text-lg font-bold tracking-tight">Expo Screen</span>
        <div className="flex items-center gap-3 text-xs">
          {wakeLockActive && (
            <span className="text-emerald-400">● Screen On</span>
          )}
          {!audioReady && (
            <span className="text-amber-400 animate-pulse">Tap anywhere to enable sound</span>
          )}
          {!connected && (
            <span className="text-red-400 animate-pulse">● Reconnecting…</span>
          )}
          {connected && (
            <span className="text-emerald-400">● Live</span>
          )}
        </div>
      </div>

      {/* Order columns */}
      <div className="grid grid-cols-3 gap-3 p-4 h-[calc(100vh-56px)] overflow-hidden">
        {(['new', 'acknowledged', 'preparing'] as ExpoStatus[]).map(status => (
          <div key={status} className="flex flex-col gap-3 overflow-y-auto">
            {/* Column header */}
            <div className={`text-xs font-semibold uppercase tracking-widest px-2 ${
              status === 'new' ? 'text-red-400' :
              status === 'acknowledged' ? 'text-amber-400' :
              'text-emerald-400'
            }`}>
              {STATUS_LABELS[status]}
              {grouped[status].length > 0 && (
                <span className="ml-2 font-bold">{grouped[status].length}</span>
              )}
            </div>

            {grouped[status].length === 0 && (
              <div className="text-xs text-gray-600 px-2">No orders</div>
            )}

            {grouped[status].map(order => {
              const mins = minutesAgo(order.created_at)
              const ackMins = order.expo_acknowledged_at ? minutesAgo(order.expo_acknowledged_at) : null
              const isEscalating = status === 'acknowledged' && ackMins !== null && ackMins >= 7
              const next = STATUS_NEXT[status]

              return (
                <div
                  key={order.id}
                  className={`rounded-xl p-3 border ${
                    isEscalating
                      ? 'bg-red-950 border-red-500'
                      : status === 'new'
                      ? 'bg-gray-900 border-gray-700'
                      : 'bg-gray-900 border-gray-700'
                  }`}
                >
                  {/* Order header */}
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold text-sm">
                      {order.order_number ? `#${order.order_number}` : '—'}
                      {order.pickup_name ? ` · ${order.pickup_name}` : ''}
                    </span>
                    <span className={`text-xs ${mins >= 15 ? 'text-red-400' : 'text-gray-400'}`}>
                      {mins}m ago
                    </span>
                  </div>

                  {/* Escalation warning */}
                  {isEscalating && (
                    <div className="mb-2 text-xs text-red-400 font-semibold">
                      ⚠ Unacknowledged {ackMins}m — owner notified
                    </div>
                  )}

                  {/* Items */}
                  <div className="mb-2 space-y-0.5">
                    {(order.cart_json ?? []).map((item, i) => (
                      <div key={i} className="text-sm">
                        <span className="font-medium">{item.quantity}×</span>{' '}
                        {item.name}
                        {item.size_label ? ` (${item.size_label})` : ''}
                      </div>
                    ))}
                  </div>

                  {/* Notes */}
                  {order.notes && (
                    <div className="mb-2 text-xs text-amber-300 bg-amber-950/40 rounded px-2 py-1">
                      {order.notes}
                    </div>
                  )}

                  {/* Total + advance */}
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-sm font-semibold text-gray-300">
                      {fmt(order.total_cents)}
                    </span>
                    {next && (
                      <button
                        onClick={(e) => { e.stopPropagation(); advance(order.id, status) }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                          status === 'new'
                            ? 'bg-red-600 hover:bg-red-500 text-white'
                            : status === 'acknowledged'
                            ? 'bg-amber-600 hover:bg-amber-500 text-white'
                            : 'bg-emerald-700 hover:bg-emerald-600 text-white'
                        }`}
                      >
                        {STATUS_NEXT_LABEL[status]}
                      </button>
                    )}
                  </div>

                  {/* Pickup time */}
                  {order.pickup_time && (
                    <div className="mt-1 text-xs text-gray-500">
                      Pickup: {new Date(order.pickup_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
