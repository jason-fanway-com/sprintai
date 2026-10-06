import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabaseUrl } from '../lib/supabase'

/** The approver's page, opened from the email link. Needs no sign-in: the one-time link is the proof (2026-10-05). */
export default function ApproveAccess() {
  const [params] = useSearchParams()
  const id = params.get('id') ?? '', t = params.get('t') ?? ''
  const [req, setReq] = useState<{ name: string; email: string; status: string; expired: boolean } | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const call = async (body: Record<string, string>) => {
    const r = await fetch(`${supabaseUrl}/functions/v1/access-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, id, t }) })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error ?? 'Something went wrong')
    return data
  }
  useEffect(() => { call({ action: 'view' }).then(setReq).catch(e => setMsg(e.message)) }, [])
  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true)
    try { const r = await call({ action: 'decide', decision }); setMsg(r.status === 'approved' ? `Approved. ${r.name} has full admin access and has been emailed.` : `Denied. ${r.name} won't get access.`); setReq(null) } catch (e) { setMsg(e instanceof Error ? e.message : 'Something went wrong') }
    setBusy(false)
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 w-full max-w-md space-y-4">
        <h1 className="text-lg font-bold text-gray-900">OrderFare access request</h1>
        {req && req.status === 'pending' && !req.expired && (
          <>
            <p className="text-sm text-gray-700"><b>{req.name}</b> ({req.email}) is asking for OrderFare team access: full admin, every shop.</p>
            <div className="flex gap-2">
              <button onClick={() => decide('approve')} disabled={busy} className="flex-1 px-4 py-2.5 text-sm text-white bg-brand-600 rounded-lg disabled:opacity-50">Approve</button>
              <button onClick={() => decide('deny')} disabled={busy} className="flex-1 px-4 py-2.5 text-sm text-gray-700 border border-gray-300 rounded-lg disabled:opacity-50">Deny</button>
            </div>
          </>
        )}
        {req && req.status !== 'pending' && <p className="text-sm text-gray-700">This request was already {req.status}.</p>}
        {req && req.status === 'pending' && req.expired && <p className="text-sm text-gray-700">This link has expired. Ask them to request access again.</p>}
        {msg && <p className="text-sm text-gray-700">{msg}</p>}
      </div>
    </div>
  )
}
