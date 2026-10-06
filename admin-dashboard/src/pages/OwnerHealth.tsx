import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { CheckCircle2, Circle, AlertTriangle, HeartPulse, Store } from 'lucide-react'
import { supabase, supabaseUrl } from '../lib/supabase'
import { useEffectiveTenant } from '../lib/useOwnerTenant'

/**
 * Owner "Health" page (Jason 2026-10-05): replaces Quality, Production Readiness and Issues for owners with the two
 * questions an owner has — am I ready to go live, and is anything wrong that I need to act on — plus a short week strip.
 * The detailed pages stay in the admin view. Readiness comes from go-live's evaluate mode (the same gates that decide go-live).
 */
const OWNER_GATES: Array<[string, string, string]> = [
  ['menu', 'Menu loaded', 'Add your menu on the Menu page.'],
  ['menu_approved', 'You approved your menu', 'Review the Menu page and approve it.'],
  ['menu_clean', 'No menu items waiting for review', 'Answer the flagged items on the Menu page.'],
  ['hours', 'Store hours set', 'Set your hours on the Settings page.'],
  ['ticket_destination', 'Kitchen tickets have somewhere to go', 'Add a ticket email on the Settings page.'],
  ['delivery_geo', 'Delivery area set', 'Set your address on the Settings page.'],
  ['connect', 'Payments connected', 'OrderFare will help you finish payment setup.'],
  ['subscription', 'Account set up', 'OrderFare sets this up with you.'],
  ['ein', 'Business tax ID on file', 'OrderFare will ask for it.'],
]
const ORDERFARE_GATES: Array<[string, string]> = [
  ['number', 'Your text number'],
  ['campaign_assignment', 'Text number approved by the carriers'],
  ['proof', 'OrderFare test run passed'],
  ['delivery_test', 'Test order placed on a real phone'],
]
// alerts an owner can act on; everything else (compliance, latency, grader errors) is OrderFare's
const OWNER_RULES: Record<string, [string, string]> = {
  unacked_order_escalation: ['An order was not acknowledged', '/expo'],
  ticket_send_failed: ["A kitchen ticket didn't send", '/settings'],
  ticket_missing: ['A paid order has no kitchen ticket', '/expo'],
  ticket_no_destination: ['Kitchen tickets have nowhere to go', '/settings'],
  courier_not_booked: ['A delivery courier was not booked', '/expo'],
}

interface Shop { id: string; name: string }

