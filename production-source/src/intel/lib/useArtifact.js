import { useState, useCallback, useRef, useEffect } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { generateArtifact } from './artifact-api'
export function useArtifact(contextScope = '') {
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const scope = `${user?.id || ''}:${org?.id || ''}:${contextScope}`
  const active = useRef(scope); active.current = scope
  const sequence = useRef(0)
  const [state, setState] = useState({ scope, result: null, loading: false, error: null })
  useEffect(() => () => { sequence.current++ }, [scope])
  const setResult = useCallback(result => setState(s => ({ ...s, scope, result: typeof result === 'function' ? result(s.scope === scope ? s.result : null) : result })), [scope])
  const generate = useCallback(async params => {
    if (!org?.id || !user?.id) return
    const operation = ++sequence.current
    setState(s => ({ scope, result: s.scope === scope ? s.result : null, loading: true, error: null }))
    try {
      const result = await generateArtifact(supabase, { ...params, orgId: org.id })
      if (active.current === scope && sequence.current === operation) setState({ scope, result, loading: false, error: null })
      return result
    } catch (e) { if (active.current === scope && sequence.current === operation) setState(s => ({ ...s, loading: false, error: e.message })) }
  }, [org?.id, user?.id, supabase, scope])
  const refresh = useCallback(params => generate({ ...params, force: true }), [generate])
  return { ...(state.scope === scope ? state : { result: null, error: null, loading: false }), setResult, generate, refresh }
}
