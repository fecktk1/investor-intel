import { useCallback, useEffect, useRef, useState } from 'react'
import { intelReadError } from './read-error'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { getAssetThesisMarkers } from './thesis-api'
const EMPTY = { markers: [], nextCursor: null, error: null, historicalCoverage: null, loading: false, loadingMore: false }
export function useAssetThesisHistory({ canonicalKey, entityId, thesisId, from, to } = {}) {
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const scope = JSON.stringify([user?.id, org?.id, canonicalKey, entityId, thesisId, from, to])
  const active = useRef(scope); active.current = scope
  const request = useRef(0), morePending = useRef(false)
  const [state, setState] = useState({ ...EMPTY, scope: null })
  const enabled = !!(user?.id && org?.id && (canonicalKey || entityId || thesisId))
  const refresh = useCallback(async () => {
    const generation = ++request.current
    morePending.current = false
    if (!enabled) return
    setState({ ...EMPTY, scope, loading: true })
    try {
      const data = await getAssetThesisMarkers(supabase, org.id, { canonicalKey, entityId, thesisId, from, to })
      if (active.current === scope && generation === request.current) setState({ ...EMPTY, ...data, scope })
    } catch (error) {
      if (active.current === scope && generation === request.current) setState({ ...EMPTY, scope, error: intelReadError(error, 'Your chart research history is temporarily unavailable. Your Thesis Journal remains available.') })
    }
  }, [enabled, scope, supabase, org?.id, canonicalKey, entityId, thesisId, from, to])
  useEffect(() => { void refresh(); return () => { request.current++ } }, [refresh])
  useEffect(() => {
    const update = e => { if (e.detail?.orgId === org?.id) void refresh() }
    window.addEventListener('intel:thesis-activity-changed', update)
    return () => window.removeEventListener('intel:thesis-activity-changed', update)
  }, [refresh, org?.id])
  const loadMore = useCallback(async () => {
    if (morePending.current || state.scope !== scope || !state.nextCursor) return
    morePending.current = true
    const generation = request.current
    setState(s => ({ ...s, loadingMore: true }))
    try {
      const data = await getAssetThesisMarkers(supabase, org.id, { canonicalKey, entityId, thesisId, from, to, cursor: state.nextCursor })
      if (active.current === scope && generation === request.current) setState(s => ({ ...s, ...data, markers: [...new Map([...s.markers, ...data.markers].map(m => [m.id, m])).values()], loadingMore: false }))
    } catch (error) {
      if (active.current === scope && generation === request.current) setState(s => ({ ...s, error: intelReadError(error, 'More research history could not be loaded. Please retry.'), loadingMore: false }))
    } finally { if (generation === request.current) morePending.current = false }
  }, [state.scope, state.nextCursor, scope, supabase, org?.id, canonicalKey, entityId, thesisId, from, to])
  return { ...(state.scope === scope ? state : { ...EMPTY, loading: enabled }), scope, refresh, loadMore }
}
