import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, AlertTriangle, AlertCircle, Flag, Clock, User, RefreshCw, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { supabase } from '../lib/supabase'

interface Issue {
  id: string
  tenant_id: string
  shop_id: string | null
  conversation_id: string | null
  eval_id: string | null
  severity: 'sev_1' | 'sev_2' | 'sev_3'
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed'
  detection_rule: string
  title: string
  description: string | null
  detected_at: string
  acknowledged_at: string | null
  acknowledged_by: string | null
  resolved_at: string | null
  resolved_by: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

interface ResLogEntry {
  id: string
  action: string
  actor: string
  note: string | null
  old_status: string | null
  new_status: string | null
  created_at: string
}

const SEVERITY_STYLES: Record<string, string> = {
  sev_1: 'bg-red-100 text-red-700 border border-red-200',
  sev_2: 'bg-orange-100 text-orange-700 border border-orange-200',
  sev_3: 'bg-yellow-100 text-yellow-700 border border-yellow-200',
}

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-red-50 text-red-700 border-red-100',
  acknowledged: 'bg-blue-50 text-blue-700 border-blue-100',
  resolved: 'bg-green-50 text-green-700 border-green-100',
  dismissed: 'bg-gray-50 text-gray-500 border-gray-100',
}

const ACTION_LABELS: Record<string, string> = {
  created: 'Issue created',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
  note_added: 'Note added',
  auto_resolved: 'Auto-resolved',
}

