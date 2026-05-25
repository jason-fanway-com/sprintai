import { useEffect } from 'react'
import { Globe, MessageSquare, UtensilsCrossed, Upload, Settings, Pencil, Trash2, Plus } from 'lucide-react'
import { UseMutationResult } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import ShopChatTest from '../ShopChatTest'

interface MenuItem {
  id: string
  name: string
  price_cents: number
  category: string
  description: string | null
  active: boolean
  modifiers_json: Array<{ name: string; price_cents: number }> | null
}

type EditItemForm = { name: string; price_cents_str: string; description: string; category: string }
type AddItemForm = { name: string; price_cents_str: string; description: string }

interface ChatAdminTabProps {
  shopId: string
  shopName: string
  shop: { website_url: string | null; shop_context: string | null; ai_instructions: string | null }
  menuItems: MenuItem[] | undefined
  soldOutIds: Set<string> | undefined
  activeMenuId: string | null
  urlDraft: string
  contextDraft: string
  instructionsDraft: string
  editingContext: boolean
  isScraping: boolean
  isUploading: boolean
  uploadStatus: string
  editingItemId: string | null
  editItemForm: EditItemForm
  addingToCategory: string | null
  addItemForm: AddItemForm
  addItemCategory: string
  onUrlDraftChange: (value: string) => void
  onContextDraftChange: (value: string) => void
  onInstructionsDraftChange: (value: string) => void
  onEditingContextChange: (editing: boolean) => void
  onUploadPdf: (e: React.ChangeEvent<HTMLInputElement>) => void
  onScrapeFromChatTab: () => void
  onSaveChatContext: () => void
  onEditItemIdChange: (id: string | null) => void
  onEditItemFormChange: (form: EditItemForm) => void
  onDeleteMenuItem: UseMutationResult<void, Error, string, unknown>
  onEditMenuItem: UseMutationResult<void, Error, { itemId: string; form: EditItemForm }, unknown>
  onAddMenuItem: UseMutationResult<void, Error, { category: string; form: AddItemForm }, unknown>
  onAddingToCategoryChange: (category: string | null) => void
  onAddItemFormChange: (form: AddItemForm) => void
  onAddItemCategoryChange: (category: string) => void
  saveChatContext: UseMutationResult<void, Error, void, unknown>
  onDirtyChange?: (dirty: boolean) => void
}

