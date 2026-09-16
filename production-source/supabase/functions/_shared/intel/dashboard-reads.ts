import {curatedEnvelope,figureEnvelope,ageFreshness,figureScope,type FigureEnvelope,type FigureFreshness} from './market-figure-scope.ts'
type Result={data:any;error:any}
/** Start lazy PostgREST reads within a bounded per-request queue. Failures are
 * settled immediately, so an optional rejection cannot become an unhandled
 * promise while another section is being assembled. Never caches private data. */
export function createDashboardReads(concurrency=8,clock=()=>performance.now()){
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw Error('invalid_dashboard_concurrency')
 let active=0;const queue:(()=>void)[]=[],states:Record<string,{state:string;durationMs:number}>={}
 const next=()=>{while(active<concurrency&&queue.length){active++;queue.shift()!()}}
 const read=(name:string,run:()=>PromiseLike<Result>,kind:'rows'|'optional'|'record'='rows')=>{
  if(!/^[a-z_]+$/.test(name)||name in states)throw Error('invalid_dashboard_read')
  states[name]={state:'pending',durationMs:0}
  return new Promise<Result>(resolve=>{queue.push(()=>{const start=clock();Promise.resolve().then(run).then(result=>{
   if(!result||result.error||(kind==='rows'&&!Array.isArray(result.data))||(kind==='record'&&(!result.data||typeof result.data!=='object'))||(kind==='optional'&&result.data!=null&&typeof result.data!=='object'))throw Error('dashboard_read_failed')
   states[name]={state:result.data==null||(Array.isArray(result.data)&&!result.data.length)?'empty':'available',durationMs:Math.max(0,clock()-start)};resolve(result)
  }).catch(()=>{states[name]={state:'error',durationMs:Math.max(0,clock()-start)};resolve({data:null,error:{code:'dashboard_read_failed'}})}).finally(()=>{active--;next()})});next()})
 }
 return {read,states,timing:()=>Object.entries(states).filter(([,s])=>s.state!=='pending').map(([name,s])=>`${name};dur=${s.durationMs.toFixed(1)}`).join(', ')}
}

export function dashboardSourceReads(db:any,orgId:string,userId:string,scope:string,chain:string|null){
 const batch=createDashboardReads(),read=batch.read
 const sources={
  watchlist:read('watchlist',()=>db.from('watchlist_items').select('item_type, label, entity:entities(id, display_symbol, canonical_ref_key, chain_namespace, chain_id, contract_address),watchlist:watchlists!inner(user_id,org_id)').eq('org_id',orgId).eq('watchlist.org_id',orgId).eq('watchlist.user_id',userId).limit(201)),
  profile:read('profile',()=>db.from('intel_user_profiles').select('chains_of_interest').eq('org_id',orgId).eq('user_id',userId).maybeSingle(),'optional'),
  custom_news:read('custom_news',()=>db.from('news_items').select('id, title, url, source_name, sentiment, published_at, created_at, entity:entities(display_symbol, canonical_ref_key, chain_namespace, chain_id)').eq('org_id',orgId).order('created_at',{ascending:false}).limit(20)),
  global_news:read('global_news',async()=>{
   const base='id, title, url, source_name, sentiment, published_at, created_at, chains, entity_symbol'
   let r=await db.from('intel_global_news').select(`${base}, source_quality, authority_level, news_category`).order('created_at',{ascending:false}).limit(60)
   // Only schema-compatibility errors warrant another request. An outage is an error.
   if(r.error&&['42703','PGRST204'].includes(r.error.code))r=await db.from('intel_global_news').select(base).order('created_at',{ascending:false}).limit(60)
   return r
  }),
  narratives:read('narratives',()=>db.from('tracked_narratives').select('id, title, status, last_signal_at').eq('org_id',orgId).order('updated_at',{ascending:false}).limit(10)),
  alerts:read('alerts',()=>db.from('intel_alert_events').select('id, fired_at, payload, read_at,rule:intel_alert_rules!inner(user_id,org_id)').eq('org_id',orgId).eq('rule.org_id',orgId).eq('rule.user_id',userId).order('fired_at',{ascending:false}).limit(8)),
  brief:read('brief',()=>db.from('intel_briefs').select('period_date, brief_type, artifact:research_artifacts!inner(structured,user_id)').eq('org_id',orgId).or(`user_id.eq.${userId},user_id.is.null`,{referencedTable:'artifact'}).order('period_date',{ascending:false}).limit(1).maybeSingle(),'optional'),
  research:read('research',()=>db.from('research_artifacts').select('id, artifact_type, title, confidence, created_at').eq('org_id',orgId).eq('user_id',userId).order('created_at',{ascending:false}).limit(6)),
  changes:read('changes',()=>db.rpc('intel_what_changed_context',{p_org_id:orgId,p_user_id:userId,p_surface:'market_pulse',p_since:null}),'record'),
  exchange_tickers:read('exchange_tickers',()=>db.from('exchange_latest_tickers').select('normalized_symbol, provider, provider_symbol, price_change_pct_24h, volume_quote_24h, spread_pct, as_of').limit(1000)),
  exchange_signals:read('exchange_signals',()=>db.from('exchange_latest_market_signals').select('normalized_symbol, direction, strength, confidence, title, summary, why_it_matters, provider_count, confirming_providers').limit(1000)),
  curated_news:read('curated_news',()=>db.from('intel_curated_news').select('cluster_hash, cleaned_title, title, summary, what_happened, why_it_matters, crypto_impact, watch_next, bull_case, bear_case, chains, tokens, sectors, narratives, signal, signal_bias, news_category, confidence, final_score, source_quality_score, needs_confirmation, source_count, source_type, primary_url, published_at, should_surface, reason_to_suppress, stale_after, updated_at').gt('stale_after',new Date().toISOString()).order('final_score',{ascending:false}).limit(40)),
  signal_feed:read('signal_feed',()=>db.rpc('signal_feed_v2',{p_org_id:orgId,p_subject_type:null,p_chains:scope==='chain'&&chain?[chain]:null,p_limit:48})),
 }
 return {...batch,sources}
}

