import { useState } from 'react'
import { Upload, ToggleLeft, ToggleRight, UtensilsCrossed, HelpCircle, Plus, X, ChevronDown, ChevronRight, Trash2, Pencil } from 'lucide-react'
import { UseMutationResult } from '@tanstack/react-query'

interface OptionChoice {
  id: string
  name: string
  price_cents: number
  display_order: number
}

interface OptionGroup {
  id: string
  name: string
  required: boolean
  min_select: number
  max_select: number
  display_order: number
  option_choices?: OptionChoice[] | null
}

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
  // Shop editor Step 1: importer-flagged "we need a choice we couldn't capture" gap
  prompt_for?: string | null
  modifiers_json?: Array<{ name: string; price_cents: number }> | null
  option_groups?: OptionGroup[] | null
}

interface ItemFormDraft {
  name: string
  price_cents_str: string
  description: string
  category: string
}

interface ChoiceDraft {
  name: string
  priceStr: string
}

interface GroupDraft {
  phrase: string
  name: string
  required: boolean
  allowMultiple: boolean
  choices: ChoiceDraft[]
}

type AnswerPromptForGroups = Array<{
  name: string
  required: boolean
  minSelect: number
  maxSelect: number
  choices: Array<{ name: string; price_cents: number }>
}>

interface MenuTabProps {
  menuItems: MenuItem[] | undefined
  soldOutIds: Set<string> | undefined
  isUploading: boolean
  uploadStatus: string
  onUploadPdf: (e: React.ChangeEvent<HTMLInputElement>) => void
  onToggleSoldOut: UseMutationResult<void, Error, { menuItemId: string; currentlySoldOut: boolean }, unknown>
  onResetAll: UseMutationResult<void, Error, void, unknown>
  onClearFlag?: UseMutationResult<void, Error, { menuItemId: string }, unknown>
  onAnswerPromptFor?: UseMutationResult<void, Error, { itemId: string; groups: AnswerPromptForGroups }, unknown>
  // Shop editor Step 3: full item + option editing, reusing the existing item mutations.
  onEditMenuItem?: UseMutationResult<void, Error, { itemId: string; form: ItemFormDraft }, unknown>
  onDeleteMenuItem?: UseMutationResult<void, Error, string, unknown>
  onAddMenuItem?: UseMutationResult<void, Error, { category: string; form: Omit<ItemFormDraft, 'category'> }, unknown>
  onSaveOptionGroup?: UseMutationResult<void, Error, { id?: string; itemId: string; name: string; required: boolean; minSelect: number; maxSelect: number }, unknown>
  onDeleteOptionGroup?: UseMutationResult<void, Error, string, unknown>
  onSaveOptionChoice?: UseMutationResult<void, Error, { id?: string; groupId: string; name: string; priceCents: number }, unknown>
  onDeleteOptionChoice?: UseMutationResult<void, Error, string, unknown>
}