export default function IssueDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')

  const { data: issue, isLoading } = useQuery<Issue>({
    queryKey: ['issue', id],
    queryFn: async () => {
      const { data } = await supabase
        .from('issues')
        .select('*')
        .eq('id', id)
        .maybeSingle()
      return data as Issue
    },
  })

  const { data: log } = useQuery<ResLogEntry[]>({
    queryKey: ['issue-log', id],
    queryFn: async () => {
      const { data } = await supabase
        .from('resolution_log')
        .select('*')
        .eq('issue_id', id)
        .order('created_at', { ascending: false })
      return (data ?? []) as ResLogEntry[]
    },
  })

  const updateStatus = useMutation({
    mutationFn: async ({ status, noteText }: { status: string; noteText?: string }) => {
      const updates: Record<string, unknown> = { status, updated_at: new Date().toISOString() }
      if (status === 'acknowledged') {
        updates.acknowledged_at = new Date().toISOString()
        updates.acknowledged_by = 'admin'
      }
      if (status === 'resolved') {
        updates.resolved_at = new Date().toISOString()
        updates.resolved_by = 'admin'
      }

      const { error: updErr } = await supabase
        .from('issues')
        .update(updates)
        .eq('id', id)

      if (updErr) throw updErr

      // Write resolution log entry
      const { error: logErr } = await supabase
        .from('resolution_log')
        .insert({
          issue_id: id,
          action: status === 'acknowledged' ? 'acknowledged' : 'resolved',
          actor: 'admin',
          note: noteText ?? null,
          old_status: issue?.status ?? 'open',
          new_status: status,
        })

      if (logErr) console.warn('Failed to write resolution log:', logErr.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue', id] })
      queryClient.invalidateQueries({ queryKey: ['issue-log', id] })
    },
  })

  const addNote = useMutation({
    mutationFn: async (text: string) => {
      const { error } = await supabase
        .from('resolution_log')
        .insert({
          issue_id: id,
          action: 'note_added',
          actor: 'admin',
          note: text,
          old_status: issue?.status ?? 'open',
          new_status: issue?.status ?? 'open',
        })
      if (error) throw error
      setNote('')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue-log', id] })
    },
  })

  if (isLoading) {
    return (
      <div className="p-8 max-w-3xl">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-gray-100 rounded w-1/2" />
          <div className="h-4 bg-gray-50 rounded w-3/4" />
          <div className="h-32 bg-gray-50 rounded" />
        </div>
      </div>
    )
  }

  if (!issue) {
    return (
      <div className="p-8 text-center text-gray-400">
        Issue not found. <Link to="/issues" className="text-brand-600 hover:underline">Back to issues</Link>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-3xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-4 mb-6">
        <Link to="/issues" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900 truncate">{issue.title}</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${SEVERITY_STYLES[issue.severity]}`}>
              {issue.severity.toUpperCase()}
            </span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${STATUS_STYLES[issue.status]}`}>
              {issue.status}
            </span>
            <span className="text-xs text-gray-400 font-mono">
              {issue.detection_rule}
            </span>
          </div>
        </div>
      </div>

      {/* Diagnosis card */}
      <section className="card p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-3">
          <AlertCircle className="w-4 h-4 text-gray-400" /> Diagnosis
        </h2>
        {issue.description ? (
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{issue.description}</p>
        ) : (
          <p className="text-sm text-gray-400">No description provided.</p>
        )}
      </section>

      {/* Metadata / evidence */}
      {issue.metadata && Object.keys(issue.metadata).length > 0 && (
        <section className="card p-6 mb-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Detection Evidence</h2>
          <div className="space-y-2">
            {Object.entries(issue.metadata).map(([key, val]) => (
              <div key={key} className="flex items-start gap-2 text-sm">
                <span className="text-gray-400 font-mono text-xs flex-shrink-0 min-w-[140px]">{key}:</span>
                <span className="text-gray-700 break-all font-mono text-xs">
                  {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Linked resources */}
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        {issue.conversation_id && (
          <Link
            to={`/conversations/${issue.conversation_id}`}
            className="card p-4 flex items-center gap-3 hover:shadow-md hover:border-brand-200 transition-all"
          >
            <ExternalLink className="w-4 h-4 text-brand-500" />
            <div>
              <div className="text-sm font-medium text-gray-900">View Conversation</div>
              <div className="text-xs text-gray-400 font-mono">{issue.conversation_id.slice(0, 8)}</div>
            </div>
          </Link>
        )}
        {issue.eval_id && (
          <Link
            to={`/conversation-quality`}
            className="card p-4 flex items-center gap-3 hover:shadow-md hover:border-brand-200 transition-all"
          >
            <ExternalLink className="w-4 h-4 text-brand-500" />
            <div>
              <div className="text-sm font-medium text-gray-900">View Eval</div>
              <div className="text-xs text-gray-400 font-mono">{issue.eval_id.slice(0, 8)}</div>
            </div>
          </Link>
        )}
      </section>

      {/* Actions */}
      <section className="card p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Actions</h2>
        <div className="flex flex-wrap gap-2">
          {issue.status === 'open' && (
            <button
              onClick={() => updateStatus.mutate({ status: 'acknowledged' })}
              disabled={updateStatus.isPending}
              className="btn-primary"
            >
              {updateStatus.isPending ? '...' : 'Acknowledge'}
            </button>
          )}
          {(issue.status === 'open' || issue.status === 'acknowledged') && (
            <>
              <button
                onClick={() => updateStatus.mutate({ status: 'resolved' })}
                disabled={updateStatus.isPending}
                className="btn-secondary"
              >
                <Check className="w-4 h-4" /> Resolve
              </button>
            </>
          )}
          {issue.status === 'open' && (
            <button
              onClick={() => updateStatus.mutate({ status: 'dismissed' })}
              disabled={updateStatus.isPending}
              className="btn-secondary !text-red-600"
            >
              Dismiss
            </button>
          )}
        </div>
      </section>

      {/* Add note */}
      <section className="card p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Add Note</h2>
        <div className="flex gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note to the resolution log..."
            className="input flex-1"
            rows={2}
          />
          <button
            onClick={() => note.trim() && addNote.mutate(note.trim())}
            disabled={addNote.isPending || !note.trim()}
            className="btn-primary self-end"
          >
            {addNote.isPending ? '...' : 'Add'}
          </button>
        </div>
      </section>

      {/* Resolution log */}
      <section className="card p-6">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-4">
          <Clock className="w-4 h-4 text-gray-400" /> Resolution Log
        </h2>
        {!log?.length ? (
          <p className="text-sm text-gray-400">No log entries yet.</p>
        ) : (
          <div className="space-y-3">
            {log.map((entry) => (
              <div key={entry.id} className="flex gap-3 text-sm border-l-2 border-gray-100 pl-3">
                <div className="flex-shrink-0 mt-0.5">
                  {entry.action === 'created' && <Flag className="w-4 h-4 text-gray-400" />}
                  {entry.action === 'acknowledged' && <AlertCircle className="w-4 h-4 text-blue-400" />}
                  {entry.action === 'resolved' && <Check className="w-4 h-4 text-green-500" />}
                  {entry.action === 'note_added' && <User className="w-4 h-4 text-gray-400" />}
                  {entry.action === 'dismissed' && <AlertCircle className="w-4 h-4 text-gray-400" />}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-700">{ACTION_LABELS[entry.action] ?? entry.action}</span>
                    <span className="text-xs text-gray-400">by {entry.actor}</span>
                    <span className="text-xs text-gray-300">{new Date(entry.created_at).toLocaleString()}</span>
                  </div>
                  {entry.note && (
                    <p className="text-xs text-gray-600 mt-0.5 whitespace-pre-wrap">{entry.note}</p>
                  )}
                  {entry.old_status && entry.new_status && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      Status: <span className="font-mono">{entry.old_status}</span> → <span className="font-mono">{entry.new_status}</span>
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Footer metadata */}
      <div className="mt-6 text-xs text-gray-400 space-y-1">
        <p>Detected: {new Date(issue.detected_at).toLocaleString()}</p>
        {issue.acknowledged_at && <p>Acknowledged: {new Date(issue.acknowledged_at).toLocaleString()} by {issue.acknowledged_by}</p>}
        {issue.resolved_at && <p>Resolved: {new Date(issue.resolved_at).toLocaleString()} by {issue.resolved_by}</p>}
        <p className="font-mono">ID: {issue.id}</p>
      </div>
    </div>
  )
}

// Small inline since we use it above but don't want to add another import
function Check({ className }: { className: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5"/>
    </svg>
  )
}
