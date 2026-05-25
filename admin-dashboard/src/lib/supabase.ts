import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
export { supabaseAnonKey, supabaseUrl }

// Admin API base URL (Supabase Edge Function)
export const ADMIN_API_URL = `${supabaseUrl}/functions/v1/admin-api`

/** Get auth headers for admin API calls */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) {
    throw new Error('Not authenticated')
  }
  return {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  }
}

/** Make authenticated request to admin API */
export async function adminFetch<T = unknown>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const headers = await getAuthHeaders()
  const res = await fetch(`${ADMIN_API_URL}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...(options?.headers ?? {}),
    },
  })

  if (!res.ok) {
    const errData = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(errData.error ?? `API error: ${res.status}`)
  }

  return res.json() as Promise<T>
}
