import { useState, useEffect, useCallback } from 'react'
import { supabase } from './lib/supabase'
import type { User } from '@supabase/supabase-js'
import Login from './components/Login'
import Chat from './components/Chat'
import ShopPicker from './components/ShopPicker'

interface Shop {
  id: string
  name: string
  slug: string
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [tenantId, setTenantId] = useState<string | null>(null)
  const [shopId, setShopId] = useState<string | null>(null)
  const [shopName, setShopName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        const tid = session.user.user_metadata?.tenant_id
        if (tid) {
          setUser(session.user)
          setTenantId(tid)
        } else {
          setError('Your account isn\'t linked to a shop. Contact support.')
        }
      }
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        const tid = session.user.user_metadata?.tenant_id
        if (tid) {
          setUser(session.user)
          setTenantId(tid)
          setShopId(null)
          setShopName(null)
          setError('')
        } else {
          setError('Your account isn\'t linked to a shop. Contact support.')
          setUser(null)
          setTenantId(null)
          setShopId(null)
        }
      } else {
        setUser(null)
        setTenantId(null)
        setShopId(null)
        setShopName(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const handleLogin = useCallback((u: User) => {
    const tid = u.user_metadata?.tenant_id
    if (tid) {
      setUser(u)
      setTenantId(tid)
      setShopId(null)
      setShopName(null)
      setError('')
    } else {
      setError('Your account isn\'t linked to a shop. Contact support.')
      supabase.auth.signOut()
    }
  }, [])

  const handleShopSelect = useCallback((shop: Shop) => {
    setShopId(shop.id)
    setShopName(shop.name)
  }, [])

  const handleSwitchShop = useCallback(() => {
    setShopId(null)
    setShopName(null)
  }, [])

  const handleLogout = useCallback(async () => {
    await supabase.auth.signOut()
    setUser(null)
    setTenantId(null)
    setShopId(null)
    setShopName(null)
  }, [])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-white">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-brand-600 animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-2.5 h-2.5 rounded-full bg-brand-600 animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-2.5 h-2.5 rounded-full bg-brand-600 animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    )
  }

  if (!user || !tenantId) {
    return (
      <>
        {error && (
          <div className="fixed top-0 left-0 right-0 z-50 p-4 mx-4 mt-4 bg-red-50 border border-red-200 rounded-xl shadow-sm text-sm text-red-700 safe-area-top">
            {error}
          </div>
        )}
        <Login user={user} onLogin={handleLogin} />
      </>
    )
  }

  if (!shopId) {
    return <ShopPicker tenantId={tenantId} onSelect={handleShopSelect} />
  }

  return (
    <div className="h-full">
      <Chat shopId={shopId} onLogout={handleLogout} onSwitchShop={handleSwitchShop} shopName={shopName ?? undefined} />
    </div>
  )
}
