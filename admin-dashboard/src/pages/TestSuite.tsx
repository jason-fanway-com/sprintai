import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { FlaskConical, CheckCircle2, XCircle, ChevronDown, ChevronRight, AlertTriangle, MessageSquare, Gavel, Wrench } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useEffectiveTenant } from '../lib/useOwnerTenant'

/**
 * ADMIN VIEW (SprintAI employee) — global QA console.
 * Every shop's test runs, drill into each case + verdict. Operator framing:
 * raw pass/fail, model tier, critical failures. Super-admin only (route-guarded).
 *
 * Two-level drill-down: run → cases → case detail (transcript, judge findings,
 * proposed fix + fix status).
 */

interface Run {
  id: string
  shop_id: string
  label: string | null
  model_tier: string | null
  total: number
  passed: number
  failed: number
  overall_pass_pct: number | null
  critical_failures: unknown[] | null
  status: string
  started_at: string
  shops: { name: string } | null
}

interface TranscriptTurn {
  role: string
  message?: string
  reply?: string
  phase?: string
  cart?: unknown[]
}

interface SuccessCriterion {
  id: string
  check_id?: string
  description: string
}

type FixStatus = 'open' | 'proposed' | 'fixed' | 'harness' | 'test-data' | 'wontfix'

interface CaseResult {
  id: string
  case_id: string
  category: string | null
  criticality: string | null
  passed: boolean | null
  verdict: string | null
  reason: string | null
  transcript: TranscriptTurn[] | null
  success_criteria: SuccessCriterion[] | null
  root_cause: string | null
  proposed_fix: string | null
  fix_status: FixStatus | null
}

const FIX_STATUS_LABELS: Record<FixStatus, string> = {
  open: 'Open',
  proposed: 'Proposed',
  fixed: 'Fixed',
  harness: 'Harness',
  'test-data': 'Test data',
  wontfix: "Won't fix",
}

function fixStatusClass(s: FixStatus | null) {
  switch (s) {
    case 'fixed':
      return 'bg-green-100 text-green-700'
    case 'proposed':
      return 'bg-blue-100 text-blue-700'
    case 'harness':
      return 'bg-purple-100 text-purple-700'
    case 'test-data':
      return 'bg-amber-100 text-amber-700'
    case 'wontfix':
      return 'bg-gray-200 text-gray-600'
    case 'open':
    default:
      return 'bg-gray-100 text-gray-500'
  }
}

function pct(n: number | null) {
  return n == null ? '—' : `${n}%`
}

function passClass(p: number | null) {
  if (p == null) return 'bg-gray-100 text-gray-500'
  if (p >= 95) return 'bg-green-100 text-green-700'
  if (p >= 80) return 'bg-yellow-100 text-yellow-700'
  return 'bg-red-100 text-red-700'
}

