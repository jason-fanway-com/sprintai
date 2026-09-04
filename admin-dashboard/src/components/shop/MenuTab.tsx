import { Upload, ToggleLeft, ToggleRight, UtensilsCrossed, HelpCircle } from 'lucide-react'
import { UseMutationResult } from '@tanstack/react-query'

interface MenuItem {
  id: string
  name: string
  price_cents: number
  category: string
  description: string | null
  active: boolean
  // Item F: confidence-based curation flags from extract-menu-items
  flag_review?: boolean | null
  flag_reason?: string | null
}

interface MenuTabProps {
  menuItems: MenuItem[] | undefined
  soldOutIds: Set<string> | undefined
  isUploading: boolean
  uploadStatus: string
  onUploadPdf: (e: React.ChangeEvent<HTMLInputElement>) => void
  onToggleSoldOut: UseMutationResult<void, Error, { menuItemId: string; currentlySoldOut: boolean }, unknown>
  onResetAll: UseMutationResult<void, Error, void, unknown>
  onClearFlag?: UseMutationResult<void, Error, { menuItemId: string }, unknown>
}

export default function MenuTab({
  menuItems,
  soldOutIds,
  isUploading,
  uploadStatus,
  onUploadPdf,
  onToggleSoldOut,
  onResetAll,
  onClearFlag,
}: MenuTabProps) {
  const allItems = menuItems ?? []

  // Item F: split into confident (ready to go) and flagged (needs owner answer)
  const confidentItems = allItems.filter(it => !it.flag_review)
  const flaggedItems   = allItems.filter(it => it.flag_review)

  const categoryGroups = confidentItems.reduce<Record<string, MenuItem[]>>((acc, item) => {
    const cat = item.category ?? 'Other'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(item)
    return acc
  }, {})

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">
          {(soldOutIds?.size ?? 0) > 0
            ? `${soldOutIds?.size} item(s) sold out today`
            : 'All items available'}
        </p>
        <div className="flex gap-2">
          {(soldOutIds?.size ?? 0) > 0 && (
            <button
              onClick={() => onResetAll.mutate()}
              disabled={onResetAll.isPending}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Reset All
            </button>
          )}
          <label className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors cursor-pointer ${isUploading ? 'bg-gray-400 cursor-wait' : 'bg-brand-600 hover:bg-brand-700'} text-white`}>
            {isUploading ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Upload className="w-4 h-4" />}
            {isUploading ? 'Parsing...' : 'Upload Menu PDF'}
            <input type="file" accept=".pdf" className="hidden" onChange={onUploadPdf} disabled={isUploading} />
          </label>
        </div>
      </div>

      {uploadStatus && (
        <div className={`mt-3 mb-4 flex items-center gap-2 text-sm ${isUploading ? 'text-brand-600' : uploadStatus.startsWith('Upload failed') ? 'text-red-600' : 'text-green-600'}`}>
          {isUploading && <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-brand-600 flex-shrink-0" />}
          {!isUploading && !uploadStatus.startsWith('Upload failed') && <span>✓</span>}
          {!isUploading && uploadStatus.startsWith('Upload failed') && <span>✗</span>}
          {uploadStatus}
        </div>
      )}

      {/* Item F: "We have questions" section — low-confidence items surfaced as specific questions */}
      {flaggedItems.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <HelpCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
            <h3 className="text-sm font-semibold text-amber-700">
              We have questions ({flaggedItems.length})
            </h3>
          </div>
          <p className="text-xs text-amber-600 mb-3">
            These items were extracted but we're not fully confident about them. Review each question below and click "Looks right" to confirm.
          </p>
          <div className="bg-amber-50 rounded-xl border border-amber-200 overflow-hidden">
            {flaggedItems.map((item, idx) => (
              <div
                key={item.id}
                className={`px-4 py-3 ${idx < flaggedItems.length - 1 ? 'border-b border-amber-100' : ''}`}
              >
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{item.name}</p>
                    {item.price_cents > 0 && (
                      <p className="text-xs text-gray-500">${(item.price_cents / 100).toFixed(2)} · {item.category}</p>
                    )}
                    {item.flag_reason && (
                      <p className="mt-1 text-xs text-amber-700 font-medium">
                        ? {item.flag_reason}
                      </p>
                    )}
                  </div>
                  {onClearFlag && (
                    <button
                      onClick={() => onClearFlag.mutate({ menuItemId: item.id })}
                      disabled={onClearFlag.isPending}
                      className="flex-shrink-0 px-3 py-1 text-xs font-medium rounded-lg border border-amber-300 bg-white text-amber-700 hover:bg-amber-100 transition-colors disabled:opacity-50"
                    >
                      Looks right
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confident items — normal category view */}
      {Object.keys(categoryGroups).length === 0 && flaggedItems.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          <UtensilsCrossed className="w-10 h-10 mx-auto mb-2 opacity-30" />
          <p>No menu items yet. Upload a PDF to get started.</p>
        </div>
      )}

      {Object.keys(categoryGroups).length > 0 && (
        <div>
          {flaggedItems.length > 0 && (
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Your menu ({confidentItems.length} items)
            </h3>
          )}
          {Object.entries(categoryGroups).map(([category, items]) => (
            <div key={category} className="mb-6">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{category}</h3>
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {items.map((item, idx) => {
                  const soldOut = soldOutIds?.has(item.id) ?? false
                  return (
                    <div
                      key={item.id}
                      className={`flex items-center gap-4 px-4 py-3 ${idx < items.length - 1 ? 'border-b border-gray-50' : ''} ${soldOut ? 'opacity-60' : ''}`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium ${soldOut ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                          {item.name}
                        </p>
                        {item.description && (
                          <p className="text-xs text-gray-400 truncate">{item.description}</p>
                        )}
                      </div>
                      <span className={`text-sm font-medium ${soldOut ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                        ${(item.price_cents / 100).toFixed(2)}
                      </span>
                      <button
                        onClick={() => onToggleSoldOut.mutate({ menuItemId: item.id, currentlySoldOut: soldOut })}
                        className="flex-shrink-0"
                        title={soldOut ? 'Mark available' : 'Mark sold out'}
                      >
                        {soldOut
                          ? <ToggleLeft className="w-8 h-8 text-red-400 hover:text-red-600 transition-colors" />
                          : <ToggleRight className="w-8 h-8 text-green-500 hover:text-green-700 transition-colors" />}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
