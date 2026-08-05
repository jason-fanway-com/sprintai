import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { AlertTriangle, AlertCircle, Flag, ChevronLeft, ChevronRight, Filter } from 'lucide-react'
import { supabase } from '../lib/supabase'

interface Issue {
  id: string
  tenant_id: string
  conversation_id: string | null
  severity: 'sev_1' | 'sev_2' | 'sev_3'
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed'
  detection_rule: string
  title: string
  detected_at: string
  metadata: Record<string, unknown>
}

const SEVERITY_LABELS: Record<string, string> = {
  sev_1: 'Critical',
  sev_2: 'Major',
  sev_3: 'Minor',
}

const SEVERITY_STYLES: Record<string, string> = {
  sev_1: 'bg-red-100 text-red-700 border border-red-200',
  sev_2: 'bg-orange-100 text-orange-700 border border-orange-200',
  sev_3: 'bg-yellow-100 text-yellow-700 border border-yellow-200',
}

const ICONS: Record<string, React.ReactNode> = {
  sev_1: <AlertCircle className="w-4 h-4 text-red-500" />,
  sev_2: <AlertTriangle className="w-4 h-4 text-orange-500" />,
  sev_3: <Flag className="w-4 h-4 text-yellow-500" />,
}

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-red-50 text-red-700 border-red-100',
  acknowledged: 'bg-blue-50 text-blue-700 border-blue-100',
  resolved: 'bg-green-50 text-green-700 border-green-100',
  dismissed: 'bg-gray-50 text-gray-500 border-gray-100',
}

const PAGE_SIZE = 25

export default function Issues() {
  const [page, setPage] = useState(1)
  const [sevFilter, setSevFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('open')

  const { data, isLoading } = useQuery<{ issues: Issue[]; total: number }>({
    queryKey: ['issues', page, sevFilter, statusFilter],
    queryFn: async () => {
      let query = supabase
        .from('issues')
        .select('*', { count: 'exact' })
        .order('severity', { ascending: true }) // sev_1 first
        .order('detected_at', { ascending: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)

      if (sevFilter !== 'all') query = query.eq('severity', sevFilter)
      if (statusFilter !== 'all') query = query.eq('status', statusFilter)

      const { data, count } = await query
      return { issues: (data ?? []) as Issue[], total: count ?? 0 }
    },
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Issues</h1>
          <p className="text-gray-500 mt-1">
            {data?.total ?? 0} issues · self-diagnosing detection
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-6">
        <Filter className="w-4 h-4 text-gray-400" />
        <select
          value={sevFilter}
          onChange={(e) => { setSevFilter(e.target.value); setPage(1) }}
          className="input !min-h-0 !py-1.5 !px-3 !w-auto text-sm"
        >
          <option value="all">All severities</option>
          <option value="sev_1">Sev-1 (Critical)</option>
          <option value="sev_2">Sev-2 (Major)</option>
          <option value="sev_3">Sev-3 (Minor)</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
          className="input !min-h-0 !py-1.5 !px-3 !w-auto text-sm"
        >
          <option value="all">All statuses</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Dismissed</option>
        </select>
      </div>

      {/* Issue list */}
      <div className="space-y-3">
        {isLoading ? (
          [...Array(5)].map((_, i) => (
            <div key={i} className="card p-4">
              <div className="h-4 bg-gray-100 rounded w-3/4 animate-pulse mb-2" />
              <div className="h-3 bg-gray-50 rounded w-1/2 animate-pulse" />
            </div>
          ))
        ) : !data?.issues.length ? (
          <div className="card p-12 text-center text-gray-400">No issues found</div>
        ) : (
          data.issues.map((issue) => (
            <Link
              key={issue.id}
              to={`/issues/${issue.id}`}
              className="card p-4 block hover:shadow-md hover:border-brand-200 transition-all"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="mt-0.5">{ICONS[issue.severity]}</div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${SEVERITY_STYLES[issue.severity]}`}>
                        {SEVERITY_LABELS[issue.severity]}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${STATUS_STYLES[issue.status]}`}>
                        {issue.status}
                      </span>
                      <span className="text-xs text-gray-400 font-mono">
                        {issue.detection_rule}
                      </span>
                    </div>
                    <h3 className="text-sm font-medium text-gray-900 mt-1.5">
                      {issue.title}
                    </h3>
                    <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
                      <span>Detected {new Date(issue.detected_at).toLocaleString()}</span>
                      {issue.conversation_id && (
                        <span className="font-mono">
                          conv: {issue.conversation_id.slice(0, 8)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0 mt-1" />
              </div>
            </Link>
          ))
        )}
      </div>

      {/* Pagination */}
      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-6">
          <p className="text-sm text-gray-500">
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn-secondary disabled:opacity-50"
            >
              <ChevronLeft className="w-4 h-4" /> Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page * PAGE_SIZE >= data.total}
              className="btn-secondary disabled:opacity-50"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
