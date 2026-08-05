import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import type { User } from '@supabase/supabase-js'
import { Sparkles, Mail } from 'lucide-react'

interface LoginProps {
  user: User | null
  onLogin: (user: User) => void
}

export default function Login({ user, onLogin }: LoginProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'magic' | 'password'>('password')

  useEffect(() => {
    if (user) {
      const tenantId = user.user_metadata?.tenant_id
      if (!tenantId) {
        setError('Your account isn\'t linked to a shop. Contact support.')
        return
      }
      onLogin(user)
    }
  }, [user, onLogin])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    if (mode === 'password') {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      setLoading(false)
      if (authError) {
        setError(authError.message)
      }
    } else {
      const { error: authError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/chat/`,
        },
      })
      setLoading(false)
      if (authError) {
        setError(authError.message)
      } else {
        setSent(true)
      }
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8 safe-area-top safe-area-bottom">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <Sparkles className="w-7 h-7 text-brand-600" />
          <span className="text-xl font-bold text-gray-900">Sprint</span>
          <span className="text-sm text-gray-500 font-medium">Chat</span>
        </div>

        {sent ? (
          <div className="bg-white rounded-2xl p-6 shadow-sm text-center">
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Mail className="w-6 h-6 text-green-600" />
            </div>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Check your email</h2>
            <p className="text-gray-500 text-sm">
              We sent a login link to <strong>{email}</strong>.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl p-6 shadow-sm">
            <h1 className="text-xl font-bold text-gray-900 mb-1 text-center">Shop Owner Login</h1>
            <p className="text-gray-500 text-sm mb-6 text-center">Manage your menu with AI</p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="owner@shop.com"
                  required
                  autoComplete="email"
                />
              </div>

              {mode === 'password' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="Enter password"
                    required
                    autoComplete="current-password"
                  />
                </div>
              )}

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !email}
                className="w-full py-2.5 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                style={{ minHeight: 48 }}
              >
                {loading ? (mode === 'password' ? 'Signing in...' : 'Sending...') : (mode === 'password' ? 'Sign In' : 'Send Magic Link')}
              </button>

              <button
                type="button"
                onClick={() => { setMode(mode === 'password' ? 'magic' : 'password'); setError('') }}
                className="w-full text-center text-sm text-gray-500 hover:text-gray-700 py-2"
                style={{ minHeight: 44 }}
              >
                {mode === 'password' ? 'Use magic link instead' : 'Use password instead'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}