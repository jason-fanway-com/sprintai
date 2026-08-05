import { useMemo } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Download, MessageSquare, UserPlus } from 'lucide-react'

interface Shop {
  id: string
  name: string
  slug: string
  phone_number_e164: string | null
}

interface QRCodesTabProps {
  shop: Shop
}

/**
 * Derive a friendly "I want to order" message from the shop name.
 * If the name contains a known food keyword, use it. Otherwise, generic.
 */
function deriveOrderMessage(shopName: string): string {
  const lower = shopName.toLowerCase()
  if (lower.includes('bagel')) return `I'd like to order some bagels from ${shopName}!`
  if (lower.includes('pizza')) return `I'd like to order some pizza from ${shopName}!`
  if (lower.includes('burger')) return `I'd like to order a burger from ${shopName}!`
  if (lower.includes('sushi')) return `I'd like to order some sushi from ${shopName}!`
  if (lower.includes('taco')) return `I'd like to order some tacos from ${shopName}!`
  if (lower.includes('chicken')) return `I'd like to order some chicken from ${shopName}!`
  if (lower.includes('sandwich') || lower.includes('sub') || lower.includes('deli')) return `I'd like to order a sandwich from ${shopName}!`
  if (lower.includes('coffee') || lower.includes('cafe') || lower.includes('café')) return `I'd like to place an order from ${shopName}!`
  if (lower.includes('bakery') || lower.includes('bake')) return `I'd like to place an order from ${shopName}!`
  if (lower.includes('thai') || lower.includes('chinese') || lower.includes('indian') || lower.includes('mexican')) return `I'd like to place an order from ${shopName}!`
  return `I'd like to place an order from ${shopName}!`
}

/** Format E.164 number for display: +1 (610) 379-2553 */
function formatPhoneDisplay(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/)
  if (m) return `+1 (${m[1]}) ${m[2]}-${m[3]}`
  return e164
}

/** Build the SMS QR payload.  iOS/Android handle sms: URIs slightly differently. */
function buildSmsUri(phone: string, body: string): string {
  // Both iOS 14+ and Android support sms:&body= (colon before body)
  // Using the universally-safe format: sms:+1XXXXXXXXXX?&body=URL-encoded
  return `sms:${phone}?&body=${encodeURIComponent(body)}`
}

/** Build a vCard 3.0 string for the contact card QR */
function buildVCard(shop: Shop): string {
  const phone = shop.phone_number_e164 || ''
  const displayPhone = formatPhoneDisplay(phone)
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${shop.name}`,
    `TEL;TYPE=WORK,MSG:${displayPhone}`,
    `TEL;TYPE=WORK,MSG:${phone}`,
    `ORG:${shop.name}`,
    'END:VCARD',
  ].join('\n')
}

function downloadSvg(svgElement: SVGSVGElement, filename: string) {
  const serializer = new XMLSerializer()
  const svgString = serializer.serializeToString(svgElement)
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export default function QRCodesTab({ shop }: QRCodesTabProps) {
  const hasPhone = !!shop.phone_number_e164

  const orderMessage = useMemo(() => deriveOrderMessage(shop.name), [shop.name])
  const smsUri = useMemo(
    () => (hasPhone ? buildSmsUri(shop.phone_number_e164!, orderMessage) : ''),
    [hasPhone, shop.phone_number_e164, orderMessage],
  )
  const vcard = useMemo(() => buildVCard(shop), [shop])

  return (
    <div className="space-y-6 max-w-2xl">
      {!hasPhone && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          This shop doesn't have a phone number assigned yet. QR codes will appear once a number is provisioned.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* SMS QR */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 flex flex-col items-center">
          <div className="flex items-center gap-2 mb-1 text-gray-700">
            <MessageSquare className="w-4 h-4 text-brand-600" />
            <h3 className="font-semibold text-sm">Scan to Text Us</h3>
          </div>
          <p className="text-xs text-gray-400 mb-4 text-center">
            Opens a text message to the shop with a pre-filled order request
          </p>
          {hasPhone ? (
            <>
              <div className="p-4 bg-white rounded-xl border border-gray-100">
                <QRCodeSVG
                  id="qr-sms"
                  value={smsUri}
                  size={200}
                  level="M"
                  includeMargin={true}
                />
              </div>
              <p className="text-xs text-gray-500 mt-3 text-center max-w-[220px]">
                Pre-filled message: "{orderMessage}"
              </p>
              <p className="text-xs font-mono text-gray-400 mt-1">
                {formatPhoneDisplay(shop.phone_number_e164!)}
              </p>
              <button
                onClick={() => {
                  const svg = document.getElementById('qr-sms') as unknown as SVGSVGElement
                  if (svg) downloadSvg(svg, `${shop.slug}-scan-to-text.svg`)
                }}
                className="mt-4 flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Download QR
              </button>
            </>
          ) : (
            <div className="w-[200px] h-[200px] flex items-center justify-center bg-gray-50 rounded-xl border border-dashed border-gray-200">
              <span className="text-xs text-gray-300">No number assigned</span>
            </div>
          )}
        </div>

        {/* Contact Card QR */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 flex flex-col items-center">
          <div className="flex items-center gap-2 mb-1 text-gray-700">
            <UserPlus className="w-4 h-4 text-brand-600" />
            <h3 className="font-semibold text-sm">Scan to Save Our Contact</h3>
          </div>
          <p className="text-xs text-gray-400 mb-4 text-center">
            Saves the shop as a contact in the customer's phone
          </p>
          {hasPhone ? (
            <>
              <div className="p-4 bg-white rounded-xl border border-gray-100">
                <QRCodeSVG
                  id="qr-contact"
                  value={vcard}
                  size={200}
                  level="M"
                  includeMargin={true}
                />
              </div>
              <p className="text-xs text-gray-500 mt-3 text-center">
                Adds: {shop.name} · {formatPhoneDisplay(shop.phone_number_e164!)}
              </p>
              <button
                onClick={() => {
                  const svg = document.getElementById('qr-contact') as unknown as SVGSVGElement
                  if (svg) downloadSvg(svg, `${shop.slug}-contact-card.svg`)
                }}
                className="mt-4 flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Download QR
              </button>
            </>
          ) : (
            <div className="w-[200px] h-[200px] flex items-center justify-center bg-gray-50 rounded-xl border border-dashed border-gray-200">
              <span className="text-xs text-gray-300">No number assigned</span>
            </div>
          )}
        </div>
      </div>

      {/* Print instructions */}
      {hasPhone && (
        <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
          <h4 className="text-xs font-semibold text-gray-600 mb-2">How to use these QR codes</h4>
          <ul className="text-xs text-gray-500 space-y-1 list-disc list-inside">
            <li><b>Scan to Text Us</b> — Print and display at the counter or on tables. Customer scans, a text opens pre-filled, they hit send.</li>
            <li><b>Scan to Save Contact</b> — Print near the register. Customer scans, the shop saves to their contacts so they can text anytime.</li>
            <li>Download the SVG files for high-quality printing at any size.</li>
          </ul>
        </div>
      )}
    </div>
  )
}
