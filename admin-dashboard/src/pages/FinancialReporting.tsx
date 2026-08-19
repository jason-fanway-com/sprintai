import { FileText } from 'lucide-react'
import { useEffectiveTenant } from '../lib/useOwnerTenant'

/**
 * Financial Reporting — placeholder.
 *
 * Full build (QuickBooks-like transaction ledger + QB CSV export, backed by a
 * `shop-financials` edge function) is tracked separately. This shell exists so
 * the owner nav route resolves and the app builds; it is owner-scoped and shows
 * a "coming soon" state rather than any unscoped data.
 *
 * See docs/specs/2026-08-08-shop-financial-reporting.md.
 */
export default function FinancialReporting() {
  const { isOwnerView, effTenant } = useEffectiveTenant()

  if (isOwnerView && !effTenant) {
    return (
      <div className="p-8 text-gray-500">Pick a shop to view its financials.</div>
    )
  }

  return (
    <div className="p-8">
      <div className="flex items-center gap-3 mb-2">
        <FileText className="w-6 h-6 text-gray-400" />
        <h1 className="text-2xl font-semibold text-gray-800">Financial Reporting</h1>
      </div>
      <p className="text-gray-500 max-w-xl">
        A full transaction ledger and QuickBooks-ready CSV export are on the way.
        You'll see every order, fee, and payout here, reconciled and exportable.
      </p>
    </div>
  )
}
