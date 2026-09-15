import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { listWatchlists } from '../lib/watchlist-api'
import { useWorkspacePreference } from './PersonalWorkspace'
const WatchlistSelection = createContext(null)
export function WatchlistSelectionProvider({ children }) {
  const { org } = useProfile(), { supabase, user } = useSupabase()
  return <Selection key={`${user?.id}:${org?.id}`} orgId={org?.id} userId={user?.id} supabase={supabase}>{children}</Selection>
}
function Selection({ orgId, userId, supabase, children }) {
  const prefs = useWorkspacePreference('selection'), alive = useRef(true), generation = useRef(0)
  const [state, setState] = useState({ lists: [], loading: true, error: null })
  const reload = useCallback(async () => {
    if (!orgId || !userId) return []
    const request = ++generation.current
    setState(s => ({ ...s, loading: true, error: null }))
    try { const lists = await listWatchlists(supabase, orgId); if (alive.current && request === generation.current) setState({ lists, loading: false, error: null }); return lists }
    catch (e) { if (alive.current && request === generation.current) setState({ lists: [], loading: false, error: e.message }); throw e }
  }, [supabase, orgId, userId])
  useEffect(() => { alive.current = true; void reload().catch(() => {}); return () => { alive.current = false; generation.current++ } }, [reload])
  const selected = state.lists.find(list => list.id === prefs.value.watchlistId) || state.lists.find(list => list.is_default) || state.lists[0] || null
  return <WatchlistSelection.Provider value={{ ...state, loading: state.loading || prefs.loading, error: state.error || prefs.error, selected, reload, select: id => prefs.save({ watchlistId: id }) }}>{children}</WatchlistSelection.Provider>
}
export function useWatchlistSelection(explicitId) {
  const state = useContext(WatchlistSelection)
  if (!state) return { lists: [], selected: null, loading: false, error: null, unavailable: true }
  return { ...state, selected: explicitId ? state.lists.find(list => list.id === explicitId) || null : state.selected,
    invalidList: !!explicitId && !state.loading && !state.lists.some(list => list.id === explicitId) }
}