// ─── Provenance (Play 7) ──────────────────────────────────────────────────────

/** The review envelope for one curated story. The read above already filters
 * on stale_after, but a card can outlive its window in a client cache, so the
 * envelope is still derived per row rather than assumed. */
export function curatedStoryEnvelope(row:any,now=Date.now()){
 return curatedEnvelope('intel_curated_news',row?.updated_at??row?.created_at??null,row?.stale_after??null,'news_curated',now)
}
/** Attach the envelope to a mapped curated card. A card past its window keeps
 * its summary only under `stale_analysis`, never under `analysis`, so a view
 * that renders `analysis` cannot present an expired summary as current. */
export function withCuratedEnvelope<T extends Record<string,any>>(card:T,row:any,now=Date.now()){
 const provenance=curatedStoryEnvelope(row,now)
 if(provenance.kind==='curated')return {...card,provenance}
 return {...card,analysis:null,stale_analysis:card.analysis??null,provenance}
}

const newest=(values:unknown[]):string|null=>{
 const stamps=values.map(v=>Date.parse(String(v??''))).filter(Number.isFinite)
 return stamps.length?new Date(Math.max(...stamps)).toISOString():null
}
/** Chain quotes refresh within fifteen minutes (nativeChainPerformance marks a
 * row older than that as delayed); the exchange ticker layer within five. */
export const CHAIN_QUOTE_REFRESH_SECONDS=900,EXCHANGE_TICKER_REFRESH_SECONDS=300

/** One envelope per dashboard figure group. Every group names its source, the
 * newest clock it carries, its freshness and what it does not mean. Pure. */
export function dashboardFigureProvenance(input:{chainPerf?:any[];movers?:any[];marketMovers?:any[];exchangeAsOf?:unknown[];news?:any[];newsSource?:'curated'|'stored';signals?:any[];signalsSource?:string},now=Date.now()):Record<string,FigureEnvelope>{
 const chain=input.chainPerf||[],cmcRows=chain.filter(r=>r?.source==='coinmarketcap')
 const chainAt=newest(chain.map(r=>r?.as_of))
 const chainFreshness:FigureFreshness|null=!chain.length?'unavailable':chain.some(r=>r?.stale)?'stale':'cached'
 const exchangeAt=newest(input.exchangeAsOf||[])
 const signals=input.signals||[]
 const signalWindows=signals.map(s=>Date.parse(String(s?.stale_after??''))).filter(Number.isFinite)
 const news=input.news||[]
 return {
  chain_perf:figureEnvelope('stored',cmcRows.length===chain.length&&chain.length?'coinmarketcap':cmcRows.length?'coinmarketcap+coingecko':'coingecko',chainAt,chainFreshness,figureScope('price')),
  // The render path reads only unexpired overview cache entries, and that read
  // returns no capture clock, so the time is reported as absent, not invented.
  movers:figureEnvelope('stored','birdeye',null,(input.movers||[]).length?'cached':'unavailable','birdeye_price'),
  market_movers:figureEnvelope('stored','exchange',exchangeAt,(input.marketMovers||[]).length?ageFreshness(exchangeAt,EXCHANGE_TICKER_REFRESH_SECONDS,now):'unavailable','exchange_ticker'),
  news:input.newsSource==='curated'
   ?figureEnvelope('stored','intel_curated_news',newest(news.map(n=>n?.provenance?.fetchedAt)),news.length?(news.some(n=>n?.provenance?.kind==='curated_stale')?'stale':'cached'):'unavailable','news_curated')
   :figureEnvelope('stored','news_items+intel_global_news',newest(news.map(n=>n?.published_at)),news.length?'cached':'unavailable','news_stored'),
  signals:figureEnvelope('stored',input.signalsSource==='signal_store'?'signal_store':'derived_from_stored_news',newest(signals.map(s=>s?.generated_at)),
   !signals.length?'unavailable':signalWindows.length?(signalWindows.every(t=>t>now)?'cached':'stale'):null,'signals_stored'),
 }
}
