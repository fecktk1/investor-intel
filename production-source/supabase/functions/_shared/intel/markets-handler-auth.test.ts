import {assert,assertEquals,assertMatch} from 'jsr:@std/assert@1'
import {handleMarkets} from '../../intel-markets/index.ts'
function fixture({member=true,allowed=true,valid=true,screenError=false}={}) {
 let userReads=0,chainReads=0;const rpcs:string[]=[]
 const db={auth:{getUser:()=>{userReads++;return Promise.resolve({data:{user:valid?{id:'verified-user'}:null},error:null})}},from:(table:string)=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:table==='org_members'&&member?{org_id:'org'}:table==='profiles'?{is_super_admin:false}:null})};return q},rpc:(name:string)=>{rpcs.push(name);return Promise.resolve({data:name==='can_access_intel'?allowed:{records:[],total:0,page:0,limit:50},error:screenError&&name==='intel_markets_screen_for_user'?{code:'42P01',message:'unavailable'}:null})}}
 return {factory:()=>db,chains:()=>{chainReads++;return Promise.resolve({rows:[],unavailable:false})},counts:()=>({userReads,chainReads,rpcs})}
}
async function withEnv(fn:()=>Promise<void>){const keys={SUPABASE_URL:'https://fixture.test',SUPABASE_ANON_KEY:'fixture-anon'},before=Object.fromEntries(Object.keys(keys).map(k=>[k,Deno.env.get(k)]));try{for(const[k,v]of Object.entries(keys))Deno.env.set(k,v);await fn()}finally{for(const[k,v]of Object.entries(before))if(v===undefined)Deno.env.delete(k);else Deno.env.set(k,v)}}
const request=(header='Bearer fixture-user')=>new Request('https://fixture.test/intel-markets',{method:'POST',headers:{Authorization:header,'Content-Type':'application/json'},body:JSON.stringify({orgId:'org'})})
Deno.test('Markets verifies the user exactly once, then checks organization and entitlement before cached reads',()=>withEnv(async()=>{
 const f=fixture(),r=await handleMarkets(request(),f.factory,f.chains);assertEquals(r.status,200);assertEquals(f.counts(),{userReads:1,chainReads:1,rpcs:['can_access_intel','intel_markets_screen_for_user']})
 const timing=r.headers.get('Server-Timing')||'';assertEquals(timing.split(', ').map(v=>v.split(';')[0]).sort(),['access','assemble','body','native','region','runtime','screen','total','trace']);assertEquals(/verified-user|org|fixture/.test(timing),false);assertEquals(r.headers.get('Timing-Allow-Origin'),'*')
 assertEquals(await r.json(),{catalog:null,snapshot:{strongestChain:null,freshness:'unavailable'},rows:[],total:0,page:0,limit:50,marketCapPanel:{topByMarketCap:[],estimatedCount:0},topGainers:[],topLosers:[],availableCategories:[],categoryLeaders:[],watchlistMovers:[],chainHeatmap:[],crossExchangeSpreads:[],providerStatus:[],nativeChains:[],nativeChainsUnavailable:false})
}))
for(const [label,config,status]of [['invalid user',{valid:false},401],['other organization',{member:false},403],['expired entitlement',{allowed:false},403]] as const)Deno.test(`Markets ${label} cannot reach market or chain reads`,()=>withEnv(async()=>{
 const f=fixture(config),r=await handleMarkets(request(),f.factory,f.chains);assertEquals(r.status,status);assertEquals(f.counts().chainReads,0);assertEquals(f.counts().rpcs.includes('intel_markets_screen_for_user'),false)
}))
Deno.test('Markets missing credentials remains denied',()=>withEnv(async()=>{
 const f=fixture(),r=await handleMarkets(request(''),f.factory,f.chains);assertEquals(r.status,401);assertEquals(f.counts().chainReads,0)
}))
Deno.test('Markets trace correlates safe response timings without logging request words or identities',()=>withEnv(async()=>{
 const messages:unknown[][]=[],emit=console.info,oldRegion=Deno.env.get('SB_REGION')
 try {
  console.info=(...args)=>{messages.push(args)};Deno.env.set('SB_REGION','us-east-1')
  const f=fixture(),r=await handleMarkets(new Request('https://fixture.test/intel-markets?secret=never-log',{method:'POST',headers:{Authorization:'Bearer never-log','Content-Type':'application/json','x-request-id':'untrusted-input'},body:JSON.stringify({orgId:'org',search:'private research words'})}),f.factory,f.chains)
  const timing=r.headers.get('Server-Timing')||'',id=timing.match(/trace;desc="([^"]+)"/)?.[1]||''
  assertMatch(id,/^[0-9a-f]{8}-[0-9a-f-]{27}$/);assert(timing.includes('region;desc="us-east-1"'))
  const logged=JSON.stringify(messages);assert(logged.includes(id));assert(!/never-log|private research words|verified-user|untrusted-input/.test(logged))
  const durations=[...timing.matchAll(/(\w+);dur=([\d.]+)/g)].map(([,name,value])=>[name,Number(value)] as const)
  assert(durations.every(([,v])=>Number.isFinite(v)&&v>=0));const total=durations.find(([k])=>k==='total')?.[1]??-1
  assert(total>=Math.max(...durations.map(([,v])=>v)))
 }finally{console.info=emit;if(oldRegion===undefined)Deno.env.delete('SB_REGION');else Deno.env.set('SB_REGION',oldRegion)}
}))
Deno.test('Markets failed screen remains a 503 with an attributable completed request',()=>withEnv(async()=>{
 const f=fixture({screenError:true}),r=await handleMarkets(request(),f.factory,f.chains)
 assertEquals(r.status,503);assertEquals(await r.json(),{error:'market_snapshot_unavailable'});assertMatch(r.headers.get('Server-Timing')||'',/total;dur=/)
}))
Deno.test('Markets denied requests are timed without reading any market data',()=>withEnv(async()=>{
 const f=fixture({member:false}),r=await handleMarkets(request(),f.factory,f.chains)
 assertEquals(r.status,403);assertMatch(r.headers.get('Server-Timing')||'',/total;dur=/);assert(!r.headers.get('Server-Timing')?.includes('screen;'))
}))
Deno.test('Markets preflight permission is bounded and does not cache or authorize personal reads',()=>withEnv(async()=>{
 const f=fixture(),preflight=await handleMarkets(new Request('https://fixture.test/intel-markets',{method:'OPTIONS',headers:{Origin:'https://thecontentforge.io','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,apikey,x-client-info'}}),f.factory,f.chains)
 assertEquals(preflight.status,200);assertEquals(await preflight.text(),'ok')
 assertEquals(preflight.headers.get('Access-Control-Max-Age'),'600')
 assertEquals(preflight.headers.get('Access-Control-Allow-Origin'),'*')
 assertEquals(preflight.headers.get('Access-Control-Allow-Headers'),'authorization, x-client-info, apikey, content-type')
 assertEquals(f.counts(),{userReads:0,chainReads:0,rpcs:[]})
 const denied=await handleMarkets(request(''),f.factory,f.chains)
 assertEquals(denied.status,401);assertEquals(denied.headers.get('Cache-Control'),'private, no-store')
 const allowed=await handleMarkets(request(),f.factory,f.chains)
 assertEquals(allowed.status,200);assertEquals(allowed.headers.get('Cache-Control'),'private, no-store')
 assertEquals(allowed.headers.get('Access-Control-Max-Age'),null)
 assertEquals(f.counts().userReads,1)
}))
Deno.test('Markets detail validation keeps its status and is included in total timing',()=>withEnv(async()=>{
 const f=fixture(),r=await handleMarkets(new Request('https://fixture.test/intel-markets',{method:'POST',headers:{Authorization:'Bearer fixture-user','Content-Type':'application/json'},body:JSON.stringify({orgId:'org',sourceProvider:'coinmarketcap',providerId:'1027',timeframe:'unsupported'})}),f.factory,f.chains)
 assertEquals(r.status,400);assertEquals(await r.json(),{error:'invalid_chart_range'})
 assertEquals(f.counts(),{userReads:1,chainReads:0,rpcs:['can_access_intel']})
 assertMatch(r.headers.get('Server-Timing')||'',/detail;dur=/)
 assertMatch(r.headers.get('Server-Timing')||'',/total;dur=/)
 assertEquals(r.headers.get('Cache-Control'),'private, no-store')
}))
