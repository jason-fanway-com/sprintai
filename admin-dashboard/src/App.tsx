import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Toaster } from 'react-hot-toast'
import { supabase } from './lib/supabase'
import { getUserRole, type UserRoleInfo } from './lib/roles'
import { RoleContext } from './lib/RoleContext'
import { ViewProvider } from './lib/ViewContext'
import type { User } from '@supabase/supabase-js'

import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Tenants from './pages/Tenants'
import TenantDetail from './pages/TenantDetail'
import Conversations from './pages/Conversations'
import ConversationDetail from './pages/ConversationDetail'
import Shops from './pages/Shops'
import ShopCreate from './pages/ShopCreate'
import ShopDetail from './pages/ShopDetail'
import ChatTest from './pages/ChatTest'
import ConversationQuality from './pages/ConversationQuality'
import CommandCenter from './pages/CommandCenter'
import ShopChatTranscripts from './pages/ShopChatTranscripts'
import ShopChatDetail from './pages/ShopChatDetail'
import Issues from './pages/Issues'
import IssueDetail from './pages/IssueDetail'
import ShopFinancialsPage from './pages/shop-financials/ShopFinancialsPage'
import ShopOwnerDashboard from './pages/ShopOwnerDashboard'
import TestSuite from './pages/TestSuite'
import FinancialReporting from './pages/FinancialReporting'
import ExpoScreen from './pages/ExpoScreen'

// ── route guards ────────────────────────────────────────────────────────────
// Every protected route uses one of these. Navigation links hiding is
// cosmetic; these are the enforcement point. A shop_owner typing a super-admin
// URL into the address bar must be redirected.

function SuperAdminRoute({ children, role }: { children: React.ReactNode; role: UserRoleInfo }) {
  if (role.isShopOwner) return <Navigate to="/shop-owner" replace />
  return <>{children}</>
}

function ShopOwnerRoute({ children, role }: { children: React.ReactNode; role: UserRoleInfo }) {
  if (!role.isShopOwner && !role.isSuperAdmin) return <Navigate to="/login" replace />
  return <>{children}</>
}

function ProtectedRoute({ children, role }: { children: React.ReactNode; role: UserRoleInfo }) {
  if (!role.role) return <Navigate to="/login" replace />
  return <>{children}</>
}

// ── login redirect: super-admin → global dashboard, shop_owner → their shop ──
function LoginRedirect({ role }: { role: UserRoleInfo }) {
  if (role.isShopOwner) return <Navigate to="/shop-owner" replace />
  if (role.isSuperAdmin) return <Navigate to="/dashboard" replace />
  return <Navigate to="/login" replace />
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const roleInfo = getUserRole(user)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    )
  }

  return (
    <RoleContext.Provider value={roleInfo}>
     <ViewProvider>
      <Toaster position="top-right" />
      <Routes>
        <Route path="/login" element={<Login user={user} />} />
        <Route
          path="/"
          element={
            <ProtectedRoute role={roleInfo}>
              <Layout user={user} role={roleInfo} />
            </ProtectedRoute>
          }
        >
          {/* root → role-based redirect */}
          <Route index element={<LoginRedirect role={roleInfo} />} />

          {/* ═══ SHOP-OWNER routes (also accessible by super-admin) ═══ */}
          <Route
            path="shop-owner"
            element={
              <ShopOwnerRoute role={roleInfo}>
                <ShopOwnerDashboard />
              </ShopOwnerRoute>
            }
          />
          <Route
            path="shops/:id"
            element={
              <ShopOwnerRoute role={roleInfo}>
                <ShopDetail />
              </ShopOwnerRoute>
            }
          />
          <Route
            path="shop/:id/financials"
            element={
              <ShopOwnerRoute role={roleInfo}>
                <ShopFinancialsPage />
              </ShopOwnerRoute>
            }
          />
          <Route
            path="shop/:shopId/expo"
            element={
              <ShopOwnerRoute role={roleInfo}>
                <ExpoScreen />
              </ShopOwnerRoute>
            }
          />
          <Route
            path="expo"
            element={
              <ShopOwnerRoute role={roleInfo}>
                <ExpoScreen />
              </ShopOwnerRoute>
            }
          />

          {/* ═══ SHARED routes (super-admin + shop owner, each page self-scopes) ═══ */}
          <Route path="conversations" element={<Conversations />} />
          <Route path="conversations/:id" element={<ConversationDetail />} />
          <Route path="conversation-quality" element={<ConversationQuality />} />
          <Route path="test-suite" element={<TestSuite />} />
          <Route path="issues" element={<Issues />} />
          <Route path="issues/:id" element={<IssueDetail />} />
          <Route path="shop-chats" element={<ShopChatTranscripts />} />
          <Route path="shop-chats/:id" element={<ShopChatDetail />} />
          <Route path="financial-reporting" element={<FinancialReporting />} />

          {/* ═══ SUPER-ADMIN ONLY ═══ */}
          <Route
            path="dashboard"
            element={
              <SuperAdminRoute role={roleInfo}>
                <Dashboard />
              </SuperAdminRoute>
            }
          />
          <Route
            path="tenants"
            element={
              <SuperAdminRoute role={roleInfo}>
                <Tenants />
              </SuperAdminRoute>
            }
          />
          <Route
            path="tenants/:id"
            element={
              <SuperAdminRoute role={roleInfo}>
                <TenantDetail />
              </SuperAdminRoute>
            }
          />
          <Route
            path="command-center"
            element={
              <SuperAdminRoute role={roleInfo}>
                <CommandCenter />
              </SuperAdminRoute>
            }
          />
          <Route
            path="shops"
            element={
              <SuperAdminRoute role={roleInfo}>
                <Shops />
              </SuperAdminRoute>
            }
          />
          <Route
            path="shops/new"
            element={
              <SuperAdminRoute role={roleInfo}>
                <ShopCreate />
              </SuperAdminRoute>
            }
          />
          <Route
            path="chat-test"
            element={
              <SuperAdminRoute role={roleInfo}>
                <ChatTest />
              </SuperAdminRoute>
            }
          />
        </Route>
      </Routes>
     </ViewProvider>
    </RoleContext.Provider>
  )
}
