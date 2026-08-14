import { createContext, useContext, useState, type ReactNode } from 'react'

/**
 * View mode for super-admins: preview the shop-owner experience without logging out.
 * 'admin'  → normal SprintAI operator view.
 * 'owner'  → render the owner view for a previewed shop/tenant.
 * Shop owners are always effectively 'owner' and never see the toggle.
 * Persisted to localStorage so it survives refreshes.
 */
export type ViewMode = 'admin' | 'owner'

interface ViewCtx {
  mode: ViewMode
  previewTenantId: string | null
  previewShopName: string | null
  setMode: (m: ViewMode) => void
  setPreview: (tenantId: string | null, shopName?: string | null) => void
}

const Ctx = createContext<ViewCtx>({
  mode: 'admin',
  previewTenantId: null,
  previewShopName: null,
  setMode: () => {},
  setPreview: () => {},
})

export function ViewProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ViewMode>(
    () => (localStorage.getItem('viewMode') as ViewMode) || 'admin',
  )
  const [previewTenantId, setTenant] = useState<string | null>(
    () => localStorage.getItem('previewTenantId'),
  )
  const [previewShopName, setName] = useState<string | null>(
    () => localStorage.getItem('previewShopName'),
  )

  const setMode = (m: ViewMode) => {
    setModeState(m)
    localStorage.setItem('viewMode', m)
  }
  const setPreview = (tenantId: string | null, shopName: string | null = null) => {
    setTenant(tenantId)
    setName(shopName)
    if (tenantId) localStorage.setItem('previewTenantId', tenantId)
    else localStorage.removeItem('previewTenantId')
    if (shopName) localStorage.setItem('previewShopName', shopName)
    else localStorage.removeItem('previewShopName')
  }

  return (
    <Ctx.Provider value={{ mode, previewTenantId, previewShopName, setMode, setPreview }}>
      {children}
    </Ctx.Provider>
  )
}

export const useView = () => useContext(Ctx)
