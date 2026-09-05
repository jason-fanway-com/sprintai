import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, HelpCircle, AlertTriangle, Search, Plus, Trash2, Save, X, Check } from 'lucide-react'
import toast from 'react-hot-toast'
import { applyFormOps, type OptionGroupOp } from '../../lib/shopOps'

export interface MenuItemRow {
  id: string
  name: string
  price_cents: number
  description: string | null
  category: string
  active: boolean
  prompt_for: string | null
  flag_review: boolean | null
  flag_reason: string | null
  display_order: number
}

export interface OptionGroupWithChoices {
  id: string
  menu_item_id: string
  name: string
  required: boolean
  min_select: number
  max_select: number
  choices: { id: string; option_group_id: string; name: string; price_cents: number }[]
}

type Filter = 'needs_answers' | 'low_confidence' | 'all'

interface PendingEdit {
  name?: string
  price_dollars?: string
  description?: string
  category?: string
  active?: boolean
}

interface MenuBulkEditorProps {
  shopId: string
  items: MenuItemRow[]
  isLoading: boolean
  optionGroupsByItem: Record<string, OptionGroupWithChoices[]>
  onSaved: () => void
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase())
}

export default function MenuBulkEditor({ shopId, items, isLoading, optionGroupsByItem, onSaved }: MenuBulkEditorProps) {
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<Record<string, PendingEdit>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [saving, setSaving] = useState(false)

  const needsAnswers = useMemo(
    () => items.filter(i => i.prompt_for && (optionGroupsByItem[i.id]?.length ?? 0) === 0),
    [items, optionGroupsByItem],
  )
  const lowConfidence = useMemo(() => items.filter(i => i.flag_review), [items])

  const needsAnswersIds = useMemo(() => new Set(needsAnswers.map(i => i.id)), [needsAnswers])
  const lowConfidenceIds = useMemo(() => new Set(lowConfidence.map(i => i.id)), [lowConfidence])

  const visibleItems = useMemo(() => {
    let list = items
    if (filter === 'needs_answers') list = list.filter(i => needsAnswersIds.has(i.id))
    else if (filter === 'low_confidence') list = list.filter(i => lowConfidenceIds.has(i.id))
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(i => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q))
    }
    return list
  }, [items, filter, search, needsAnswersIds, lowConfidenceIds])

  const categoryGroups = useMemo(() => {
    const groups: Record<string, MenuItemRow[]> = {}
    for (const item of visibleItems) {
      const cat = item.category ?? 'Other'
      groups[cat] = [...(groups[cat] ?? []), item]
    }
    return groups
  }, [visibleItems])

  const setField = (itemId: string, field: keyof PendingEdit, value: string | boolean) => {
    setPending(prev => ({ ...prev, [itemId]: { ...prev[itemId], [field]: value } }))
  }

  const clearReviewFlag = async (itemId: string) => {
    try {
      const result = await applyFormOps(shopId, [{ intent: 'SET_ITEM_FIELDS', item_id: itemId, item_fields: { clear_review_flag: true } }])
      const r = result.results[0]
      if (!r?.ok) throw new Error(r?.error ?? 'Failed to confirm item')
      toast.success('Confirmed — moved out of Low confidence')
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const pendingCount = Object.keys(pending).length

  const diff = useMemo(() => {
    let priceChanges = 0, renames = 0, hidden = 0, shown = 0, otherFields = 0
    for (const [itemId, edit] of Object.entries(pending)) {
      const original = items.find(i => i.id === itemId)
      if (!original) continue
      if (edit.price_dollars !== undefined) {
        const cents = Math.round(parseFloat(edit.price_dollars) * 100)
        if (!Number.isNaN(cents) && cents !== original.price_cents) priceChanges++
      }
      if (edit.name !== undefined && edit.name !== original.name) renames++
      if (edit.active !== undefined && edit.active !== original.active) {
        if (edit.active) shown++; else hidden++
      }
      if (edit.description !== undefined && edit.description !== (original.description ?? '')) otherFields++
      if (edit.category !== undefined && edit.category !== original.category) otherFields++
    }
    const parts: string[] = []
    if (priceChanges > 0) parts.push(`${priceChanges} price${priceChanges === 1 ? '' : 's'} changed`)
    if (renames > 0) parts.push(`${renames} item${renames === 1 ? '' : 's'} renamed`)
    if (hidden > 0) parts.push(`${hidden} item${hidden === 1 ? '' : 's'} hidden`)
    if (shown > 0) parts.push(`${shown} item${shown === 1 ? '' : 's'} made available`)
    if (otherFields > 0) parts.push(`${otherFields} other field${otherFields === 1 ? '' : 's'} changed`)
    return parts.length > 0 ? parts.join(', ') : 'No changes'
  }, [pending, items])

  const doSave = async () => {
    setSaving(true)
    try {
      const ops = Object.entries(pending).flatMap(([itemId, edit]) => {
        const original = items.find(i => i.id === itemId)
        if (!original) return []
        const fields: Record<string, unknown> = {}
        if (edit.name !== undefined && edit.name !== original.name) fields.name = edit.name
        if (edit.price_dollars !== undefined) {
          const cents = Math.round(parseFloat(edit.price_dollars) * 100)
          if (!Number.isNaN(cents) && cents !== original.price_cents) fields.price_dollars = edit.price_dollars
        }
        if (edit.description !== undefined && edit.description !== (original.description ?? '')) fields.description = edit.description
        if (edit.category !== undefined && edit.category !== original.category) fields.category = edit.category
        if (edit.active !== undefined && edit.active !== original.active) fields.active = edit.active
        if (Object.keys(fields).length === 0) return []
        return [{ intent: 'SET_ITEM_FIELDS' as const, item_id: itemId, item_fields: fields }]
      })
      if (ops.length === 0) { setShowDiff(false); setPending({}); return }
      const result = await applyFormOps(shopId, ops)
      const failed = result.results.filter(r => !r.ok)
      if (failed.length > 0) {
        toast.error(`${failed.length} change(s) failed: ${failed.map(f => f.error).join('; ')}`)
      } else {
        toast.success(`Saved ${result.results.length} change(s)`)
      }
      setPending({})
      setShowDiff(false)
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      {/* Filter strip */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <FilterChip label="Needs answers" count={needsAnswers.length} active={filter === 'needs_answers'} tone="amber" onClick={() => setFilter(filter === 'needs_answers' ? 'all' : 'needs_answers')} />
        <FilterChip label="Low confidence" count={lowConfidence.length} active={filter === 'low_confidence'} tone="orange" onClick={() => setFilter(filter === 'low_confidence' ? 'all' : 'low_confidence')} />
        <FilterChip label="All items" count={items.length} active={filter === 'all'} tone="gray" onClick={() => setFilter('all')} />
        <div className="flex-1 min-w-[160px] relative ml-auto">
          <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search items or category..."
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        {pendingCount > 0 && (
          <button
            onClick={() => setShowDiff(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            Save {pendingCount} change{pendingCount === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {isLoading && <div className="text-center py-12 text-gray-400">Loading menu...</div>}
      {!isLoading && items.length === 0 && (
        <div className="text-center py-12 text-gray-400">No menu items yet.</div>
      )}
      {!isLoading && items.length > 0 && visibleItems.length === 0 && (
        <div className="text-center py-12 text-gray-400">No items match this filter.</div>
      )}

      {Object.entries(categoryGroups).map(([category, catItems]) => (
        <div key={category} className="mb-5">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{category}</h3>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {catItems.map((item, idx) => {
              const edit = pending[item.id]
              const isExpanded = expanded === item.id
              const needsAnswer = needsAnswersIds.has(item.id)
              const isFlagged = lowConfidenceIds.has(item.id)
              return (
                <div key={item.id} className={idx < catItems.length - 1 ? 'border-b border-gray-100' : ''}>
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                    <button
                      onClick={() => setExpanded(isExpanded ? null : item.id)}
                      className="flex-shrink-0 text-gray-400 hover:text-gray-600"
                      title="Edit options"
                    >
                      {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                    <input
                      value={edit?.name ?? item.name}
                      onChange={e => setField(item.id, 'name', e.target.value)}
                      className="flex-1 min-w-[140px] px-2 py-1 text-sm border border-transparent hover:border-gray-200 focus:border-brand-400 rounded focus:outline-none"
                    />
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-xs text-gray-400">$</span>
                      <input
                        value={edit?.price_dollars ?? (item.price_cents / 100).toFixed(2)}
                        onChange={e => setField(item.id, 'price_dollars', e.target.value)}
                        className="w-16 px-1.5 py-1 text-sm border border-transparent hover:border-gray-200 focus:border-brand-400 rounded focus:outline-none text-right"
                      />
                    </div>
                    <input
                      value={edit?.description ?? item.description ?? ''}
                      onChange={e => setField(item.id, 'description', e.target.value)}
                      placeholder="Description"
                      className="hidden md:block w-40 px-2 py-1 text-xs text-gray-500 border border-transparent hover:border-gray-200 focus:border-brand-400 rounded focus:outline-none"
                    />
                    <button
                      onClick={() => setField(item.id, 'active', !(edit?.active ?? item.active))}
                      className={`flex-shrink-0 text-xs px-2 py-1 rounded-full border ${
                        (edit?.active ?? item.active) ? 'border-green-200 text-green-700 bg-green-50' : 'border-gray-200 text-gray-400 bg-gray-50 line-through'
                      }`}
                    >
                      {(edit?.active ?? item.active) ? 'Active' : 'Hidden'}
                    </button>
                    {needsAnswer && (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                        <HelpCircle className="w-3 h-3" /> Needs: {item.prompt_for}
                      </span>
                    )}
                    {isFlagged && (
                      <>
                        <span className="flex items-center gap-1 text-[11px] font-medium text-orange-700 bg-orange-50 border border-orange-200 rounded-full px-2 py-0.5" title={item.flag_reason ?? undefined}>
                          <AlertTriangle className="w-3 h-3" /> {item.flag_reason ?? 'Review'}
                        </span>
                        <button
                          onClick={() => clearReviewFlag(item.id)}
                          className="flex items-center gap-1 text-[11px] font-medium text-white bg-orange-600 hover:bg-orange-700 rounded-full px-2 py-0.5"
                        >
                          <Check className="w-3 h-3" /> Looks right
                        </button>
                      </>
                    )}
                  </div>
                  {isExpanded && (
                    <ItemOptionsEditor
                      shopId={shopId}
                      item={item}
                      groups={optionGroupsByItem[item.id] ?? []}
                      onSaved={onSaved}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {showDiff && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Save changes?</h3>
            <p className="text-sm text-gray-600 mb-4">{diff}</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowDiff(false)} className="px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={doSave} disabled={saving} className="px-3 py-1.5 text-sm text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function FilterChip({ label, count, active, tone, onClick }: { label: string; count: number; active: boolean; tone: 'amber' | 'orange' | 'gray'; onClick: () => void }) {
  const toneClasses = {
    amber: active ? 'bg-amber-600 text-white border-amber-600' : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100',
    orange: active ? 'bg-orange-600 text-white border-orange-600' : 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100',
    gray: active ? 'bg-gray-800 text-white border-gray-800' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100',
  }[tone]
  return (
    <button onClick={onClick} className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${toneClasses}`}>
      {label} ({count})
    </button>
  )
}

// ── Per-item option group editor — inline expandable, full CRUD ──────────────────────
interface DraftChoice { choice_id?: string; name: string; price_dollars: string }
interface DraftGroup { group_id?: string; name: string; required: boolean; min_select: number; max_select: number; choices: DraftChoice[]; bulkPaste: string }

function ItemOptionsEditor({ shopId, item, groups, onSaved }: { shopId: string; item: MenuItemRow; groups: OptionGroupWithChoices[]; onSaved: () => void }) {
  const needsAnswer = !!item.prompt_for && groups.length === 0

  const initialDrafts: DraftGroup[] = groups.length > 0
    ? groups.map(g => ({
        group_id: g.id, name: g.name, required: g.required, min_select: g.min_select, max_select: g.max_select,
        choices: g.choices.map(c => ({ choice_id: c.id, name: c.name, price_dollars: (c.price_cents / 100).toFixed(2) })),
        bulkPaste: '',
      }))
    : needsAnswer
      ? [{ name: titleCase(item.prompt_for!), required: true, min_select: 1, max_select: 1, choices: [], bulkPaste: '' }]
      : []

  const [drafts, setDrafts] = useState<DraftGroup[]>(initialDrafts)
  const [deletedGroupIds, setDeletedGroupIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const updateDraft = (idx: number, patch: Partial<DraftGroup>) => {
    setDrafts(prev => prev.map((d, i) => i === idx ? { ...d, ...patch } : d))
  }

  const addGroup = () => setDrafts(prev => [...prev, { name: '', required: false, min_select: 0, max_select: 1, choices: [], bulkPaste: '' }])

  const removeGroup = (idx: number) => {
    const d = drafts[idx]
    if (d.group_id) setDeletedGroupIds(prev => [...prev, d.group_id!])
    setDrafts(prev => prev.filter((_, i) => i !== idx))
  }

  const addChoice = (gIdx: number) => {
    setDrafts(prev => prev.map((d, i) => i === gIdx ? { ...d, choices: [...d.choices, { name: '', price_dollars: '0.00' }] } : d))
  }

  const applyBulkPaste = (gIdx: number) => {
    setDrafts(prev => prev.map((d, i) => {
      if (i !== gIdx) return d
      const names = d.bulkPaste.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
      if (names.length === 0) return d
      return { ...d, choices: [...d.choices, ...names.map(n => ({ name: n, price_dollars: '0.00' }))], bulkPaste: '' }
    }))
  }

  const removeChoice = (gIdx: number, cIdx: number) => {
    setDrafts(prev => prev.map((d, i) => i === gIdx ? { ...d, choices: d.choices.filter((_, j) => j !== cIdx) } : d))
  }

  const updateChoice = (gIdx: number, cIdx: number, patch: Partial<DraftChoice>) => {
    setDrafts(prev => prev.map((d, i) => i === gIdx ? { ...d, choices: d.choices.map((c, j) => j === cIdx ? { ...c, ...patch } : c) } : d))
  }

  const save = async () => {
    const upsert_groups: OptionGroupOp[] = drafts
      .filter(d => d.name.trim())
      .map(d => ({
        group_id: d.group_id,
        name: d.name.trim(),
        required: d.required,
        min_select: d.min_select,
        max_select: d.max_select,
        choices: d.choices.filter(c => c.name.trim()).map(c => ({
          choice_id: c.choice_id,
          name: c.name.trim(),
          price_cents: Math.round((parseFloat(c.price_dollars) || 0) * 100),
        })),
      }))
      .filter(g => g.choices.length > 0)

    if (upsert_groups.length === 0 && deletedGroupIds.length === 0) {
      toast.error('Nothing to save — add at least one choice.')
      return
    }

    setSaving(true)
    try {
      const result = await applyFormOps(shopId, [{
        intent: 'SET_ITEM_OPTIONS',
        item_id: item.id,
        item_name: item.name,
        upsert_groups,
        delete_group_ids: deletedGroupIds,
      }])
      const r = result.results[0]
      if (!r?.ok) throw new Error(r?.error ?? 'Save failed')
      toast.success(r.result ?? 'Options saved')
      setDeletedGroupIds([])
      onSaved()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 space-y-3">
      {needsAnswer && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          The menu importer knew this item needs a choice ("{item.prompt_for}") but couldn't capture it. Type the exact choices below — nothing is invented for you.
        </p>
      )}
      {drafts.map((d, gIdx) => (
        <div key={d.group_id ?? `new-${gIdx}`} className="bg-white rounded-lg border border-gray-200 p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={d.name}
              onChange={e => updateDraft(gIdx, { name: e.target.value })}
              placeholder="Group name, e.g. Wing Flavor"
              className="flex-1 min-w-[140px] px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <label className="flex items-center gap-1 text-xs text-gray-500">
              <input type="checkbox" checked={d.required} onChange={e => updateDraft(gIdx, { required: e.target.checked })} />
              Required
            </label>
            <label className="flex items-center gap-1 text-xs text-gray-500">
              Min
              <input type="number" min={0} value={d.min_select} onChange={e => updateDraft(gIdx, { min_select: parseInt(e.target.value) || 0 })} className="w-12 px-1 py-0.5 border border-gray-200 rounded text-xs" />
            </label>
            <label className="flex items-center gap-1 text-xs text-gray-500">
              Max
              <input type="number" min={1} value={d.max_select} onChange={e => updateDraft(gIdx, { max_select: parseInt(e.target.value) || 1 })} className="w-12 px-1 py-0.5 border border-gray-200 rounded text-xs" />
            </label>
            <button onClick={() => removeGroup(gIdx)} className="ml-auto text-gray-400 hover:text-red-600" title="Delete group">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-1">
            {d.choices.map((c, cIdx) => (
              <div key={cIdx} className="flex items-center gap-2">
                <input
                  value={c.name}
                  onChange={e => updateChoice(gIdx, cIdx, { name: e.target.value })}
                  placeholder="Choice name"
                  className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <span className="text-xs text-gray-400">$</span>
                <input
                  value={c.price_dollars}
                  onChange={e => updateChoice(gIdx, cIdx, { price_dollars: e.target.value })}
                  className="w-16 px-1.5 py-1 text-xs border border-gray-200 rounded text-right"
                />
                <button onClick={() => removeChoice(gIdx, cIdx)} className="text-gray-400 hover:text-red-600">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button onClick={() => addChoice(gIdx)} className="text-xs text-brand-600 hover:text-brand-700 flex items-center gap-1">
              <Plus className="w-3 h-3" /> Add choice
            </button>
          </div>

          <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
            <input
              value={d.bulkPaste}
              onChange={e => updateDraft(gIdx, { bulkPaste: e.target.value })}
              placeholder="Or paste several, comma or newline separated: Hot, Mild, BBQ"
              className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <button onClick={() => applyBulkPaste(gIdx)} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">
              Add all
            </button>
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2">
        <button onClick={addGroup} className="text-xs text-brand-600 hover:text-brand-700 flex items-center gap-1">
          <Plus className="w-3 h-3" /> Add option group
        </button>
        <button onClick={save} disabled={saving} className="ml-auto px-3 py-1.5 text-xs text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save options'}
        </button>
      </div>
    </div>
  )
}
