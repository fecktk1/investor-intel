import { useCallback, useEffect, useRef, useState } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { createDashboardCache, dashboardScopeKey, loadDashboard } from './dashboard-api'
import { markSurfaceSeen } from './changes-api'
import { useDashboardCache } from '../context/DashboardCache'

export function useDashboard({ scope, chain }) {
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const key = dashboardScopeKey({ orgId: org?.id, userId: user?.id, scope, chain })
  const active = useRef(key); active.current = key
  const generation = useRef(0)
  const workspaceCache = useDashboardCache(), fallbackCache = useRef(null)
  if (!fallbackCache.current) fallbackCache.current = createDashboardCache()
  const cache = workspaceCache || fallbackCache.current
  const [state, setState] = useState({ key, data: null, grounding: null, loading: true, groundingLoading: true, error: null, groundingError: null })
  const load = useCallback((force = false) => {
    const request = ++generation.current
    const current = () => generation.current === request && active.current === key
    if (!key) return
    setState(s => ({ key, data: s.key === key ? s.data : null, grounding: s.key === key ? s.grounding : null, loading: true, groundingLoading: true, error: null, groundingError: null }))
    cache.load(key, () => loadDashboard(supabase, org.id, { scope, chain, section: 'core' }), force)
      .then(data => {
        if (!current()) return
        setState(s => ({ ...s, data, loading: false }))
        // Advance only through activity actually included in this read.
        const observedAt = data.what_changed_context?.observedAt
        if (observedAt) void markSurfaceSeen(supabase, 'market_pulse', '', { orgId: org.id, userId: user.id, observedAt })
      }).catch(e => { if (current()) setState(s => ({ ...s, loading: false, error: e.message })) })
    const groundingKey = dashboardScopeKey({ orgId: org.id, userId: user.id, scope, chain, section: 'picture' })
    cache.load(groundingKey, () => loadDashboard(supabase, org.id, { scope, chain, section: 'picture' }), force)
      .then(data => { if (current()) setState(s => ({ ...s, grounding: data.intelligence_grounding, groundingLoading: false })) })
      .catch(e => { if (current()) setState(s => ({ ...s, groundingLoading: false, groundingError: e.message })) })
  }, [key, org?.id, user?.id, scope, chain, supabase, cache])
  useEffect(() => { load(); return () => { generation.current++ } }, [load])
  return { ...(state.key === key ? state : { data: null, grounding: null, loading: !!key, groundingLoading: !!key, error: null, groundingError: null }), refresh: () => load(true), key }
}
