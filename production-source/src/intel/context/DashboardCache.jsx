import React, { createContext, useContext, useEffect, useMemo } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { createDashboardCache } from '../lib/dashboard-api'

const DashboardCache = createContext(null)
// Kept only for this mounted, authenticated workspace. No persisted private data.
export function DashboardCacheProvider({ children }) {
  const { org } = useProfile(), { user, supabase } = useSupabase()
  const cache = useMemo(() => createDashboardCache(), [user?.id, org?.id, supabase])
  useEffect(() => () => cache.clear?.(), [cache])
  return <DashboardCache.Provider value={cache}>{children}</DashboardCache.Provider>
}
export const useDashboardCache = () => useContext(DashboardCache)
