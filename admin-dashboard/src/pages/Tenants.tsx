import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Plus, Search, RefreshCw, ExternalLink } from 'lucide-react'
import { adminFetch } from '../lib/supabase'

interface Tenant {
  id: string
  name: string
  slug: string
  phone_number: string | null
  website_url: string | null
  plan: 'starter' | 'pro' | 'enterprise'
  status: 'active' | 'paused' | 'cancelled' | 'onboarding'
  onboarding_status: string
  created_at: string
}

interface TenantsResponse {
  tenants: Tenant[]
  total: number
}

const STATUS_BADGE: Record<string, string> = {
  active: 'badge-active',
  paused: 'badge-paused',
  cancelled: 'badge-cancelled',
  onboarding: 'badge-onboarding',
}

const PLAN_COLORS: Record<string, string> = {
  starter: 'bg-gray-100 text-gray-700',
  pro: 'bg-blue-100 text-blue-700',
  enterprise: 'bg-purple-100 text-purple-700',
}

export default function Tenants() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery<TenantsResponse>({
    queryKey: ['tenants', search, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (statusFilter) params.set('status', statusFilter)
      return adminFetch<TenantsResponse>(`/tenants?${params}`)
    },
  })

  const [showAddModal, setShowAddModal] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newPlan, setNewPlan] = useState('starter')

  const createMutation = useMutation({
    mutationFn: (body: Record<string, string>) => adminFetch('/tenants', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenants'] })
      setShowAddModal(false)
      setNewName('')
      setNewUrl('')
    },
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tenants</h1>
          <p className="text-gray-500 mt-1">{data?.total ?? 0} total customers</p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="btn-primary">
          <Plus className="w-4 h-4" />
          Add Tenant
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tenants..."
            className="input pl-9"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="input w-40"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="onboarding">Onboarding</option>
          <option value="paused">Paused</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-6 py-3 font-medium text-gray-500">Business</th>
              <th className="text-left px-6 py-3 font-medium text-gray-500">Plan</th>
              <th className="text-left px-6 py-3 font-medium text-gray-500">Status</th>
              <th className="text-left px-6 py-3 font-medium text-gray-500">Phone</th>
              <th className="text-left px-6 py-3 font-medium text-gray-500">Joined</th>
              <th className="px-6 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              [...Array(5)].map((_, i) => (
                <tr key={i}>
                  <td colSpan={6} className="px-6 py-4">
                    <div className="h-4 bg-gray-100 rounded animate-pulse" />
                  </td>
                </tr>
              ))
            ) : data?.tenants.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-gray-400">
                  No tenants found
                </td>
              </tr>
            ) : (
              data?.tenants.map((tenant) => (
                <tr key={tenant.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4">
                    <div>
                      <Link
                        to={`/tenants/${tenant.id}`}
                        className="font-medium text-gray-900 hover:text-brand-600"
                      >
                        {tenant.name}
                      </Link>
                      {tenant.website_url && (
                        <a
                          href={tenant.website_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs text-gray-400 hover:text-brand-600 mt-0.5"
                        >
                          <ExternalLink className="w-3 h-3" />
                          {tenant.website_url.replace(/^https?:\/\//, '')}
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${PLAN_COLORS[tenant.plan] ?? ''}`}>
                      {tenant.plan}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={STATUS_BADGE[tenant.status] ?? 'badge-active'}>
                      {tenant.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-500 font-mono text-xs">
                    {tenant.phone_number ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    {new Date(tenant.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link to={`/tenants/${tenant.id}`} className="btn-secondary text-xs py-1.5">
                      Manage
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Add Tenant Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold mb-4">Add Tenant</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                createMutation.mutate({ name: newName, website_url: newUrl, plan: newPlan })
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Business Name</label>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} className="input" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Website URL</label>
                <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} className="input" placeholder="https://" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Plan</label>
                <select value={newPlan} onChange={(e) => setNewPlan(e.target.value)} className="input">
                  <option value="starter">Starter ($99/mo)</option>
                  <option value="pro">Pro ($247/mo)</option>
                  <option value="enterprise">Enterprise ($497/mo)</option>
                </select>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" className="btn-primary flex-1 justify-center" disabled={createMutation.isPending}>
                  {createMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : 'Create Tenant'}
                </button>
                <button type="button" onClick={() => setShowAddModal(false)} className="btn-secondary">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
