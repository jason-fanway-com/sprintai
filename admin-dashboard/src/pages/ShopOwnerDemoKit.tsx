import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import {
  Store, Gift, MessageSquare, UserPlus, LayoutDashboard,
  Download, Copy, Check, Phone, AlertTriangle,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useRole } from '../lib/RoleContext'
import { useView } from '../lib/ViewContext'
import {
  type DemoKitShop,
  deriveOrderMessage,
  formatPhoneDisplay,
  formatPhoneSpoken,
  buildSmsUri,
  buildVCard,
  buildOwnerDashboardUrl,
  downloadSvg,
} from '../lib/demoKit'

/**
 * Demo Kit — the owner-facing web version of the demo email.
 *
 * Every code on this page is generated at render time from the shop row this
 * page just loaded. There is no stored SVG, no pre-baked attachment, and no
 * hand-typed number anywhere in the render path. If the shop's number changes,
 * this page changes with it on the next load; it cannot go stale.
 *
 * That is the whole point. The emailed kit shipped baked SVGs that outlived the
 * data they were generated from, and one of them encoded a placeholder. A page
 * rendered from the record can only show what is true right now.
 */

// ─── Small UI helpers ────────────────────────────────────────────────────────

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        })
      }}
      className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-brand-600 transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  )
}

interface KitCardProps {
  badge: string
  icon: React.ReactNode
  title: string
  blurb: string
  /** The exact string the QR encodes. Null = we have nothing true to encode. */
  payload: string | null
  /** Shown under the code so a human can read/say/type it without scanning. */
  readable: React.ReactNode
  /** Raw payload preview so drift is visible, not silent. */
  decodesTo: string
  downloadName: string
  qrId: string
  /** Plain-English reason there is no code, when payload is null. */
  missingReason?: string
}

