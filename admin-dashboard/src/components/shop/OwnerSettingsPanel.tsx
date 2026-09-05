import { useEffect, useState } from 'react'
import { Save, AlertTriangle } from 'lucide-react'
import toast from 'react-hot-toast'
import { applyFormOps, type DayHoursOp, type FormOp } from '../../lib/shopOps'

// Shop-specific config only. This type is deliberately narrow — is_test, protected,
// tenant_id, phone_number_e164, telnyx_*, twilio_*, stripe_*, toast_*, merchant_pin,
// subscription_*, founding_promo are never fetched by the caller and so can never render
// here. Money, identity, and routing are not shop config.
export interface OwnerShopSettings {
  id: string
  name: string
  open_hours: Record<string, { closed?: boolean; open?: string; close?: string }> | null
  delivery_hours: Record<string, { closed?: boolean; open?: string; close?: string }> | null
  delivery_enabled: boolean
  ai_instructions: string | null
  wing_flavors_included: number | null
  wing_mix_extra: boolean | null
}

const DAYS: { key: string; label: string }[] = [
  { key: 'mon', label: 'Monday' }, { key: 'tue', label: 'Tuesday' }, { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' }, { key: 'fri', label: 'Friday' }, { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
]

type DraftHours = Record<string, { closed: boolean; open: string; close: string }>

function toDraft(hours: OwnerShopSettings['open_hours']): DraftHours {
  const draft: DraftHours = {}
  for (const { key } of DAYS) {
    const v = hours?.[key]
    draft[key] = v && v.closed !== true
      ? { closed: false, open: v.open ?? '11:00', close: v.close ?? '21:00' }
      : { closed: true, open: v?.open ?? '11:00', close: v?.close ?? '21:00' }
  }
  return draft
}

function draftToPayload(draft: DraftHours): Record<string, DayHoursOp> {
  const payload: Record<string, DayHoursOp> = {}
  for (const { key } of DAYS) {
    const d = draft[key]
    payload[key] = d.closed ? { closed: true } : { closed: false, open: d.open, close: d.close }
  }
  return payload
}

function hoursEqual(a: Record<string, DayHoursOp>, b: OwnerShopSettings['open_hours']): boolean {
  return JSON.stringify(a) === JSON.stringify(draftToPayload(toDraft(b)))
}

function HoursEditor({ title, draft, onChange }: { title: string; draft: DraftHours; onChange: (d: DraftHours) => void }) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-700 mb-2">{title}</h4>
      <div className="space-y-1.5">
        {DAYS.map(({ key, label }) => {
          const d = draft[key]
          return (
            <div key={key} className="flex items-center gap-3 text-sm">
              <span className="w-24 flex-shrink-0 text-gray-600">{label}</span>
              <label className="flex items-center gap-1.5 text-xs text-gray-500 flex-shrink-0">
                <input
                  type="checkbox"
                  checked={d.closed}
                  onChange={e => onChange({ ...draft, [key]: { ...d, closed: e.target.checked } })}
                />
                Closed
              </label>
              {!d.closed && (
                <>
                  <input
                    type="time"
                    value={d.open}
                    onChange={e => onChange({ ...draft, [key]: { ...d, open: e.target.value } })}
                    className="px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <span className="text-gray-400">to</span>
                  <input
                    type="time"
                    value={d.close}
                    onChange={e => onChange({ ...draft, [key]: { ...d, close: e.target.value } })}
                    className="px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function OwnerSettingsPanel({ shopId, settings, onSaved }: { shopId: string; settings: OwnerShopSettings | null; onSaved: () => void }) {
  const [openHoursDraft, setOpenHoursDraft] = useState<DraftHours>(() => toDraft(settings?.open_hours ?? null))
  const [deliveryHoursDraft, setDeliveryHoursDraft] = useState<DraftHours>(() => toDraft(settings?.delivery_hours ?? null))
  const [deliveryEnabled, setDeliveryEnabled] = useState<boolean>(settings?.delivery_enabled ?? true)
  const [instructions, setInstructions] = useState<string>(settings?.ai_instructions ?? '')
  const [wingFlavorsIncluded, setWingFlavorsIncluded] = useState<string>(settings?.wing_flavors_included != null ? String(settings.wing_flavors_included) : '')
  const [wingMixExtra, setWingMixExtra] = useState<'unset' | 'included' | 'extra'>(
    settings?.wing_mix_extra === true ? 'extra' : settings?.wing_mix_extra === false ? 'included' : 'unset',
  )
  const [saving, setSaving] = useState(false)

  // Re-sync drafts when the shop or its settings load/change (e.g. switching shops in preview).
  useEffect(() => {
    setOpenHoursDraft(toDraft(settings?.open_hours ?? null))
    setDeliveryHoursDraft(toDraft(settings?.delivery_hours ?? null))
    setDeliveryEnabled(settings?.delivery_enabled ?? true)
    setInstructions(settings?.ai_instructions ?? '')
    setWingFlavorsIncluded(settings?.wing_flavors_included != null ? String(settings.wing_flavors_included) : '')
    setWingMixExtra(settings?.wing_mix_extra === true ? 'extra' : settings?.wing_mix_extra === false ? 'included' : 'unset')
  }, [settings?.id, settings?.open_hours, settings?.delivery_hours, settings?.delivery_enabled, settings?.ai_instructions, settings?.wing_flavors_included, settings?.wing_mix_extra])

  if (!settings) return <div className="text-center py-12 text-gray-400">Loading settings...</div>

  const save = async () => {
    const ops: FormOp[] = []

    const openPayload = draftToPayload(openHoursDraft)
    if (!hoursEqual(openPayload, settings.open_hours)) {
      ops.push({ intent: 'SET_STORE_HOURS', open_hours: openPayload })
    }
    const deliveryPayload = draftToPayload(deliveryHoursDraft)
    if (!hoursEqual(deliveryPayload, settings.delivery_hours)) {
      ops.push({ intent: 'SET_DELIVERY_HOURS', delivery_hours: deliveryPayload })
    }
    if (deliveryEnabled !== settings.delivery_enabled) {
      ops.push({ intent: 'SET_DELIVERY_ENABLED', delivery_enabled: deliveryEnabled })
    }
    if (instructions !== (settings.ai_instructions ?? '')) {
      ops.push({ intent: 'SET_SHOP_INSTRUCTIONS', ai_instructions: instructions })
    }
    const flavorsNum = wingFlavorsIncluded.trim() ? parseInt(wingFlavorsIncluded, 10) : null
    const mixExtra = wingMixExtra === 'unset' ? null : wingMixExtra === 'extra'
    if (flavorsNum !== settings.wing_flavors_included || mixExtra !== settings.wing_mix_extra) {
      ops.push({ intent: 'SET_WING_POLICY', wing_flavors_included: flavorsNum, wing_mix_extra: mixExtra })
    }

    if (ops.length === 0) {
      toast('No changes to save', { icon: 'ℹ️' })
      return
    }

    setSaving(true)
    try {
      const result = await applyFormOps(shopId, ops)
      const failed = result.results.filter(r => !r.ok)
      if (failed.length > 0) toast.error(`${failed.length} change(s) failed: ${failed.map(f => f.error).join('; ')}`)
      else toast.success('Settings saved')
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <HoursEditor title="Store hours" draft={openHoursDraft} onChange={setOpenHoursDraft} />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-gray-700">Delivery</h4>
          <button
            onClick={() => setDeliveryEnabled(v => !v)}
            className={`text-xs px-3 py-1 rounded-full border ${deliveryEnabled ? 'border-green-200 text-green-700 bg-green-50' : 'border-gray-200 text-gray-500 bg-gray-50'}`}
          >
            {deliveryEnabled ? 'Delivery on' : 'Delivery off'}
          </button>
        </div>
        {!deliveryEnabled && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            Turning delivery off makes the bot refuse delivery orders for this shop, permanently — this isn't a same-day pause. Use "pause delivery" in chat for a temporary stop instead.
          </p>
        )}
        <HoursEditor title="Delivery hours" draft={deliveryHoursDraft} onChange={setDeliveryHoursDraft} />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-2">
        <h4 className="text-sm font-semibold text-gray-700">Shop instructions</h4>
        <p className="text-xs text-gray-400">
          Behavior rules for the ordering bot. The menu always wins on item names and prices — instructions that contradict the menu will silently lose.
        </p>
        <textarea
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          rows={4}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
        />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
        <h4 className="text-sm font-semibold text-gray-700">Wing policy</h4>
        <p className="text-xs text-gray-400">Until this is set, the bot won't guess whether flavors can be mixed.</p>
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-600">Flavors included per order</label>
          <input
            type="number"
            min={1}
            value={wingFlavorsIncluded}
            onChange={e => setWingFlavorsIncluded(e.target.value)}
            className="w-20 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="wing-mix" checked={wingMixExtra === 'included'} onChange={() => setWingMixExtra('included')} />
            Mixing flavors is included
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="wing-mix" checked={wingMixExtra === 'extra'} onChange={() => setWingMixExtra('extra')} />
            Mixing flavors costs extra
          </label>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          {saving ? 'Saving...' : 'Save settings'}
        </button>
      </div>
    </div>
  )
}
