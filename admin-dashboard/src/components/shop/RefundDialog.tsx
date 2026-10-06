import { useEffect, useState } from 'react'
import { supabase, supabaseUrl } from '../../lib/supabase'

/** Cancel or refund a paid order by the agreed rules (refund-order). Always shows the breakdown first (2026-10-06). */
interface Plan { foodRefundCents: number; platformRefundCents: number; customerRefundCents: number; uberChargeCents: number; shopOwesCents: number; cancelCourier: boolean; explain: string[] }
const money = (c: number) => `$${(c / 100).toFixed(2)}`

async function call(body: Record<string, unknown>) {
  const { data: { session } } = await supabase.auth.getSession()
  const r = await fetch(`${supabaseUrl}/functions/v1/refund-order`, { method: 'POST', headers: { Authorization: `Bearer ${session?.access_token ?? ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await r.json()
  if (!r.ok) throw new Error(data.error ?? 'Something went wrong')
  return data as { plan: Plan; total_cents?: number; order_number?: number }
}

export default function RefundDialog({ cartId, orderNumber, onClose, onDone }: { cartId: string; orderNumber: number | null; onClose: () => void; onDone: () => void }) {
  const [by, setBy] = useState<'shop' | 'customer'>('customer')
  const [food, setFood] = useState<'full' | 'none' | 'some'>('full')
  const [someDollars, setSomeDollars] = useState('')
  const [preview, setPreview] = useState<{ plan: Plan; total_cents?: number } | null>(null)
  const [foodTax, setFoodTax] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Plan | null>(null)

  const foodCents = () => by === 'shop' || food === 'full' ? undefined : food === 'none' ? 0 : Math.round(parseFloat(someDollars || '0') * 100)
  useEffect(() => {
    let live = true
    setError('')
    call({ order_cart_id: cartId, initiated_by: by, food_refund_cents: foodCents(), preview: true })
      .then(p => { if (!live) return; setPreview(p); if (foodTax === null) setFoodTax(p.plan.foodRefundCents) })
      .catch(e => live && setError(e.message))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [by, food, someDollars])

  const confirm = async () => {
    setBusy(true); setError('')
    try { const r = await call({ order_cart_id: cartId, initiated_by: by, food_refund_cents: foodCents() }); setDone(r.plan); onDone() } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong') }
    setBusy(false)
  }

  const p = preview?.plan
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white text-gray-900 rounded-2xl p-5 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold">Cancel / refund order {orderNumber ? `#${orderNumber}` : ''}</h2>
        {done ? (
          <>
            <p className="text-sm">Done. The customer gets <b>{money(done.customerRefundCents)}</b> back and has been texted.</p>
            <button onClick={onClose} className="w-full px-4 py-2.5 text-sm text-white bg-brand-600 rounded-lg">Close</button>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <p className="text-sm font-medium">Who cancelled?</p>
              <div className="flex gap-2 text-sm">
                {(['customer', 'shop'] as const).map(k => (
                  <button key={k} onClick={() => setBy(k)} className={`px-3 py-1.5 rounded-full border ${by === k ? 'border-brand-500 text-brand-700 bg-brand-50' : 'border-gray-200 text-gray-500'}`}>
                    {k === 'customer' ? 'The customer' : "We can't fill it"}
                  </button>
                ))}
              </div>
            </div>
            {by === 'customer' && (
              <div className="space-y-1">
                <p className="text-sm font-medium">Refund the food?</p>
                <div className="flex gap-2 text-sm flex-wrap">
                  {([['full', 'All of it'], ['none', 'None (already made)'], ['some', 'Part']] as const).map(([k, l]) => (
                    <button key={k} onClick={() => setFood(k)} className={`px-3 py-1.5 rounded-full border ${food === k ? 'border-brand-500 text-brand-700 bg-brand-50' : 'border-gray-200 text-gray-500'}`}>{l}</button>
                  ))}
                </div>
                {food === 'some' && <input value={someDollars} onChange={e => setSomeDollars(e.target.value)} placeholder={`Amount, up to ${foodTax !== null ? money(foodTax) : ''}`} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" inputMode="decimal" />}
              </div>
            )}
            {p && (
              <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
                <div className="flex justify-between"><span>Food and tax (from you)</span><span>{money(p.foodRefundCents)}</span></div>
                <div className="flex justify-between"><span>Delivery, tip and fee (from OrderFare)</span><span>{money(p.platformRefundCents)}</span></div>
                <div className="flex justify-between font-semibold border-t border-gray-200 pt-1"><span>Customer gets back</span><span>{money(p.customerRefundCents)}</span></div>
                {p.shopOwesCents > 0 && <div className="flex justify-between text-amber-700"><span>Uber fee (comes out of your next orders)</span><span>{money(p.shopOwesCents)}</span></div>}
                {p.cancelCourier && <p className="text-xs text-gray-500">The Uber driver will be cancelled first.</p>}
                {p.explain.map(x => <p key={x} className="text-xs text-gray-600">{x}</p>)}
              </div>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 px-4 py-2.5 text-sm text-gray-700 border border-gray-300 rounded-lg">Keep the order</button>
              <button onClick={confirm} disabled={busy || !p} className="flex-1 px-4 py-2.5 text-sm text-white bg-red-600 rounded-lg disabled:opacity-50">{busy ? 'Working…' : p && p.customerRefundCents > 0 ? `Refund ${money(p.customerRefundCents)}` : 'Cancel order'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
