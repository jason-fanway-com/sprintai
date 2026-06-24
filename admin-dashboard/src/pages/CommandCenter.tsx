import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Activity, ShieldAlert, ShieldCheck, Store, GitBranch, Server,
  AlertTriangle, CircleDot, CheckCircle2, Ban, RefreshCw, Clock, Flag,
} from 'lucide-react'
import { supabase } from '../lib/supabase'

/**
 * Command Center — internal super-admin operator view.
 *
 * Two halves, both LIVE (nothing hand-maintained in the bundle):
 *
 *  A) PROGRAM-MANAGEMENT DASHBOARD (restored from the original command-center.html).
 *     Editorial content lives in admin-RLS DB ROWS (migration 019: program_epics,
 *     program_tasks, program_milestones, program_launch_path, program_risks,
 *     program_decisions, program_compliance, program_team, program_activity,
 *     program_series_a, program_meta). Updating any of it is a ROW WRITE, not a
 *     redeploy. EVERY rollup (overall build %, vital signs, per-epic %, kanban
 *     column counts, roadmap NOW marker) is DERIVED here at view-time from those
 *     rows — never stored, never typed.
 *
 *  B) OPERATIONAL PANELS (the 4 already-live panels, unchanged):
 *     - Platform health / deploy state ... supabase.rpc('command_center_deploy_status')
 *     - Conversation-quality rollup ...... conversation_evals (admin RLS)
 *     - Onboarding / tenant state ........ shops + tenants (admin RLS)
 *     - Known open items / blockers ...... program_items (admin RLS, editorial rows)
 *
 * All reads use the admin user's JWT via the existing `supabase` client. NO
 * service-role key / access token / secret is ever in the client bundle.
 * Reuses ProtectedRoute (mounted under the authed Layout in App.tsx). NOT public.
 * The live order/messaging/billing path never reads or writes any program_* table.
 */

// ── shared types ─────────────────────────────────────────────────────────────
type Severity = 'critical' | 'major' | 'minor'
type Confidence = 'high' | 'low'

interface DeployRow { version: string; name: string }

interface EvalRow {
  id: string
  tenant_id: string
  conversation_id: string
  judged_at: string
  verdict: 'clean' | 'flagged' | 'errored'
  max_severity: Severity | null
  confidence: Confidence
  flags: { check: string; severity: Severity; explanation: string }[]
  cost_cents: number | null
}

interface ProgramItem {
  id: string
  title: string
  status: 'open' | 'done' | 'blocked'
  severity: Severity
  note: string | null
  updated_at: string
}

interface ShopRow {
  id: string
  name: string
  onboarding_step: string | null
  subscription_status: string | null
  connect_status: string | null
  is_paused: boolean
}

interface TenantRow { id: string; name: string; status: string | null }

// ── program (restored dashboard) types ──────────────────────────────────────
type Tone = 'done' | 'progress' | 'todo' | 'open'

interface Epic {
  epic_key: string; name: string; owner: string
  status_label: string; status_tone: Tone; sort_order: number
}
type KanbanColumn = 'To Do' | 'In Progress' | 'In Review' | 'Done' | 'Blocked'
interface Task {
  task_key: string; title: string; epic_key: string
  column_name: KanbanColumn; priority: string | null
  evidence: string | null; blocker: string | null; sort_order: number
}
interface Milestone {
  milestone_key: string; phase: string; start_date: string; end_date: string
  status: 'done' | 'active' | 'upcoming'; sort_order: number
}
interface LaunchStep {
  step_key: string; title: string; detail: string
  state: 'progress' | 'blocked' | 'todo' | 'done'; label: string; sort_order: number
}
interface Risk {
  risk_key: string; risk: string; severity: string; likelihood: string
  status_label: string; status_tone: 'open' | 'progress'; mitigation: string; sort_order: number
}
interface Decision {
  decision_key: string; kind: 'locked' | 'open'; text: string
  owner: string | null; sort_order: number
}
interface StateRow {
  item: string; status_text: string; state: 'done' | 'progress' | 'open'; sort_order: number
}
interface ComplianceRow extends StateRow { item_key: string }
interface SeriesARow extends StateRow { item_key: string }
interface TeamMember {
  member_key: string; name: string; role: string; model: string
  load_text: string; color: string; sort_order: number
}
interface ActivityRow { activity_key: string; when_label: string; text: string; sort_order: number }
interface MetaRow { meta_key: string; meta_value: string }

