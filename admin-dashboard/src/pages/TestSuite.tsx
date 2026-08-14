import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { FlaskConical, CheckCircle2, XCircle, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { supabase } from '../lib/supabase'

/**
 * ADMIN VIEW (SprintAI employee) — global QA console.
 * Every shop's test runs, drill into each case + verdict. Operator framing:
 * raw pass/fail, model tier, critical failures. Super-admin only (route-guarded).
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

interface CaseResult {
  id: string
  case_id: string
  category: string | null
  criticality: string | null
  passed: boolean | null
  verdict: string | null
  reason: string | null
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

  const { data: runs, isLoading, error } = useQuery<Run[]>({
    queryKey: ['test-runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('test_runs')
        .select('*, shops(name)')
        .order('started_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as Run[]
    },
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
          <h1 className="text-2xl font-bold text-gray-900">Test Suite</h1>
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
                onClick={() => setOpenRun(isOpen ? null : run.id)}
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
                    <div key={c.id} className="flex items-start gap-3 px-4 py-3">
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
                        {c.reason && <p className="text-xs text-gray-500 mt-0.5">{c.reason}</p>}
                      </div>
                    </div>
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
