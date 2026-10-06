import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase, supabaseUrl } from '../lib/supabase'

/** Signed in, no role yet: ask for access. The approver gets an email; approval shows up here (2026-10-05). */
export default function RequestAccess({ user }: { user: User }) {
  const [status, setStatus] = useState<'loading' | 'none' | 'pending' | 'approved' | 'denied'>('loading')
  const [kind, setKind] = useState<'team' | 'owner'>('team')
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const call = async (body: Record<string, string>) => {
    const { data: { session } } = await supabase.auth.getSession()
    const r = await fetch(`${supabaseUrl}/functions/v1/access-request`, { method: 'POST', headers: { Authorization: `Bearer ${session?.access_token ?? ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error ?? 'Something went wrong')
    return data as { status: 'none' | 'pending' | 'approved' | 'denied' }
  }

  useEffect(() => {
    let stop = false
    const check = async () => {
      try {
        const s = await call({ action: 'status' })
        if (stop) return
        if (s.status === 'approved') { await supabase.auth.refreshSession(); window.location.href = `${import.meta.env.BASE_URL}`; return } // the new role is in a fresh token
        setStatus(s.status)
      } catch { if (!stop) setStatus('none') }
    }
    check()
    const t = setInterval(check, 15000)
    return () => { stop = true; clearInterval(t) }
  }, [])

  const submit = async () => {
    setBusy(true); setError('')
    try { setStatus((await call({ action: 'request', name, note })).status) } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong') }
    setBusy(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 w-full max-w-md space-y-4">
        <h1 className="text-lg font-bold text-gray-900">Request access to OrderFare</h1>
        <p className="text-sm text-gray-500">Signed in as {user.email}.</p>
        {status === 'loading' && <p className="text-sm text-gray-500">Checking…</p>}
        {status === 'pending' && <p className="text-sm text-gray-700">Your request is waiting for approval. This page will open the admin as soon as you're approved.</p>}
        {status === 'denied' && <p className="text-sm text-gray-700">Your last request wasn't approved. Contact OrderFare if that's a mistake.</p>}
        {(status === 'none' || status === 'denied') && (
          <>
            <div className="flex gap-2 text-sm">
              {(['team', 'owner'] as const).map(k => (
                <button key={k} onClick={() => setKind(k)} className={`px-3 py-1.5 rounded-full border ${kind === k ? 'border-brand-500 text-brand-700 bg-brand-50' : 'border-gray-200 text-gray-500'}`}>
                  {k === 'team' ? "I'm on the OrderFare team" : 'I own a shop'}
                </button>
              ))}
            </div>
            {kind === 'owner' ? (
              <p className="text-sm text-gray-700">Shop owners get access by signing their shop up at <a className="text-brand-600 underline" href="https://getsprintai.com/signup-page/">getsprintai.com/signup-page</a>. Use this same email.</p>
            ) : (
              <>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
                <input value={note} onChange={e => setNote(e.target.value)} placeholder="Anything we should know (optional)" className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
                <button onClick={submit} disabled={busy || !name.trim()} className="w-full px-4 py-2.5 text-sm text-white bg-brand-600 rounded-lg disabled:opacity-50">{busy ? 'Sending…' : 'Request access'}</button>
              </>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
          </>
        )}
        <button onClick={() => supabase.auth.signOut()} className="text-xs text-gray-400 underline">Sign out</button>
      </div>
    </div>
  )
}
