import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {investigationService} from './investigation-service.ts'
const actor={orgId:'10000000-0000-4000-8000-000000000001',userId:'20000000-0000-4000-8000-000000000001'},view='30000000-0000-4000-8000-000000000001'
function database(fail=false){
 const calls:any[]=[]
 return {calls,from:(name:string)=>{calls.push(['from',name]);if(name!=='provider_quota_budgets')throw Error('A release must not read price history or fetch provider data');const q:any={select:()=>q,eq:()=>q,maybeSingle:()=>Promise.resolve({data:{config:{}},error:null})};return q},rpc:(name:string,args:any)=>{calls.push(['rpc',name,args]);return Promise.resolve({data:null,error:fail?{message:'storage failure'}:null})}}
}
Deno.test('release forwards the exact authorized view lease and skips market reads',async()=>{
 const db=database(),response=await investigationService(db,actor,{subject:'native:bitcoin',operation:'live',enabled:false,viewId:view})
 eq(db.calls.filter(c=>c[0]==='rpc'),[['rpc','intel_live_focus_touch',{p_org:actor.orgId,p_user:actor.userId,p_subject:'market:coinmarketcap:1',p_enabled:false,p_view:view}]])
 eq(response,{state:'paused',reason:null,observation:null,expiresAt:null})
})
Deno.test('old clients keep the separate legacy RPC signature',async()=>{
 const db=database();await investigationService(db,actor,{subject:'native:bitcoin',operation:'live',enabled:false})
 eq('p_view' in db.calls.find(c=>c[0]==='rpc')[2],false)
})
Deno.test('invalid view identities are rejected before demand mutation',async()=>{
 for(const viewId of ['other-tab',{},'30000000-0000-4000-8000-000000000001'.repeat(100)]){
  const db=database();await assertRejects(()=>investigationService(db,actor,{subject:'native:bitcoin',operation:'live',enabled:false,viewId}),Error,'invalid_live_focus');eq(db.calls.some(c=>c[0]==='rpc'),false)
 }
})
Deno.test('failed demand release is a failure, never a successful pause receipt',async()=>{
 await assertRejects(()=>investigationService(database(true),actor,{subject:'native:bitcoin',operation:'live',enabled:false,viewId:view}),Error,'investigation_storage_unavailable')
})

const evm='0x'+'ab'.repeat(20),contract=`contract:base:${evm}`,canonical=`eip155:8453:${evm}`
const config={CMC_LIVE_ENABLED:'true',CMC_VERIFIED_BASELINE_PLAN:'startup'}
/** A reader fake: every builder is thenable, so `await query` resolves rows. */
function tapeDatabase(observations:any[]=[],leases:any[]=[],settings:Record<string,string>={}){
 const calls:any[]=[]
 const rows=(name:string)=>name==='intel_market_observations'?observations:name==='intel_live_focus_demands'?leases:[]
 return {calls,rpc:(name:string,args:any)=>{calls.push(['rpc',name,args]);return Promise.resolve({data:'2026-09-15T03:00:45Z',error:null})},
  from:(name:string)=>{const q:any={select:()=>q,eq:(k:string,v:any)=>{calls.push(['eq',name,k,v]);return q},in:(k:string,v:any)=>{calls.push(['in',name,k,v]);return q},
   gt:(k:string,v:any)=>{calls.push(['gt',name,k,v]);return q},order:()=>q,limit:(n:number)=>{calls.push(['limit',name,n]);return q},
   maybeSingle:()=>Promise.resolve({data:{config:settings},error:null}),
   then:(res:any,rej:any)=>Promise.resolve({data:rows(name),error:null}).then(res,rej)};calls.push(['from',name]);return q}}
}
const now=Date.parse('2026-09-15T03:00:00Z')
const observation=(metric:string,value:number,metadata:any={})=>({observation:{id:'cmc:'+metric,subject:canonical,provider:'coinmarketcap',metric,value,
 unit:metric==='unique_traders'?'accounts':'USD',observedAt:new Date(now-1000).toISOString(),metadata}})

