import { useMemo } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Download, MessageSquare, MessageCircle, UserPlus, ClipboardCheck, ImageIcon } from 'lucide-react'
// Payload builders live in one place so the admin tab and the owner-facing
// Demo Kit page can never render different codes for the same shop.
import {
  type DemoKitShop as Shop,
  deriveOrderMessage,
  formatPhoneDisplay,
  buildSmsUri,
  buildVCard,
  downloadSvg,
} from '../../lib/demoKit'

interface QRCodesTabProps {
  shop: Shop
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
    <div className="space-y-8 max-w-2xl">
      {!hasPhone && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          This shop doesn't have a phone number assigned yet. QR codes will appear once a number is provisioned.
        </div>
      )}

      {/* ── QR Codes ──────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">QR Codes</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
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

          {/* Store Chat QR — owner-facing */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 flex flex-col items-center">
            <div className="flex items-center gap-2 mb-1 text-gray-700">
              <MessageCircle className="w-4 h-4 text-brand-600" />
              <h3 className="font-semibold text-sm">Scan to Open Store Chat</h3>
            </div>
            <p className="text-xs text-gray-400 mb-4 text-center">
              Opens the shop owner chat PWA — manage orders and chat with customers
            </p>
            <div className="p-4 bg-white rounded-xl border border-gray-100">
              <QRCodeSVG
                id="qr-store-chat"
                value="https://getsprintai.com/chat"
                size={200}
                level="M"
                includeMargin={true}
              />
            </div>
            <p className="text-xs text-gray-500 mt-3 text-center">
              getsprintai.com/chat
            </p>
            <button
              onClick={() => {
                const svg = document.getElementById('qr-store-chat') as unknown as SVGSVGElement
                if (svg) downloadSvg(svg, `${shop.slug}-store-chat.svg`)
              }}
              className="mt-4 flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Download QR
            </button>
          </div>
        </div>
      </section>

      {/* ── Onboarding ────────────────────────────────────────────── */}
      <section>
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center gap-2 mb-4">
            <ClipboardCheck className="w-5 h-5 text-brand-600" />
            <h2 className="text-lg font-semibold text-gray-900">How It Works</h2>
          </div>
          <p className="text-sm text-gray-500 mb-5">
            Here's what happens when a customer scans your QR code — from first tap to completed order.
          </p>
          <ol className="space-y-4">
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-brand-100 text-brand-700 text-sm font-bold flex items-center justify-center">1</span>
              <div>
                <p className="text-sm font-semibold text-gray-800">Customer scans the QR</p>
                <p className="text-xs text-gray-500 mt-0.5">They scan the code on your door sticker, counter sign, or takeout bag. No app to download — their phone camera does the work.</p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-brand-100 text-brand-700 text-sm font-bold flex items-center justify-center">2</span>
              <div>
                <p className="text-sm font-semibold text-gray-800">Save the contact or start a text</p>
                <p className="text-xs text-gray-500 mt-0.5">One tap saves your shop to their phone, or opens a pre-filled text ready to send. No forms, no signups.</p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-brand-100 text-brand-700 text-sm font-bold flex items-center justify-center">3</span>
              <div>
                <p className="text-sm font-semibold text-gray-800">They order over SMS</p>
                <p className="text-xs text-gray-500 mt-0.5">The customer texts what they want. Sprint's AI understands natural language — they can say "large pepperoni and a Caesar salad" and we get it.</p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-brand-100 text-brand-700 text-sm font-bold flex items-center justify-center">4</span>
              <div>
                <p className="text-sm font-semibold text-gray-800">Payment happens in the chat</p>
                <p className="text-xs text-gray-500 mt-0.5">Sprint sends a secure payment link right in the text thread. The customer taps, pays in a few seconds, and gets a receipt.</p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-brand-100 text-brand-700 text-sm font-bold flex items-center justify-center">5</span>
              <div>
                <p className="text-sm font-semibold text-gray-800">Pickup or delivery</p>
                <p className="text-xs text-gray-500 mt-0.5">They choose pickup or delivery during the order. Sprint handles the timing and lets them know when it's ready. That's it — no back-and-forth, no phone tag.</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      {/* ── Print instructions (legacy) ───────────────────────────── */}
      {hasPhone && (
        <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
          <h4 className="text-xs font-semibold text-gray-600 mb-2">How to use these QR codes</h4>
          <ul className="text-xs text-gray-500 space-y-1 list-disc list-inside">
            <li><b>Scan to Text Us</b> — Print and display at the counter or on tables. Customer scans, a text opens pre-filled, they hit send.</li>
            <li><b>Scan to Save Contact</b> — Print near the register. Customer scans, the shop saves to their contacts so they can text anytime.</li>
            <li><b>Scan to Open Store Chat</b> — Print for staff or keep behind the counter. Opens the shop owner chat PWA to manage orders and talk with customers.</li>
            <li>Download the SVG files for high-quality printing at any size.</li>
          </ul>
        </div>
      )}

      {/* ── Marketing Kit ─────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Marketing Kit</h2>
        <p className="text-sm text-gray-500 mb-5">
          Ready-to-print materials to get your QR codes in front of customers. Swap in your own photos when you're live.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Door sticker */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col items-center">
            <div className="w-full aspect-[4/3] bg-gray-50 rounded-lg border border-dashed border-gray-200 flex items-center justify-center mb-3">
              <div className="flex flex-col items-center text-gray-300">
                <ImageIcon className="w-8 h-8 mb-1" />
                <span className="text-xs">Door sticker</span>
              </div>
            </div>
            <p className="text-xs font-medium text-gray-700 text-center">Door Sticker with QR</p>
            <p className="text-xs text-gray-400 text-center mt-1">Weatherproof 4×6 vinyl sticker for your front door or window. Includes your "Scan to Text Us" QR code and a short call-to-action.</p>
          </div>

          {/* Counter sign */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col items-center">
            <div className="w-full aspect-[4/3] bg-gray-50 rounded-lg border border-dashed border-gray-200 flex items-center justify-center mb-3">
              <div className="flex flex-col items-center text-gray-300">
                <ImageIcon className="w-8 h-8 mb-1" />
                <span className="text-xs">Counter sign</span>
              </div>
            </div>
            <p className="text-xs font-medium text-gray-700 text-center">Checkout-Counter Sign with QRs</p>
            <p className="text-xs text-gray-400 text-center mt-1">5×7 tent card for your register or pickup counter. Shows both the "Scan to Text Us" and "Scan to Save Contact" QRs.</p>
          </div>

          {/* Bag / box stickers */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col items-center">
            <div className="w-full aspect-[4/3] bg-gray-50 rounded-lg border border-dashed border-gray-200 flex items-center justify-center mb-3">
              <div className="flex flex-col items-center text-gray-300">
                <ImageIcon className="w-8 h-8 mb-1" />
                <span className="text-xs">Bag sticker</span>
              </div>
            </div>
            <p className="text-xs font-medium text-gray-700 text-center">Stickers for Bags & Boxes</p>
            <p className="text-xs text-gray-400 text-center mt-1">3×3 round stickers for takeout bags, pizza boxes, and bagel sleeves. Small QR, big return visits — customers reorder with one tap next time.</p>
          </div>
        </div>
      </section>
    </div>
  )
}