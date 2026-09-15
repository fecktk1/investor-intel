import { useCallback, useEffect, useRef, useState } from 'react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { getAssetPortfolioContext, getAssetPortfolioHolding } from './portfolio-api'
import { usePortfolioSelection } from './PortfolioSelectionContext'
import { portfolioEventMarkers } from './portfolio-markers'

const EMPTY = { holding: null, events: [], markers: [], nextCursor: null, coverage: null, error: null }

export function useAssetPortfolioContext({ canonicalAssetKey, portfolioId: explicitId, from, to } = {}) {
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const selection = usePortfolioSelection(explicitId)
  const { portfolioId } = selection
  const [defaultEnd] = useState(Date.now)
  const start = from ?? defaultEnd - 7 * 86400000
  const end = to ?? defaultEnd
  const scope = JSON.stringify([user?.id, org?.id, portfolioId, canonicalAssetKey, start, end])
  const [state, setState] = useState({ ...EMPTY, scope: null, loading: false, loadingMore: false })
  const generation = useRef(0)
  const activeScope = useRef(scope)
  activeScope.current = scope
  const pagination = useRef(false)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    pagination.current = false
    if (!user?.id || !org?.id || !portfolioId || !canonicalAssetKey) return
    setState({ ...EMPTY, scope, loading: true, loadingMore: false })
    try {
      const data = await getAssetPortfolioContext(supabase, org.id, { portfolioId, canonicalAssetKey, from: start, to: end })
      if (request === generation.current && activeScope.current === scope) setState({ ...EMPTY, ...data, scope, loading: false, loadingMore: false })
    } catch (error) {
      if (request === generation.current && activeScope.current === scope) setState({ ...EMPTY, scope, error, loading: false, loadingMore: false })
    }
  }, [user?.id, org?.id, portfolioId, canonicalAssetKey, start, end, scope, supabase])
  useEffect(() => { void refresh(); return () => { generation.current += 1 } }, [refresh])
  useEffect(()=>{
    if(!user?.id||!org?.id||!portfolioId||!canonicalAssetKey)return
    let stopped=false,busy=false,controller=null
    const updatePosition=async()=>{
      if(stopped||busy||document.hidden)return
      busy=true;controller=new AbortController();const request=generation.current
      try{
        const holding=await getAssetPortfolioHolding(supabase,org.id,{portfolioId,canonicalAssetKey,signal:controller.signal})
        if(!stopped&&request===generation.current&&activeScope.current===scope)setState(s=>s.scope===scope?{...s,holding,positionError:null}:s)
      }catch(positionError){
        if(!stopped&&request===generation.current&&activeScope.current===scope)setState(s=>s.scope===scope?{...s,holding:null,positionError}:s)
      }finally{busy=false}
    }
    const timer=setInterval(updatePosition,60000)
    document.addEventListener('visibilitychange',updatePosition)
    return()=>{stopped=true;controller?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',updatePosition)}
  },[user?.id,org?.id,portfolioId,canonicalAssetKey,scope,supabase])
  const loadMore = useCallback(async () => {
    if (pagination.current || state.scope !== scope || !state.nextCursor) return
    const request = generation.current
    pagination.current = true
    setState((s) => ({ ...s, loadingMore: true, error: null }))
    try {
      const data = await getAssetPortfolioContext(supabase, org.id, { portfolioId, canonicalAssetKey, from: start, to: end, cursor: state.nextCursor })
      if (request !== generation.current || activeScope.current !== scope) return
      setState((s) => {
        const events = [...new Map([...s.events, ...data.events].map((e) => [e.eventKey, e])).values()]
        return { ...s, ...data, events, markers: portfolioEventMarkers(events, { portfolioId, canonicalAssetKey }), loadingMore: false, error: null }
      })
    } catch (error) {
      if (request === generation.current && activeScope.current === scope) setState((s) => ({ ...s, error, loadingMore: false }))
    } finally { if (request === generation.current) pagination.current = false }
  }, [state.scope, state.nextCursor, scope, org?.id, portfolioId, canonicalAssetKey, start, end, supabase])
  const visible = state.scope === scope ? state : { ...EMPTY, loading: !!(portfolioId && canonicalAssetKey), loadingMore: false }
  return { ...selection, ...visible, error: visible.error || selection.error,
    loading: visible.loading || selection.loading, portfolioId, canonicalAssetKey,
    portfolio: selection.portfolios.find((p) => p.id === portfolioId) || null,
    from: start, to: end, refresh, loadMore, explicitPortfolioId: explicitId || null }
}
