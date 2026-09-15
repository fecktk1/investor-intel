import {useCallback, useEffect, useRef, useState} from 'react'
import {readStoredPortfolioResearch} from './stored-portfolio-research'
import {getPortfolioIntel} from './portfolio-api'

const empty = {intel: null, reading: false, generating: false, error: null}
export function usePortfolioResearch({supabase, orgId, userId, portfolioId, revision = 0}) {
  const scope = JSON.stringify([orgId, userId, portfolioId])
  const identity = useRef({scope, supabase})
  identity.current = {scope, supabase}
  const sequence = useRef(0), controller = useRef(null)
  const [state, setState] = useState({...empty, scope: null, client: null})
  const enabled = !!(orgId && userId && portfolioId)
  const current = useCallback(operation => identity.current.scope === scope &&
    identity.current.supabase === supabase && operation === sequence.current, [scope, supabase])
  const reload = useCallback(async (versionId) => {
    const operation = ++sequence.current
    controller.current?.abort()
    if (!enabled) return
    const abort = new AbortController(); controller.current = abort
    // A re-read may follow deletion of private notes; hide previous text while checking.
    setState({...empty, scope, client: supabase, reading: true})
    try {
      const intel = await readStoredPortfolioResearch(supabase, {orgId, userId, portfolioId, signal: abort.signal,versionId})
      if(versionId&&!intel)throw new Error('This portfolio reading was deleted or is unavailable.')
      if (current(operation)) setState({...empty, scope, client: supabase, intel})
    } catch (error) {
      if (current(operation) && !abort.signal.aborted) setState({...empty, scope, client: supabase, error})
    }
  }, [enabled, scope, supabase, orgId, userId, portfolioId, current])
  useEffect(() => {
    void reload()
    return () => {++sequence.current; controller.current?.abort()}
  }, [reload, revision])
  const generate = useCallback(async () => {
    if (!enabled) return
    const operation = ++sequence.current
    controller.current?.abort()
    setState(value => ({...empty, scope, client: supabase,
      intel: value.scope === scope && value.client === supabase ? value.intel : null, generating: true}))
    try {
      const intel = await getPortfolioIntel(supabase, orgId, portfolioId)
      if (current(operation)) setState({...empty, scope, client: supabase, intel})
    } catch (error) {
      if (current(operation)) setState(value => ({...value, generating: false, error}))
    }
  }, [enabled, scope, supabase, orgId, portfolioId, current])
  const visible = state.scope === scope && state.client === supabase ? state : {...empty, reading: enabled}
  return {...visible, reload, generate}
}