// Edge functions are public repo facts (names only), not secrets.
const EDGE_FUNCTIONS = [
  'chat-sms', 'admin-api', 'eval-sweep', 'create-checkout', 'refund-order',
  'stripe-webhook', 'toast-order', 'go-live', 'onboard-tenant', 'onboarding-save',
  'provision-number', 'scrape-shop', 'train-tenant', 'parse-menu-pdf',
  'import-menu-csv', 'merchant-auth', 'connect-create-express', 'connect-oauth',
]

const KANBAN_COLS: KanbanColumn[] = ['To Do', 'In Progress', 'In Review', 'Done', 'Blocked']

const SEV_RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 }
const sevBadge: Record<Severity, string> = {
  critical: 'bg-red-100 text-red-700 border border-red-200',
  major: 'bg-orange-100 text-orange-700 border border-orange-200',
  minor: 'bg-yellow-100 text-yellow-700 border border-yellow-200',
}
const itemStatusIcon = {
  open: <CircleDot className="w-4 h-4 text-orange-500" />,
  done: <CheckCircle2 className="w-4 h-4 text-green-600" />,
  blocked: <Ban className="w-4 h-4 text-red-600" />,
}

// status-tone → tailwind tag classes (mirrors original 'tag' colors)
const toneTag: Record<string, string> = {
  done: 'bg-green-100 text-green-700 border border-green-200',
  progress: 'bg-blue-100 text-blue-700 border border-blue-200',
  todo: 'bg-gray-100 text-gray-600 border border-gray-200',
  open: 'bg-orange-100 text-orange-700 border border-orange-200',
}
const stateDot: Record<string, string> = {
  done: 'bg-green-500', progress: 'bg-blue-500', open: 'bg-orange-500',
}
const sevPill: Record<string, string> = {
  High: 'bg-red-100 text-red-700', Med: 'bg-orange-100 text-orange-700', Low: 'bg-gray-100 text-gray-600',
}

function fmt(ts: string | null | undefined) {
  return ts ? new Date(ts).toLocaleString() : '—'
}

// generic admin-RLS table read, sorted by sort_order
function useProgramTable<T>(key: string, table: string, cols: string) {
  return useQuery<T[]>({
    queryKey: [key],
    queryFn: async () => {
      const { data } = await supabase.from(table).select(cols).order('sort_order', { ascending: true })
      return (data ?? []) as T[]
    },
  })
}

