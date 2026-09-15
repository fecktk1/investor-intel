import React, { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Radar, ArrowRight } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { loadSignalFeed } from '../lib/signals-api'
import SignalCard from './SignalCard'

// Drop-in "Relevant signals" rail powered by the reusable Intel Signal store.
// Self-contained (fetches its own data) so any surface can include it with one line.
// `personalOnly` keeps only signals that matched the user's watchlist/holdings/
// followed narratives/chains/topics — i.e. "what matters to YOU". Renders nothing
// while empty so it never adds noise. Maps store rows → SignalCard shape.

function rowToCard(r) {
  const kind = r.subject_type === 'chain' ? 'chain' : r.subject_type === 'narrative' ? 'narrative' : r.subject_type === 'news' ? 'news' : 'token'
  return {
    id: r.signal_key,
    name: r.display_symbol || r.subject_id,
    kind,
    asset_symbol: r.subject_type === 'asset' ? String(r.display_symbol || '').toUpperCase() || null : null,
    chain: r.chain || null,
    ref: (r.subject_type === 'asset' || r.subject_type === 'chain') ? r.subject_id : null,
    signal_type: r.signal_type || 'Signal',
    signal_scope: kind === 'token' ? 'token_specific' : kind === 'chain' ? 'chain_specific' : kind,
    direction: r.direction,
    confidence: r.confidence,
    time_window: 'last 24h',
    mention_count: r.source_count,
    source_count: r.source_count,
    source_diversity: r.source_diversity,
    headlines: r.headlines || [],
    why_it_matters: r.why_it_matters,
    what_to_watch_next: r.what_to_watch_next,
    change_24h: r.metrics && typeof r.metrics.change_24h === 'number' ? r.metrics.change_24h : null,
    score_delta: r.score_delta || null,
    stale_after: r.stale_after || null,
    corroboration: r.metrics?.corroboration || null,
    reasons: r.reasons || [],
  }
}

export default function RelevantSignals({ subjectType = null, title = 'Signals relevant to you', personalOnly = true, limit = 5, seeAllHref = '/intel',portfolioId=null }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile(),{supabase,user}=useSupabase()
  const owner=JSON.stringify([org?.id,user?.id,portfolioId]),[selection,setSelection]=useState(null),mode=portfolioId?(selection?.owner===owner?selection.mode:'portfolio'):'all'
  const scope=JSON.stringify([owner,subjectType,mode]),[state,setState]=useState(null),[retry,setRetry]=useState(0)
  useEffect(()=>{
    let alive=true
    if(!org?.id||!user?.id)return
    setState({scope,loading:true})
    loadSignalFeed(supabase,org.id,{subjectType,limit:24,portfolioId:mode==='portfolio'?portfolioId:null}).then(rows=>{if(alive)setState({scope,rows})},error=>{if(alive)setState({scope,error:error.message})})
    return()=>{alive=false}
  },[org?.id,user?.id,supabase,scope,retry]) // eslint-disable-line react-hooks/exhaustive-deps
  if(!org?.id||!user?.id)return null
  const current=state?.scope===scope?state:null,cards=(current?.rows||[]).map(rowToCard).filter(c=>!personalOnly||(c.reasons||[]).length>0).slice(0,limit)
  return <section className="intel-relevant-signals" aria-label="Relevant signals">
    <div className="intel-section-header"><h2>{mode==='portfolio'?'Signals for this portfolio':title}</h2><Link to={seeAllHref} className="btn btn--quiet btn--sm">All <ArrowRight className="h-3 w-3"/></Link></div>
    {portfolioId&&<div className="intel-underlined-nav" role="group" aria-label="Signal relevance"><button aria-pressed={mode==='portfolio'} onClick={()=>setSelection({owner,mode:'portfolio'})}>This portfolio</button><button aria-pressed={mode==='all'} onClick={()=>setSelection({owner,mode:'all'})}>All interests</button></div>}
    <p className="intel-section-sub">{mode==='portfolio'?'Matched to current holdings in the selected portfolio. Market-wide asset news may apply across networks.':t('signals.personalized_sub',{defaultValue:'Personalized from your watchlist, holdings, followed narratives, chains, and topics.'})}</p>
    {!current||current.loading?<p role="status">Loading signals…</p>:current.error?<p role="alert">{current.error} <button className="btn" onClick={()=>setRetry(n=>n+1)}>Retry signals</button></p>:!cards.length?<p className="intel-section-sub">{mode==='portfolio'?'No current signals match this portfolio. All interests remains available.':'No current signals match your interests.'}</p>:<div className="intel-signal-rows">{cards.map(c=><details key={scope+':'+c.id}><summary><span>{c.asset_symbol?c.asset_symbol:c.name}</span><span>{({bullish:'Leans bullish',bearish:'Leans bearish',mixed:'Mixed',neutral:'Neutral'})[c.direction]||c.direction||'Unclear'}</span></summary><SignalCard s={c}/></details>)}</div>}
  </section>
}
