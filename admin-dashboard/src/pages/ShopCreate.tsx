import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Store } from 'lucide-react'
import { supabase, adminFetch } from '../lib/supabase'

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
]

const DEFAULT_HOURS = JSON.stringify(
  {
    mon: [{ open: '09:00', close: '21:00' }],
    tue: [{ open: '09:00', close: '21:00' }],
    wed: [{ open: '09:00', close: '21:00' }],
    thu: [{ open: '09:00', close: '21:00' }],
    fri: [{ open: '09:00', close: '22:00' }],
    sat: [{ open: '10:00', close: '22:00' }],
    sun: [],
  },
  null,
  2,
)

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export default function ShopCreate() {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    name:                    '',
    slug:                    '',
    website_url:             '',
    email_ticket_recipient:  '',
    phone_number_e164:       '',
    timezone:                'America/New_York',
    merchant_pin:            '',
    open_hours:              DEFAULT_HOURS,
  })
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false)
  const [submitting, setSubmitting]                 = useState(false)
  const [error, setError]                           = useState<string | null>(null)

  function setField(field: keyof typeof form, value: string) {
    setForm(prev => {
      const next = { ...prev, [field]: value }
      if (field === 'name' && !slugManuallyEdited) {
        next.slug = slugify(value)
      }
      return next
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!form.name.trim()) { setError('Shop name is required'); return }
    if (!form.slug.trim()) { setError('Slug is required'); return }

    let openHours: Record<string, unknown> = {}
    try {
      openHours = JSON.parse(form.open_hours)
    } catch {
      setError('Open Hours must be valid JSON')
      return
    }

    setSubmitting(true)
    try {
      const tenant = await adminFetch<{ id: string }>('/tenants', {
        method: 'POST',
        body:   JSON.stringify({ name: form.name.trim() }),
      })

      const { data: shop, error: shopErr } = await supabase
        .from('shops')
        .insert({
          tenant_id:               tenant.id,
          name:                    form.name.trim(),
          slug:                    form.slug.trim(),
          website_url:             form.website_url.trim()              || null,
          email_ticket_recipient:  form.email_ticket_recipient.trim()   || null,
          phone_number_e164:       form.phone_number_e164.trim()        || null,
          timezone:                form.timezone,
          merchant_pin:            form.merchant_pin.trim()             || null,
          open_hours:              openHours,
        })
        .select('id')
        .single()

      if (shopErr) throw new Error(shopErr.message)
      navigate(`/shops/${shop.id}`)
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={() => navigate('/shops')}
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2">
          <Store className="w-5 h-5 text-brand-600" />
          <h1 className="text-2xl font-bold text-gray-900">New Shop</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Shop Name *</label>
            <input
              value={form.name}
              onChange={e => setField('name', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="Joe's Diner"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Slug *</label>
            <input
              value={form.slug}
              onChange={e => { setSlugManuallyEdited(true); setField('slug', e.target.value) }}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="joes-diner"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Website URL</label>
          <input
            type="url"
            value={form.website_url}
            onChange={e => setField('website_url', e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="https://joesdiner.com"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Owner Email</label>
            <input
              type="email"
              value={form.email_ticket_recipient}
              onChange={e => setField('email_ticket_recipient', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="owner@restaurant.com"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Phone Number</label>
            <input
              value={form.phone_number_e164}
              onChange={e => setField('phone_number_e164', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="+15551234567"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Timezone</label>
            <select
              value={form.timezone}
              onChange={e => setField('timezone', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Merchant PIN</label>
            <input
              value={form.merchant_pin}
              onChange={e => setField('merchant_pin', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="1234"
              maxLength={8}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Open Hours (JSON)
          </label>
          <textarea
            value={form.open_hours}
            onChange={e => setField('open_hours', e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono"
            rows={9}
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={() => navigate('/shops')}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
          >
            {submitting ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                Creating...
              </>
            ) : (
              <>
                <Store className="w-4 h-4" />
                Create Shop
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  )
}
