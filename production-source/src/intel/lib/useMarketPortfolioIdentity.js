import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { canonicalPortfolioKey } from './asset-identity'
import { getPortfolioChoiceHoldings } from './portfolio-api'
import { usePortfolioSelection } from './PortfolioSelectionContext'

const read = key => { try { return key ? localStorage.getItem(key) : null } catch { return null } }

export function useMarketPortfolioIdentity({ identityChoices, defaultKey, marketKey, explicitKey } = {}) {
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const selection = usePortfolioSelection()
  const choicesJSON = JSON.stringify(identityChoices || [])
  const choices = useMemo(() => {
    const rows = JSON.parse(choicesJSON)
    const fallback = canonicalPortfolioKey(defaultKey)
    if (!rows.length && fallback) rows.push({ canonicalAssetKey: fallback, label: fallback })
    return [...new Map(rows.slice(0, 64).map(row => {
      const key = canonicalPortfolioKey(row.canonicalAssetKey)
      return [key, { ...row, canonicalAssetKey: key }]
    }).filter(([key]) => key)).values()]
  }, [choicesJSON, defaultKey])
  const keysJSON = JSON.stringify(choices.map(row => row.canonicalAssetKey))
  const keys = useMemo(() => JSON.parse(keysJSON), [keysJSON])
  const scope = JSON.stringify([user?.id, org?.id, selection.portfolioId, marketKey, keys])
  const storageKey = user?.id && org?.id && selection.portfolioId && marketKey
    ? `intel:asset-network:${user.id}:${org.id}:${selection.portfolioId}:${marketKey}` : null
  const saved = useMemo(() => read(storageKey), [storageKey])
  const explicit = canonicalPortfolioKey(explicitKey)
  const invalidExplicit = !!explicitKey && !keys.includes(explicit)
  const explicitValid = explicitKey && !invalidExplicit ? explicit : null
  const preferred = explicitValid || (keys.includes(saved) ? saved : null)
  const fallback = keys.includes(canonicalPortfolioKey(defaultKey)) ? canonicalPortfolioKey(defaultKey) : keys[0]
  // Known choices do not require an async holdings read. In particular, a single
  // verified representation cannot be changed by inspecting held quantities.
  const immediate = !selection.loading && !invalidExplicit && marketKey && keys.length
    ? preferred || (keys.length === 1 || !user?.id || !org?.id || !selection.portfolioId ? fallback : null) : null
  const [state, setState] = useState({ scope: null, key: null, loading: false, error: null })
  const active = useRef(scope); active.current = scope
  const [revision, setRevision] = useState(0)
  const retry = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    let alive = true
    if (selection.loading || invalidExplicit || !keys.length || !marketKey) return
    if (immediate) { setState({ scope, key: immediate, loading: false, error: null }); return }
    setState({ scope, key: null, loading: true, error: null })
    getPortfolioChoiceHoldings(supabase, org.id, user.id, selection.portfolioId, keys).then(rows => {
      if (!alive || active.current !== scope) return
      // Preserve the server's deterministic order. A live position wins over a
      // closed one; amounts and ticker strings never combine representations.
      const held = keys.find(key => rows.some(row => row.canonical_asset_key === key && !row.is_closed && Number(row.quantity) !== 0))
        || keys.find(key => rows.some(row => row.canonical_asset_key === key))
      setState({ scope, key: held || fallback, loading: false, error: null })
    }).catch(error => {
      if (alive && active.current === scope) setState({ scope, key: null, loading: false, error })
    })
    return () => { alive = false }
  }, [scope, keys, immediate, fallback, invalidExplicit, marketKey, selection.loading, selection.portfolioId, user?.id, org?.id, supabase, revision])
  const selectNetwork = useCallback(key => {
    if (!keys.includes(key)) return false
    try { if (storageKey) localStorage.setItem(storageKey, key) } catch { /* keep session selection */ }
    setState({ scope, key, loading: false, error: null })
    return true
  }, [keys, storageKey, scope])
  const visible = state.scope === scope ? state : { key: null, loading: !!keys.length, error: null }
  return { ...selection, choices, canonicalAssetKey: invalidExplicit ? null : explicitValid || visible.key || immediate,
    loading: selection.loading || (!invalidExplicit && !immediate && visible.loading), error: (immediate ? null : visible.error) || selection.error,
    invalidExplicit, selectNetwork, retry }
}
