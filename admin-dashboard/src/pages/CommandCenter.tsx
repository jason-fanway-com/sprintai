import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Activity, ShieldAlert, ShieldCheck, Store, GitBranch, Server,
  AlertTriangle, RefreshCw, Hammer, GitCommit, FlaskConical, UserCheck,
} from 'lucide-react'
import { supabase } from '../lib/supabase'

/**
 * Command Center — internal super-admin operator view.
 *
 * Every tile reads from a source that cannot drift (Jason, 2026-09-05). The
 * browser cannot read the repo or run git, so `scripts/publish-build-status.sh`
 * (launchd every 5 min + a git post-commit hook) derives build/ship state from
 * docs/specs/2026-09-03-READINESS.md, `git log`, and the Supabase Management
 * API, and writes it to build_status_items / _commits / _functions / _meta.
 * This page reads those tables back — nothing here is hand-typed, and there is
 * no "illustrative" content. If a number cannot be derived from real data, it
 * does not get a tile.
 *
 * Freshness guard: every publisher-sourced tile (Build progress, Shipped
 * today, Blocked on Jason) checks build_status_meta. If generated_at is more
 * than 15 minutes old, or publisher_ok is false, the tile renders a "not
 * updating" banner INSTEAD of numbers — a dashboard that silently shows stale
 * data is the thing this page replaced.
 *
 * All reads use the admin user's JWT via the existing `supabase` client. NO
 * service-role key / access token / secret is ever in the client bundle —
 * writes to build_status_* happen only from the publisher script's service
 * role, never from the browser. Reuses ProtectedRoute (mounted under the
 * authed Layout in App.tsx). NOT public.
 */

const FRESHNESS_LIMIT_MS = 15 * 60 * 1000

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

interface ShopRow {
  id: string
  name: string
  onboarding_step: string | null
  subscription_status: string | null
  connect_status: string | null
  is_paused: boolean
}

interface TenantRow { id: string; name: string; status: string | null }

// ── build_status_* types (publisher-derived, never hand-typed) ─────────────
interface BuildStatusItem {
  item: string
  what: string
  status: string
  blockers: string | null
  blocked_on_jason: boolean
  sort_order: number
}
interface BuildStatusCommit {
  sha: string
  subject: string
  committed_at: string
  author: string
}
interface BuildStatusMeta {
  generated_at: string
  head_sha: string | null
  readiness_mtime: string | null
  publisher_ok: boolean
  publisher_error: string | null
}
interface TestTranscriptRow {
  id: string
  tester_name: string | null
  reporter_note: string | null
  shop_name: string
  created_at: string
}

const SEV_RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 }
const sevBadge: Record<Severity, string> = {
  critical: 'bg-red-100 text-red-700 border border-red-200',
  major: 'bg-orange-100 text-orange-700 border border-orange-200',
  minor: 'bg-yellow-100 text-yellow-700 border border-yellow-200',
}
const statusBadge: Record<string, string> = {
  building: 'bg-blue-100 text-blue-700 border border-blue-200',
  'in verification': 'bg-purple-100 text-purple-700 border border-purple-200',
  'not started': 'bg-gray-100 text-gray-500 border border-gray-200',
  built: 'bg-green-100 text-green-700 border border-green-200',
  other: 'bg-gray-100 text-gray-600 border border-gray-200',
}

function fmt(ts: string | null | undefined) {
  return ts ? new Date(ts).toLocaleString() : '—'
}
function fmtET(ts: string | null | undefined) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) + ' ET'
}

type StatusGroup = 'building' | 'in verification' | 'not started' | 'built' | 'other'
const GROUP_ORDER: StatusGroup[] = ['building', 'in verification', 'not started', 'built', 'other']
function classifyStatus(status: string): StatusGroup {
  const s = status.toLowerCase()
  if (s.startsWith('building')) return 'building'
  if (s.startsWith('in verification')) return 'in verification'
  if (s.startsWith('not started')) return 'not started'
  if (s.startsWith('built')) return 'built'
  return 'other'
}

