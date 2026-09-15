/** Non-secret operating policy lives in the existing service-only provider ledger.
 * Credentials remain in Secrets. A one-minute, project-scoped cache also collapses
 * concurrent readers; an unreadable policy falls back to the baseline profile. */
export type CmcOperatingSettings=Partial<Record<'CMC_ENABLED'|'CMC_CONNECTED_DEMAND_ENABLED'|'CMC_LIVE_ENABLED'|'CMC_LIVE_ONCHAIN_ENABLED'|'CMC_ACCESS_PROFILE'|'CMC_VERIFIED_HACKATHON_PLAN'|'CMC_VERIFIED_BASELINE_PLAN'|'CMC_MONTHLY_CREDIT_CEILING'|'CMC_HACKATHON_EXPIRES_AT'|'CMC_ALLOW_HISTORICAL_RETENTION'|'CMC_HISTORY_RETENTION_DAYS'|'CMC_ALLOW_AI_PROCESSING'|'INTEL_CHART_CMC_PRODUCT_SHARING'|'CMC_SOURCE_POLICY_EXPIRES_AT',string>>
const keys=['CMC_ENABLED','CMC_CONNECTED_DEMAND_ENABLED','CMC_LIVE_ENABLED','CMC_LIVE_ONCHAIN_ENABLED','CMC_ACCESS_PROFILE','CMC_VERIFIED_HACKATHON_PLAN','CMC_VERIFIED_BASELINE_PLAN','CMC_MONTHLY_CREDIT_CEILING','CMC_HACKATHON_EXPIRES_AT','CMC_ALLOW_HISTORICAL_RETENTION','CMC_HISTORY_RETENTION_DAYS','CMC_ALLOW_AI_PROCESSING','INTEL_CHART_CMC_PRODUCT_SHARING','CMC_SOURCE_POLICY_EXPIRES_AT'] as const
/** Explicit operator activation only; retention permission never enables live
 * data. An emergency environment or shared-policy disable wins over activation. */
export function cmcLiveActivation(settings:CmcOperatingSettings,env:(key:string)=>string|undefined) {
 const flags=[env('CMC_LIVE_ENABLED'),settings.CMC_LIVE_ENABLED]
 return !flags.some(v=>v!=null&&['false','0','off'].includes(v.toLowerCase()))&&flags.includes('true')
}
/** The on-chain tape is a second, separate switch with the same rules: explicit
 * activation only, from the operating profile row or the environment, and a
 * disable in either place wins. It lives in the profile row because the Edge
 * secret store is full and this is operating policy, not a credential. */
export function cmcLiveOnchainActivation(settings:CmcOperatingSettings,env:(key:string)=>string|undefined) {
 const flags=[env('CMC_LIVE_ONCHAIN_ENABLED'),settings.CMC_LIVE_ONCHAIN_ENABLED]
 return !flags.some(v=>v!=null&&['false','0','off'].includes(v.toLowerCase()))&&flags.includes('true')
}
export function cmcPolicyEnvironment(settings:CmcOperatingSettings,env:(key:string)=>string|undefined,now=Date.now()){
 const read=(key:string)=>env(key)??settings[key as keyof CmcOperatingSettings]
 return (key:string)=>{
  const expiry=read('CMC_SOURCE_POLICY_EXPIRES_AT')
  if(['CMC_ALLOW_HISTORICAL_RETENTION','CMC_ALLOW_AI_PROCESSING','INTEL_CHART_CMC_PRODUCT_SHARING'].includes(key)&&expiry!=null&&(!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=now))return 'false'
  return read(key)
 }
}
type Entry={expires:number,promise:Promise<CmcOperatingSettings>}
const projects=new Map<string,Entry>(),clients=new WeakMap<object,Entry>()
export function normalizeCmcOperatingSettings(input:unknown):CmcOperatingSettings{
 if(!input||typeof input!=='object'||Array.isArray(input))return {}
 const result:CmcOperatingSettings={}
 for(const key of keys){const value=(input as Record<string,unknown>)[key];if(typeof value==='string'&&value.length<=100)result[key]=value}
 return result
}
export async function loadCmcOperatingSettings(db:any,now=Date.now()):Promise<CmcOperatingSettings>{
 if(!db?.from)return {}
 const project=typeof db.supabaseUrl==='string'&&/^https:\/\/[^/]+\.supabase\.co\/?$/.test(db.supabaseUrl)?db.supabaseUrl:null
 const cached=project?projects.get(project):clients.get(db)
 if(cached&&cached.expires>now)return cached.promise
 const promise=(async()=>{try{
  const {data,error}=await db.from('provider_quota_budgets').select('config').eq('provider','coinmarketcap').eq('data_type','cmc_operating_profile').eq('period_start','1970-01-01T00:00:00Z').maybeSingle()
  return error?{}:normalizeCmcOperatingSettings(data?.config)
 }catch{return {}}})()
 const entry={expires:now+60000,promise}
 if(project){if(projects.size>=4&&!projects.has(project))projects.delete(projects.keys().next().value!);projects.set(project,entry)}else clients.set(db,entry)
 return promise
}
