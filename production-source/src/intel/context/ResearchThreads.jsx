import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { createResearchThreadStore } from '../lib/research-thread-store'
const ResearchThreads = createContext(null)
export function ResearchThreadsProvider({ children }) {
  const { org } = useProfile(), { supabase, user } = useSupabase()
  const store = useMemo(() => createResearchThreadStore({ supabase, orgId: org?.id, userId: user?.id }), [supabase, org?.id, user?.id])
  useEffect(() => { store.activate(); return () => store.dispose() }, [store])
  return <ResearchThreads.Provider value={store}>{children}</ResearchThreads.Provider>
}
export function useResearchThread(subject, { load = true } = {}) {
  const store = useContext(ResearchThreads)
  useSyncExternalStore(store?.subscribe || (() => () => {}), store?.snapshot || (() => 0))
  useEffect(() => { if (load && store && subject) void store.load(subject).catch(() => {}) }, [store, subject, load])
  return { record: store && subject ? store.get(subject) : null, store }
}
