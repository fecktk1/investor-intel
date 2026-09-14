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
  exchange_tickers:read('exchange_tickers',()=>db.from('exchange_latest_tickers').select('normalized_symbol, provider, provider_symbol, price_change_pct_24h, volume_quote_24h, spread_pct').limit(1000)),
  exchange_signals:read('exchange_signals',()=>db.from('exchange_latest_market_signals').select('normalized_symbol, direction, strength, confidence, title, summary, why_it_matters, provider_count, confirming_providers').limit(1000)),
  curated_news:read('curated_news',()=>db.from('intel_curated_news').select('cluster_hash, cleaned_title, title, summary, what_happened, why_it_matters, crypto_impact, watch_next, bull_case, bear_case, chains, tokens, sectors, narratives, signal, signal_bias, news_category, confidence, final_score, source_quality_score, needs_confirmation, source_count, source_type, primary_url, published_at, should_surface, reason_to_suppress').gt('stale_after',new Date().toISOString()).order('final_score',{ascending:false}).limit(40)),
  signal_feed:read('signal_feed',()=>db.rpc('signal_feed_v2',{p_org_id:orgId,p_subject_type:null,p_chains:scope==='chain'&&chain?[chain]:null,p_limit:48})),
 }
 return {...batch,sources}
}
