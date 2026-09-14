import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {loadCmcOperatingSettings,normalizeCmcOperatingSettings,cmcPolicyEnvironment,cmcLiveActivation} from './cmc-operating-settings.ts'
import {cmcPlan,cmcCreditCeiling,requestCmc} from './cmc-transport.ts'
const startup={CMC_ACCESS_PROFILE:'hackathon',CMC_VERIFIED_HACKATHON_PLAN:'startup',CMC_VERIFIED_BASELINE_PLAN:'basic',CMC_HACKATHON_EXPIRES_AT:'2026-09-30T23:59:00Z',CMC_MONTHLY_CREDIT_CEILING:'360000'}
const names=Object.keys(startup)
Deno.test('product retention and analysis policy is bounded, expires, and never grants export or stream access',()=>{
 const now=Date.parse('2026-09-11T00:00:00Z'),settings={CMC_ALLOW_HISTORICAL_RETENTION:'true',CMC_ALLOW_AI_PROCESSING:'true',INTEL_CHART_CMC_PRODUCT_SHARING:'true',CMC_SOURCE_POLICY_EXPIRES_AT:'2026-09-30T00:00:00Z'}
 const current=cmcPolicyEnvironment(normalizeCmcOperatingSettings({...settings,CMC_ALLOW_EXPORT:'true'}),()=>undefined,now)
 eq(current('CMC_ALLOW_HISTORICAL_RETENTION'),'true');eq(current('CMC_ALLOW_EXPORT'),undefined);eq(current('CMC_LIVE_ENABLED'),undefined)
 eq(cmcPolicyEnvironment(settings,()=>undefined,Date.parse(settings.CMC_SOURCE_POLICY_EXPIRES_AT))('CMC_ALLOW_HISTORICAL_RETENTION'),'false')
 eq(cmcPolicyEnvironment(settings,k=>k==='CMC_ALLOW_HISTORICAL_RETENTION'?'false':undefined,now)('CMC_ALLOW_HISTORICAL_RETENTION'),'false')
 eq(cmcPolicyEnvironment({...settings,CMC_SOURCE_POLICY_EXPIRES_AT:'invalid'},()=>undefined,now)('CMC_ALLOW_AI_PROCESSING'),'false')
})
async function clean(fn:()=>Promise<void>){const saved=names.map(n=>Deno.env.get(n));names.forEach(n=>Deno.env.delete(n));try{await fn()}finally{names.forEach((n,i)=>saved[i]==null?Deno.env.delete(n):Deno.env.set(n,saved[i]!))}}
function database(config:any,url?:string){let reads=0,error=false;const db={supabaseUrl:url,from:(table:string)=>{eq(table,'provider_quota_budgets');const q:any={select:()=>q,eq:()=>q,maybeSingle:()=>{reads++;return Promise.resolve({data:{config},error:error?{}:null})}};return q}};return {db,reads:()=>reads,fail:()=>{error=true}}}
Deno.test('operating policy admits only bounded non-secret settings',()=>{eq(normalizeCmcOperatingSettings({...startup,CMC_API_KEY:'never',CMC_ALLOW_EXPORT:'true'}),startup);eq(normalizeCmcOperatingSettings({CMC_ACCESS_PROFILE:'x'.repeat(101)}),{})})
Deno.test('live activation is explicit, shares operating configuration, and either disable wins',()=>{
 eq(cmcLiveActivation({},()=>undefined),false)
 eq(cmcLiveActivation({CMC_ALLOW_HISTORICAL_RETENTION:'true'},()=>undefined),false)
 eq(cmcLiveActivation(normalizeCmcOperatingSettings({CMC_LIVE_ENABLED:'true'}),()=>undefined),true)
 eq(cmcLiveActivation({CMC_LIVE_ENABLED:'true'},()=> 'false'),false)
 eq(cmcLiveActivation({CMC_LIVE_ENABLED:'false'},()=> 'true'),false)
 eq(cmcLiveActivation({CMC_LIVE_ENABLED:'TRUE'},()=>undefined),false)
})
Deno.test('100 readers and separate clients for one project share one policy read',async()=>{const first=database(startup,'https://cmc-policy-a.supabase.co'),second=database({},'https://cmc-policy-a.supabase.co');const values=await Promise.all(Array.from({length:100},(_,i)=>loadCmcOperatingSettings(i%2?first.db:second.db,1000)));eq(first.reads()+second.reads(),1);eq(values.every(x=>JSON.stringify(x)===JSON.stringify(values[0])),true)})
Deno.test('projects cannot inherit another project operating tier',async()=>{const one=database(startup,'https://cmc-policy-b.supabase.co'),two=database({},'https://cmc-policy-c.supabase.co');eq(await loadCmcOperatingSettings(one.db,1000),startup);eq(await loadCmcOperatingSettings(two.db,1000),{})})
Deno.test('policy expires after a minute and a failed read cannot retain Startup indefinitely',async()=>{const value=database(startup);eq(await loadCmcOperatingSettings(value.db,1000),startup);value.fail();eq(await loadCmcOperatingSettings(value.db,60999),startup);eq(await loadCmcOperatingSettings(value.db,61000),{});eq(value.reads(),2)})
Deno.test('database profile expires to the declared baseline and caps spending',()=>clean(async()=>{eq(cmcPlan(Date.parse('2026-09-10T00:00:00Z'),startup),'startup');eq(cmcPlan(Date.parse('2026-10-01T00:00:00Z'),startup),'basic');eq(cmcPlan(Date.parse('2026-09-10T00:00:00Z'),{...startup,CMC_HACKATHON_EXPIRES_AT:'invalid'}),'basic');eq(cmcCreditCeiling(startup),360000);Deno.env.set('CMC_MONTHLY_CREDIT_CEILING','100');eq(cmcCreditCeiling(startup),100)}))
Deno.test('explicit baseline override remains authoritative over database promotion',()=>clean(async()=>{Deno.env.set('CMC_ACCESS_PROFILE','baseline');eq(cmcPlan(Date.parse('2026-09-10T00:00:00Z'),startup),'basic')}))
Deno.test('transport uses database Startup policy without new environment secrets',()=>clean(async()=>{let requestKey='';const db={from:(table:string)=>{const q:any={select:()=>q,eq:(field:string,value:string)=>{if(field==='cache_key')requestKey=value;return q},maybeSingle:()=>Promise.resolve({data:table==='provider_quota_budgets'?{config:startup}:null})};return q},rpc:()=>Promise.resolve({data:{allowed:false,reason:'budget_exceeded'}})};const saved=Deno.env.get('COINMARKETCAP_API_KEY');Deno.env.set('COINMARKETCAP_API_KEY','synthetic-policy-test');try{const result=await requestCmc('ohlcv',{id:1,count:10},{supabase:db,kind:'render'});eq(result.reason,'refresh_required');eq(requestKey.startsWith('cmc:v3:startup:'),true)}finally{saved==null?Deno.env.delete('COINMARKETCAP_API_KEY'):Deno.env.set('COINMARKETCAP_API_KEY',saved)}}))