export default function OwnerHealth() {
  const { isOwnerView, effTenant } = useEffectiveTenant()
  const [shopId, setShopId] = useState<string | null>(null)
  const { data: shops, isLoading } = useQuery<Shop[]>({
    queryKey: ['health-shops', effTenant],
    queryFn: async () => (await supabase.from('shops').select('id, name').eq('tenant_id', effTenant!).order('created_at', { ascending: false })).data ?? [],
    enabled: !!effTenant,
  })
  const shop = useMemo(() => shops?.find(s => s.id === shopId) ?? shops?.[0] ?? null, [shops, shopId])

  const gates = useQuery<{ gates?: Record<string, boolean> }>({
    queryKey: ['health-gates', shop?.id],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const r = await fetch(`${supabaseUrl}/functions/v1/go-live`, { method: 'POST', headers: { Authorization: `Bearer ${session?.access_token ?? ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ shop_id: shop!.id, evaluate: true }) })
      return r.ok ? r.json() : {}
    },
    enabled: !!shop?.id,
  })
  const attention = useQuery({
    queryKey: ['health-attention', shop?.id],
    queryFn: async () => {
      const { data } = await supabase.from('issues').select('id, detection_rule, title, detected_at').eq('shop_id', shop!.id).eq('status', 'open').in('detection_rule', Object.keys(OWNER_RULES)).order('detected_at', { ascending: false }).limit(20)
      const { data: menu } = await supabase.from('menus').select('id').eq('shop_id', shop!.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
      const { count } = menu ? await supabase.from('owner_questions').select('id', { count: 'exact', head: true }).eq('menu_id', menu.id).eq('status', 'pending') : { count: 0 }
      return { issues: data ?? [], menuQuestions: count ?? 0 }
    },
    enabled: !!shop?.id,
  })
  const week = useQuery({
    queryKey: ['health-week', shop?.id],
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString()
      const { data: carts } = await supabase.from('order_carts').select('payment_status').eq('shop_id', shop!.id).gte('created_at', since).limit(1000)
      const { data: flagged } = await supabase.from('conversation_evals').select('conversation_id').eq('shop_id', shop!.id).eq('verdict', 'flagged').gte('created_at', since).order('created_at', { ascending: false }).limit(10)
      const started = carts?.length ?? 0, paid = (carts ?? []).filter(c => c.payment_status === 'paid').length
      return { started, paid, flagged: flagged ?? [] }
    },
    enabled: !!shop?.id,
  })

  if (isOwnerView && !effTenant) return <div className="p-8 text-gray-500">Pick a shop to see its health.</div>
  if (isLoading) return <div className="p-8 flex justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
  if (!shop) return <div className="p-8 text-center py-16 text-gray-400"><Store className="w-12 h-12 mx-auto mb-3 opacity-30" /><p className="font-medium">No shop assigned</p></div>

  const g = gates.data?.gates ?? {}
  const ownerDone = OWNER_GATES.filter(([k]) => g[k]).length
  const items = attention.data?.issues ?? []
  const mq = attention.data?.menuQuestions ?? 0
  const w = week.data

  return (
    <div className="p-6 md:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-brand-50 flex items-center justify-center"><HeartPulse className="w-6 h-6 text-brand-600" /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Health</h1>
          {shops && shops.length > 1
            ? <select value={shop.id} onChange={e => setShopId(e.target.value)} className="bg-transparent border border-gray-200 rounded-md px-2 py-0.5 text-sm text-gray-600">{shops.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            : <p className="text-sm text-gray-400">{shop.name}</p>}
        </div>
      </div>

      {/* Needs attention */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-3">Needs your attention</h2>
        {attention.isLoading ? <p className="text-sm text-gray-400">Checking…</p> : items.length === 0 && mq === 0 ? (
          <p className="text-sm text-green-700 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Nothing needs you right now.</p>
        ) : (
          <ul className="space-y-2">
            {mq > 0 && <li className="flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2 text-gray-800"><AlertTriangle className="w-4 h-4 text-amber-500" /> {mq} menu question{mq === 1 ? '' : 's'} waiting for your answer</span><Link to="/menu" className="text-brand-600 text-xs font-medium">Answer</Link></li>}
            {items.map(i => (
              <li key={i.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 text-gray-800"><AlertTriangle className="w-4 h-4 text-red-500" /> {OWNER_RULES[i.detection_rule]?.[0] ?? i.title} <span className="text-xs text-gray-400">{new Date(i.detected_at).toLocaleString()}</span></span>
                <Link to={OWNER_RULES[i.detection_rule]?.[1] ?? '/expo'} className="text-brand-600 text-xs font-medium">Fix</Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Ready to go live */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-900">Ready to go live?</h2>
          {gates.data?.gates && <span className="text-xs text-gray-500">{ownerDone} of {OWNER_GATES.length} of your steps done</span>}
        </div>
        {gates.isLoading ? <p className="text-sm text-gray-400">Checking…</p> : (
          <div className="grid md:grid-cols-2 gap-x-6 gap-y-2">
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Your steps</p>
              {OWNER_GATES.map(([k, label, fix]) => (
                <div key={k} className="text-sm">
                  <span className="flex items-center gap-2">{g[k] ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <Circle className="w-4 h-4 text-gray-300" />}<span className={g[k] ? 'text-gray-700' : 'text-gray-900 font-medium'}>{label}</span></span>
                  {!g[k] && <p className="text-xs text-gray-500 ml-6">{fix}</p>}
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">OrderFare's steps</p>
              {ORDERFARE_GATES.map(([k, label]) => (
                <span key={k} className="flex items-center gap-2 text-sm">{g[k] ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <Circle className="w-4 h-4 text-gray-300" />}<span className="text-gray-700">{label}</span></span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* This week */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-3">This week</h2>
        {week.isLoading || !w ? <p className="text-sm text-gray-400">Loading…</p> : (
          <>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div><p className="text-2xl font-bold text-gray-900">{w.paid}</p><p className="text-xs text-gray-500">paid orders</p></div>
              <div><p className="text-2xl font-bold text-gray-900">{w.started ? Math.round((w.paid / w.started) * 100) : 0}%</p><p className="text-xs text-gray-500">of conversations reached payment</p></div>
              <div><p className="text-2xl font-bold text-gray-900">{w.flagged.length}</p><p className="text-xs text-gray-500">conversations flagged for a look</p></div>
            </div>
            {w.flagged.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {w.flagged.map((f, k) => <Link key={f.conversation_id + k} to={`/conversations/${f.conversation_id}`} className="text-xs text-brand-600 underline">Conversation {k + 1}</Link>)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