export default function CommandCenter() {
  // ── A) restored program dashboard sources (admin-RLS DB rows) ──────────────
  const epicsQ = useProgramTable<Epic>('cc-epics', 'program_epics', 'epic_key, name, owner, status_label, status_tone, sort_order')
  const tasksQ = useProgramTable<Task>('cc-tasks', 'program_tasks', 'task_key, title, epic_key, column_name, priority, evidence, blocker, sort_order')
  const milesQ = useProgramTable<Milestone>('cc-miles', 'program_milestones', 'milestone_key, phase, start_date, end_date, status, sort_order')
  const launchQ = useProgramTable<LaunchStep>('cc-launch', 'program_launch_path', 'step_key, title, detail, state, label, sort_order')
  const risksQ = useProgramTable<Risk>('cc-risks', 'program_risks', 'risk_key, risk, severity, likelihood, status_label, status_tone, mitigation, sort_order')
  const decQ = useProgramTable<Decision>('cc-decisions', 'program_decisions', 'decision_key, kind, text, owner, sort_order')
  const compQ = useProgramTable<ComplianceRow>('cc-compliance', 'program_compliance', 'item_key, item, status_text, state, sort_order')
  const teamQ = useProgramTable<TeamMember>('cc-team', 'program_team', 'member_key, name, role, model, load_text, color, sort_order')
  const feedQ = useProgramTable<ActivityRow>('cc-activity', 'program_activity', 'activity_key, when_label, text, sort_order')
  const seriesQ = useProgramTable<SeriesARow>('cc-seriesa', 'program_series_a', 'item_key, item, status_text, state, sort_order')
  const metaQ = useQuery<MetaRow[]>({
    queryKey: ['cc-meta'],
    queryFn: async () => {
      const { data } = await supabase.from('program_meta').select('meta_key, meta_value')
      return (data ?? []) as MetaRow[]
    },
  })

  // ── B) the 4 existing live operational panels (unchanged) ──────────────────
  const deploy = useQuery<{ migrations: DeployRow[]; error: string | null }>({
    queryKey: ['cc-deploy'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('command_center_deploy_status')
      if (error) return { migrations: [], error: error.message }
      return { migrations: (data ?? []) as DeployRow[], error: null }
    },
  })
  const evals = useQuery<EvalRow[]>({
    queryKey: ['cc-evals'],
    queryFn: async () => {
      const { data } = await supabase
        .from('conversation_evals')
        .select('id, tenant_id, conversation_id, judged_at, verdict, max_severity, confidence, flags, cost_cents')
        .order('judged_at', { ascending: false })
        .limit(1000)
      return ((data ?? []) as EvalRow[]).map((r) => ({ ...r, confidence: (r.confidence ?? 'high') as Confidence }))
    },
  })
  const shops = useQuery<ShopRow[]>({
    queryKey: ['cc-shops'],
    queryFn: async () => {
      const { data } = await supabase
        .from('shops')
        .select('id, name, onboarding_step, subscription_status, connect_status, is_paused')
        .limit(2000)
      return (data ?? []) as ShopRow[]
    },
  })
  const tenants = useQuery<TenantRow[]>({
    queryKey: ['cc-tenants'],
    queryFn: async () => {
      const { data } = await supabase.from('tenants').select('id, name, status').limit(2000)
      return (data ?? []) as TenantRow[]
    },
  })
  const items = useQuery<ProgramItem[]>({
    queryKey: ['cc-program-items'],
    queryFn: async () => {
      const { data } = await supabase
        .from('program_items')
        .select('id, title, status, severity, note, updated_at')
        .order('status', { ascending: true })
        .order('updated_at', { ascending: false })
      return (data ?? []) as ProgramItem[]
    },
  })

  // ══ DERIVED rollups — computed from rows at view-time, never stored/typed ══
  const epics = epicsQ.data ?? []
  const tasks = tasksQ.data ?? []
  const miles = milesQ.data ?? []
  const risks = risksQ.data ?? []

  // per-epic done/total/% (from tasks)
  const epicRollup = epics.map((ep) => {
    const ts = tasks.filter((t) => t.epic_key === ep.epic_key)
    const done = ts.filter((t) => t.column_name === 'Done').length
    return { ...ep, total: ts.length, done, pct: ts.length ? Math.round((done / ts.length) * 100) : 0 }
  })
  // overall build % = done tasks / all tasks
  const overall = tasks.length
    ? Math.round((tasks.filter((t) => t.column_name === 'Done').length / tasks.length) * 100) : 0
  // vital signs (all derived)
  const blockerCount = tasks.filter((t) => t.column_name === 'Blocked').length
  const openRisks = risks.filter((r) => r.status_tone === 'open').length
  const heroVitals: [string, number, '' | 'warn' | 'bad'][] = [
    ['Workstreams', epics.length, ''],
    ['Tracked tasks', tasks.length, ''],
    ['Blockers', blockerCount, 'warn'],
    ['Open risks', openRisks, 'bad'],
  ]
  // kanban counts (derived per column)
  const kanban = KANBAN_COLS.map((col) => ({ col, cards: tasks.filter((t) => t.column_name === col) }))

  // roadmap axis from program_meta (changeable), with NOW marker derived from today
  const meta = metaQ.data ?? []
  const axisStart = meta.find((m) => m.meta_key === 'roadmap_axis_start')?.meta_value ?? '2026-04-01'
  const axisEnd = meta.find((m) => m.meta_key === 'roadmap_axis_end')?.meta_value ?? '2027-07-01'
  const frac = (d: string) => {
    const a = new Date(axisStart).getTime(), b = new Date(axisEnd).getTime(), x = new Date(d).getTime()
    return Math.max(0, Math.min(1, (x - a) / (b - a)))
  }
  const nowPct = frac(new Date().toISOString().slice(0, 10)) * 100

  const epicShort = (id: string) => {
    const e = epics.find((x) => x.epic_key === id)
    if (!e) return id
    const base = e.name.replace(/ \(.*\)/, '').split(' ')[0]
    return e.epic_key === 'cmdcenter' ? base + ' CC' : base
  }

  const lockedDecisions = (decQ.data ?? []).filter((d) => d.kind === 'locked')
  const openDecisions = (decQ.data ?? []).filter((d) => d.kind === 'open')

  // ── operational rollups (panels B) ─────────────────────────────────────────
  const evRows = evals.data ?? []
  const clean = evRows.filter((r) => r.verdict === 'clean').length
  const flagged = evRows.filter((r) => r.verdict === 'flagged').length
  const errored = evRows.filter((r) => r.verdict === 'errored').length
  const highConf = evRows.filter((r) => r.verdict === 'flagged' && r.confidence === 'high').length
  const lowConf = evRows.filter((r) => r.verdict === 'flagged' && r.confidence === 'low').length
  const lastSweep = evRows.length ? evRows[0].judged_at : null
  const sweepSpend = evRows.reduce((s, r) => s + (Number(r.cost_cents) || 0), 0)
  const tenantName = (id: string) => tenants.data?.find((t) => t.id === id)?.name ?? id.slice(0, 8)
  const worstFlags = evRows
    .filter((r) => r.verdict === 'flagged' && r.confidence === 'high')
    .sort((a, b) => {
      const sa = a.max_severity ? SEV_RANK[a.max_severity] : 0
      const sb = b.max_severity ? SEV_RANK[b.max_severity] : 0
      if (sb !== sa) return sb - sa
      return new Date(b.judged_at).getTime() - new Date(a.judged_at).getTime()
    })
    .slice(0, 10)
  const shopRows = shops.data ?? []
  const liveShops = shopRows.filter((s) => s.onboarding_step === 'done').length
  const pausedShops = shopRows.filter((s) => s.is_paused).length
  const subActive = shopRows.filter((s) => s.subscription_status === 'active').length
  const connectEnabled = shopRows.filter((s) => s.connect_status === 'enabled').length
  const byStep = shopRows.reduce<Record<string, number>>((acc, s) => {
    const k = s.onboarding_step ?? '(none)'
    acc[k] = (acc[k] ?? 0) + 1
    return acc
  }, {})
  const itemRows = items.data ?? []
  const openBlockers = itemRows.filter((i) => i.status !== 'done').length

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <Activity className="w-7 h-7 text-brand-600" />
          <h1 className="text-2xl font-bold text-gray-900">Command Center</h1>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2.5 py-1">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse motion-reduce:animate-none" /> live
          </span>
        </div>
        <span className="text-sm text-gray-400">rendered {new Date().toLocaleString()}</span>
      </div>
      <p className="text-gray-500 mb-8">
        Internal operator view. Program content is editable DB rows; every number is derived live at view-time — nothing here is hand-maintained.
      </p>

      {/* ════════════════ A) RESTORED PROGRAM DASHBOARD ════════════════ */}

      {/* 1) HERO — overall build % + vital signs (all derived) */}
      <section className="card p-6 mb-8 bg-gradient-to-br from-gray-900 to-gray-800 text-white">
        <div className="flex flex-col md:flex-row md:items-center gap-6">
          <Ring pct={overall} />
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-brand-300 mb-1">Program status · Q2 2026</div>
            <h2 className="text-2xl font-bold mb-2">SprintAI build at a glance</h2>
            <p className="text-gray-300 text-sm mb-4 max-w-2xl">
              {epics.length} workstreams from foundation to launch — payments, menu pipeline, signup wizard and merchant
              security verified; parser and hours fixes in flight ahead of the first real paid SMS order at Jack's Slice.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {heroVitals.map(([label, n, cls]) => (
                <div key={label} className="bg-white/10 rounded-lg px-3 py-2">
                  <div className={`text-2xl font-bold ${n > 0 && cls === 'bad' ? 'text-red-300' : n > 0 && cls === 'warn' ? 'text-orange-300' : 'text-white'}`}>{n}</div>
                  <div className="text-xs text-gray-300">{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 2) LAUNCH CRITICAL PATH — the most important section */}
      <section className="card p-6 mb-8 border-2 border-brand-200 bg-brand-50/40">
        <div className="flex items-center gap-2 mb-1">
          <Flag className="w-5 h-5 text-brand-600" />
          <span className="text-xs uppercase tracking-wide font-semibold text-brand-700">Launch critical path</span>
        </div>
        <h2 className="text-lg font-bold text-gray-900">What stands between us and Jack's Slice taking one real paid SMS order</h2>
        <p className="text-sm text-gray-500 mb-4">The shortest line to first revenue. Everything else is secondary until these four clear.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {(launchQ.data ?? []).map((s, i) => {
            const tone = s.state === 'blocked' ? 'border-red-300 bg-red-50' : s.state === 'progress' ? 'border-blue-300 bg-blue-50' : s.state === 'done' ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-white'
            return (
              <div key={s.step_key} className={`rounded-lg border p-4 ${tone}`}>
                <div className="w-7 h-7 rounded-full bg-gray-900 text-white flex items-center justify-center text-sm font-bold mb-2">{i + 1}</div>
                <div className="font-semibold text-sm text-gray-900">{s.title}</div>
                <div className="text-xs text-gray-600 mt-1">{s.detail}</div>
                <div className="text-xs font-medium text-gray-500 mt-2">{s.label}</div>
              </div>
            )
          })}
        </div>
      </section>

      {/* 3) PROGRESS BY EPIC */}
      <section className="mb-8">
        <SecHead eyebrow="Workstreams" title="Progress by epic" hint="Owner · tasks complete · % built" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {epicRollup.map((e) => (
            <div key={e.epic_key} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-sm text-gray-900">{e.name}</div>
                  <div className="text-xs text-gray-500">{e.owner} · {e.done} / {e.total} tasks</div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-lg font-bold text-gray-900">{e.pct}%</div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${toneTag[e.status_tone] ?? toneTag.todo}`}>{e.status_label}</span>
                </div>
              </div>
              <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-brand-500 rounded-full" style={{ width: `${e.pct}%` }} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 4) TASK BOARD (kanban) */}
      <section className="mb-8">
        <SecHead eyebrow="Execution" title="Task board" hint="Swipe columns on mobile" />
        <div className="flex gap-3 overflow-x-auto pb-2">
          {kanban.map(({ col, cards }) => (
            <div key={col} className={`flex-shrink-0 w-64 rounded-lg p-3 ${col === 'Blocked' ? 'bg-red-50 border border-red-100' : 'bg-gray-50 border border-gray-100'}`}>
              <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide flex items-center justify-between mb-2">
                {col}<span className="text-gray-400 bg-white rounded-full px-2 py-0.5 text-[10px]">{cards.length}</span>
              </h3>
              <div className="space-y-2">
                {cards.map((t) => (
                  <div key={t.task_key} className="bg-white rounded-md border border-gray-200 p-2.5 shadow-sm">
                    <div className="text-xs font-medium text-gray-900">{t.title}</div>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      <span className="text-[10px] bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">{epicShort(t.epic_key)}</span>
                      {t.priority && <span className={`text-[10px] rounded px-1.5 py-0.5 ${sevPill[t.priority] ?? 'bg-gray-100 text-gray-600'}`}>{t.priority}</span>}
                    </div>
                    {t.blocker && <div className="text-[11px] text-red-600 mt-1.5">⛔ {t.blocker}</div>}
                    {t.column_name === 'Done' && t.evidence && (
                      <div className="text-[11px] text-green-700 mt-1.5">✓ <b>evidence:</b> {t.evidence}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 5) ROADMAP / PHASE TIMELINE */}
      <section className="mb-8">
        <SecHead eyebrow="Roadmap" title="Phase timeline" hint="Illustrative plan — editable" />
        <div className="card p-6">
          <div className="flex text-[11px] text-gray-400 mb-2 pl-[34%]">
            <span className="flex-1">Q2 '26</span><span className="flex-1">Q3 '26</span><span className="flex-1">Q4 '26</span><span className="flex-1">Q1 '27</span><span className="flex-1">Q2 '27</span>
          </div>
          <div className="relative">
            {/* NOW marker */}
            <div className="absolute top-0 bottom-0 w-px bg-brand-500 z-10" style={{ left: `calc(34% + ${nowPct}% * 0.66)` }}>
              <span className="absolute -top-1 -translate-x-1/2 text-[9px] font-bold text-brand-600 bg-white px-1">NOW</span>
            </div>
            {miles.map((g) => {
              const s = frac(g.start_date) * 100, e = frac(g.end_date) * 100
              const width = Math.max(2, e - s)
              const barTone = g.status === 'active' ? 'bg-blue-500' : g.status === 'done' ? 'bg-green-500' : 'bg-gray-300'
              const lbl = g.status === 'active' ? 'In progress' : g.status === 'done' ? 'Complete' : ''
              return (
                <div key={g.milestone_key} className="flex items-center gap-2 py-1.5">
                  <div className="w-1/3 text-xs text-gray-700 truncate pr-2">{g.phase}</div>
                  <div className="flex-1 relative h-6 bg-gray-50 rounded">
                    <div className={`absolute h-6 rounded ${barTone} flex items-center justify-center text-[10px] text-white font-medium px-1 overflow-hidden`} style={{ left: `${s}%`, width: `${width}%` }}>{lbl}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* 6) RISK REGISTER */}
      <section className="mb-8">
        <SecHead eyebrow="Governance" title="Risk register" hint="Identified · rated · mitigated" />
        <div className="card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100">
                <th className="px-4 py-3">Risk</th><th className="px-4 py-3">Severity</th><th className="px-4 py-3">Likelihood</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 w-2/5">Mitigation</th>
              </tr>
            </thead>
            <tbody>
              {risks.map((r) => (
                <tr key={r.risk_key} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-3 text-gray-900 font-medium">{r.risk}</td>
                  <td className="px-4 py-3"><span className={`text-[10px] rounded px-1.5 py-0.5 font-semibold ${sevPill[r.severity] ?? 'bg-gray-100 text-gray-600'}`}>{r.severity}</span></td>
                  <td className="px-4 py-3 text-gray-600">{r.likelihood}</td>
                  <td className="px-4 py-3"><span className={`text-[10px] rounded px-1.5 py-0.5 font-semibold ${toneTag[r.status_tone === 'open' ? 'todo' : r.status_tone] ?? toneTag.todo}`}>{r.status_label}</span></td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{r.mitigation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 7) DECISIONS — locked + open */}
      <section className="mb-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-6">
          <div className="text-xs uppercase tracking-wide text-gray-400">Architecture decision record</div>
          <h2 className="text-lg font-bold text-gray-900">Decisions locked</h2>
          <p className="text-sm text-gray-500 mb-3">The calls that shape the build</p>
          <ul className="space-y-2">
            {lockedDecisions.map((d) => (
              <li key={d.decision_key} className="flex gap-2 text-sm text-gray-700">
                <span className="text-green-600 flex-shrink-0">✓</span><span>{d.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card p-6">
          <div className="text-xs uppercase tracking-wide text-gray-400">Needs you</div>
          <h2 className="text-lg font-bold text-gray-900">Open decisions</h2>
          <p className="text-sm text-gray-500 mb-3">Awaiting a founder call — these gate work</p>
          <ul className="space-y-2">
            {openDecisions.map((d) => (
              <li key={d.decision_key} className="flex gap-2 text-sm text-gray-700">
                <span className="text-orange-500 flex-shrink-0">?</span><span>{d.text}{d.owner && <b className="text-gray-900"> · {d.owner}</b>}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 8-10) COMPLIANCE / TEAM / ACTIVITY */}
      <section className="mb-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 8 compliance */}
        <div className="card p-6">
          <div className="text-xs uppercase tracking-wide text-gray-400">Posture</div>
          <h2 className="text-lg font-bold text-gray-900">Compliance &amp; readiness</h2>
          <p className="text-sm text-gray-500 mb-3">Maturity signals</p>
          <div className="space-y-2">
            {(compQ.data ?? []).map((c) => (
              <div key={c.item_key} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-gray-700">{c.item}</span>
                <span className="flex items-center gap-1.5 text-gray-500 text-xs text-right"><span className={`w-2 h-2 rounded-full flex-shrink-0 ${stateDot[c.state] ?? 'bg-gray-300'}`} />{c.status_text}</span>
              </div>
            ))}
          </div>
        </div>
        {/* 9 team */}
        <div className="card p-6">
          <div className="text-xs uppercase tracking-wide text-gray-400">Build team</div>
          <h2 className="text-lg font-bold text-gray-900">Agents</h2>
          <p className="text-sm text-gray-500 mb-3">Multi-agent build crew</p>
          <div className="space-y-3">
            {(teamQ.data ?? []).map((m) => (
              <div key={m.member_key} className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0" style={{ background: m.color }}>{m.name[0].toUpperCase()}</div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-900">{m.name}</div>
                  <div className="text-xs text-gray-500 truncate">{m.role} · {m.model}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* 10 activity — plain text (NOT innerHTML) */}
        <div className="card p-6">
          <div className="text-xs uppercase tracking-wide text-gray-400">Recent</div>
          <h2 className="text-lg font-bold text-gray-900">Activity</h2>
          <p className="text-sm text-gray-500 mb-3">Latest movements</p>
          <ul className="space-y-2.5">
            {(feedQ.data ?? []).map((f) => (
              <li key={f.activity_key} className="text-sm">
                <span className="text-xs text-gray-400 mr-2">{f.when_label}</span>
                <span className="text-gray-700">{f.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 11) SERIES A READINESS */}
      <section className="mb-10">
        <div className="card p-6">
          <div className="text-xs uppercase tracking-wide text-gray-400">Investor lens</div>
          <h2 className="text-lg font-bold text-gray-900">Series A readiness</h2>
          <p className="text-sm text-gray-500 mb-3">What a Series A diligence team looks for — tracked from day one</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {(seriesQ.data ?? []).map((s) => (
              <div key={s.item_key} className="flex items-center justify-between gap-2 text-sm border-b border-gray-50 py-1.5">
                <span className="text-gray-700">{s.item}</span>
                <span className="flex items-center gap-1.5 text-gray-500 text-xs text-right"><span className={`w-2 h-2 rounded-full flex-shrink-0 ${stateDot[s.state] ?? 'bg-gray-300'}`} />{s.status_text}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-lg bg-gray-50 border border-gray-100 p-3">
            <span className="text-[10px] uppercase font-semibold text-gray-500">Definition of done</span>
            <p className="text-xs text-gray-600 mt-1"><b>Done</b> means observable artifacts — running code, passing QA, data in production — <b>never</b> an agent's claim.</p>
          </div>
        </div>
      </section>

      {/* ════════════════ B) LIVE OPERATIONAL PANELS (unchanged) ════════════════ */}
      <div className="border-t border-gray-200 pt-8 mb-4">
        <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Live operations</div>
        <h2 className="text-lg font-bold text-gray-900 mb-1">Operational telemetry</h2>
        <p className="text-sm text-gray-500 mb-6">Real platform state read live at view-time.</p>
      </div>

      {/* top vitals (operational) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Vital icon={<ShieldAlert className="w-5 h-5 text-red-500" />} n={highConf} label="High-confidence flags" tone={highConf > 0 ? 'bad' : 'ok'} />
        <Vital icon={<Store className="w-5 h-5 text-brand-600" />} n={liveShops} label={`Live shops / ${shopRows.length} total`} />
        <Vital icon={<AlertTriangle className="w-5 h-5 text-orange-500" />} n={openBlockers} label="Open blockers" tone={openBlockers > 0 ? 'warn' : 'ok'} />
        <Vital icon={<GitBranch className="w-5 h-5 text-gray-600" />} n={deploy.data?.migrations.length ?? 0} label="DB migrations applied" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* PANEL 1: platform health / deploy */}
        <section className="card p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-1">
            <Server className="w-5 h-5 text-gray-500" /> Platform health &amp; deploy
          </h2>
          <p className="text-sm text-gray-500 mb-4">Applied DB migrations (live ledger) + edge-function inventory.</p>

          <div className="text-xs uppercase tracking-wide text-gray-400 mb-2">Applied migrations</div>
          {deploy.isLoading ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : deploy.data?.error ? (
            <p className="text-sm text-red-500">Could not read migrations ledger: {deploy.data.error}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {deploy.data?.migrations.map((m) => (
                <span key={m.version} title={m.name} className="font-mono text-xs bg-gray-100 text-gray-700 rounded px-2 py-1 border border-gray-200">
                  {m.version} {m.name ? <span className="text-gray-400">· {m.name}</span> : null}
                </span>
              ))}
              {deploy.data?.migrations.length === 0 && <span className="text-sm text-gray-400">none reported</span>}
            </div>
          )}

          <div className="text-xs uppercase tracking-wide text-gray-400 mb-2">Edge functions ({EDGE_FUNCTIONS.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {EDGE_FUNCTIONS.map((f) => (
              <span key={f} className="font-mono text-xs bg-gray-50 text-gray-600 rounded px-2 py-1 border border-gray-200">{f}</span>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Function names from repo manifest. Per-function deploy <em>versions</em> are not available client-side
            (would require a secret) and are intentionally omitted.
          </p>
        </section>

        {/* PANEL 4: known open items / blockers */}
        <section className="card p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-1">
            <AlertTriangle className="w-5 h-5 text-orange-500" /> Known open items &amp; blockers
          </h2>
          <p className="text-sm text-gray-500 mb-4">Editorial rows from <span className="font-mono">program_items</span> — update is a row write, not a redeploy.</p>
          {items.isLoading ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : itemRows.length === 0 ? (
            <p className="text-sm text-gray-400">No items.</p>
          ) : (
            <ul className="space-y-3">
              {itemRows.map((i) => (
                <li key={i.id} className="flex gap-3">
                  <div className="mt-0.5">{itemStatusIcon[i.status]}</div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-sm font-medium ${i.status === 'done' ? 'line-through text-gray-400' : 'text-gray-900'}`}>{i.title}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${sevBadge[i.severity]}`}>{i.severity.toUpperCase()}</span>
                    </div>
                    {i.note && <p className="text-xs text-gray-500 mt-0.5">{i.note}</p>}
                    <p className="text-[11px] text-gray-300 mt-0.5 flex items-center gap-1"><Clock className="w-3 h-3" /> {fmt(i.updated_at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* PANEL 2: conversation quality */}
        <section className="card p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-1">
            <ShieldCheck className="w-5 h-5 text-green-600" /> Conversation quality
          </h2>
          <p className="text-sm text-gray-500 mb-4">Live rollup of <span className="font-mono">conversation_evals</span> (judge output).</p>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <Stat n={clean} label="Clean" />
            <Stat n={flagged} label="Flagged" tone={flagged > 0 ? 'warn' : 'ok'} />
            <Stat n={errored} label="Errored" />
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500 border-t border-gray-100 pt-3 mb-3">
            <span>High-conf flags: <b className="text-gray-800">{highConf}</b></span>
            <span>Low-conf: <b className="text-gray-800">{lowConf}</b></span>
            <span>Last sweep: <b className="text-gray-800">{fmt(lastSweep)}</b></span>
            <span>Spend: <b className="text-gray-800">${(sweepSpend / 100).toFixed(2)}</b></span>
          </div>

          <div className="text-xs uppercase tracking-wide text-gray-400 mb-2">Worst-first (high-confidence)</div>
          {evals.isLoading ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : worstFlags.length === 0 ? (
            <p className="text-sm text-gray-400">No high-confidence flags. 🎉</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {worstFlags.map((r) => (
                <li key={r.id} className="py-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {r.max_severity && <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${sevBadge[r.max_severity]}`}>{r.max_severity.toUpperCase()}</span>}
                    <span className="text-sm text-gray-700 truncate">{tenantName(r.tenant_id)} — {r.flags.map((f) => f.check).join(', ') || '—'}</span>
                  </div>
                  <Link to={`/conversations/${r.conversation_id}`} className="btn-secondary text-xs py-1 flex-shrink-0">Transcript</Link>
                </li>
              ))}
            </ul>
          )}
          <Link to="/conversation-quality" className="inline-block text-sm text-brand-600 hover:underline mt-3">View full conversation quality →</Link>
        </section>

        {/* PANEL 3: onboarding / tenant state */}
        <section className="card p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-1">
            <Store className="w-5 h-5 text-brand-600" /> Onboarding &amp; tenant state
          </h2>
          <p className="text-sm text-gray-500 mb-4">Aggregate over <span className="font-mono">shops</span> + <span className="font-mono">tenants</span> (RLS-scoped admin view).</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <Stat n={shopRows.length} label="Shops" />
            <Stat n={liveShops} label="Live (done)" tone="ok" />
            <Stat n={pausedShops} label="Paused" tone={pausedShops > 0 ? 'warn' : 'ok'} />
            <Stat n={tenants.data?.length ?? 0} label="Tenants" />
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500 border-t border-gray-100 pt-3 mb-4">
            <span>Subscription active: <b className="text-gray-800">{subActive}</b></span>
            <span>Stripe Connect enabled: <b className="text-gray-800">{connectEnabled}</b></span>
          </div>
          <div className="text-xs uppercase tracking-wide text-gray-400 mb-2">By onboarding step</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(byStep).sort((a, b) => b[1] - a[1]).map(([step, n]) => (
              <span key={step} className="text-xs bg-gray-50 text-gray-700 rounded px-2 py-1 border border-gray-200">
                {step} <b className="ml-1">{n}</b>
              </span>
            ))}
            {shopRows.length === 0 && <span className="text-sm text-gray-400">no shops</span>}
          </div>
          <Link to="/shops" className="inline-block text-sm text-brand-600 hover:underline mt-3">View shops →</Link>
        </section>
      </div>

      <p className="text-xs text-gray-300 mt-8 flex items-center gap-1">
        <RefreshCw className="w-3 h-3" /> Data fetched live on load. No secret keys are present in this page or the client bundle.
      </p>
    </div>
  )
}

// ── small presentational helpers ─────────────────────────────────────────────
function Ring({ pct }: { pct: number }) {
  const C = 2 * Math.PI * 42 // r=42
  const offset = C - (C * pct) / 100
  return (
    <div className="relative flex-shrink-0 w-32 h-32">
      <svg width="128" height="128" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="8" />
        <circle
          cx="50" cy="50" r="42" fill="none" stroke="url(#ccog)" strokeWidth="8" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={offset} transform="rotate(-90 50 50)"
        />
        <defs>
          <linearGradient id="ccog" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#E8521A" /><stop offset="1" stopColor="#FF6B35" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold">{pct}%</span>
        <span className="text-[10px] text-gray-300 uppercase tracking-wide">Overall build</span>
      </div>
    </div>
  )
}

function SecHead({ eyebrow, title, hint }: { eyebrow: string; title: string; hint: string }) {
  return (
    <div className="flex items-end justify-between mb-3">
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-400">{eyebrow}</div>
        <h2 className="text-xl font-bold text-gray-900">{title}</h2>
      </div>
      <div className="text-xs text-gray-400 hidden sm:block">{hint}</div>
    </div>
  )
}

function Vital({ icon, n, label, tone }: { icon: React.ReactNode; n: number; label: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-orange-500' : 'text-gray-900'
  return (
    <div className="card p-4 flex items-center gap-3">
      {icon}
      <div>
        <div className={`text-2xl font-bold ${color}`}>{n}</div>
        <div className="text-xs text-gray-500">{label}</div>
      </div>
    </div>
  )
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: 'ok' | 'warn' }) {
  const color = tone === 'warn' ? 'text-orange-500' : 'text-gray-900'
  return (
    <div className="rounded-lg bg-gray-50 border border-gray-100 p-3 text-center">
      <div className={`text-xl font-bold ${color}`}>{n}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  )
}
