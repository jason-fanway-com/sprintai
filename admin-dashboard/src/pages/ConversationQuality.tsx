import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ShieldCheck, ShieldAlert, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'

// Conversation Quality panel (Spec 06 §4) — reads conversation_evals written by
// the async judge worker. READ-ONLY view: clean-vs-flagged counts per tenant,
// flagged list newest/worst first, drill into transcript + judge reasoning,
// tenant filter. Touches no live order path.

type Severity = 'critical' | 'major' | 'minor'

interface EvalFlag {
  check: string
  severity: Severity
  evidence_message_ids: string[]
  explanation: string
}

interface EvalRow {
  id: string
  tenant_id: string
  conversation_id: string
  judged_at: string
  verdict: 'clean' | 'flagged' | 'errored'
  max_severity: Severity | null
  flags: EvalFlag[]
  model: string
}

interface Tenant {
  id: string
  name: string
}

const SEV_RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 }

const sevBadge: Record<Severity, string> = {
  critical: 'bg-red-100 text-red-700 border border-red-200',
  major: 'bg-orange-100 text-orange-700 border border-orange-200',
  minor: 'bg-yellow-100 text-yellow-700 border border-yellow-200',
}

export default function ConversationQuality() {
  const [tenantFilter, setTenantFilter] = useState<string>('all')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const { data: tenants } = useQuery<Tenant[]>({
    queryKey: ['cq-tenants'],
    queryFn: async () => {
      const { data } = await supabase.from('tenants').select('id, name').order('name')
      return (data ?? []) as Tenant[]
    },
  })

  const { data, isLoading } = useQuery<EvalRow[]>({
    queryKey: ['conversation-evals', tenantFilter],
    queryFn: async () => {
      let q = supabase
        .from('conversation_evals')
        .select('id, tenant_id, conversation_id, judged_at, verdict, max_severity, flags, model')
        .order('judged_at', { ascending: false })
        .limit(500)
      if (tenantFilter !== 'all') q = q.eq('tenant_id', tenantFilter)
      const { data } = await q
      return (data ?? []) as EvalRow[]
    },
  })

  const rows = data ?? []
  const tenantName = (id: string) => tenants?.find((t) => t.id === id)?.name ?? id.slice(0, 8)

  const cleanCount = rows.filter((r) => r.verdict === 'clean').length
  const flaggedCount = rows.filter((r) => r.verdict === 'flagged').length
  const erroredCount = rows.filter((r) => r.verdict === 'errored').length

  // Flagged list: worst severity first, then newest first.
  const flagged = rows
    .filter((r) => r.verdict === 'flagged')
    .sort((a, b) => {
      const sa = a.max_severity ? SEV_RANK[a.max_severity] : 0
      const sb = b.max_severity ? SEV_RANK[b.max_severity] : 0
      if (sb !== sa) return sb - sa
      return new Date(b.judged_at).getTime() - new Date(a.judged_at).getTime()
    })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Conversation Quality</h1>
          <p className="text-gray-500 mt-1">
            Automated judge results — flagged conversations surfaced worst-first.
          </p>
        </div>
        <select
          value={tenantFilter}
          onChange={(e) => setTenantFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
        >
          <option value="all">All tenants</option>
          {tenants?.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>

      {/* Counts */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card p-5 flex items-center gap-3">
          <ShieldCheck className="w-8 h-8 text-green-500" />
          <div>
            <div className="text-2xl font-bold text-gray-900">{cleanCount}</div>
            <div className="text-sm text-gray-500">Clean</div>
          </div>
        </div>
        <div className="card p-5 flex items-center gap-3">
          <ShieldAlert className="w-8 h-8 text-red-500" />
          <div>
            <div className="text-2xl font-bold text-gray-900">{flaggedCount}</div>
            <div className="text-sm text-gray-500">Flagged</div>
          </div>
        </div>
        <div className="card p-5 flex items-center gap-3">
          <AlertTriangle className="w-8 h-8 text-gray-400" />
          <div>
            <div className="text-2xl font-bold text-gray-900">{erroredCount}</div>
            <div className="text-sm text-gray-500">Errored (judge)</div>
          </div>
        </div>
      </div>

      <h2 className="text-lg font-semibold text-gray-900 mb-3">Flagged conversations</h2>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3" />
              <th className="text-left px-4 py-3 font-medium text-gray-500">Severity</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Tenant</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Flags</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Judged</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Loading…</td></tr>
            ) : flagged.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                No flagged conversations — all clean. 🎉
              </td></tr>
            ) : (
              flagged.map((r) => {
                const open = expanded[r.id]
                return (
                  <>
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <button onClick={() => setExpanded((e) => ({ ...e, [r.id]: !open }))}>
                          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        {r.max_severity && (
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${sevBadge[r.max_severity]}`}>
                            {r.max_severity.toUpperCase()}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">{tenantName(r.tenant_id)}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {r.flags.map((f) => f.check).join(', ')}
                      </td>
                      <td className="px-4 py-3 text-gray-500">{new Date(r.judged_at).toLocaleString()}</td>
                      <td className="px-4 py-3 text-right">
                        <Link to={`/conversations/${r.conversation_id}`} className="btn-secondary text-xs py-1.5">
                          Transcript
                        </Link>
                      </td>
                    </tr>
                    {open && (
                      <tr key={`${r.id}-detail`} className="bg-gray-50">
                        <td colSpan={6} className="px-8 py-4">
                          <div className="space-y-3">
                            {r.flags.map((f, i) => (
                              <div key={i} className="border-l-2 border-gray-300 pl-3">
                                <div className="flex items-center gap-2">
                                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${sevBadge[f.severity]}`}>
                                    {f.severity.toUpperCase()}
                                  </span>
                                  <span className="font-mono text-xs text-gray-700">{f.check}</span>
                                </div>
                                <p className="text-sm text-gray-700 mt-1">{f.explanation}</p>
                                {f.evidence_message_ids.length > 0 && (
                                  <p className="text-xs text-gray-400 mt-1">
                                    evidence msg ids: {f.evidence_message_ids.join(', ')}
                                  </p>
                                )}
                              </div>
                            ))}
                            <p className="text-xs text-gray-400">judge model: {r.model}</p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
