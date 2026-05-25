import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { User } from '@supabase/supabase-js'
import { Zap, Mail } from 'lucide-react'

interface LoginProps {
  user: User | null
}

export default function Login({ user }: LoginProps) {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'magic' | 'password'>('password')

  useEffect(() => {
    if (user) navigate('/dashboard', { replace: true })
  }, [user, navigate])

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
          emailRedirectTo: `${window.location.origin}/dashboard`,
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md">
        <div className="card p-8">
          {/* Logo */}
          <div className="flex items-center gap-2 mb-8">
            <Zap className="w-7 h-7 text-brand-600" />
            <span className="text-xl font-bold text-gray-900">SprintAI</span>
            <span className="text-sm text-gray-500 font-medium">Admin</span>
          </div>

          {sent ? (
            <div className="text-center">
              <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Mail className="w-6 h-6 text-green-600" />
              </div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">Check your email</h2>
              <p className="text-gray-500 text-sm">
                We sent a login link to <strong>{email}</strong>. Click it to access the admin dashboard.
              </p>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Admin Login</h1>
              <p className="text-gray-500 text-sm mb-6">Enter your email to receive a magic link</p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input"
                    placeholder="admin@getsprintai.com"
                    required
                  />
                </div>

                {mode === 'password' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="input"
                      placeholder="Enter password"
                      required
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
                  className="btn-primary w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (mode === 'password' ? 'Signing in...' : 'Sending...') : (mode === 'password' ? 'Sign In' : 'Send Magic Link')}
                </button>

                <button
                  type="button"
                  onClick={() => { setMode(mode === 'password' ? 'magic' : 'password'); setError(''); }}
                  className="w-full text-center text-sm text-gray-500 hover:text-gray-700"
                >
                  {mode === 'password' ? 'Use magic link instead' : 'Use password instead'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
