import { CMC_CAPABILITIES, cmcUsable } from './cmc-capabilities.ts'
import { cmcPlan, refreshCmcSnapshot,loadCmcOperatingSettings,requestCmc } from './cmc-transport.ts'
import {cmcDemandPolicy,connectedDemandEnabled} from './cmc-demand-policy.ts'

/** A small shared due set, no per-wallet/per-user/provider fan-out. */
export function planCmcRefresh(rows:any[],plan:string,now=Date.now(),connected=false) {
  const seen=new Set<string>()
  const candidates=rows.filter(row=>{
    const policy=cmcDemandPolicy(row.capability,row.request_params||{},plan,connected)
    if(!policy||row.access_profile!==plan||!row.demand_org_id||!row.demand_user_id||typeof row.cache_key!=='string')return false
    const demand=Date.parse(row.demanded_at),expiry=Date.parse(row.expires_at)
    if(!Number.isFinite(demand)||!Number.isFinite(expiry)||demand<now-policy.demandSeconds*1000||demand>now+30000||expiry>now||Date.parse(row.refresh_until||'')>now)return false
    const fetched=Date.parse(row.fetched_at)
    if(connected&&(!Number.isFinite(fetched)||fetched>now-policy.cadenceSeconds*1000))return false
    if(seen.has(row.cache_key))return false;seen.add(row.cache_key);return true
  }).sort((a,b)=>Date.parse(a.expires_at)-Date.parse(b.expires_at)||(connected?a.cache_key.localeCompare(b.cache_key):0))
  if(!connected)return candidates.slice(0,8)
  const features=new Map<string,number>()
  return candidates.filter(row=>{const feature=CMC_CAPABILITIES[row.capability].feature,count=features.get(feature)||0;if(count>=2)return false;features.set(feature,count+1);return true}).slice(0,8)
}
export async function refreshCmcDemand(db:any,now=Date.now()) {
  const settings=await loadCmcOperatingSettings(db,now),plan=cmcPlan(now,settings)
  const connected=connectedDemandEnabled(settings,key=>{try{return Deno.env.get(key)}catch{return undefined}})
  const capabilities=Object.keys(CMC_CAPABILITIES).filter(name=>cmcDemandPolicy(name,{},plan,connected))
  if(!capabilities.length)return 'idle' as const
  // Fetch a bounded candidate slice per feature so a large discovery backlog
  // cannot hide all price/regime rows before the in-memory fairness check.
  const groups=connected?[...new Set(capabilities.map(name=>CMC_CAPABILITIES[name].feature))].map(feature=>capabilities.filter(name=>CMC_CAPABILITIES[name].feature===feature)):[capabilities]
  const results=await Promise.all(groups.map(group=>db.from('market_data_response_cache').select('cache_key,capability,request_params,access_profile,demanded_at,demand_org_id,demand_user_id,expires_at,refresh_until,fetched_at')
    .eq('provider','coinmarketcap').eq('access_profile',plan).in('capability',group).gte('demanded_at',new Date(now-(connected?180:1800)*1000).toISOString()).lte('expires_at',new Date(now).toISOString()).order('expires_at',{ascending:true}).limit(12)))
  if(results.some(result=>result.error||!Array.isArray(result.data)))return 'error' as const
  const data=results.flatMap(result=>result.data)
  let refreshed=0
  for(const row of planCmcRefresh(data||[],plan,now,connected)) {
    // Recheck demand owner's access at execution, preserving trial/holder rules.
    const [access,member]=await Promise.all([db.rpc('can_access_intel',{p_user:row.demand_user_id,p_org:row.demand_org_id}),db.from('org_members').select('org_id').eq('org_id',row.demand_org_id).eq('user_id',row.demand_user_id).maybeSingle()])
    if(access.error||access.data!==true||member.error||!member.data)continue
    const result=await refreshCmcSnapshot(row.capability,row.request_params||{},{supabase:db,kind:'job',maxCalls:1,caller:'intel-cmc-demand-refresh'})
    // A snapshot already live when the lane reached it counts as satisfied demand,
    // exactly as it did when the transport called that same cache hit 'fresh'.
    if(cmcUsable(result.state))refreshed++
  }
  return refreshed?'processed' as const:'idle' as const
}

// ── The on-demand lane ───────────────────────────────────────────────────────
// Assets someone searched for stay in use for 24 hours (market_asset_demand),
// and that ledger is an aggregate: asset keys, counters and a window, never a
// searcher. This lane keeps their quotes warm for one credit per pass — the
// quotes endpoint bills 250 ids per credit, and every in-use asset shares a
// single batched request. The foreground demand lane above handles the rows a
// user is actively looking at; this one covers assets nothing is viewing right
// now but that are still in their in-use window.
//
// Pacing has two parts: `provider_schedule_policy` (coinmarketcap/quotes,
// 300 seconds by default) gates how often the lane may run in a worker process,
// and the quote snapshot's own expiry is what makes a repeat call necessary at
// all — an id a live snapshot already covers is never re-requested.
//
// Stage 4's worker release calls this next to refreshCmcDemand(); worker/ is
// untouched here.
export const ON_DEMAND_QUOTE_IDS=50
let onDemandRunAt=0
export function __resetOnDemandLaneForTests(){onDemandRunAt=0}
export async function refreshOnDemandQuotes(db:any,now=Date.now(),request:typeof requestCmc=requestCmc) {
  const policy=await db.from('provider_schedule_policy').select('cadence_seconds,enabled')
    .eq('provider','coinmarketcap').eq('feature','quotes').maybeSingle()
  if(policy?.error)return 'error' as const
  if(policy?.data?.enabled===false)return 'idle' as const
  const cadence=Math.max(60,Number(policy?.data?.cadence_seconds)||300)
  if(now-onDemandRunAt<cadence*1000)return 'idle' as const

  const demand=await db.from('market_asset_demand').select('provider_id,last_demanded_at')
    .eq('provider','coinmarketcap').gt('in_use_until',new Date(now).toISOString())
    .order('last_demanded_at',{ascending:false}).limit(ON_DEMAND_QUOTE_IDS)
  if(demand.error||!Array.isArray(demand.data))return 'error' as const
  const ids=[...new Set<string>(demand.data.map((row:any)=>String(row?.provider_id??'')))].filter(id=>/^[1-9][0-9]{0,9}$/.test(id)).slice(0,ON_DEMAND_QUOTE_IDS)
  if(!ids.length)return 'idle' as const

  // A quote snapshot that has not expired already answers for its whole batch.
  const cache=await db.from('market_data_response_cache').select('request_params,expires_at')
    .eq('provider','coinmarketcap').eq('capability','quotes').gt('expires_at',new Date(now).toISOString()).limit(40)
  if(cache.error)return 'error' as const
  const covered=new Set((cache.data||[]).flatMap((row:any)=>String(row?.request_params?.id??'').split(',')))
  const due=ids.filter(id=>!covered.has(id))
  onDemandRunAt=now
  if(!due.length)return 'idle' as const

  const result=await request('quotes',{id:due.join(',')},{supabase:db,kind:'job',maxCalls:1,caller:'intel-on-demand-refresh'})
  return cmcUsable(result?.state)?'processed' as const:'idle' as const
}