Deno.test('the tape reports each kind with its metric, unit, clock and evidence metadata',async()=>{
 const db=tapeDatabase([observation('swap_event_usd',1250.5,{transaction:'0xfeed',venue:'Uniswap v3',eventType:'buy'}),observation('unique_traders',412)],
  [{user_id:actor.userId,expires_at:'2026-09-15T03:00:40Z'},{user_id:actor.userId,expires_at:'2026-09-15T03:00:45Z'}])
 const response:any=await investigationService(db,actor,{subject:contract,operation:'tape',since:new Date(now-60000).toISOString()},now)
 eq(response.subject,contract)
 eq(response.observationSubject,canonical,'events live under the REST DEX subject, not a second namespace')
 eq(db.calls.find(c=>c[0]==='eq'&&c[1]==='intel_market_observations'&&c[2]==='subject')?.[3],canonical)
 eq(db.calls.some(c=>c[0]==='eq'&&c[1]==='intel_live_focus_demands'&&c[2]==='subject'&&c[3]===contract),true,'the lease is still addressed by the lease grammar')
 eq(response.events,[{kind:'swap',metric:'swap_event_usd',value:1250.5,unit:'USD',observedAt:new Date(now-1000).toISOString(),metadata:{transaction:'0xfeed',venue:'Uniswap v3',eventType:'buy'}},
  {kind:'traders',metric:'unique_traders',value:412,unit:'accounts',observedAt:new Date(now-1000).toISOString(),metadata:{}}])
 eq(response.asOf,new Date(now).toISOString())
 eq(response.lease,{active:true,expiresAt:'2026-09-15T03:00:45Z',viewers:1},'two windows of one member are one viewer')
 eq(response.reason,null)
 eq(db.calls.some(c=>c[0]==='rpc'),false,'a read never touches a lease')
 eq(db.calls.find(c=>c[0]==='in'&&c[1]==='intel_market_observations')?.[3],['swap_event_usd','liquidity_event_usd','swap_volume_usd','unique_traders'])
 eq(db.calls.find(c=>c[0]==='limit'&&c[1]==='intel_market_observations')?.[2],500,'the read is bounded')
 eq(db.calls.some(c=>c[0]==='eq'&&c[1]==='intel_live_focus_demands'&&c[2]==='org_id'&&c[3]===actor.orgId),true,'lease state never leaves the caller org')
})
Deno.test('a quiet contract with a lease is quiet; without one the reason is the missing lease',async()=>{
 const quiet:any=await investigationService(tapeDatabase([],[{user_id:actor.userId,expires_at:'2026-09-15T03:00:45Z'}]),actor,{subject:contract,operation:'tape'},now)
 eq([quiet.events.length,quiet.lease.active,quiet.reason],[0,true,null])
 const dark:any=await investigationService(tapeDatabase(),actor,{subject:contract,operation:'tape'},now)
 eq([dark.events.length,dark.lease,dark.reason],[0,{active:false,expiresAt:null,viewers:0},'no_live_lease'])
})
Deno.test('the tape accepts every grammar that names the same contract, and nothing else',async()=>{
 for(const subject of [contract,canonical,`eip155:8453/erc20:0x${'AB'.repeat(20)}`]){
  const response:any=await investigationService(tapeDatabase(),actor,{subject,operation:'tape'},now)
  eq(response.subject,contract,subject)
 }
 eq((await investigationService(tapeDatabase(),actor,{subject:'native:bitcoin',operation:'tape'},now) as any).subject,'market:coinmarketcap:1')
 for(const subject of ['BTC','contract:bnb:'+evm,`contract:base:${evm.slice(0,-1)}`,null,42])
  await assertRejects(()=>investigationService(tapeDatabase(),actor,{subject,operation:'tape'},now),Error,'invalid_live_tape')
})
Deno.test('the tape window is bounded and never reaches into history',async()=>{
 for(const since of [new Date(now-3600001).toISOString(),new Date(now+5000).toISOString(),'not-a-time'])
  await assertRejects(()=>investigationService(tapeDatabase(),actor,{subject:contract,operation:'tape',since},now),Error,'invalid_live_tape_since')
 const db=tapeDatabase()
 await investigationService(db,actor,{subject:contract,operation:'tape'},now)
 eq(db.calls.find(c=>c[0]==='gt'&&c[1]==='intel_market_observations'&&c[2]==='observed_at')?.[3],new Date(now-300000).toISOString(),'five minutes by default')
 eq(db.calls.some(c=>c[0]==='gt'&&c[1]==='intel_market_observations'&&c[2]==='retain_until'),true,'expired evidence is never served')
})
Deno.test('a contract lease is refused until the on-chain tape flag is set, and pausing one always works',async()=>{
 Deno.env.delete('CMC_LIVE_ONCHAIN_ENABLED');Deno.env.set('CMC_LIVE_ENABLED','true')
 try{
  const off=tapeDatabase([],[],config)
  eq(await investigationService(off,actor,{subject:canonical,operation:'live',enabled:true,viewId:view},now),
   {state:'polling',reason:'Shared live focus is not enabled for the current operating profile.',observation:null})
  eq(off.calls.some(c=>c[0]==='rpc'),false,'no lease exists while the tape is off, so the released worker plan is unchanged')
  const paused=tapeDatabase([],[],config)
  eq((await investigationService(paused,actor,{subject:canonical,operation:'live',enabled:false,viewId:view},now) as any).state,'paused')
  eq(paused.calls.find(c=>c[0]==='rpc')?.[2].p_subject,contract,'a release always reaches the exact lease grammar')
  Deno.env.set('CMC_LIVE_ONCHAIN_ENABLED','true')
  const on=tapeDatabase([],[],config)
  const started:any=await investigationService(on,actor,{subject:canonical,operation:'live',enabled:true,viewId:view},now)
  eq(on.calls.find(c=>c[0]==='rpc')?.[2],{p_org:actor.orgId,p_user:actor.userId,p_subject:contract,p_enabled:true,p_view:view})
  eq(on.calls.find(c=>c[0]==='in'&&c[1]==='intel_market_observations')?.[3],['swap_event_usd','liquidity_event_usd','swap_volume_usd','unique_traders'])
  eq(on.calls.find(c=>c[0]==='eq'&&c[1]==='intel_market_observations'&&c[2]==='subject')?.[3],canonical)
  eq([started.state,started.expiresAt],['polling','2026-09-15T03:00:45Z'])
  const market=tapeDatabase([],[],config)
  await investigationService(market,actor,{subject:'native:bitcoin',operation:'live',enabled:true,viewId:view},now)
  eq(market.calls.find(c=>c[0]==='rpc')?.[2].p_subject,'market:coinmarketcap:1')
  eq(market.calls.some(c=>c[0]==='eq'&&c[2]==='metric'&&c[3]==='price'),true,'the price lane is untouched')
 }finally{Deno.env.delete('CMC_LIVE_ONCHAIN_ENABLED');Deno.env.delete('CMC_LIVE_ENABLED')}
})
