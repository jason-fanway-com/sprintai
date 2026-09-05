/**
 * demoKit.ts — the ONE source of truth for every demo-kit payload.
 *
 * Everything a QR code encodes is derived here, from the live shop record, at
 * render time. Nothing is baked, cached, or stored as a file.
 *
 * WHY THIS FILE EXISTS: the Vito's demo email shipped pre-generated SVG QR
 * attachments. They drifted from the shop record and encoded a phone number
 * the shop no longer had. Erin would have scanned a code in front of a buyer
 * and opened a text to the wrong number. Two artifacts, two renderings, silent
 * divergence. There is now one renderer, and it reads the database.
 *
 * Rule for anything added here: derive from the `shop` argument. Never accept a
 * pre-formatted string a caller typed in, and never write a payload to disk.
 */

/** The public front door humans use. Never a raw *.netlify.app origin. */
export const PUBLIC_SITE_URL: string =
  (import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined) ?? 'https://getsprintai.com'

export interface DemoKitShop {
  id: string
  name: string
  slug: string
  phone_number_e164: string | null
}

/**
 * Derive a friendly "I want to order" message from the shop name.
 * If the name contains a known food keyword, use it. Otherwise, generic.
 */
export function deriveOrderMessage(shopName: string): string {
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

/** Format E.164 for display: +1 (610) 379-2553. Non-US/odd shapes pass through. */
export function formatPhoneDisplay(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/)
  if (m) return `+1 (${m[1]}) ${m[2]}-${m[3]}`
  return e164
}

/** Bare national format for reading aloud: (610) 379-2553. */
export function formatPhoneSpoken(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/)
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`
  return e164
}

/** Build the SMS QR payload. iOS/Android handle sms: URIs slightly differently. */
export function buildSmsUri(phone: string, body: string): string {
  return `sms:${phone}?&body=${encodeURIComponent(body)}`
}

/** Build a vCard 3.0 string for the contact-card QR. */
export function buildVCard(shop: DemoKitShop): string {
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

/**
 * Owner dashboard deep link for this shop, on the public front door.
 * `?shop=` accepts a slug — ShopOwnerDashboard resolves slug → id.
 */
export function buildOwnerDashboardUrl(shop: DemoKitShop): string {
  return `${PUBLIC_SITE_URL}/admin/shop-owner?shop=${encodeURIComponent(shop.slug)}`
}

/** Serialize a live <svg> node and hand it to the browser as a download. */
export function downloadSvg(svgElement: SVGSVGElement, filename: string) {
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
