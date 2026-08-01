import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { LayoutDashboard, Users, MessageSquare, LogOut, Zap, Store, ShieldCheck, Activity, Menu, X } from 'lucide-react'
import { useState, useEffect } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

interface LayoutProps {
  user: User | null
}

const sidebarNav = [
  { to: '/command-center', label: 'Command Center', icon: Activity },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/shops', label: 'Shops', icon: Store },
  { to: '/tenants', label: 'Tenants', icon: Users },
  { to: '/conversations', label: 'Conversations', icon: MessageSquare },
  { to: '/conversation-quality', label: 'Conv Quality', icon: ShieldCheck },
]

// Bottom nav: 5 key items for mobile
const bottomNav = [
  { to: '/command-center', label: 'Commands', icon: Activity },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/shops', label: 'Shops', icon: Store },
  { to: '/conversations', label: 'Chats', icon: MessageSquare },
  { to: '/tenants', label: 'Tenants', icon: Users },
]

export default function Layout({ user }: LayoutProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    navigate('/login')
  }

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
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 -mr-1 text-gray-300 hover:text-white"
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* ---- MOBILE SLIDEOVER SIDEBAR (lg:hidden) ---- */}
      {sidebarOpen && (
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

      {/* ---- DESKTOP SIDEBAR (hidden on mobile) ---- */}
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

      {/* ---- MAIN CONTENT ---- */}
      <main className="flex-1 overflow-auto min-h-0 pb-16 lg:pb-0">
        <Outlet />
      </main>

      {/* ---- MOBILE BOTTOM NAV (lg:hidden) ---- */}
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
    </div>
  )
}