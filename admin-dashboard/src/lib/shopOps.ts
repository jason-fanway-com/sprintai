import { supabase, supabaseUrl } from './supabase'

/**
 * Client for the admin-chat operations registry — the SAME apply() the chat UI calls.
 * The structured Menu & Settings editor builds ops directly from clicks/edits and sends
 * them here, skipping the LLM entirely. There is exactly one writer per operation; this
 * file and ConversationalAdminChat.tsx are two callers of it, never two implementations.
 */

export interface OptionChoiceOp {
  choice_id?: string
  name: string
  price_cents: number
}

export interface OptionGroupOp {
  group_id?: string
  name: string
  required: boolean
  min_select: number
  max_select: number
  choices: OptionChoiceOp[]
  delete_choice_ids?: string[]
}

export interface DayHoursOp {
  closed: boolean
  open?: string
  close?: string
}

export type FormOp =
  | { intent: 'SET_ITEM_FIELDS'; item_id: string; item_fields: { name?: string; price_dollars?: string; description?: string; category?: string; active?: boolean; clear_review_flag?: boolean } }
  | { intent: 'ADD_ITEM'; new_item: { name: string; price_dollars: string; description?: string; category?: string } }
  | { intent: 'REMOVE_ITEM'; item_id: string; item_name?: string }
  | { intent: 'EIGHTYSIX_ITEM'; item_ids: string[]; needs_clarification: false }
  | { intent: 'RESTORE_ITEM'; item_ids: string[]; needs_clarification: false }
  | { intent: 'SET_ITEM_OPTIONS'; item_id: string; item_name?: string; upsert_groups?: OptionGroupOp[]; delete_group_ids?: string[] }
  | { intent: 'SET_STORE_HOURS'; open_hours: Record<string, DayHoursOp> }
  | { intent: 'SET_DELIVERY_HOURS'; delivery_hours: Record<string, DayHoursOp> }
  | { intent: 'SET_DELIVERY_ENABLED'; delivery_enabled: boolean }
  | { intent: 'SET_SHOP_INSTRUCTIONS'; ai_instructions: string }
  | { intent: 'SET_WING_POLICY'; wing_flavors_included?: number | null; wing_mix_extra?: boolean | null }

export interface FormOpResult {
  ok: boolean
  intent: string
  result?: string
  error?: string
}

export interface FormBatchResult {
  type: 'form_batch_result'
  results: FormOpResult[]
  all_ok: boolean
}

export async function applyFormOps(shopId: string, ops: FormOp[]): Promise<FormBatchResult> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Please log in again.')

  const res = await fetch(`${supabaseUrl}/functions/v1/admin-chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ shop_id: shopId, form_ops: ops }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Save failed')
  return data as FormBatchResult
}