export default function ChatAdminTab({
  shopId,
  shopName,
  shop,
  menuItems,
  activeMenuId,
  urlDraft,
  contextDraft,
  instructionsDraft,
  editingContext,
  isScraping,
  isUploading,
  uploadStatus,
  editingItemId,
  editItemForm,
  addingToCategory,
  addItemForm,
  addItemCategory,
  onUrlDraftChange,
  onContextDraftChange,
  onInstructionsDraftChange,
  onEditingContextChange,
  onUploadPdf,
  onScrapeFromChatTab,
  onSaveChatContext,
  onEditItemIdChange,
  onEditItemFormChange,
  onDeleteMenuItem,
  onEditMenuItem,
  onAddMenuItem,
  onAddingToCategoryChange,
  onAddItemFormChange,
  onAddItemCategoryChange,
  saveChatContext,
  onDirtyChange,
}: ChatAdminTabProps) {
  const isDirty = instructionsDraft !== (shop.ai_instructions ?? '') || contextDraft !== (shop.shop_context ?? '')

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // Browser beforeunload guard
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  const categoryGroups = (menuItems ?? []).reduce<Record<string, MenuItem[]>>((acc, item) => {
    const cat = item.category ?? 'Other'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(item)
    return acc
  }, {})

  return (
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
      {/* Left panel: knowledge base (2/3 on desktop) */}
      <div className="lg:w-2/3 overflow-y-auto border-b border-gray-200 lg:border-b-0 lg:border-r max-h-64 lg:max-h-none">
        <div className="p-4 space-y-6">
          {/* AI Training Instructions */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
              <Settings className="w-4 h-4 text-gray-400" />
              AI Training Instructions
            </h3>
            <p className="text-xs text-gray-400 mb-2">Behavior corrections and rules for this shop. These override default behavior.</p>
            <textarea
              value={instructionsDraft}
              onChange={e => onInstructionsDraftChange(e.target.value)}
              rows={4}
              placeholder="Example: When a customer orders a dozen bagels, ask them what kinds they want until they reach 12. Never default to plain."
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
            />
          </div>

          {/* Shop Context section */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <Globe className="w-4 h-4 text-gray-400" />
              Shop Context
            </h3>
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="url"
                  value={urlDraft}
                  onChange={e => onUrlDraftChange(e.target.value)}
                  placeholder="https://example.com"
                  className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <button
                  onClick={onScrapeFromChatTab}
                  disabled={isScraping || !urlDraft.trim()}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm border border-brand-200 text-brand-600 rounded-lg hover:bg-brand-50 transition-colors disabled:opacity-50 flex-shrink-0"
                >
                  {isScraping
                    ? <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-brand-600" />
                    : <Globe className="w-3.5 h-3.5" />}
                  {isScraping ? 'Scraping...' : 'Scrape'}
                </button>
              </div>

              <div className="relative">
                <textarea
                  value={contextDraft}
                  onChange={e => onContextDraftChange(e.target.value)}
                  readOnly={!editingContext}
                  rows={5}
                  placeholder="AI-generated summary will appear here after scraping..."
                  className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none ${
                    editingContext ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 text-gray-600 cursor-default'
                  }`}
                />
                {!editingContext && contextDraft && (
                  <button
                    onClick={() => onEditingContextChange(true)}
                    className="absolute top-2 right-2 px-2 py-0.5 text-xs text-gray-400 hover:text-gray-600 border border-gray-200 rounded hover:bg-white transition-colors"
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Single save button for instructions + context */}
          <div className="flex justify-end pt-2 border-t border-gray-100">
            <button
              onClick={() => onSaveChatContext()}
              disabled={saveChatContext.isPending}
              className="flex items-center gap-1.5 px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
            >
              {isDirty && (
                <span className="w-2 h-2 rounded-full bg-yellow-300 flex-shrink-0" />
              )}
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {saveChatContext.isPending ? 'Saving...' : isDirty ? 'Save*' : 'Save'}
            </button>
          </div>

          {/* Menu section */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <UtensilsCrossed className="w-4 h-4 text-gray-400" />
                Menu
              </h3>
              <label className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors cursor-pointer ${isUploading ? 'bg-gray-400 cursor-wait' : 'bg-brand-600 hover:bg-brand-700'} text-white`}>
                {isUploading ? <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" /> : <Upload className="w-3.5 h-3.5" />}
                {isUploading ? 'Parsing...' : 'Upload PDF'}
                <input type="file" accept=".pdf" className="hidden" onChange={onUploadPdf} disabled={isUploading} />
              </label>
            </div>
            {uploadStatus && (
              <div className={`mb-3 flex items-center gap-2 text-xs ${isUploading ? 'text-brand-600' : uploadStatus.startsWith('Upload failed') ? 'text-red-600' : 'text-green-600'}`}>
                {isUploading && <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-brand-600 flex-shrink-0" />}
                {uploadStatus}
              </div>
            )}

            {Object.keys(categoryGroups).length === 0 && (
              <div className="text-center py-8 text-gray-400">
                <UtensilsCrossed className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No menu items yet. Upload a PDF to get started.</p>
              </div>
            )}

            {Object.entries(categoryGroups).map(([category, items]) => (
              <div key={category} className="mb-4">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{category}</h4>
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  {items.map((item, idx) => {
                    const isEditing = editingItemId === item.id
                    return (
                      <div key={item.id} className={idx < items.length - 1 ? 'border-b border-gray-100' : ''}>
                        {isEditing ? (
                          <div className="p-3 space-y-2 bg-blue-50">
                            <div className="flex gap-2">
                              <input
                                value={editItemForm.name}
                                onChange={e => onEditItemFormChange({ ...editItemForm, name: e.target.value })}
                                placeholder="Item name"
                                className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                                autoFocus
                              />
                              <input
                                value={editItemForm.price_cents_str}
                                onChange={e => onEditItemFormChange({ ...editItemForm, price_cents_str: e.target.value })}
                                placeholder="Price"
                                className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                              />
                            </div>
                            <input
                              value={editItemForm.description}
                              onChange={e => onEditItemFormChange({ ...editItemForm, description: e.target.value })}
                              placeholder="Description (optional)"
                              className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={() => onEditItemIdChange(null)}
                                className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => onEditMenuItem.mutate({ itemId: item.id, form: editItemForm })}
                                disabled={onEditMenuItem.isPending || !editItemForm.name.trim()}
                                className="px-3 py-1 text-xs text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
                              >
                                {onEditMenuItem.isPending ? 'Saving...' : 'Save'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start gap-2 px-3 py-2.5">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <p className="text-sm font-medium leading-snug text-gray-900">{item.name}</p>
                                <span className="text-xs flex-shrink-0 text-gray-500">
                                  ${(item.price_cents / 100).toFixed(2)}
                                </span>
                              </div>
                              {item.description && (
                                <p className="text-xs text-gray-400 truncate">{item.description}</p>
                              )}
                              {item.modifiers_json && item.modifiers_json.length > 0 && (
                                <p className="text-xs text-gray-400 truncate">
                                  {item.modifiers_json.map(m => m.name).join(', ')}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              <button
                                onClick={() => {
                                  onEditItemIdChange(item.id)
                                  onEditItemFormChange({
                                    name: item.name,
                                    price_cents_str: (item.price_cents / 100).toFixed(2),
                                    description: item.description ?? '',
                                    category: item.category,
                                  })
                                }}
                                className="p-1.5 text-gray-400 hover:text-brand-600 transition-colors rounded"
                                title="Edit item"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => {
                                  if (window.confirm(`Delete "${item.name}"?`)) {
                                    onDeleteMenuItem.mutate(item.id)
                                  }
                                }}
                                disabled={onDeleteMenuItem.isPending}
                                className="p-1.5 text-gray-400 hover:text-red-600 transition-colors rounded disabled:opacity-50"
                                title="Delete item"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {/* Add item to this category */}
                  {addingToCategory === category ? (
                    <div className="p-3 space-y-2 bg-green-50 border-t border-gray-100">
                      <div className="flex gap-2">
                        <input
                          value={addItemForm.name}
                          onChange={e => onAddItemFormChange({ ...addItemForm, name: e.target.value })}
                          placeholder="Item name"
                          className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                          autoFocus
                        />
                        <input
                          value={addItemForm.price_cents_str}
                          onChange={e => onAddItemFormChange({ ...addItemForm, price_cents_str: e.target.value })}
                          placeholder="Price"
                          className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      </div>
                      <input
                        value={addItemForm.description}
                        onChange={e => onAddItemFormChange({ ...addItemForm, description: e.target.value })}
                        placeholder="Description (optional)"
                        className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => onAddingToCategoryChange(null)}
                          className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => onAddMenuItem.mutate({ category, form: addItemForm })}
                          disabled={onAddMenuItem.isPending || !addItemForm.name.trim()}
                          className="px-3 py-1 text-xs text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
                        >
                          {onAddMenuItem.isPending ? 'Adding...' : 'Add'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="border-t border-gray-100">
                      <button
                        onClick={() => onAddingToCategoryChange(category)}
                        className="w-full px-3 py-2 text-xs text-gray-400 hover:text-brand-600 hover:bg-gray-50 transition-colors flex items-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add item
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Add item to a new category */}
            {activeMenuId && (
              addingToCategory === '__new__' ? (
                <div className="mt-2 p-3 bg-green-50 rounded-xl border border-gray-200 space-y-2">
                  <input
                    value={addItemCategory}
                    onChange={e => onAddItemCategoryChange(e.target.value)}
                    placeholder="Category name (e.g. Desserts)"
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <input
                      value={addItemForm.name}
                      onChange={e => onAddItemFormChange({ ...addItemForm, name: e.target.value })}
                      placeholder="Item name"
                      className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <input
                      value={addItemForm.price_cents_str}
                      onChange={e => onAddItemFormChange({ ...addItemForm, price_cents_str: e.target.value })}
                      placeholder="Price"
                      className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                  </div>
                  <input
                    value={addItemForm.description}
                    onChange={e => onAddItemFormChange({ ...addItemForm, description: e.target.value })}
                    placeholder="Description (optional)"
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => onAddingToCategoryChange(null)}
                      className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => onAddMenuItem.mutate({ category: addItemCategory.trim() || 'Other', form: addItemForm })}
                      disabled={onAddMenuItem.isPending || !addItemForm.name.trim()}
                      className="px-3 py-1 text-xs text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
                    >
                      {onAddMenuItem.isPending ? 'Adding...' : 'Add'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => onAddingToCategoryChange('__new__')}
                  className="mt-3 w-full py-2 text-xs text-gray-400 hover:text-brand-600 border border-dashed border-gray-200 rounded-lg hover:border-brand-300 transition-colors flex items-center justify-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add item to new category
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {/* Right panel: phone mockup (1/3 on desktop) */}
      <div className="lg:w-1/3 flex-shrink-0 flex justify-center items-start pt-6 pb-6 border-t border-gray-200 lg:border-t-0 lg:border-l overflow-hidden">
        <ShopChatTest shopId={shopId} shopName={shopName} />
      </div>
    </div>
  )
}
