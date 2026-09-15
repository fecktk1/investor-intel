import { useCallback, useEffect, useRef, useState } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { ASSET_NEWS_REFRESH_MS, loadAssetNews } from './asset-news'

export function useAssetNews(identity) {
  const { org } = useProfile(), { supabase, user } = useSupabase()
  const identityJSON = JSON.stringify(identity)
  const scope = JSON.stringify([user?.id, org?.id, identityJSON])
  const active = useRef(scope); active.current = scope
  const request = useRef(null), checked = useRef({ scope: null, at: 0 })
  const [state, setState] = useState({ scope: null, rows: [], loading: false, error: null })
  const refresh = useCallback(async (force = false) => {
    if (!user?.id || !org?.id || !JSON.parse(identityJSON)?.key) return
    if (request.current?.scope === scope || (!force && checked.current.scope === scope && Date.now() - checked.current.at < ASSET_NEWS_REFRESH_MS)) return
    request.current?.controller.abort()
    const controller = new AbortController(), pending = { scope, controller }
    request.current = pending
    checked.current = { scope, at: Date.now() }
    setState(s => ({ ...s, scope, rows: s.scope === scope ? s.rows : [], checkedAt: s.scope === scope ? s.checkedAt : null, loading: true, error: null }))
    try {
      const result = await loadAssetNews(supabase, org.id, JSON.parse(identityJSON), { signal: controller.signal })
      if (!controller.signal.aborted && active.current === scope) setState({ scope, ...result, loading: false, error: null })
    } catch {
      if (!controller.signal.aborted && active.current === scope) setState(s => ({ ...s, loading: false, error: 'unavailable' }))
    } finally { if (request.current === pending) request.current = null }
  }, [scope, identityJSON, user?.id, org?.id, supabase])
  useEffect(() => {
    void refresh(true)
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void refresh() }
    const interval = window.setInterval(visibleRefresh, ASSET_NEWS_REFRESH_MS)
    document.addEventListener('visibilitychange', visibleRefresh)
    window.addEventListener('focus', visibleRefresh)
    return () => { request.current?.controller.abort(); request.current = null; clearInterval(interval); document.removeEventListener('visibilitychange', visibleRefresh); window.removeEventListener('focus', visibleRefresh) }
  }, [refresh])
  return { ...(state.scope === scope ? state : { rows: [], loading: !!identity?.key, error: null }), refresh: () => refresh(true) }
}
