import type { User } from '@supabase/supabase-js'

export type UserRole = 'super_admin' | 'shop_owner'

export interface UserRoleInfo {
  role: UserRole | null
  tenantId: string | null
  isSuperAdmin: boolean
  isShopOwner: boolean
}

/**
 * Derive role + tenant_id from the authed user's JWT claims.
 * Mirrors admin-chat/index.ts:~791: app_metadata first, user_metadata fallback.
 * Never trusts a client-set value beyond what the JWT carries.
 */
export function getUserRole(user: User | null): UserRoleInfo {
  if (!user) {
    return { role: null, tenantId: null, isSuperAdmin: false, isShopOwner: false }
  }

  const am = (user.app_metadata ?? {}) as Record<string, unknown>
  const um = (user.user_metadata ?? {}) as Record<string, unknown>

  const appRole = am.role as string | undefined

  // super_admin: explicit in app_metadata, or legacy is_admin in user_metadata
  const isSuperAdmin =
    appRole === 'super_admin' || (!appRole && um.is_admin === true)
  const isShopOwner = appRole === 'shop_owner'

  const role: UserRole | null =
    isSuperAdmin ? 'super_admin' : isShopOwner ? 'shop_owner' : null

  const tenantId =
    (am.tenant_id as string) || (um.tenant_id as string) || null

  return { role, tenantId, isSuperAdmin, isShopOwner }
}