/** Derive a human group name from a prompt_for phrase ("which pasta (...)" -> "Pasta"). */
function deriveGroupName(phrase: string): string {
  const m = phrase.match(/which\s+([a-z ]+?)(?:\s*\(|$)/i)
  if (m) {
    const noun = m[1].trim()
    return noun.charAt(0).toUpperCase() + noun.slice(1)
  }
  const head = phrase.split('(')[0].trim()
  if (head.length > 0 && head.length <= 30) return head.charAt(0).toUpperCase() + head.slice(1)
  return 'Choice'
}

function deriveAllowMultiple(phrase: string): boolean {
  return /flavor\(s\)|toppings|multiple/i.test(phrase)
}

function defaultGroupsForItem(item: MenuItem): GroupDraft[] {
  const phrases = (item.prompt_for ?? '').split(';').map(s => s.trim()).filter(Boolean)
  return phrases.map(phrase => ({
    phrase,
    name: deriveGroupName(phrase),
    required: true,
    allowMultiple: deriveAllowMultiple(phrase),
    choices: [{ name: '', priceStr: '' }],
  }))
}

function isPriceValid(priceStr: string): boolean {
  if (priceStr.trim() === '') return true
  return /^\d+(\.\d{1,2})?$/.test(priceStr.trim())
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
  onAnswerPromptFor,
  onEditMenuItem,
  onDeleteMenuItem,
  onAddMenuItem,
  onSaveOptionGroup,
  onDeleteOptionGroup,
  onSaveOptionChoice,
  onDeleteOptionChoice,
}: MenuTabProps) {
  const allItems = menuItems ?? []
  const [promptDrafts, setPromptDrafts] = useState<Record<string, GroupDraft[]>>({})

  // Step 3: expand-to-edit item state (independent of any other tab's edit state).
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [itemDraft, setItemDraft] = useState<ItemFormDraft | null>(null)
  const [addingCategory, setAddingCategory] = useState<string | null>(null)
  const [addDraft, setAddDraft] = useState({ name: '', price_cents_str: '', description: '' })
  const [newGroupDrafts, setNewGroupDrafts] = useState<Record<string, { name: string; required: boolean; allowMultiple: boolean }>>({})
  const [groupEditDrafts, setGroupEditDrafts] = useState<Record<string, { name: string; required: boolean; allowMultiple: boolean }>>({})
  const [newChoiceDrafts, setNewChoiceDrafts] = useState<Record<string, ChoiceDraft>>({})
  const [choiceEditDrafts, setChoiceEditDrafts] = useState<Record<string, ChoiceDraft>>({})

  const toggleExpand = (item: MenuItem) => {
    if (expandedId === item.id) {
      setExpandedId(null)
      setItemDraft(null)
    } else {
      setExpandedId(item.id)
      setItemDraft({
        name: item.name,
        price_cents_str: (item.price_cents / 100).toFixed(2),
        description: item.description ?? '',
        category: item.category,
      })
    }
  }

  const saveItem = (item: MenuItem) => {
    if (!itemDraft || !onEditMenuItem || !itemDraft.name.trim() || !isPriceValid(itemDraft.price_cents_str)) return
    onEditMenuItem.mutate({ itemId: item.id, form: itemDraft })
  }

  const submitAddItem = (category: string) => {
    if (!onAddMenuItem || !addDraft.name.trim() || !isPriceValid(addDraft.price_cents_str)) return
    onAddMenuItem.mutate({ category, form: addDraft })
    setAddingCategory(null)
    setAddDraft({ name: '', price_cents_str: '', description: '' })
  }

  const saveNewGroup = (item: MenuItem) => {
    const draft = newGroupDrafts[item.id]
    if (!draft || !draft.name.trim() || !onSaveOptionGroup) return
    onSaveOptionGroup.mutate({
      itemId: item.id, name: draft.name.trim(), required: draft.required,
      minSelect: draft.required ? 1 : 0, maxSelect: draft.allowMultiple ? 99 : 1,
    })
    setNewGroupDrafts(prev => { const next = { ...prev }; delete next[item.id]; return next })
  }

  const saveEditGroup = (group: OptionGroup) => {
    const draft = groupEditDrafts[group.id]
    if (!draft || !draft.name.trim() || !onSaveOptionGroup) return
    onSaveOptionGroup.mutate({
      id: group.id, itemId: '', name: draft.name.trim(), required: draft.required,
      minSelect: draft.required ? 1 : 0, maxSelect: draft.allowMultiple ? 99 : 1,
    })
    setGroupEditDrafts(prev => { const next = { ...prev }; delete next[group.id]; return next })
  }

  const saveNewChoice = (groupId: string) => {
    const draft = newChoiceDrafts[groupId]
    if (!draft || !draft.name.trim() || !isPriceValid(draft.priceStr) || !onSaveOptionChoice) return
    onSaveOptionChoice.mutate({
      groupId, name: draft.name.trim(),
      priceCents: draft.priceStr.trim() === '' ? 0 : Math.round(parseFloat(draft.priceStr.trim()) * 100),
    })
    setNewChoiceDrafts(prev => { const next = { ...prev }; delete next[groupId]; return next })
  }

  const saveEditChoice = (choice: OptionChoice) => {
    const draft = choiceEditDrafts[choice.id]
    if (!draft || !draft.name.trim() || !isPriceValid(draft.priceStr) || !onSaveOptionChoice) return
    onSaveOptionChoice.mutate({
      id: choice.id, groupId: '', name: draft.name.trim(),
      priceCents: draft.priceStr.trim() === '' ? 0 : Math.round(parseFloat(draft.priceStr.trim()) * 100),
    })
    setChoiceEditDrafts(prev => { const next = { ...prev }; delete next[choice.id]; return next })
  }

  const hasNoOptions = (item: MenuItem) =>
    (!item.option_groups || item.option_groups.length === 0) &&
    (!item.modifiers_json || item.modifiers_json.length === 0)

  // Item F: split into confident (ready to go) and flagged (needs owner answer)
  const flaggedItems = allItems.filter(it => it.flag_review)
  const promptForItems = allItems.filter(it => !it.flag_review && it.prompt_for && it.prompt_for.trim() && hasNoOptions(it))
  const confidentItems = allItems.filter(it => !it.flag_review && !(it.prompt_for && it.prompt_for.trim() && hasNoOptions(it)))

  const categoryGroups = confidentItems.reduce<Record<string, MenuItem[]>>((acc, item) => {
    const cat = item.category ?? 'Other'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(item)
    return acc
  }, {})

  const getDraft = (item: MenuItem): GroupDraft[] => promptDrafts[item.id] ?? defaultGroupsForItem(item)

  const setDraft = (itemId: string, groups: GroupDraft[]) => {
    setPromptDrafts(prev => ({ ...prev, [itemId]: groups }))
  }

  const updateGroup = (item: MenuItem, groupIdx: number, patch: Partial<GroupDraft>) => {
    const groups = getDraft(item).slice()
    groups[groupIdx] = { ...groups[groupIdx], ...patch }
    setDraft(item.id, groups)
  }

  const updateChoice = (item: MenuItem, groupIdx: number, choiceIdx: number, patch: Partial<ChoiceDraft>) => {
    const groups = getDraft(item).slice()
    const choices = groups[groupIdx].choices.slice()
    choices[choiceIdx] = { ...choices[choiceIdx], ...patch }
    groups[groupIdx] = { ...groups[groupIdx], choices }
    setDraft(item.id, groups)
  }

  const addChoice = (item: MenuItem, groupIdx: number) => {
    const groups = getDraft(item).slice()
    groups[groupIdx] = { ...groups[groupIdx], choices: [...groups[groupIdx].choices, { name: '', priceStr: '' }] }
    setDraft(item.id, groups)
  }

  const removeChoice = (item: MenuItem, groupIdx: number, choiceIdx: number) => {
    const groups = getDraft(item).slice()
    const choices = groups[groupIdx].choices.filter((_, i) => i !== choiceIdx)
    groups[groupIdx] = { ...groups[groupIdx], choices: choices.length ? choices : [{ name: '', priceStr: '' }] }
    setDraft(item.id, groups)
  }

  const draftIsValid = (groups: GroupDraft[]): boolean =>
    groups.every(g =>
      g.name.trim() !== '' &&
      g.choices.some(c => c.name.trim() !== '') &&
      g.choices.every(c => c.name.trim() === '' || isPriceValid(c.priceStr))
    )

  const submitPromptFor = (item: MenuItem) => {
    if (!onAnswerPromptFor) return
    const groups = getDraft(item)
    if (!draftIsValid(groups)) return
    const payload: AnswerPromptForGroups = groups.map(g => {
      const choices = g.choices.filter(c => c.name.trim() !== '')
      return {
        name: g.name.trim(),
        required: g.required,
        minSelect: g.required ? 1 : 0,
        maxSelect: g.allowMultiple ? Math.max(choices.length, 1) : 1,
        choices: choices.map(c => ({
          name: c.name.trim(),
          price_cents: c.priceStr.trim() === '' ? 0 : Math.round(parseFloat(c.priceStr.trim()) * 100),
        })),
      }
    })
    onAnswerPromptFor.mutate({ itemId: item.id, groups: payload })
  }

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

      {/* Shop editor Step 1: the importer's own uncertainty flags, made answerable */}
      {promptForItems.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <HelpCircle className="w-4 h-4 text-blue-500 flex-shrink-0" />
            <h3 className="text-sm font-semibold text-blue-700">
              Menu needs option answers ({promptForItems.length})
            </h3>
          </div>
          <p className="text-xs text-blue-600 mb-3">
            These items need a choice the menu import couldn't capture on its own — the shop's own answer, not global config. Fill it in once and the bot offers it on every order.
          </p>
          <div className="space-y-3">
            {promptForItems.map(item => {
              const groups = getDraft(item)
              const valid = draftIsValid(groups)
              return (
                <div key={item.id} className="bg-blue-50 rounded-xl border border-blue-200 p-4">
                  <div className="mb-3">
                    <p className="text-sm font-medium text-gray-900">{item.name}</p>
                    {item.price_cents > 0 && (
                      <p className="text-xs text-gray-500">${(item.price_cents / 100).toFixed(2)} · {item.category}</p>
                    )}
                  </div>
                  {groups.map((g, gi) => (
                    <div key={gi} className={`${gi > 0 ? 'mt-4 pt-4 border-t border-blue-100' : ''}`}>
                      <p className="text-xs font-medium text-blue-800 mb-2">{g.phrase}?</p>
                      <div className="flex items-center gap-4 mb-2">
                        <label className="flex items-center gap-1.5 text-xs text-gray-600">
                          <input
                            type="checkbox"
                            checked={g.required}
                            onChange={e => updateGroup(item, gi, { required: e.target.checked })}
                          />
                          Customer must choose
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-gray-600">
                          <input
                            type="checkbox"
                            checked={g.allowMultiple}
                            onChange={e => updateGroup(item, gi, { allowMultiple: e.target.checked })}
                          />
                          Allow more than one selection
                        </label>
                        <input
                          value={g.name}
                          onChange={e => updateGroup(item, gi, { name: e.target.value })}
                          placeholder="Group name"
                          className="ml-auto w-40 px-2 py-1 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      </div>
                      <div className="space-y-1.5">
                        {g.choices.map((c, ci) => (
                          <div key={ci} className="flex items-center gap-2">
                            <input
                              value={c.name}
                              onChange={e => updateChoice(item, gi, ci, { name: e.target.value })}
                              placeholder="e.g. Buffalo"
                              className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                            <span className="text-xs text-gray-400">+$</span>
                            <input
                              value={c.priceStr}
                              onChange={e => updateChoice(item, gi, ci, { priceStr: e.target.value })}
                              placeholder="0.00"
                              inputMode="decimal"
                              className={`w-20 px-2 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 ${!isPriceValid(c.priceStr) ? 'border-red-300' : 'border-gray-200'}`}
                            />
                            <button
                              onClick={() => removeChoice(item, gi, ci)}
                              className="flex-shrink-0 text-gray-300 hover:text-red-500"
                              title="Remove"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={() => addChoice(item, gi)}
                        className="mt-2 flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700"
                      >
                        <Plus className="w-3 h-3" /> add a choice
                      </button>
                    </div>
                  ))}
                  <div className="mt-4 flex justify-end">
                    <button
                      onClick={() => submitPromptFor(item)}
                      disabled={!valid || onAnswerPromptFor?.isPending}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
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
      {Object.keys(categoryGroups).length === 0 && flaggedItems.length === 0 && promptForItems.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          <UtensilsCrossed className="w-10 h-10 mx-auto mb-2 opacity-30" />
          <p>No menu items yet. Upload a PDF to get started.</p>
        </div>
      )}

      {Object.keys(categoryGroups).length > 0 && (
        <div>
          {(flaggedItems.length > 0 || promptForItems.length > 0) && (
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
                  const expanded = expandedId === item.id
                  const groups = item.option_groups ?? []
                  const canEditOptions = !!(onSaveOptionGroup && onDeleteOptionGroup && onSaveOptionChoice && onDeleteOptionChoice)
                  return (
                    <div key={item.id} className={`${idx < items.length - 1 ? 'border-b border-gray-50' : ''} ${soldOut ? 'opacity-60' : ''}`}>
                      <div className="flex items-center gap-3 px-4 py-3">
                        {(onEditMenuItem || canEditOptions) && (
                          <button onClick={() => toggleExpand(item)} className="flex-shrink-0 text-gray-400 hover:text-gray-600" title="Edit item and options">
                            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm font-medium ${soldOut ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                            {item.name}
                          </p>
                          {item.description && (
                            <p className="text-xs text-gray-400 truncate">{item.description}</p>
                          )}
                          {groups.length > 0 && (
                            <p className="text-xs text-gray-400">{groups.length} option group{groups.length > 1 ? 's' : ''}</p>
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

                      {expanded && (
                        <div className="px-4 pb-4 bg-gray-50 border-t border-gray-100">
                          {itemDraft && onEditMenuItem && (
                            <div className="pt-3 flex flex-wrap items-end gap-2">
                              <div>
                                <label className="block text-[11px] text-gray-500 mb-0.5">Name</label>
                                <input
                                  value={itemDraft.name}
                                  onChange={e => setItemDraft({ ...itemDraft, name: e.target.value })}
                                  className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg w-48"
                                />
                              </div>
                              <div>
                                <label className="block text-[11px] text-gray-500 mb-0.5">Price ($)</label>
                                <input
                                  value={itemDraft.price_cents_str}
                                  onChange={e => setItemDraft({ ...itemDraft, price_cents_str: e.target.value })}
                                  className={`px-2 py-1.5 text-sm border rounded-lg w-24 ${!isPriceValid(itemDraft.price_cents_str) ? 'border-red-300' : 'border-gray-200'}`}
                                />
                              </div>
                              <div>
                                <label className="block text-[11px] text-gray-500 mb-0.5">Category</label>
                                <input
                                  value={itemDraft.category}
                                  onChange={e => setItemDraft({ ...itemDraft, category: e.target.value })}
                                  className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg w-32"
                                />
                              </div>
                              <div className="flex-1 min-w-[10rem]">
                                <label className="block text-[11px] text-gray-500 mb-0.5">Description</label>
                                <input
                                  value={itemDraft.description}
                                  onChange={e => setItemDraft({ ...itemDraft, description: e.target.value })}
                                  className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg w-full"
                                />
                              </div>
                              <button
                                onClick={() => saveItem(item)}
                                disabled={!itemDraft.name.trim() || !isPriceValid(itemDraft.price_cents_str) || onEditMenuItem.isPending}
                                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
                              >
                                Save
                              </button>
                              {onDeleteMenuItem && (
                                <button
                                  onClick={() => { if (window.confirm(`Delete "${item.name}"?`)) { onDeleteMenuItem.mutate(item.id); setExpandedId(null) } }}
                                  disabled={onDeleteMenuItem.isPending}
                                  className="p-1.5 text-gray-400 hover:text-red-500"
                                  title="Delete item"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          )}

                          {canEditOptions && (
                            <div className="mt-3 pt-3 border-t border-gray-200">
                              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Options</p>
                              {groups.map(group => {
                                const editingGroup = groupEditDrafts[group.id]
                                const choices = group.option_choices ?? []
                                return (
                                  <div key={group.id} className="mb-3 bg-white rounded-lg border border-gray-200 p-3">
                                    {editingGroup ? (
                                      <div className="flex flex-wrap items-center gap-3 mb-2">
                                        <input
                                          value={editingGroup.name}
                                          onChange={e => setGroupEditDrafts(prev => ({ ...prev, [group.id]: { ...editingGroup, name: e.target.value } }))}
                                          className="px-2 py-1 text-xs border border-gray-200 rounded-lg w-32"
                                        />
                                        <label className="flex items-center gap-1 text-xs text-gray-600">
                                          <input type="checkbox" checked={editingGroup.required} onChange={e => setGroupEditDrafts(prev => ({ ...prev, [group.id]: { ...editingGroup, required: e.target.checked } }))} />
                                          Required
                                        </label>
                                        <label className="flex items-center gap-1 text-xs text-gray-600">
                                          <input type="checkbox" checked={editingGroup.allowMultiple} onChange={e => setGroupEditDrafts(prev => ({ ...prev, [group.id]: { ...editingGroup, allowMultiple: e.target.checked } }))} />
                                          Multiple
                                        </label>
                                        <button onClick={() => saveEditGroup(group)} disabled={!editingGroup.name.trim()} className="text-xs text-brand-600 font-medium disabled:opacity-50">Save</button>
                                        <button onClick={() => setGroupEditDrafts(prev => { const n = { ...prev }; delete n[group.id]; return n })} className="text-xs text-gray-400">Cancel</button>
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-2 mb-2">
                                        <p className="text-sm font-medium text-gray-800">{group.name}</p>
                                        <span className="text-[11px] text-gray-400">
                                          {group.required ? 'required' : 'optional'} · {group.max_select > 1 ? 'pick multiple' : 'pick one'}
                                        </span>
                                        <button
                                          onClick={() => setGroupEditDrafts(prev => ({ ...prev, [group.id]: { name: group.name, required: group.required, allowMultiple: group.max_select > 1 } }))}
                                          className="ml-auto text-gray-300 hover:text-gray-600"
                                          title="Rename / edit group"
                                        >
                                          <Pencil className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                          onClick={() => { if (window.confirm(`Delete option group "${group.name}"?`)) onDeleteOptionGroup!.mutate(group.id) }}
                                          className="text-gray-300 hover:text-red-500"
                                          title="Delete group"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                    )}

                                    <div className="space-y-1">
                                      {choices.map(choice => {
                                        const editingChoice = choiceEditDrafts[choice.id]
                                        return editingChoice ? (
                                          <div key={choice.id} className="flex items-center gap-2">
                                            <input
                                              value={editingChoice.name}
                                              onChange={e => setChoiceEditDrafts(prev => ({ ...prev, [choice.id]: { ...editingChoice, name: e.target.value } }))}
                                              className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded-lg"
                                            />
                                            <span className="text-xs text-gray-400">+$</span>
                                            <input
                                              value={editingChoice.priceStr}
                                              onChange={e => setChoiceEditDrafts(prev => ({ ...prev, [choice.id]: { ...editingChoice, priceStr: e.target.value } }))}
                                              className={`w-16 px-2 py-1 text-xs border rounded-lg ${!isPriceValid(editingChoice.priceStr) ? 'border-red-300' : 'border-gray-200'}`}
                                            />
                                            <button onClick={() => saveEditChoice(choice)} disabled={!editingChoice.name.trim() || !isPriceValid(editingChoice.priceStr)} className="text-xs text-brand-600 font-medium disabled:opacity-50">Save</button>
                                            <button onClick={() => setChoiceEditDrafts(prev => { const n = { ...prev }; delete n[choice.id]; return n })} className="text-xs text-gray-400">Cancel</button>
                                          </div>
                                        ) : (
                                          <div key={choice.id} className="flex items-center gap-2 text-sm">
                                            <span className="flex-1 text-gray-700">{choice.name}</span>
                                            <span className="text-gray-500 font-mono text-xs">${(choice.price_cents / 100).toFixed(2)}</span>
                                            <button
                                              onClick={() => setChoiceEditDrafts(prev => ({ ...prev, [choice.id]: { name: choice.name, priceStr: (choice.price_cents / 100).toFixed(2) } }))}
                                              className="text-gray-300 hover:text-gray-600"
                                            >
                                              <Pencil className="w-3 h-3" />
                                            </button>
                                            <button
                                              onClick={() => onDeleteOptionChoice!.mutate(choice.id)}
                                              className="text-gray-300 hover:text-red-500"
                                            >
                                              <X className="w-3.5 h-3.5" />
                                            </button>
                                          </div>
                                        )
                                      })}
                                    </div>

                                    {newChoiceDrafts[group.id] ? (
                                      <div className="flex items-center gap-2 mt-2">
                                        <input
                                          value={newChoiceDrafts[group.id].name}
                                          onChange={e => setNewChoiceDrafts(prev => ({ ...prev, [group.id]: { ...prev[group.id], name: e.target.value } }))}
                                          placeholder="Choice name"
                                          className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded-lg"
                                        />
                                        <span className="text-xs text-gray-400">+$</span>
                                        <input
                                          value={newChoiceDrafts[group.id].priceStr}
                                          onChange={e => setNewChoiceDrafts(prev => ({ ...prev, [group.id]: { ...prev[group.id], priceStr: e.target.value } }))}
                                          placeholder="0.00"
                                          className={`w-16 px-2 py-1 text-xs border rounded-lg ${!isPriceValid(newChoiceDrafts[group.id].priceStr) ? 'border-red-300' : 'border-gray-200'}`}
                                        />
                                        <button onClick={() => saveNewChoice(group.id)} disabled={!newChoiceDrafts[group.id].name.trim() || !isPriceValid(newChoiceDrafts[group.id].priceStr)} className="text-xs text-brand-600 font-medium disabled:opacity-50">Add</button>
                                        <button onClick={() => setNewChoiceDrafts(prev => { const n = { ...prev }; delete n[group.id]; return n })} className="text-xs text-gray-400">Cancel</button>
                                      </div>
                                    ) : (
                                      <button
                                        onClick={() => setNewChoiceDrafts(prev => ({ ...prev, [group.id]: { name: '', priceStr: '' } }))}
                                        className="mt-2 flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700"
                                      >
                                        <Plus className="w-3 h-3" /> add a choice
                                      </button>
                                    )}
                                  </div>
                                )
                              })}

                              {newGroupDrafts[item.id] ? (
                                <div className="bg-white rounded-lg border border-gray-200 p-3 flex flex-wrap items-center gap-3">
                                  <input
                                    value={newGroupDrafts[item.id].name}
                                    onChange={e => setNewGroupDrafts(prev => ({ ...prev, [item.id]: { ...prev[item.id], name: e.target.value } }))}
                                    placeholder="Group name (e.g. Toppings)"
                                    className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg w-48"
                                  />
                                  <label className="flex items-center gap-1 text-xs text-gray-600">
                                    <input type="checkbox" checked={newGroupDrafts[item.id].required} onChange={e => setNewGroupDrafts(prev => ({ ...prev, [item.id]: { ...prev[item.id], required: e.target.checked } }))} />
                                    Customer must choose
                                  </label>
                                  <label className="flex items-center gap-1 text-xs text-gray-600">
                                    <input type="checkbox" checked={newGroupDrafts[item.id].allowMultiple} onChange={e => setNewGroupDrafts(prev => ({ ...prev, [item.id]: { ...prev[item.id], allowMultiple: e.target.checked } }))} />
                                    Allow multiple
                                  </label>
                                  <button onClick={() => saveNewGroup(item)} disabled={!newGroupDrafts[item.id].name.trim()} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-brand-600 text-white disabled:opacity-50">Add group</button>
                                  <button onClick={() => setNewGroupDrafts(prev => { const n = { ...prev }; delete n[item.id]; return n })} className="text-xs text-gray-400">Cancel</button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setNewGroupDrafts(prev => ({ ...prev, [item.id]: { name: '', required: true, allowMultiple: false } }))}
                                  className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700"
                                >
                                  <Plus className="w-3 h-3" /> add an option group
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {onAddMenuItem && (
                addingCategory === category ? (
                  <div className="mt-2 bg-white rounded-lg border border-gray-200 p-3 flex flex-wrap items-end gap-2">
                    <div>
                      <label className="block text-[11px] text-gray-500 mb-0.5">Name</label>
                      <input
                        value={addDraft.name}
                        onChange={e => setAddDraft({ ...addDraft, name: e.target.value })}
                        className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg w-48"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-gray-500 mb-0.5">Price ($)</label>
                      <input
                        value={addDraft.price_cents_str}
                        onChange={e => setAddDraft({ ...addDraft, price_cents_str: e.target.value })}
                        className={`px-2 py-1.5 text-sm border rounded-lg w-24 ${!isPriceValid(addDraft.price_cents_str) ? 'border-red-300' : 'border-gray-200'}`}
                      />
                    </div>
                    <div className="flex-1 min-w-[10rem]">
                      <label className="block text-[11px] text-gray-500 mb-0.5">Description</label>
                      <input
                        value={addDraft.description}
                        onChange={e => setAddDraft({ ...addDraft, description: e.target.value })}
                        className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg w-full"
                      />
                    </div>
                    <button
                      onClick={() => submitAddItem(category)}
                      disabled={!addDraft.name.trim() || !isPriceValid(addDraft.price_cents_str) || onAddMenuItem.isPending}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      Add
                    </button>
                    <button onClick={() => setAddingCategory(null)} className="text-xs text-gray-400">Cancel</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setAddingCategory(category)}
                    className="mt-2 flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700"
                  >
                    <Plus className="w-3 h-3" /> add item to {category}
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
