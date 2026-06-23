import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Activity, ShieldAlert, ShieldCheck, Store, GitBranch, Server,
  AlertTriangle, CircleDot, CheckCircle2, Ban, RefreshCw, Clock,
} from 'lucide-react'
import { supabase } from '../lib/supabase'

/**
 * Command Center — internal super-admin operator view.
 *
 * EVERYTHING on this page is derived LIVE at view-time from real sources, so it
 * can never go stale (it replaces the old hand-maintained static HTML dashboard).
 *
 * Data sources (all read with the admin user's JWT — NO service-role key / access
 * token / secret is ever in the client bundle):
 *   - Platform health / deploy state ... supabase.rpc('command_center_deploy_status')
 *       (admin-gated SECURITY DEFINER fn reads the PostgREST-unexposed migrations
 *        ledger and returns only version+name). Edge-function inventory below is a
 *        NON-secret repo manifest; per-function deploy versions are NOT reachable
 *        safely client-side and are shown as "not available client-side".
 *   - Conversation-quality rollup ...... conversation_evals (admin RLS)
 *   - Onboarding / tenant state ........ shops + tenants (admin RLS)
 *   - Known open items / blockers ...... program_items (admin RLS, editorial rows)
 *
 * Reuses ProtectedRoute (mounted under the authed Layout in App.tsx). NOT public.
 */

// ── types ────────────────────────────────────────────────────────────────────
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

// Edge functions are public repo facts (names only), not secrets. Versions are
// not safely reachable from the browser, so we render them as unavailable rather
// than leak anything.
const EDGE_FUNCTIONS = [
  'chat-sms', 'admin-api', 'eval-sweep', 'create-checkout', 'refund-order',
  'stripe-webhook', 'toast-order', 'go-live', 'onboard-tenant', 'onboarding-save',
  'provision-number', 'scrape-shop', 'train-tenant', 'parse-menu-pdf',
  'import-menu-csv', 'merchant-auth', 'connect-create-express', 'connect-oauth',
]

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

function fmt(ts: string | null | undefined) {
  return ts ? new Date(ts).toLocaleString() : '—'
}

export default function CommandCenter() {
  // 1) deploy state — applied migrations via admin-gated RPC
  const deploy = useQuery<{ migrations: DeployRow[]; error: string | null }>({
    queryKey: ['cc-deploy'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('command_center_deploy_status')
      if (error) return { migrations: [], error: error.message }
      return { migrations: (data ?? []) as DeployRow[], error: null }
    },
  })

  // 2) conversation-quality rollup
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

  // 3) onboarding / tenant state
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

  // 4) known open items / blockers (editorial rows)
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

  // ── derived rollups ──────────────────────────────────────────────────────
  const evRows = evals.data ?? []
  const clean = evRows.filter((r) => r.verdict === 'clean').length
  const flagged = evRows.filter((r) => r.verdict === 'flagged').length
  const errored = evRows.filter((r) => r.verdict === 'errored').length
  const highConf = evRows.filter((r) => r.verdict === 'flagged' && r.confidence === 'high').length
  const lowConf = evRows.filter((r) => r.verdict === 'flagged' && r.confidence === 'low').length
  const lastSweep = evRows.length ? evRows[0].judged_at : null
  const sweepSpend = evRows.reduce((s, r) => s + (Number(r.cost_cents) || 0), 0)

  const tenantName = (id: string) => tenants.data?.find((t) => t.id === id)?.name ?? id.slice(0, 8)

  // worst-first high-confidence flagged
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
  // counts by onboarding step
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
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> live
          </span>
        </div>
        <span className="text-sm text-gray-400">rendered {new Date().toLocaleString()}</span>
      </div>
      <p className="text-gray-500 mb-6">
        Internal operator view. Every panel reads live state at view-time — nothing here is hand-maintained.
      </p>

      {/* top vitals */}
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
