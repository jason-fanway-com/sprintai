import { Save, X, Store } from 'lucide-react'
import { UseMutationResult } from '@tanstack/react-query'

type DayRangeList = Array<{ open: string; close: string }>
// A day is EITHER explicitly closed OR an array of open/close ranges. This must never be
// left absent for a configured day: the ordering engine only refuses orders for a day
// that is explicitly {closed:true} or has ranges the current time falls outside — an
// ABSENT day key is silently treated as open, not closed. See normalizeDayHours below.
export type DayValue = { closed: true } | DayRangeList
export type DayHours = Record<string, DayValue>

interface Shop {
  id: string
  name: string
  timezone: string
  email_ticket_recipient: string | null
  pause_message: string | null
  phone_number_e164: string | null
  merchant_pin?: string | null
  toast_client_id?: string | null
  toast_client_secret?: string | null
  toast_location_guid?: string | null
  delivery_radius_mi?: number | null
  open_hours?: DayHours
  delivery_hours?: DayHours
  delivery_enabled?: boolean
  wing_flavors_included?: number | null
  wing_mix_extra?: boolean | null
  ai_instructions?: string | null
}

const DAYS: Array<{ key: string; label: string }> = [
  { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
]

/** A range is malformed if either time is blank or close doesn't come after open — the
 * ordering engine reads a malformed range as "closed" with no error, so this must be
 * caught here, before it ever reaches the database. */
function rangeInvalid(r: { open: string; close: string }): boolean {
  return !r.open || !r.close || r.close <= r.open
}

function isClosedDay(v: DayValue | undefined): boolean {
  return !!v && !Array.isArray(v) && v.closed === true
}
function rangesOf(v: DayValue | undefined): DayRangeList {
  return Array.isArray(v) ? v : []
}

/** A day that's present but neither explicitly closed nor a valid, non-empty range list
 * is malformed. An ABSENT day is not itself an error here — normalizeDayHours (called at
 * save time) fills every missing day in as explicitly closed before it reaches the DB. */
export function hoursHaveError(hours: DayHours | undefined): boolean {
  if (!hours) return false
  return DAYS.some(({ key }) => {
    const v = hours[key]
    if (v === undefined) return false
    if (!Array.isArray(v)) return v.closed !== true
    return v.length === 0 || v.some(rangeInvalid)
  })
}

/** Fill every one of the 7 days explicitly (closed by default) so the write can never
 * leave a day absent — an absent day is read by the ordering engine as open, not closed. */
export function normalizeDayHours(hours: DayHours | undefined): DayHours {
  const next: DayHours = {}
  for (const { key } of DAYS) {
    const v = hours?.[key]
    next[key] = v === undefined ? { closed: true } : v
  }
  return next
}

function HoursEditor({ hours, onChange, disabled }: { hours: DayHours; onChange: (h: DayHours) => void; disabled: boolean }) {
  const setDay = (key: string, value: DayValue) => onChange({ ...hours, [key]: value })
  return (
    <div className="space-y-1.5">
      {DAYS.map(({ key, label }) => {
        const value = hours[key]
        const closed = value === undefined || isClosedDay(value)
        const ranges = rangesOf(value)
        return (
          <div key={key} className="flex items-start gap-2">
            <span className="w-9 pt-1.5 text-xs font-medium text-gray-500 flex-shrink-0">{label}</span>
            <div className="flex-1 space-y-1">
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={!closed}
                  disabled={disabled}
                  onChange={e => setDay(key, e.target.checked ? [{ open: '', close: '' }] : { closed: true })}
                />
                {closed ? 'Closed' : 'Open'}
              </label>
              {!closed && ranges.map((r, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    type="time"
                    value={r.open}
                    disabled={disabled}
                    onChange={e => setDay(key, ranges.map((rr, ii) => (ii === i ? { ...rr, open: e.target.value } : rr)))}
                    className={`px-2 py-1 text-xs border rounded-lg ${rangeInvalid(r) ? 'border-red-300' : 'border-gray-200'}`}
                  />
                  <span className="text-xs text-gray-400">to</span>
                  <input
                    type="time"
                    value={r.close}
                    disabled={disabled}
                    onChange={e => setDay(key, ranges.map((rr, ii) => (ii === i ? { ...rr, close: e.target.value } : rr)))}
                    className={`px-2 py-1 text-xs border rounded-lg ${rangeInvalid(r) ? 'border-red-300' : 'border-gray-200'}`}
                  />
                  {!disabled && ranges.length > 1 && (
                    <button onClick={() => setDay(key, ranges.filter((_, ii) => ii !== i))} className="text-gray-300 hover:text-red-500">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {!closed && !disabled && (
                <button onClick={() => setDay(key, [...ranges, { open: '', close: '' }])} className="text-xs text-brand-600 hover:text-brand-700">
                  + add another range
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface SettingsTabProps {
  shop: Shop
  editingShop: boolean
  shopForm: Partial<Shop>
  onEditChange: (editing: boolean) => void
  onFormChange: (field: keyof Shop, value: any) => void
  onFormReset: () => void
  onSave: UseMutationResult<void, Error, void, unknown>
}

export default function SettingsTab({
  shop,
  editingShop,
  shopForm,
  onEditChange,
  onFormChange,
  onFormReset,
  onSave,
}: SettingsTabProps) {
  const hoursInvalid = hoursHaveError(shopForm.open_hours) || hoursHaveError(shopForm.delivery_hours)
  const saveDisabled = onSave.isPending || (editingShop && hoursInvalid)

  const SaveBar = (
    !editingShop ? (
      <button onClick={() => onEditChange(true)} className="text-sm text-brand-600 hover:text-brand-700">
        Edit
      </button>
    ) : (
      <div className="flex gap-2">
        <button
          onClick={() => {
            onEditChange(false)
            onFormReset()
          }}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Cancel
        </button>
        <button
          onClick={() => onSave.mutate()}
          disabled={saveDisabled}
          title={hoursInvalid ? 'Fix the highlighted hours before saving' : undefined}
          className="flex items-center gap-1 text-sm text-white bg-brand-600 px-3 py-1 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
        >
          <Save className="w-3 h-3" />
          Save
        </button>
      </div>
    )
  )

  return (
    <div className="space-y-6 max-w-lg">
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-semibold text-gray-900">Shop Settings</h3>
          {SaveBar}
        </div>
        <div className="space-y-4">
          {[
            { label: 'Shop Name', field: 'name' as const },
            { label: 'Timezone', field: 'timezone' as const },
            { label: 'Order Email Recipient', field: 'email_ticket_recipient' as const },
            { label: 'Pause Message', field: 'pause_message' as const },
          ].map(({ label, field }) => (
            <div key={field}>
              <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
              {editingShop ? (
                <input
                  value={(shopForm[field] ?? '') as string}
                  onChange={e => onFormChange(field, e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              ) : (
                <p className="text-sm text-gray-700">{(shop[field] ?? '') as string || <span className="text-gray-300">Not set</span>}</p>
              )}
            </div>
          ))}

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Phone Number (SMS)</label>
            {editingShop ? (
              <input
                value={(shopForm.phone_number_e164 ?? '') as string}
                onChange={e => onFormChange('phone_number_e164', e.target.value)}
                placeholder="+16103792553"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            ) : (
              <p className="text-sm text-gray-700">{shop.phone_number_e164 ?? <span className="text-gray-300">Not configured</span>}</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Shop ID</label>
            <p className="text-xs font-mono text-gray-400">{shop.id}</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Delivery Radius (miles)</label>
            {editingShop ? (
              <input
                type="number"
                step="0.1"
                min="0"
                value={(shopForm.delivery_radius_mi ?? '') as string | number}
                onChange={e => onFormChange('delivery_radius_mi' as keyof Shop, e.target.value ? parseFloat(e.target.value) : null)}
                placeholder="e.g. 5"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            ) : (
              <p className="text-sm text-gray-700">{shop.delivery_radius_mi != null ? `${shop.delivery_radius_mi} mi` : <span className="text-gray-300">Not set — no zone check</span>}</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Merchant PIN</label>
            <p className="text-xs font-mono text-gray-400">{(shop as any).merchant_pin ?? <span className="text-gray-300">Not set</span>}</p>
          </div>
        </div>
      </div>

      {/* Shop-Specific Config — this shop only, never global/ordering-engine config */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-semibold text-gray-900 flex items-center gap-2">
            <Store className="w-4 h-4 text-brand-600" />
            Shop-Specific Config
          </h3>
          {SaveBar}
        </div>
        <p className="text-xs text-gray-500 mb-6">Hours, delivery, and instructions for this shop only. Changes here never affect another shop or the ordering engine itself.</p>

        <div className="space-y-6">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-2">Store Hours</label>
            <HoursEditor
              hours={shopForm.open_hours ?? {}}
              onChange={h => onFormChange('open_hours' as keyof Shop, h)}
              disabled={!editingShop}
            />
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <label className="text-xs font-medium text-gray-500">Delivery Enabled</label>
              {editingShop ? (
                <input
                  type="checkbox"
                  checked={shopForm.delivery_enabled ?? true}
                  onChange={e => onFormChange('delivery_enabled' as keyof Shop, e.target.checked)}
                />
              ) : (
                <span className="text-sm text-gray-700">{(shop.delivery_enabled ?? true) ? 'Yes' : 'No'}</span>
              )}
            </div>
            <p className="text-xs text-gray-400 mb-2">Turning this off makes the bot refuse delivery for every order, regardless of hours below.</p>
            <label className="block text-xs font-medium text-gray-500 mb-2">Delivery Hours</label>
            <HoursEditor
              hours={shopForm.delivery_hours ?? {}}
              onChange={h => onFormChange('delivery_hours' as keyof Shop, h)}
              disabled={!editingShop}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Wing Policy</label>
            <p className="text-xs text-gray-400 mb-2">Unset by default — the bot will not guess and will ask the customer instead.</p>
            {editingShop ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={shopForm.wing_flavors_included ?? ''}
                  onChange={e => onFormChange('wing_flavors_included' as keyof Shop, e.target.value === '' ? null : parseInt(e.target.value, 10))}
                  placeholder="Flavors included"
                  className="w-36 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <select
                  value={shopForm.wing_mix_extra === null || shopForm.wing_mix_extra === undefined ? 'unset' : shopForm.wing_mix_extra ? 'extra' : 'included'}
                  onChange={e => onFormChange('wing_mix_extra' as keyof Shop, e.target.value === 'unset' ? null : e.target.value === 'extra')}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="unset">Splitting flavors: not configured</option>
                  <option value="included">Splitting flavors: no extra charge</option>
                  <option value="extra">Splitting flavors: costs extra</option>
                </select>
              </div>
            ) : (
              <p className="text-sm text-gray-700">
                {shop.wing_flavors_included != null
                  ? `${shop.wing_flavors_included} flavor(s) included${shop.wing_mix_extra === true ? ', splitting costs extra' : shop.wing_mix_extra === false ? ', splitting free' : ''}`
                  : <span className="text-gray-300">Not configured</span>}
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Shop Instructions</label>
            <p className="text-xs text-gray-400 mb-2">Behavior corrections for this shop. The menu is always authoritative for item names and prices — instructions cannot override those.</p>
            {editingShop ? (
              <textarea
                value={shopForm.ai_instructions ?? ''}
                onChange={e => onFormChange('ai_instructions' as keyof Shop, e.target.value)}
                rows={4}
                placeholder="Example: When a customer orders a dozen bagels, ask them what kinds they want until they reach 12."
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
              />
            ) : (
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{shop.ai_instructions || <span className="text-gray-300">Not set</span>}</p>
            )}
          </div>
        </div>
      </div>

      {/* POS Integration (Toast) */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="font-semibold text-gray-900 mb-1">POS Integration (Toast)</h3>
        <p className="text-xs text-gray-500 mb-4">Contact your Toast account rep to request custom integration credentials.</p>
        <div className="space-y-4">
          {[
            { label: 'Toast Client ID', field: 'toast_client_id' as const, type: 'text' },
            { label: 'Toast Client Secret', field: 'toast_client_secret' as const, type: 'password' },
            { label: 'Toast Location GUID', field: 'toast_location_guid' as const, type: 'text' },
          ].map(({ label, field, type }) => (
            <div key={field}>
              <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
              {editingShop ? (
                <input
                  type={type}
                  value={(shopForm[field] ?? '') as string}
                  onChange={e => onFormChange(field, e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              ) : (
                <p className="text-sm text-gray-700">
                  {field === 'toast_client_secret' && shop[field]
                    ? '••••••••'
                    : ((shop[field] ?? '') as string) || <span className="text-gray-300">Not set</span>}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
