import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { isRevisionConflict } from '../lib/revision-conflict'
const PersonalWorkspace = createContext(null)
const SLOTS = ['selection', 'desk', 'markets', 'dossier']

export function PersonalWorkspaceProvider({ children }) {
  const { org } = useProfile(), { supabase, user } = useSupabase()
  const scope = user?.id && org?.id ? `${user.id}:${org.id}` : null
  return <Workspace key={scope || 'signed-out'} scope={scope} orgId={org?.id} userId={user?.id} supabase={supabase}>{children}</Workspace>
}
function Workspace({ scope, orgId, userId, supabase, children }) {
  const [state, setState] = useState({ loading: !!scope, error: null, rows: {} }), current = useRef(state), alive = useRef(true), pending = useRef(new Map())
  current.current = state
  const load = useCallback(async () => {
    if (!scope) return
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const { data, error } = await supabase.from('intel_workspace_preferences').select('*').eq('org_id', orgId).eq('user_id', userId).limit(4)
      if (error) throw error
      if (!Array.isArray(data)) throw Error('Workspace preferences could not be read.')
      if (alive.current) setState({ loading: false, error: null, rows: Object.fromEntries(data.map(row => [row.slot, row])) })
    } catch (e) { if (alive.current) setState(s => ({ ...s, loading: false, error: e.message })) }
  }, [scope, supabase, orgId, userId])
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [load])
  const save = useCallback((slot, patch) => {
    if (!SLOTS.includes(slot) || !scope) return Promise.reject(Error('Workspace scope is required.'))
    // Serialize same-tab updates; server compare-and-swap handles other tabs.
    const job = (pending.current.get(slot) || Promise.resolve()).catch(() => {}).then(async () => {
      if (!alive.current) throw Error('Workspace changed before saving.')
      const snapshot = current.current
      if (snapshot.loading || snapshot.error) throw Error('Reload workspace preferences before saving changes.')
      const row = snapshot.rows[slot], value = { ...(row?.value || {}), ...(typeof patch === 'function' ? patch(row?.value || {}) : patch), schemaVersion: 1 }
      const { data, error } = await supabase.rpc('intel_save_workspace_preferences', { p_org_id: orgId, p_expected_user: userId, p_slot: slot, p_revision: row?.revision || 0, p_value: value })
      if (error) throw Error(isRevisionConflict(error) ? 'Preferences changed in another window. Reload to review the latest version.' : error.message)
      if (!data?.revision) throw Error('Workspace preferences were not confirmed saved.')
      if (alive.current) { const next = { ...current.current, rows: { ...current.current.rows, [slot]: data } }; current.current = next; setState(next) }
      return data.value
    })
    pending.current.set(slot, job)
    return job
  }, [scope, orgId, userId, supabase])
  return <PersonalWorkspace.Provider value={{ ...state, save, reload: load, scope }}>{children}</PersonalWorkspace.Provider>
}
export function usePersonalWorkspace() { return useContext(PersonalWorkspace) }
export function useWorkspacePreference(slot) {
  const workspace = usePersonalWorkspace()
  return { value: workspace?.rows[slot]?.value || {}, loading: workspace?.loading ?? false, error: workspace?.error, available: !!workspace,
    save: patch => workspace ? workspace.save(slot, patch) : Promise.reject(Error('Workspace preferences are unavailable.')), reload: workspace?.reload }
}