function KitCard({
  badge, icon, title, blurb, payload, readable, decodesTo, downloadName, qrId, missingReason,
}: KitCardProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 flex flex-col">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-bold tracking-wider uppercase text-brand-600 bg-brand-50 rounded px-2 py-0.5">
          {badge}
        </span>
      </div>
      <div className="flex items-center gap-2 mb-1 text-gray-800">
        {icon}
        <h3 className="font-semibold text-sm">{title}</h3>
      </div>
      <p className="text-xs text-gray-500 mb-4 leading-relaxed">{blurb}</p>

      {payload ? (
        <>
          <div className="self-center p-3 bg-white rounded-xl border border-gray-100">
            <QRCodeSVG id={qrId} value={payload} size={190} level="M" includeMargin={true} />
          </div>

          <div className="mt-4 text-center">{readable}</div>

          <div className="mt-3 bg-gray-50 border border-gray-100 rounded-lg p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mb-1">
              This code opens
            </p>
            <p className="text-[11px] font-mono text-gray-600 break-all leading-snug">{decodesTo}</p>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <button
              onClick={() => {
                const svg = document.getElementById(qrId) as unknown as SVGSVGElement
                if (svg) downloadSvg(svg, downloadName)
              }}
              className="inline-flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-700 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Download QR
            </button>
            <CopyButton value={payload} label="Copy link" />
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center bg-amber-50 border border-dashed border-amber-200 rounded-xl p-6 text-center">
          <AlertTriangle className="w-6 h-6 text-amber-500 mb-2" />
          <p className="text-sm font-semibold text-amber-900">No code yet</p>
          <p className="text-xs text-amber-800 mt-1 leading-relaxed">{missingReason}</p>
        </div>
      )}
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ShopOwnerDemoKit() {
  const { tenantId, isShopOwner, isSuperAdmin } = useRole()
  const { mode, previewTenantId, setMode, setPreview } = useView()
  const [searchParams] = useSearchParams()

  const previewing = isSuperAdmin && mode === 'owner'
  const effTenant = previewing ? previewTenantId : tenantId
  const asOwner = isShopOwner || previewing

  const { data: shops } = useQuery<DemoKitShop[]>({
    queryKey: ['demo-kit-shops', effTenant],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shops')
        .select('id, name, slug, phone_number_e164')
        .eq('tenant_id', effTenant)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data ?? []
    },
    enabled: !!effTenant && asOwner,
  })

  const [shopId, setShopId] = useState<string | null>(null)
  const shop = useMemo(() => {
    if (!shops || shops.length === 0) return null
    return shops.find(s => s.id === shopId) ?? shops[0]
  }, [shops, shopId])

  // Super-admins landing here are previewing the owner experience.
  useEffect(() => {
    if (isSuperAdmin && mode !== 'owner') setMode('owner')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin])

  // ?shop= accepts a UUID or a slug (the demo links use the slug).
  useEffect(() => {
    const shopParam = searchParams.get('shop')
    if (!shopParam) return
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shopParam)
    if (isUuid) setShopId(shopParam)
    supabase
      .from('shops')
      .select('id, tenant_id, name')
      .eq(isUuid ? 'id' : 'slug', shopParam)
      .single()
      .then(({ data, error }) => {
        if (error || !data) return
        setShopId(data.id)
        if (isSuperAdmin) {
          setPreview(data.tenant_id, data.name ?? null)
          if (mode !== 'owner') setMode('owner')
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, isSuperAdmin])

  // ── Payloads — all derived, none stored ───────────────────────────────────
  const phone = shop?.phone_number_e164 ?? null
  const orderMessage = useMemo(() => (shop ? deriveOrderMessage(shop.name) : ''), [shop])
  const smsUri = useMemo(
    () => (shop && phone ? buildSmsUri(phone, orderMessage) : null),
    [shop, phone, orderMessage],
  )
  const vcard = useMemo(() => (shop && phone ? buildVCard(shop) : null), [shop, phone])
  const dashUrl = useMemo(() => (shop ? buildOwnerDashboardUrl(shop) : null), [shop])

  // ── Guards ────────────────────────────────────────────────────────────────
  if (!asOwner) {
    return <div className="p-8 flex justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
  }
  if (previewing && !effTenant) {
    return (
      <div className="p-8 text-center py-16 text-gray-400">
        <Store className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="font-medium">Owner preview</p>
        <p className="text-sm mt-1">Pick a shop in the “View as” selector above.</p>
      </div>
    )
  }
  if (shops && shops.length === 0) {
    return (
      <div className="p-8 text-center py-16 text-gray-400">
        <Store className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="font-medium">No shop assigned</p>
        <p className="text-sm mt-1">Contact SprintAI support to set up your restaurant.</p>
      </div>
    )
  }
  if (!shop) {
    return <div className="p-8 flex justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
  }

  return (
    <div className="p-6 md:p-8 max-w-[1200px] mx-auto space-y-8">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-brand-50 flex items-center justify-center">
            <Gift className="w-6 h-6 text-brand-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Demo Kit</h1>
            <div className="flex items-center gap-2 text-sm text-gray-400">
              {shops && shops.length > 1 ? (
                <select
                  value={shop.id}
                  onChange={e => setShopId(e.target.value)}
                  className="bg-transparent border border-gray-200 rounded-md px-2 py-0.5 text-sm text-gray-600"
                >
                  {shops.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              ) : (
                <span>{shop.name}</span>
              )}
            </div>
          </div>
        </div>
        <p className="text-xs text-gray-400 max-w-xs text-right hidden md:block">
          Every code below is generated from your shop record when this page loads.
          Nothing here can go out of date.
        </p>
      </div>

      {/* ── The pitch ──────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-2">The pitch, in a sentence</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          Sprint gives {shop.name} a dedicated text-ordering number. Customers text it like
          they'd text a friend — no app to download, no account to create. You keep your
          customers, your margin, and your name on the sale.
        </p>
        <div className="mt-4 bg-brand-50 border border-brand-100 rounded-lg p-4">
          <p className="text-xs font-semibold text-brand-700 uppercase tracking-wide mb-1">The numbers</p>
          <p className="text-sm text-gray-700 leading-relaxed">
            Aggregators take 15–30% per order. Sprint is $99/mo + $0.99 per order, paid by the
            customer. On $10,000 in monthly orders, DoorDash keeps about $2,500 — Sprint costs
            about $200. That's $2,300 a month back in your pocket.
          </p>
        </div>
      </div>

      {/* ── Missing-number banner ──────────────────────────────────────────── */}
      {!phone && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-900">
              {shop.name} doesn't have a text-ordering number yet.
            </p>
            <p className="text-xs text-amber-800 mt-1 leading-relaxed">
              The two texting codes below stay blank until a number is assigned. We deliberately
              don't render a code we can't stand behind — a QR that opens a text to nowhere is
              worse than no QR at all.
            </p>
          </div>
        </div>
      )}

      {/* ── The three codes ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <KitCard
          badge="QR 1"
          icon={<MessageSquare className="w-4 h-4 text-brand-600" />}
          title={`Scan to Text ${shop.name}`}
          blurb="Hand this to the person you're demoing for. They scan it and place an order like a customer would — the assistant takes the order, confirms items, totals the cart, and sends a payment link."
          payload={smsUri}
          qrId="demo-qr-sms"
          downloadName={`${shop.slug}-scan-to-text.svg`}
          missingReason="Assign a text-ordering number to this shop and the code appears here automatically."
          readable={
            <>
              <div className="flex items-center justify-center gap-2 text-gray-900">
                <Phone className="w-4 h-4 text-gray-400" />
                <span className="text-lg font-semibold tracking-tight">
                  {phone ? formatPhoneSpoken(phone) : ''}
                </span>
              </div>
              <div className="mt-1">
                {phone && <CopyButton value={phone} label="Copy number" />}
              </div>
              <p className="text-xs text-gray-500 mt-2 leading-relaxed">
                Pre-filled message: “{orderMessage}”
              </p>
            </>
          }
          decodesTo={smsUri ?? ''}
        />

        <KitCard
          badge="QR 2"
          icon={<UserPlus className="w-4 h-4 text-brand-600" />}
          title={`Add ${shop.name} to your contacts`}
          blurb="One tap saves the shop to their phone. After the first order Sprint asks the customer to save the contact — customers who do are far more likely to order again."
          payload={vcard}
          qrId="demo-qr-vcard"
          downloadName={`${shop.slug}-contact-card.svg`}
          missingReason="A contact card needs a number. Assign one and the code appears here automatically."
          readable={
            <>
              <p className="text-sm font-semibold text-gray-900">{shop.name}</p>
              <div className="flex items-center justify-center gap-2 text-gray-700 mt-0.5">
                <Phone className="w-3.5 h-3.5 text-gray-400" />
                <span className="text-sm font-medium">
                  {phone ? formatPhoneDisplay(phone) : ''}
                </span>
              </div>
              <div className="mt-1">
                {phone && <CopyButton value={phone} label="Copy number" />}
              </div>
            </>
          }
          decodesTo={
            phone
              ? `vCard 3.0 — saves “${shop.name}” with ${formatPhoneDisplay(phone)}`
              : ''
          }
        />

        <KitCard
          badge="QR 3"
          icon={<LayoutDashboard className="w-4 h-4 text-brand-600" />}
          title="Talk to the shop as admin"
          blurb="Opens this dashboard, scoped to your shop. Show them where they manage items, mark things sold out, pause ordering when the kitchen is slammed, and watch orders come in."
          payload={dashUrl}
          qrId="demo-qr-admin"
          downloadName={`${shop.slug}-owner-dashboard.svg`}
          readable={
            <>
              <p className="text-sm font-medium text-gray-800">Owner dashboard</p>
              <p className="text-xs text-gray-500 mt-0.5">Sign-in required — it's their real account</p>
              <div className="mt-1">
                {dashUrl && <CopyButton value={dashUrl} label="Copy link" />}
              </div>
            </>
          }
          decodesTo={dashUrl ?? ''}
        />
      </div>

      {/* ── The walkthrough ────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-1">The walkthrough</h2>
        <p className="text-sm text-gray-500 mb-5">
          Six steps, about five minutes. Run it in this order.
        </p>
        <ol className="space-y-4">
          {[
            {
              t: 'Warm them up',
              d: `“Let me show you something — your restaurant taking orders by text. Same way customers already text their friends and family. No app to download, no account to create, no password to remember.”`,
            },
            {
              t: 'Order as a customer (QR 1)',
              d: `“Scan this with your camera — it opens a text to the Sprint line. Order something, just like a customer would.” Point out that it understands plain language, confirms line items, remembers past orders, totals the cart, and sends a payment link.`,
            },
            {
              t: 'Show the dashboard (QR 3)',
              d: `“This is where you run the shop. See the incoming orders. Mark something sold out. Pause ordering if the kitchen gets slammed. All from your phone.”`,
            },
            {
              t: 'Save the contact (QR 2)',
              d: `“After one order, Sprint gets the customer to save the shop as a contact. That's the whole ballgame — customers with you saved in their phone reorder far more than customers who find you through an app.”`,
            },
            {
              t: 'The pitch',
              d: `“You keep your customers, your margin, and your name on the sale. No aggregator taking 30%. It's AI, so it won't be perfect — but we test every shop before go-live, we show you those tests, and we watch quality every single day. $99 a month. $0.99 an order. No contract. Cancel anytime.”`,
            },
            {
              t: 'Close',
              d: `“Want your own line? Let's get you signed up — takes 15 minutes right now.”`,
            },
          ].map((s, i) => (
            <li key={s.t} className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-brand-100 text-brand-700 text-sm font-bold flex items-center justify-center">
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-semibold text-gray-800">{s.t}</p>
                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <p className="text-xs text-gray-400 text-center pb-4">
        Sprint — SMS ordering for family-owned restaurants
      </p>
    </div>
  )
}
