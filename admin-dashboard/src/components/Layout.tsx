import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { LayoutDashboard, Users, MessageSquare, LogOut, Zap, Store, ShieldCheck, Activity, AlertTriangle, FlaskConical, Menu, X } from 'lucide-react'
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { UserRoleInfo } from '../lib/roles'
import { useRole } from '../lib/RoleContext'
import { useView } from '../lib/ViewContext'

interface LayoutProps {
  user: User | null
  role: UserRoleInfo
}

// Full nav for super-admins
const superAdminNav = [
  { to: '/command-center', label: 'Command Center', icon: Activity },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/shops', label: 'Shops', icon: Store },
  { to: '/tenants', label: 'Tenants', icon: Users },
  { to: '/conversations', label: 'Conversations', icon: MessageSquare },
  { to: '/conversation-quality', label: 'Conv Quality', icon: ShieldCheck },
  { to: '/test-suite', label: 'Test Suite', icon: FlaskConical },
  { to: '/issues', label: 'Issues', icon: AlertTriangle },
  { to: '/shop-chats', label: 'Shop Chats', icon: MessageSquare },
]

// Bottom nav for super-admins (mobile)
const superAdminBottomNav = [
  { to: '/command-center', label: 'Commands', icon: Activity },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/shops', label: 'Shops', icon: Store },
  { to: '/conversations', label: 'Chats', icon: MessageSquare },
  { to: '/tenants', label: 'Tenants', icon: Users },
]

export default function Layout({ user, role: _role }: LayoutProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { isSuperAdmin } = useRole()
  const { mode, previewTenantId, setMode, setPreview } = useView()

  // Shop list for the owner-preview picker (super-admin only; RLS lets admins see all).
  const { data: allShops } = useQuery<{ id: string; name: string; tenant_id: string }[]>({
    queryKey: ['all-shops-for-preview'],
    queryFn: async () => {
      const { data, error } = await supabase.from('shops').select('id, name, tenant_id').order('name')
      if (error) throw error
      return data ?? []
    },
    enabled: isSuperAdmin,
  })

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    navigate('/login')
  }

  // Shop owners get a minimal nav (no tenant switcher, no command center, etc.)
  // Their main nav is on the ShopOwnerDashboard tile cards.
  const sidebarNav = isSuperAdmin ? superAdminNav : []
  const bottomNav = isSuperAdmin ? superAdminBottomNav : []

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* ---- MOBILE HEADER (lg:hidden) ---- */}
      <header className="lg:hidden flex items-center justify-between px-4 py-3 bg-gray-900 text-white safe-area-top flex-shrink-0 z-30">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-brand-500" />
          <span className="font-bold">SprintAI</span>
          <span className="text-xs text-gray-400">Admin</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Mobile user avatar */}
          <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center text-sm font-medium">
            {user?.email?.[0]?.toUpperCase() ?? 'A'}
          </div>
          {isSuperAdmin && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 -mr-1 text-gray-300 hover:text-white"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
          )}
        </div>
      </header>

      {/* ---- MOBILE SLIDEOVER SIDEBAR (lg:hidden) — super-admin only ---- */}
      {sidebarOpen && isSuperAdmin && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setSidebarOpen(false)}
          />
          {/* Drawer */}
          <aside className="relative w-64 bg-gray-900 text-white flex flex-col animate-slide-in-left">
            <div className="p-4 border-b border-gray-700 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="w-5 h-5 text-brand-500" />
                <span className="font-bold">SprintAI</span>
              </div>
              <button
                onClick={() => setSidebarOpen(false)}
                className="p-1 text-gray-400 hover:text-white"
                aria-label="Close menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {sidebarNav.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-brand-600 text-white'
                        : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                    }`
                  }
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {label}
                </NavLink>
              ))}
            </nav>
            <div className="p-4 border-t border-gray-700">
              <p className="text-sm text-gray-300 truncate mb-2">{user?.email}</p>
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Sign out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* ---- DESKTOP SIDEBAR (hidden on mobile) — super-admin only ---- */}
      {isSuperAdmin && (
        <aside className="hidden lg:flex w-64 bg-gray-900 text-white flex-col flex-shrink-0">
          {/* Logo */}
          <div className="p-6 border-b border-gray-700">
            <div className="flex items-center gap-2">
              <Zap className="w-6 h-6 text-brand-500" />
              <span className="font-bold text-lg">SprintAI</span>
              <span className="text-xs text-gray-400 ml-1">Admin</span>
            </div>
          </div>

          {/* Nav */}
          <nav className="flex-1 p-4 space-y-1">
            {sidebarNav.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-brand-600 text-white'
                      : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                  }`
                }
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
              </NavLink>
            ))}
          </nav>

          {/* User */}
          <div className="p-4 border-t border-gray-700">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center text-sm font-medium">
                {user?.email?.[0]?.toUpperCase() ?? 'A'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{user?.email}</p>
                <p className="text-xs text-gray-400">Admin</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        </aside>
      )}

      {/* ---- MAIN CONTENT ---- */}
      <main className="flex-1 overflow-auto min-h-0 pb-16 lg:pb-0">
        {/* Super-admin: live Admin ⇄ Owner view toggle (no re-login) */}
        {isSuperAdmin && (
          <div className="flex items-center justify-end gap-2 px-4 py-2 border-b border-gray-100 bg-white sticky top-0 z-20">
            <span className="text-xs text-gray-400">View as:</span>
            <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
              <button
                onClick={() => { setMode('admin'); navigate('/dashboard') }}
                className={mode === 'admin' ? 'bg-brand-600 text-white px-3 py-1' : 'px-3 py-1 text-gray-600 hover:bg-gray-50'}
              >Admin</button>
              <button
                onClick={() => { setMode('owner'); navigate('/shop-owner') }}
                className={mode === 'owner' ? 'bg-brand-600 text-white px-3 py-1' : 'px-3 py-1 text-gray-600 hover:bg-gray-50'}
              >Shop Owner</button>
            </div>
            {mode === 'owner' && (
              <select
                value={previewTenantId ?? ''}
                onChange={(e) => {
                  const s = allShops?.find((x) => x.tenant_id === e.target.value)
                  setPreview(e.target.value || null, s?.name ?? null)
                  navigate('/shop-owner')
                }}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white"
              >
                <option value="">Select a shop…</option>
                {allShops?.map((s) => (
                  <option key={s.id} value={s.tenant_id}>{s.name}</option>
                ))}
              </select>
            )}
          </div>
        )}
        <Outlet />
      </main>

      {/* ---- MOBILE BOTTOM NAV (lg:hidden) — super-admin only ---- */}
      {isSuperAdmin && bottomNav.length > 0 && (
        <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex items-center justify-around safe-area-bottom z-40">
          {bottomNav.map(({ to, label, icon: Icon }) => {
            const isActive = location.pathname === to || location.pathname.startsWith(to + '/')
            return (
              <NavLink
                key={to}
                to={to}
                className={`bottom-nav-item flex-1 ${
                  isActive
                    ? 'text-brand-600'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                <Icon className="w-5 h-5 flex-shrink-0" />
                <span className="text-[10px] leading-tight">{label}</span>
              </NavLink>
            )
          })}
        </nav>
      )}
    </div>
  )
}