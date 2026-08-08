import { createContext, useContext } from 'react'
import type { UserRoleInfo } from './roles'

export const RoleContext = createContext<UserRoleInfo>({
  role: null,
  tenantId: null,
  isSuperAdmin: false,
  isShopOwner: false,
})

export function useRole() {
  return useContext(RoleContext)
}
