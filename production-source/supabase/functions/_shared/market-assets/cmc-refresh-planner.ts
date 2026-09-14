import { CMC_CAPABILITIES } from './cmc-capabilities.ts'
import { cmcPlan, refreshCmcSnapshot,loadCmcOperatingSettings } from './cmc-transport.ts'
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
    if(result.state==='fresh')refreshed++
  }
  return refreshed?'processed' as const:'idle' as const
}
