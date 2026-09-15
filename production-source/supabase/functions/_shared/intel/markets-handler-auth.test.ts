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
 assertEquals(await r.json(),{catalog:null,snapshot:{strongestChain:null,freshness:'unavailable'},rows:[],total:0,page:0,limit:50,sort:null,dir:null,marketCapPanel:{topByMarketCap:[],estimatedCount:0},topGainers:[],topLosers:[],availableCategories:[],categoryLeaders:[],watchlistMovers:[],chainHeatmap:[],crossExchangeSpreads:[],providerStatus:[],nativeChains:[],nativeChainsUnavailable:false})
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
// ── DETAIL mode: identity + coverage ─────────────────────────────────────────
// A chainable, awaitable PostgREST stand-in. Every table answers from `tables`;
// unlisted tables answer empty, exactly as a real read with no rows would.
function detailFixture(fixtures:Record<string,Record<string,unknown>[]>){
 const tables={org_members:[{org_id:'org'}],profiles:[{is_super_admin:false}],...fixtures}
 const seen:string[]=[],fetched:string[]=[]
 const table=(name:string)=>{const rows=(tables as Record<string,Record<string,unknown>[]>)[name]||[];const q:any={_head:false}
  q.select=(_columns?:unknown,options?:any)=>{q._head=options?.head===true;return q}
  for(const method of ['eq','in','order','contains','gte','lte','or','not','neq','filter','ilike','limit','range','overlaps'])q[method]=()=>q
  q.maybeSingle=()=>Promise.resolve({data:rows[0]??null,error:null})
  q.single=q.maybeSingle
  q.insert=()=>Promise.resolve({data:null,error:null});q.upsert=q.insert
  q.then=(resolve:any,reject:any)=>Promise.resolve({data:q._head?null:rows,count:rows.length,error:null}).then(resolve,reject)
  return q}
 const db={auth:{getUser:()=>Promise.resolve({data:{user:{id:'verified-user'}},error:null})},
  from:(name:string)=>{seen.push(name);return table(name)},
  rpc:(name:string)=>{seen.push(`rpc:${name}`);return Promise.resolve({data:name==='can_access_intel'?true:{records:[],total:0,page:0,limit:50},error:null})}}
 return {factory:()=>db,chains:()=>Promise.resolve({rows:[],unavailable:false}),seen,fetched,
  stubFetch(){const original=globalThis.fetch;globalThis.fetch=((input:any)=>{fetched.push(String(input?.url||input));return Promise.resolve(new Response('{}',{status:503}))}) as typeof fetch;return()=>{globalThis.fetch=original}}}
}
const detailRequest=(body:Record<string,unknown>)=>new Request('https://fixture.test/intel-markets',{method:'POST',headers:{Authorization:'Bearer fixture-user','Content-Type':'application/json'},body:JSON.stringify({orgId:'org',...body})})
const CONTRACT_ADDRESS='So11111111111111111111111111111111111111112'
const memecoinRow={chain:'solana',token_address:CONTRACT_ADDRESS,symbol:'PEPE',name:'Pepe',image_url:'https://img.test/p.png',cached_image_url:null,
 price_usd:0.0042,change_1h_pct:1.5,change_24h_pct:-7,volume_24h_usd:500_000,liquidity_usd:90_000,fdv:4_200_000,market_cap:4_000_000,
 pair_address:'POOLAAA',dex_id:'orca',source:'dexscreener',source_provider:'dexscreener',source_label:'DEX Screener',
 attribution_label:'Data via DEX Screener',confidence:'medium',as_of:'2026-09-14T10:00:00.000Z',last_refreshed_at:'2026-09-14T10:00:00.000Z'}

