import { useEffect, useState } from 'react'
import { Save, AlertTriangle, MapPin, CheckCircle2 } from 'lucide-react'
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
  delivery_radius_mi: number | null
  delivery_fee_cents: number | null
  formatted_address: string | null
  latitude: number | null
  longitude: number | null
  ai_instructions: string | null
  wing_flavors_included: number | null
  wing_mix_extra: boolean | null
}

interface AddressCandidate {
  formattedAddress: string
  place_id: string
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

function AddressSection({ shopId, settings, onConfirmed }: { shopId: string; settings: OwnerShopSettings; onConfirmed: () => void }) {
  const [addressInput, setAddressInput] = useState('')
  const [candidate, setCandidate] = useState<AddressCandidate | null>(null)
  const [looking, setLooking] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const hasConfirmedAddress = settings.latitude != null && settings.longitude != null

  const lookup = async () => {
    if (!addressInput.trim()) return
    setLooking(true)
    setCandidate(null)
    try {
      const result = await applyFormOps(shopId, [{ intent: 'LOOKUP_SHOP_ADDRESS', address: addressInput.trim() }])
      const r = result.results[0]
      if (!r.ok) { toast.error(r.error ?? 'Lookup failed'); return }
      const found = r.data?.candidate
      if (!found) { toast.error(r.result ?? 'No match found for that address.'); return }
      setCandidate(found)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setLooking(false)
    }
  }

  const confirm = async () => {
    if (!candidate) return
    setConfirming(true)
    try {
      const result = await applyFormOps(shopId, [{ intent: 'CONFIRM_SHOP_ADDRESS', place_id: candidate.place_id }])
      const r = result.results[0]
      if (!r.ok) { toast.error(r.error ?? 'Could not confirm address'); return }
      toast.success('Address confirmed')
      setCandidate(null)
      setAddressInput('')
      onConfirmed()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
      <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" /> Address</h4>
      {hasConfirmedAddress && (
        <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 flex items-start gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          Confirmed: {settings.formatted_address}
        </p>
      )}
      <p className="text-xs text-gray-400">
        {hasConfirmedAddress ? 'Enter a new address below to replace it.' : 'Required before delivery can be turned on — this is what the radius below measures from.'}
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={addressInput}
          onChange={e => setAddressInput(e.target.value)}
          placeholder="123 Main St, Allentown PA"
          className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <button
          onClick={lookup}
          disabled={looking || !addressInput.trim()}
          className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 flex-shrink-0"
        >
          {looking ? 'Looking up...' : 'Look up'}
        </button>
      </div>
      {candidate && (
        <div className="border border-brand-200 bg-brand-50 rounded-lg p-3 space-y-2">
          <p className="text-sm text-gray-800">Is this you? <span className="font-medium">{settings.name}, {candidate.formattedAddress}</span></p>
          <div className="flex gap-2">
            <button
              onClick={confirm}
              disabled={confirming}
              className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
            >
              {confirming ? 'Confirming...' : 'Yes, that’s us'}
            </button>
            <button
              onClick={() => setCandidate(null)}
              className="px-3 py-1.5 text-xs border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50"
            >
              Not this one
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function OwnerSettingsPanel({ shopId, settings, onSaved }: { shopId: string; settings: OwnerShopSettings | null; onSaved: () => void }) {
  const [openHoursDraft, setOpenHoursDraft] = useState<DraftHours>(() => toDraft(settings?.open_hours ?? null))
  const [deliveryHoursDraft, setDeliveryHoursDraft] = useState<DraftHours>(() => toDraft(settings?.delivery_hours ?? null))
  const [deliveryEnabled, setDeliveryEnabled] = useState<boolean>(settings?.delivery_enabled ?? true)
  const [deliveryRadius, setDeliveryRadius] = useState<string>(settings?.delivery_radius_mi != null ? String(settings.delivery_radius_mi) : '')
  const [deliveryFee, setDeliveryFee] = useState<string>(settings?.delivery_fee_cents != null ? (settings.delivery_fee_cents / 100).toFixed(2) : '')
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
    setDeliveryRadius(settings?.delivery_radius_mi != null ? String(settings.delivery_radius_mi) : '')
    setDeliveryFee(settings?.delivery_fee_cents != null ? (settings.delivery_fee_cents / 100).toFixed(2) : '')
    setInstructions(settings?.ai_instructions ?? '')
    setWingFlavorsIncluded(settings?.wing_flavors_included != null ? String(settings.wing_flavors_included) : '')
    setWingMixExtra(settings?.wing_mix_extra === true ? 'extra' : settings?.wing_mix_extra === false ? 'included' : 'unset')
  }, [settings?.id, settings?.open_hours, settings?.delivery_hours, settings?.delivery_enabled, settings?.delivery_radius_mi, settings?.delivery_fee_cents, settings?.ai_instructions, settings?.wing_flavors_included, settings?.wing_mix_extra])

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
    const radiusNum = deliveryRadius.trim() ? parseFloat(deliveryRadius) : null
    const feeNum = deliveryFee.trim() ? Math.round(parseFloat(deliveryFee) * 100) : 0
    if (deliveryEnabled !== settings.delivery_enabled || radiusNum !== settings.delivery_radius_mi || feeNum !== (settings.delivery_fee_cents ?? 0)) {
      ops.push({ intent: 'SET_DELIVERY_CONFIG', delivery_enabled: deliveryEnabled, delivery_radius_mi: radiusNum, delivery_fee_cents: feeNum })
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

      <AddressSection shopId={shopId} settings={settings} onConfirmed={onSaved} />

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
        {deliveryEnabled && (settings.latitude == null || settings.longitude == null || !(parseFloat(deliveryRadius || '0') > 0)) && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            This won't actually turn delivery on for customers yet — a confirmed address (above) and a radius greater than 0 miles are both required. The save will fail with a reason until both are set.
          </p>
        )}
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            Radius
            <input
              type="number"
              min={0}
              step={0.5}
              value={deliveryRadius}
              onChange={e => setDeliveryRadius(e.target.value)}
              placeholder="5"
              className="w-20 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            miles
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            Delivery fee $
            <input
              type="number"
              min={0}
              step={0.01}
              value={deliveryFee}
              onChange={e => setDeliveryFee(e.target.value)}
              placeholder="0.00"
              className="w-24 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
        </div>
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
