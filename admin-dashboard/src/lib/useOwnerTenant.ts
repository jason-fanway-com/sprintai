import { useRole } from './RoleContext'
import { useView } from './ViewContext'

/**
 * Resolve the tenant a page should be scoped to.
 *
 * - Real shop owner: their own JWT `tenantId`.
 * - Super-admin in "owner" preview mode: the `previewTenantId` they picked.
 * - Super-admin in "admin" mode: returns `null` → page shows ALL tenants
 *   (global operator view).
 *
 * Every owner-facing page MUST gate on this. If `isOwnerView` is true and
 * `effTenant` is null (owner preview with no shop picked), the page should
 * show a "pick a shop" empty state rather than fetching unscoped data.
 */
export function useEffectiveTenant() {
  const { tenantId, isSuperAdmin, isShopOwner } = useRole()
  const { mode, previewTenantId } = useView()

  const isOwnerView = isShopOwner || (isSuperAdmin && mode === 'owner')
  const effTenant = isOwnerView ? (isSuperAdmin ? previewTenantId : tenantId) : null

  return { isOwnerView, effTenant, isShopOwner, isSuperAdmin }
}