export default function TestSuite() {
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [openCase, setOpenCase] = useState<string | null>(null)
  const { isOwnerView, effTenant } = useEffectiveTenant()

  const { data: runs, isLoading, error } = useQuery<Run[]>({
    queryKey: ['test-runs', effTenant],
    queryFn: async () => {
      let q = supabase
        .from('test_runs')
        .select('*, shops(name)')
        .order('started_at', { ascending: false })
      // Tenant isolation: shop owners see ONLY their own shop's runs.
      if (effTenant) q = q.eq('tenant_id', effTenant)
      const { data, error } = await q
      if (error) throw error
      return (data ?? []) as Run[]
    },
    enabled: !isOwnerView || !!effTenant,
  })

  const { data: cases } = useQuery<CaseResult[]>({
    queryKey: ['test-cases', openRun],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('test_case_results')
        .select('*')
        .eq('run_id', openRun)
        .order('criticality', { ascending: false })
      if (error) throw error
      return (data ?? []) as CaseResult[]
    },
    enabled: !!openRun,
  })

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-brand-50 flex items-center justify-center">
          <FlaskConical className="w-5 h-5 text-brand-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Production Readiness</h1>
          <p className="text-gray-500 text-sm">Conversation QA runs across all shops — pre-live acceptance + drift battery.</p>
        </div>
      </div>

      {isLoading && (
        <div className="p-8 flex justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      )}
      {error && (
        <div className="card p-6 bg-red-50 border-red-200">
          <p className="text-red-700">Failed to load runs: {(error as Error).message}</p>
        </div>
      )}

      {runs && runs.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <FlaskConical className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No test runs yet</p>
        </div>
      )}

      <div className="space-y-3">
        {runs?.map((run) => {
          const isOpen = openRun === run.id
          const crit = Array.isArray(run.critical_failures) ? run.critical_failures.length : 0
          return (
            <div key={run.id} className="card overflow-hidden">
              <button
                onClick={() => {
                  setOpenRun(isOpen ? null : run.id)
                  setOpenCase(null)
                }}
                className="w-full flex items-center gap-4 p-4 text-left hover:bg-gray-50 transition-colors"
              >
                {isOpen ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-900">{run.shops?.name ?? 'Unknown shop'}</span>
                    <span className="text-xs text-gray-400">{new Date(run.started_at).toLocaleString()}</span>
                  </div>
                  <p className="text-xs text-gray-500 truncate">{run.label}</p>
                </div>
                {crit > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                    <AlertTriangle className="w-3 h-3" /> {crit} critical
                  </span>
                )}
                <span className="text-xs text-gray-400">{run.passed}/{run.total}</span>
                <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${passClass(run.overall_pass_pct)}`}>
                  {pct(run.overall_pass_pct)}
                </span>
              </button>

              {isOpen && (
                <div className="border-t border-gray-100 divide-y divide-gray-50">
                  <div className="px-4 py-2 text-xs text-gray-400 flex gap-4">
                    <span>model: {run.model_tier ?? '—'}</span>
                    <span>status: {run.status}</span>
                  </div>
                  {(cases ?? []).map((c) => (
                    <CaseRow
                      key={c.id}
                      c={c}
                      open={openCase === c.id}
                      onToggle={() => setOpenCase(openCase === c.id ? null : c.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CaseRow({ c, open, onToggle }: { c: CaseResult; open: boolean; onToggle: () => void }) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        {open ? <ChevronDown className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />}
        {c.passed ? (
          <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
        ) : (
          <XCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900">{c.case_id}</span>
            {c.criticality === 'critical' && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-50 text-red-600">CRITICAL</span>
            )}
            <span className="text-[10px] text-gray-400">{c.category}</span>
          </div>
          {c.reason && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{c.reason}</p>}
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 pl-11 space-y-4">
          {/* Judge findings */}
          <div className="border border-gray-100 rounded-lg p-3 bg-gray-50/50">
            <div className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-2">
              <Gavel className="w-3.5 h-3.5" /> Judge findings
              {c.verdict && (
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${c.passed ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                  {c.verdict}
                </span>
              )}
            </div>
            {c.reason ? (
              <p className="text-xs text-gray-700">{c.reason}</p>
            ) : (
              <p className="text-xs text-gray-400 italic">No findings recorded.</p>
            )}

            {c.success_criteria && c.success_criteria.length > 0 && (
              <div className="mt-3">
                <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Success criteria</p>
                <ul className="space-y-1">
                  {c.success_criteria.map((crit) => (
                    <li key={crit.id} className="text-xs text-gray-600 flex gap-1.5">
                      <span className="text-gray-400">•</span>
                      <span>{crit.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Root cause + proposed fix + status */}
          <div className="border border-gray-100 rounded-lg p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-2">
              <Wrench className="w-3.5 h-3.5" /> Remediation
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${fixStatusClass(c.fix_status)}`}>
                {c.fix_status ? FIX_STATUS_LABELS[c.fix_status] ?? c.fix_status : 'pending'}
              </span>
            </div>
            {c.root_cause ? (
              <div className="mb-2">
                <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Root cause</p>
                <p className="text-xs text-gray-800 whitespace-pre-wrap">{c.root_cause}</p>
              </div>
            ) : (
              c.passed ? (
                <p className="text-xs text-gray-400 italic">Passed — no remediation needed.</p>
              ) : (
                <p className="text-xs text-gray-400 italic">No root cause recorded.</p>
              )
            )}
            {c.proposed_fix ? (
              <div>
                <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">Proposed fix</p>
                <p className="text-xs text-gray-700 whitespace-pre-wrap">{c.proposed_fix}</p>
              </div>
            ) : (
              !c.passed && <p className="text-xs text-gray-400 italic">No fix proposed yet.</p>
            )}
          </div>

          {/* Transcript */}
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-gray-600 mb-2">
              <MessageSquare className="w-3.5 h-3.5" /> Transcript
            </div>
            {c.transcript && c.transcript.length > 0 ? (
              <div className="space-y-2">
                {c.transcript.map((t, i) => (
                  <div key={i} className="text-xs">
                    {t.message != null && t.message !== '' && (
                      <div className="flex gap-2">
                        <span className="text-[10px] font-semibold uppercase text-gray-400 w-14 flex-shrink-0 mt-0.5">customer</span>
                        <span className="text-gray-800 bg-gray-100 rounded px-2 py-1">{t.message}</span>
                      </div>
                    )}
                    {t.reply != null && t.reply !== '' && (
                      <div className="flex gap-2 mt-1">
                        <span className="text-[10px] font-semibold uppercase text-brand-500 w-14 flex-shrink-0 mt-0.5">assistant</span>
                        <span className="text-gray-700 bg-brand-50 rounded px-2 py-1">{t.reply}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400 italic">No transcript recorded.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