Deno.test('Markets detail opens the full asset page for a pasted contract identity',()=>withEnv(async()=>{
 const f=detailFixture({memecoin_latest_tokens:[memecoinRow]}),restore=f.stubFetch()
 try {
  const r=await handleMarkets(detailRequest({sourceProvider:'contract',providerId:`solana:${CONTRACT_ADDRESS}`}),f.factory,f.chains)
  assertEquals(r.status,200)
  const body=await r.json()
  assertEquals(body.detail,true)
  assertEquals(body.identity,{kind:'contract',provider:'contract',providerId:`solana:${CONTRACT_ADDRESS}`,chain:'solana',address:CONTRACT_ADDRESS})
  // The quote is the observed memecoin row, never a same-ticker substitute.
  assertEquals(body.price,0.0042);assertEquals(body.quoteProvider,'contract');assertEquals(body.displayName,'Pepe')
  assertEquals(body.marketCap.market_cap,4_000_000);assertEquals(body.asOf,'2026-09-14T10:00:00.000Z')
  assertEquals(body.contract.chain,'solana');assertEquals(body.contract.address,CONTRACT_ADDRESS)
  assertEquals(body.contract.liquidityUsd,90_000);assertEquals(body.contract.pairAddress,'POOLAAA')
  assertEquals(body.contract.sources,[{provider:'dexscreener',state:'available',observedAt:'2026-09-14T10:00:00.000Z',reason:null}])
  // Every section is reported, with a reason wherever it cannot be filled.
  assertEquals(body.coverage.sections.length,12);assertEquals(body.coverage.totalCount,12)
  assertEquals(body.coverage.sections.map((s:any)=>s.key),['quote','candles','venues','derivatives','liquidity','contract','rwa','narrative','supply','metadata','signals','orderbook'])
  assertEquals(body.coverage.sections.find((s:any)=>s.key==='derivatives'),{key:'derivatives',state:'unavailable',reason:'no_coinmarketcap_listing'})
  assertEquals(body.coverage.sections.find((s:any)=>s.key==='rwa'),{key:'rwa',state:'not_applicable',reason:'contract_identity'})
  assertEquals(body.coverage.sections.find((s:any)=>s.key==='venues'),{key:'venues',state:'unavailable',reason:'no_verified_exchange_pair'})
  assertEquals(body.cexCoverage,'unverified')
  // No CoinMarketCap identity, so no CoinMarketCap request is ever made.
  assertEquals(f.fetched.some((u)=>/coinmarketcap/i.test(u)),false)
  assertEquals(f.seen.some((t)=>/^rpc:/.test(t)&&t!=='rpc:can_access_intel'),false)
 } finally { restore() }
}))
// The CoinMarketCap response shape is unchanged apart from `identity` and the
// now-explicit `coverage` object (which previously leaked the chart's coverage
// SENTENCE — still served verbatim as `chartCoverage`). A contract identity
// must never reshape a listed one.
const CMC_DETAIL_KEYS=['asOf','barIntervalMs','bestPair','bestProvider','candles','canonicalAssetKey','catalysts','cexCoverage','chain','change1h','change24h','change7d','chartAsset','chartCoverage','chartProvenance','chartReason','chartSource','chartState','coverage','depthQuotes','detail','dex','displayName','ecosystemNarratives','identity','identityChoices','identityState','imageUrl','marketCap','memorySummary','onchain','orderbook','price','primaryChain','profile','provenance','providerId','providers','quoteProvider','quoteProviderId','quoteReason','quoteRefreshSeconds','rollups','signal','source','sourceFreshness','sourceProvider','sourceReason','sourceState','spread','symbol','timestampMeaning','unlocks','volume24h','volumeUnit']
Deno.test('Markets detail for a CoinMarketCap identity keeps its response shape and gains only identity and coverage',()=>withEnv(async()=>{
 const cmcRow={source_provider:'coinmarketcap',provider_id:'1027',symbol:'ETH',normalized_symbol:'ETH',name:'Ethereum',primary_chain:'ethereum',
  platforms:{},current_price:3000,market_cap:360_000_000_000,fdv:null,volume_24h:12_000_000_000,change_1h_pct:0.2,change_24h_pct:1.1,change_7d_pct:4,
  circulating_supply:120_000_000,image_url:'https://img.test/eth.png',as_of:'2026-09-14T10:00:00.000Z'}
 const f=detailFixture({market_assets:[cmcRow]}),restore=f.stubFetch()
 try {
  const r=await handleMarkets(detailRequest({sourceProvider:'coinmarketcap',providerId:'1027'}),f.factory,f.chains)
  assertEquals(r.status,200)
  const body=await r.json()
  assertEquals(Object.keys(body).sort(),CMC_DETAIL_KEYS)
  assertEquals(typeof body.chartCoverage==='string'||body.chartCoverage===null,true)
  assertEquals(body.identity,{kind:'cmc',provider:'coinmarketcap',providerId:'1027',chain:'ethereum',address:null})
  assertEquals(body.coverage.sections.length,12)
  assertEquals(body.coverage.sections.find((s:any)=>s.key==='derivatives'),{key:'derivatives',state:'available'})
  assertEquals(body.coverage.sections.find((s:any)=>s.key==='rwa').state,'unavailable')
  assertEquals(body.contract,undefined)
  assertEquals(body.price,3000);assertEquals(body.symbol,'ETH');assertEquals(body.canonicalAssetKey,'eip155:1:native')
 } finally { restore() }
}))
Deno.test('Markets detail validation keeps its status and is included in total timing',()=>withEnv(async()=>{
 const f=fixture(),r=await handleMarkets(new Request('https://fixture.test/intel-markets',{method:'POST',headers:{Authorization:'Bearer fixture-user','Content-Type':'application/json'},body:JSON.stringify({orgId:'org',sourceProvider:'coinmarketcap',providerId:'1027',timeframe:'unsupported'})}),f.factory,f.chains)
 assertEquals(r.status,400);assertEquals(await r.json(),{error:'invalid_chart_range'})
 assertEquals(f.counts(),{userReads:1,chainReads:0,rpcs:['can_access_intel']})
 assertMatch(r.headers.get('Server-Timing')||'',/detail;dur=/)
 assertMatch(r.headers.get('Server-Timing')||'',/total;dur=/)
 assertEquals(r.headers.get('Cache-Control'),'private, no-store')
}))