export default function CommandCenter() {
  // ── publisher-derived sources (build_status_*, admin-RLS) ──────────────────
  const buildItems = useQuery<BuildStatusItem[]>({
    queryKey: ['cc-build-items'],
    queryFn: async () => {
      const { data } = await supabase
        .from('build_status_items')
        .select('item, what, status, blockers, blocked_on_jason, sort_order')
        .order('sort_order', { ascending: true })
      return (data ?? []) as BuildStatusItem[]
    },
    refetchInterval: 60_000,
  })
  const buildCommits = useQuery<BuildStatusCommit[]>({
    queryKey: ['cc-build-commits'],
    queryFn: async () => {
      const { data } = await supabase
        .from('build_status_commits')
        .select('sha, subject, committed_at, author')
        .order('committed_at', { ascending: false })
      return (data ?? []) as BuildStatusCommit[]
    },
    refetchInterval: 60_000,
  })
  const buildMeta = useQuery<BuildStatusMeta | null>({
    queryKey: ['cc-build-meta'],
    queryFn: async () => {
      const { data } = await supabase
        .from('build_status_meta')
        .select('generated_at, head_sha, readiness_mtime, publisher_ok, publisher_error')
        .maybeSingle()
      return (data ?? null) as BuildStatusMeta | null
    },
    refetchInterval: 60_000,
  })

  // ── Test Kitchen — direct live query, not publisher-sourced ─────────────────
  const testKitchen = useQuery<TestTranscriptRow[]>({
    queryKey: ['cc-test-kitchen'],
    queryFn: async () => {
      const { data } = await supabase
        .from('test_transcripts')
        .select('id, tester_name, reporter_note, shop_name, created_at')
        .eq('source', 'public-tester')
        .order('created_at', { ascending: false })
        .limit(50)
      return (data ?? []) as TestTranscriptRow[]
    },
  })

  // ── the 4 kept operational panels (unchanged, already live) ────────────────
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
  // Today's order-ticket reliability: paid vs emailed
  const ticketReliability = useQuery<{ paid: number; emailed: number }>({
    queryKey: ['cc-ticket-reliability'],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10)
      const [{ count: paid }, { count: emailed }] = await Promise.all([
        supabase.from('order_carts').select('id', { count: 'exact', head: true })
          .eq('payment_status', 'paid')
          .gte('updated_at', today),
        supabase.from('order_carts').select('id', { count: 'exact', head: true })
          .eq('payment_status', 'paid')
          .gte('updated_at', today)
          .not('ticket_emailed_at', 'is', null),
      ])
      return { paid: (paid ?? 0) as number, emailed: (emailed ?? 0) as number }
    },
  })

  // ══ DERIVED — computed at view-time, never stored/typed ══════════════════
  const meta = buildMeta.data ?? null
  const metaAge = meta ? Date.now() - new Date(meta.generated_at).getTime() : Infinity
  const publisherFresh = !!meta && meta.publisher_ok && metaAge <= FRESHNESS_LIMIT_MS

  const items = buildItems.data ?? []
  const grouped = GROUP_ORDER.map((g) => ({ group: g, rows: items.filter((i) => classifyStatus(i.status) === g) }))
    .filter((g) => g.rows.length > 0)
  const blockedOnJason = items.filter((i) => i.blocked_on_jason)
  const commits = buildCommits.data ?? []

  const kitchenRows = testKitchen.data ?? []
  const distinctNamedTesters = new Set(kitchenRows.map((r) => r.tester_name).filter(Boolean)).size

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
  const ticketTile = (() => {
    const { paid = 0, emailed = 0 } = ticketReliability.data ?? {}
    return { paid, emailed, missing: paid - emailed }
  })()

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
        Every tile below reads from a source that cannot drift — nothing here is hand-maintained.
      </p>

      {/* top vitals — every value from a live table, none from build_status_* */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Vital icon={<ShieldAlert className="w-5 h-5 text-red-500" />} n={highConf} label="High-confidence flags" tone={highConf > 0 ? 'bad' : 'ok'} />
        <Vital icon={<Store className="w-5 h-5 text-brand-600" />} n={liveShops} label={`Live shops / ${shopRows.length} total`} />
        <Vital icon={<GitBranch className="w-5 h-5 text-gray-600" />} n={deploy.data?.migrations.length ?? 0} label="DB migrations applied" />
        <Vital
          icon={<AlertTriangle className={`w-5 h-5 ${ticketTile.missing > 0 ? 'text-orange-500' : 'text-gray-400'}`} />}
          n={ticketTile.missing}
          label={`Tickets undelivered today (${ticketTile.emailed}/${ticketTile.paid})`}
          tone={ticketTile.missing > 0 ? 'warn' : 'ok'}
        />
      </div>

      {/* ════════════════ 1) BUILD PROGRESS ════════════════ */}
      <section className="card p-6 mb-6">
        <TileHead icon={<Hammer className="w-5 h-5 text-gray-500" />} title="Build progress" meta={meta} fresh={publisherFresh} isLoading={buildItems.isLoading} />
        {!publisherFresh ? (
          <StaleBanner meta={meta} />
        ) : items.length === 0 ? (
          <p className="text-sm text-gray-400">No items on the readiness board.</p>
        ) : (
          <div className="space-y-4">
            {grouped.map(({ group, rows }) => {
              const body = (
                <ul className="space-y-2">
                  {rows.map((i) => (
                    <li key={i.item} className="flex items-start gap-3 text-sm">
                      <span className="font-mono text-xs text-gray-400 mt-0.5 w-4 flex-shrink-0">{i.item}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 ${statusBadge[classifyStatus(i.status)]}`}>{i.status}</span>
                      <span className="text-gray-700 min-w-0">{i.what}</span>
                    </li>
                  ))}
                </ul>
              )
              if (group === 'built') {
                return (
                  <details key={group}>
                    <summary className="text-xs uppercase tracking-wide text-gray-400 cursor-pointer select-none mb-2">
                      Built ({rows.length}) — click to expand
                    </summary>
                    {body}
                  </details>
                )
              }
              return (
                <div key={group}>
                  <div className="text-xs uppercase tracking-wide text-gray-400 mb-2">{group} ({rows.length})</div>
                  {body}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* ════════════════ 2) SHIPPED TODAY ════════════════ */}
        <section className="card p-6">
          <TileHead icon={<GitCommit className="w-5 h-5 text-gray-500" />} title="Shipped today" meta={meta} fresh={publisherFresh} isLoading={buildCommits.isLoading} />
          {!publisherFresh ? (
            <StaleBanner meta={meta} />
          ) : commits.length === 0 ? (
            <p className="text-sm text-gray-400">Nothing shipped yet today.</p>
          ) : (
            <ul className="space-y-2 max-h-96 overflow-y-auto">
              {commits.map((c) => (
                <li key={c.sha} className="text-sm flex items-start gap-2">
                  <span className="text-xs text-gray-400 flex-shrink-0 w-24">{fmtET(c.committed_at)}</span>
                  <span className="text-gray-700 min-w-0">{c.subject}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ════════════════ 3) TEST KITCHEN ACTIVITY (live, not publisher) ════════════════ */}
        <section className="card p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-1">
            <FlaskConical className="w-5 h-5 text-gray-500" /> Test Kitchen activity
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Live query on <span className="font-mono">test_transcripts</span> — {distinctNamedTesters} distinct named tester{distinctNamedTesters === 1 ? '' : 's'}.
          </p>
          {testKitchen.isLoading ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : kitchenRows.length === 0 ? (
            <p className="text-sm text-gray-400">No test kitchen activity yet.</p>
          ) : (
            <ul className="space-y-3 max-h-96 overflow-y-auto">
              {kitchenRows.map((r) => (
                <li key={r.id} className="text-sm border-b border-gray-50 pb-2 last:border-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-900">{r.tester_name || 'anonymous'}</span>
                    <span className="text-xs text-gray-400 flex-shrink-0">{fmtET(r.created_at)}</span>
                  </div>
                  <div className="text-xs text-gray-500">{r.shop_name}</div>
                  {r.reporter_note && <p className="text-xs text-gray-600 mt-1">"{r.reporter_note}"</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ════════════════ 4) BLOCKED ON JASON ════════════════ */}
      <section className="card p-6 mb-8">
        <TileHead icon={<UserCheck className="w-5 h-5 text-gray-500" />} title="Blocked on Jason" meta={meta} fresh={publisherFresh} isLoading={buildItems.isLoading} />
        {!publisherFresh ? (
          <StaleBanner meta={meta} />
        ) : blockedOnJason.length === 0 ? (
          <p className="text-sm text-gray-400">Nothing on the board names Jason as a blocker right now.</p>
        ) : (
          <ul className="space-y-3">
            {blockedOnJason.map((i) => (
              <li key={i.item} className="flex gap-3">
                <span className="font-mono text-xs text-gray-400 mt-0.5">{i.item}</span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900">{i.what}</div>
                  {i.blockers && <p className="text-xs text-gray-500 mt-0.5">{i.blockers}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ════════════════ LIVE OPERATIONAL PANELS (unchanged, already live) ════════════════ */}
      <div className="border-t border-gray-200 pt-8 mb-4">
        <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Live operations</div>
        <h2 className="text-lg font-bold text-gray-900 mb-1">Operational telemetry</h2>
        <p className="text-sm text-gray-500 mb-6">Real platform state read live at view-time.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* platform health / deploy */}
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
        </section>

        {/* conversation quality */}
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

        {/* onboarding / tenant state */}
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

        {/* ticket reliability detail */}
        <section className="card p-6">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-1">
            <AlertTriangle className="w-5 h-5 text-orange-500" /> Order-ticket reliability
          </h2>
          <p className="text-sm text-gray-500 mb-4">Today's paid orders vs. tickets actually emailed (<span className="font-mono">order_carts</span>).</p>
          <div className="grid grid-cols-3 gap-3">
            <Stat n={ticketTile.paid} label="Paid today" />
            <Stat n={ticketTile.emailed} label="Emailed" tone="ok" />
            <Stat n={ticketTile.missing} label="Undelivered" tone={ticketTile.missing > 0 ? 'warn' : 'ok'} />
          </div>
        </section>
      </div>

      <p className="text-xs text-gray-300 mt-8 flex items-center gap-1">
        <RefreshCw className="w-3 h-3" /> Data fetched live on load. No secret keys are present in this page or the client bundle.
      </p>
    </div>
  )
}

// ── small presentational helpers ─────────────────────────────────────────────
function TileHead({ icon, title, meta, fresh, isLoading }: {
  icon: React.ReactNode; title: string; meta: BuildStatusMeta | null; fresh: boolean; isLoading: boolean
}) {
  return (
    <div className="flex items-center justify-between mb-1">
      <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">{icon} {title}</h2>
      {!isLoading && meta && (
        <span className={`text-xs ${fresh ? 'text-gray-400' : 'text-red-500 font-medium'}`}>
          as of {fmtET(meta.generated_at)}
        </span>
      )}
    </div>
  )
}

function StaleBanner({ meta }: { meta: BuildStatusMeta | null }) {
  const lastRan = meta ? fmtET(meta.generated_at) : 'never'
  return (
    <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-700 flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <div>
        <p className="font-medium">Build status is not updating — publisher last ran at {lastRan}.</p>
        {meta?.publisher_error && <p className="text-xs text-red-500 mt-1 font-mono">{meta.publisher_error}</p>}
      </div>
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
