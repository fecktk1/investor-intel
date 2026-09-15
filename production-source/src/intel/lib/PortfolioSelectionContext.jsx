import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { listPortfolios } from './portfolio-api'
import { resolvePortfolioSelection } from './portfolio-markers'

const PortfolioSelectionContext = createContext(null)
const readSelection = (key) => { try { return window.localStorage.getItem(key) } catch { return null } }

export function PortfolioSelectionProvider({ children }) {
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const scope = user?.id && org?.id ? `${user.id}:${org.id}` : null
  const storageKey = scope ? `intel:portfolio-selection:${scope}` : null
  const [state, setState] = useState({ scope: null, portfolios: [], selectedId: null, loading: true, error: null })
  const currentScope = useRef(scope)
  currentScope.current = scope
  const request = useRef(0)
  const refreshPortfolios = useCallback(async () => {
    const generation = ++request.current
    if (!scope) return []
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const portfolios = await listPortfolios(supabase, org.id)
      if (generation !== request.current || currentScope.current !== scope) return portfolios
      setState((s) => ({ scope, portfolios, loading: false, error: null,
        selectedId: resolvePortfolioSelection(portfolios, null, s.scope === scope ? s.selectedId : readSelection(storageKey)) }))
      return portfolios
    } catch (error) {
      if (generation === request.current && currentScope.current === scope) setState({ scope, portfolios: [], selectedId: null, loading: false, error })
      throw error
    }
  }, [scope, storageKey, org?.id, supabase])
  useEffect(() => {
    if (scope) void refreshPortfolios().catch(() => {})
    return () => { request.current += 1 }
  }, [scope, refreshPortfolios])
  const selectPortfolio = useCallback((value) => {
    setState((s) => {
      if (s.scope !== scope) return s
      const requested = typeof value === 'function' ? value(s.selectedId) : value
      const selectedId = resolvePortfolioSelection(s.portfolios, null, requested)
      try { if (storageKey && selectedId) window.localStorage.setItem(storageKey, selectedId) } catch { /* session state still works */ }
      return { ...s, selectedId }
    })
  }, [scope, storageKey])
  const value = useMemo(() => ({
    portfolios: state.scope === scope ? state.portfolios : [],
    selectedId: state.scope === scope ? state.selectedId : null,
    loading: !!scope && (state.scope !== scope || state.loading),
    error: state.scope === scope ? state.error : null,
    selectPortfolio, refreshPortfolios,
  }), [scope, state, selectPortfolio, refreshPortfolios])
  // Remount personal page state when identity changes; late results cannot paint
  // the previous user's positions while the new selection is being loaded.
  return <PortfolioSelectionContext.Provider value={value}><React.Fragment key={scope || 'signed-out'}>{children}</React.Fragment></PortfolioSelectionContext.Provider>
}

export function usePortfolioSelection(explicitPortfolioId) {
  const value = useContext(PortfolioSelectionContext)
  if (!value) throw new Error('PortfolioSelectionProvider is required')
  return { ...value, portfolioId: resolvePortfolioSelection(value.portfolios, explicitPortfolioId, value.selectedId),
    invalidPortfolio: !!explicitPortfolioId && !value.loading && !value.portfolios.some((p) => p.id === explicitPortfolioId) }
}
