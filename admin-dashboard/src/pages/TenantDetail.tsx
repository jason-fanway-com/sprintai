import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, RefreshCw, Trash2, Plus, Save, Globe, Phone } from 'lucide-react'
import { adminFetch } from '../lib/supabase'

interface Tenant {
  id: string
  name: string
  slug: string
  phone_number: string | null
  website_url: string | null
  plan: string
  status: string
  onboarding_status: string
  config: Record<string, string>
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  created_at: string
  integrations: Integration[]
}

interface Integration {
  id: string
  type: string
  status: string
}

interface KBEntry {
  id: string
  content: string
  source: string
  metadata: Record<string, unknown>
  created_at: string
}

interface TenantStats {
  total_conversations: number
  total_messages: number
  total_orders: number
  knowledge_base_entries: number
  messages_last_7_days: number
}

export default function TenantDetail() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<'overview' | 'knowledge' | 'config'>('overview')
  const [newContent, setNewContent] = useState('')
  const [isAddingKB, setIsAddingKB] = useState(false)

  const { data: tenant, isLoading: tenantLoading } = useQuery<Tenant>({
    queryKey: ['tenant', id],
    queryFn: () => adminFetch<Tenant>(`/tenants/${id}`),
  })

  const { data: stats } = useQuery<TenantStats>({
    queryKey: ['tenant-stats', id],
    queryFn: () => adminFetch<TenantStats>(`/tenants/${id}/stats`),
  })

  const { data: kbData } = useQuery<{ entries: KBEntry[] }>({
    queryKey: ['knowledge-base', id],
    queryFn: () => adminFetch<{ entries: KBEntry[] }>(`/tenants/${id}/knowledge-base`),
    enabled: activeTab === 'knowledge',
  })

  const rescrape = useMutation({
    mutationFn: () => adminFetch(`/tenants/${id}/rescrape`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tenant', id] }),
  })

  const addKB = useMutation({
    mutationFn: (content: string) =>
      adminFetch(`/tenants/${id}/knowledge-base`, {
        method: 'POST',
        body: JSON.stringify({ content, source: 'manual' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-base', id] })
      setNewContent('')
      setIsAddingKB(false)
    },
  })

  const deleteKB = useMutation({
    mutationFn: (entryId: string) => adminFetch(`/knowledge-base/${entryId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['knowledge-base', id] }),
  })

  const [configEdits, setConfigEdits] = useState<Record<string, string>>({})
  const saveConfig = useMutation({
    mutationFn: () => adminFetch(`/tenants/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ config: { ...tenant?.config, ...configEdits } }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tenant', id] }),
  })

  if (tenantLoading) {
    return <div className="p-8 animate-pulse"><div className="h-8 bg-gray-200 rounded w-64" /></div>
  }

  if (!tenant) {
    return <div className="p-8 text-red-600">Tenant not found</div>
  }

  const tabs = ['overview', 'knowledge', 'config'] as const

  return (
    <div className="p-8">
      {/* Back + Header */}
      <div className="flex items-center gap-4 mb-6">
        <Link to="/tenants" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900">{tenant.name}</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium badge-${tenant.status}`}>
              {tenant.status}
            </span>
            <span className="text-sm text-gray-500">{tenant.plan} plan</span>
            {tenant.phone_number && (
              <span className="flex items-center gap-1 text-sm text-gray-500 font-mono">
                <Phone className="w-3 h-3" />
                {tenant.phone_number}
              </span>
            )}
            {tenant.website_url && (
              <a href={tenant.website_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-brand-600 hover:underline">
                <Globe className="w-3 h-3" />
                Website
              </a>
            )}
          </div>
        </div>
        {tenant.website_url && (
          <button
            onClick={() => rescrape.mutate()}
            disabled={rescrape.isPending}
            className="btn-secondary"
          >
            <RefreshCw className={`w-4 h-4 ${rescrape.isPending ? 'animate-spin' : ''}`} />
            Re-scrape Website
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        {[
          { label: 'Conversations', value: stats?.total_conversations ?? 0 },
          { label: 'Messages', value: stats?.total_messages ?? 0 },
          { label: 'Messages/7d', value: stats?.messages_last_7_days ?? 0 },
          { label: 'Orders', value: stats?.total_orders ?? 0 },
          { label: 'KB Entries', value: stats?.knowledge_base_entries ?? 0 },
        ].map(({ label, value }) => (
          <div key={label} className="card p-4 text-center">
            <p className="text-2xl font-bold text-gray-900">{value}</p>
            <p className="text-xs text-gray-500 mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium capitalize -mb-px border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab === 'knowledge' ? 'Knowledge Base' : tab}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="card p-6">
            <h3 className="font-semibold text-gray-900 mb-4">Tenant Details</h3>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Tenant ID</dt>
                <dd className="font-mono text-xs text-gray-700">{tenant.id.substring(0, 8)}...</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Slug</dt>
                <dd className="text-gray-700">{tenant.slug}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Onboarding</dt>
                <dd className="text-gray-700">{tenant.onboarding_status}</dd>
              </div>
              {tenant.stripe_customer_id && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">Stripe Customer</dt>
                  <dd>
                    <a
                      href={`https://dashboard.stripe.com/customers/${tenant.stripe_customer_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-600 hover:underline text-xs font-mono"
                    >
                      {tenant.stripe_customer_id}
                    </a>
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-gray-500">Created</dt>
                <dd className="text-gray-700">{new Date(tenant.created_at).toLocaleDateString()}</dd>
              </div>
            </dl>
          </div>

          <div className="card p-6">
            <h3 className="font-semibold text-gray-900 mb-4">Integrations</h3>
            {tenant.integrations?.length > 0 ? (
              <div className="space-y-3">
                {tenant.integrations.map((integ) => (
                  <div key={integ.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                    <span className="text-sm font-medium capitalize">{integ.type}</span>
                    <span className={`badge-${integ.status}`}>{integ.status}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">No integrations configured</p>
            )}
          </div>
        </div>
      )}

      {/* Knowledge Base Tab */}
      {activeTab === 'knowledge' && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">Knowledge Base Entries</h3>
            <button onClick={() => setIsAddingKB(true)} className="btn-primary">
              <Plus className="w-4 h-4" />
              Add Entry
            </button>
          </div>

          {isAddingKB && (
            <div className="p-4 border-b border-gray-200 bg-blue-50">
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                className="input w-full h-24 resize-none"
                placeholder="Enter knowledge base content..."
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => addKB.mutate(newContent)}
                  disabled={!newContent || addKB.isPending}
                  className="btn-primary"
                >
                  {addKB.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save
                </button>
                <button onClick={() => setIsAddingKB(false)} className="btn-secondary">
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="divide-y divide-gray-100">
            {kbData?.entries.map((entry) => (
              <div key={entry.id} className="p-4 flex gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700 whitespace-pre-wrap line-clamp-3">{entry.content}</p>
                  <div className="flex gap-3 mt-2">
                    <span className="text-xs text-gray-400 capitalize">{entry.source}</span>
                    <span className="text-xs text-gray-400">{new Date(entry.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <button
                  onClick={() => deleteKB.mutate(entry.id)}
                  className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Config Tab */}
      {activeTab === 'config' && (
        <div className="card p-6">
          <h3 className="font-semibold text-gray-900 mb-4">Business Configuration</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(['business_type', 'address', 'hours', 'phone', 'email', 'personality', 'greeting'] as const).map((field) => (
              <div key={field}>
                <label className="block text-sm font-medium text-gray-700 mb-1 capitalize">
                  {field.replace(/_/g, ' ')}
                </label>
                <input
                  type="text"
                  defaultValue={(tenant.config as Record<string, string>)[field] ?? ''}
                  onChange={(e) => setConfigEdits((prev) => ({ ...prev, [field]: e.target.value }))}
                  className="input"
                  placeholder={`Enter ${field.replace(/_/g, ' ')}...`}
                />
              </div>
            ))}
          </div>
          <div className="mt-6">
            <button
              onClick={() => saveConfig.mutate()}
              disabled={saveConfig.isPending || Object.keys(configEdits).length === 0}
              className="btn-primary disabled:opacity-50"
            >
              {saveConfig.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Configuration
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
