// The six tools added on 2026-09-22 (mcp-readings.ts), against a stub database.
//
// Same approach as mcp-tools.test.ts: every call goes through callMcpTool, so the
// schema, scope and tier gates are always in the path. The stub here also orders
// and range-filters, because these read modules find "the newest snapshot" and
// "the one before it" through order and lt, and a stub that ignored them would
// test a different read than production runs.

import {assert,assertEquals,assertAlmostEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {callMcpTool,getMcpPrompt,MCP_TOOLS,type ToolContext} from './mcp-tools.ts'
import {MARKET_FIGURE_NAMES,HISTORY_WRAPPER_CAP} from './mcp-readings.ts'
import {fitToBudget,SERIES_POINT_CAP,SERIES_TOTAL_CAP,RESULT_BYTE_BUDGET} from './mcp-size.ts'
import {rowExitScenarios as portedScenariosTyped,exitEstimate as portedEstimateTyped} from './rwa-exit-capacity.ts'
// deno-lint-ignore no-explicit-any
const portedScenarios=portedScenariosTyped as (row:any,inputs:any)=>unknown
// deno-lint-ignore no-explicit-any
const portedEstimate=portedEstimateTyped as (args:any)=>unknown
import {POOL_CLASSIFICATION} from './rwa-counter-leg.ts'
import {AGENT_SCOPES,type AgentContext} from './agent-token.ts'
// The original the port must match. Tests are not bundled into a function, so
// reading across into src/ is fine here and nowhere else.
import * as original from '../../../../src/intel/lib/rwa-exit-capacity.js'
// deno-lint-ignore no-explicit-any
const originalScenarios=original.rowExitScenarios as (row:any,inputs:any)=>unknown
// deno-lint-ignore no-explicit-any
const originalEstimate=original.exitEstimate as (args:any)=>unknown

// ── The stub ────────────────────────────────────────────────────────────────

type Row=Record<string,unknown>
const cmp=(a:unknown,b:unknown):number => {
 const na=Number(a),nb=Number(b)
 if(typeof a==='number'||typeof b==='number'){if(Number.isFinite(na)&&Number.isFinite(nb))return na-nb}
 return String(a??'').localeCompare(String(b??''))
}

function stubDb(tables:Record<string,Row[]>) {
 const from=(table:string)=>{
  const filters:Array<(row:Row)=>boolean>=[]
  const orders:Array<[string,boolean]>=[]
  let limit=Infinity,offset=0
  const rows=()=>{
   let out=(tables[table]??[]).filter(row=>filters.every(f=>f(row)))
   if(orders.length){
    out=[...out].sort((a,b)=>{
     for(const [column,ascending] of orders){
      const av=a[column],bv=b[column]
      if(av==null&&bv==null)continue
      if(av==null)return 1
      if(bv==null)return -1
      const c=cmp(av,bv)
      if(c!==0)return ascending?c:-c
     }
     return 0
    })
   }
   return {data:out.slice(offset,offset+limit),error:null}
  }
  // deno-lint-ignore no-explicit-any
  const chain:any={
   select:()=>chain,not:()=>chain,or:()=>chain,is:()=>chain,
   eq:(c:string,v:unknown)=>{filters.push(row=>String(row[c]??'')===String(v));return chain},
   in:(c:string,v:unknown[])=>{const set=new Set(v.map(String));filters.push(row=>set.has(String(row[c]??'')));return chain},
   gte:(c:string,v:unknown)=>{filters.push(row=>row[c]!=null&&cmp(row[c],v)>=0);return chain},
   gt:(c:string,v:unknown)=>{filters.push(row=>row[c]!=null&&cmp(row[c],v)>0);return chain},
   lte:(c:string,v:unknown)=>{filters.push(row=>row[c]!=null&&cmp(row[c],v)<=0);return chain},
   lt:(c:string,v:unknown)=>{filters.push(row=>row[c]!=null&&cmp(row[c],v)<0);return chain},
   order:(c:string,o?:{ascending?:boolean})=>{orders.push([c,o?.ascending!==false]);return chain},
   limit:(n:number)=>{limit=n;return chain},
   range:(a:number,b:number)=>{offset=a;limit=b-a+1;return Promise.resolve(rows())},
   maybeSingle:()=>Promise.resolve({data:rows().data[0]??null,error:null}),
   then:(fn:(v:unknown)=>unknown,err?:(e:unknown)=>unknown)=>Promise.resolve(rows()).then(fn,err),
  }
  return chain
 }
 return {
  from,
  // deno-lint-ignore no-explicit-any
  rpc:(name:string,_args:any)=>Promise.resolve({data:name==='intel_surface_allowed'?true:null,error:null}),
 }
}

const TOKEN_ID='11111111-1111-4111-8111-111111111111'
const agent:AgentContext={
 tokenId:TOKEN_ID,userId:'user-1',orgId:'org-1',tokenName:'Laptop agent',scopes:[...AGENT_SCOPES],role:'owner',
 actor:{human_user_id:'user-1',org_id:'org-1',role:'owner',token_id:TOKEN_ID,source:'agent_token',request_id:'req-1'},
}
const NOW=Date.parse('2026-09-22T15:00:00.000Z')
const TODAY='2026-09-22',YESTERDAY='2026-09-21'
const CAPTURED='2026-09-22T03:19:00.000Z'

function ctx(tables:Record<string,Row[]>):ToolContext {
 // deno-lint-ignore no-explicit-any
 return {db:stubDb(tables) as any,agent,now:NOW,tier:'free',minTier:{capture_views:'free'}}
}

async function call(context:ToolContext,name:string,args:Record<string,unknown>={}) {
 const result=await callMcpTool(context,name,args)
 // deno-lint-ignore no-explicit-any
 const payload=(result.result.structuredContent??{}) as Record<string,any>
 return {...result,payload,data:payload.data??{},bytes:JSON.stringify(result.result).length}
}

/** The ceiling mcp-tools.test.ts pins for the biggest tool on the server. */
const RESULT_CEILING=120_000

function assertGrounded(payload:Record<string,unknown>,tool:string) {
 assertEquals(payload.tool,tool)
 assert('as_of' in payload,`${tool} must carry as_of`)
 assert(payload.source,`${tool} must carry source`)
 assert(payload.calculated_by==='provider'||payload.calculated_by==='investor_intel')
 if(payload.calculated_by==='investor_intel')assert(Array.isArray(payload.inputs)&&(payload.inputs as unknown[]).length>0,`${tool} must name its inputs`)
 const tier=payload.tier as Record<string,unknown>
 assertEquals(tier.surface,'capture_views')
 assertEquals(tier.open,true)
}

// ── The catalogue ───────────────────────────────────────────────────────────

const NEW_TOOLS=['rwa_coverage','rwa_universe_changes','rwa_issuer_concentration','rwa_premium_history','rwa_exit_capacity','market_structure']

Deno.test('the six new tools are in the catalogue, on capture_views, read only and open on every tier',()=>{
 for(const name of NEW_TOOLS){
  const tool=MCP_TOOLS.find(t=>t.name===name)
  assert(tool,`${name} must be registered`)
  assertEquals(tool!.surface,'capture_views')
  assertEquals(tool!.scope,undefined,`${name} reads shared intelligence and needs no scope`)
 }
 // The regime and FX must not be exposed a second time through market_structure.
 for(const figure of ['regime','regime_at','fx','rwa_universe','new_listings'])
  assert(!MARKET_FIGURE_NAMES.includes(figure),`${figure} is already covered elsewhere`)
 const dd=getMcpPrompt('rwa_due_diligence',{subject:'rwa:coinmarketcap:1'})!.messages[0].content.text
 for(const tool of ['rwa_coverage','rwa_issuer_concentration','rwa_premium_history','rwa_exit_capacity'])
  assert(dd.includes(tool),`the due diligence prompt should use ${tool}`)
})

// ── Every new tool on an empty database ─────────────────────────────────────

Deno.test('every new tool answers an empty database with a grounded envelope and a note, never an error',async()=>{
 const empty=ctx({})
 const cases:Array<[string,Record<string,unknown>]>=[
  ['rwa_coverage',{}],['rwa_universe_changes',{}],['rwa_issuer_concentration',{}],
  ['rwa_premium_history',{rwa_id:'1'}],['rwa_exit_capacity',{crypto_id:'4705',position_usd:1000}],
  ...MARKET_FIGURE_NAMES.map(figure=>['market_structure',{
   figure,...(figure==='liquidations'?{provider_ids:['1']}:figure==='attention'?{provider_id:'1'}:{}),
  }] as [string,Record<string,unknown>]),
 ]
 for(const [name,args] of cases){
  const result=await call(empty,name,args)
  assertEquals(result.outcome,'served',`${name} ${JSON.stringify(args)}: ${result.result.content[0].text.slice(0,300)}`)
  assertGrounded(result.payload,name)
  assertEquals(result.payload.as_of,null,`${name} ${JSON.stringify(args)} must not invent a capture time`)
  assert(typeof result.payload.note==='string'&&result.payload.note.length>10,`${name} ${JSON.stringify(args)} must say why it is empty`)
 }
})

// ── rwa_coverage ────────────────────────────────────────────────────────────

function coverageTables():Record<string,Row[]> {
 const asset=(rwa_id:string,asset_type:string,coverage_state:string,token_count:number,snapshot_date=TODAY)=>({rwa_id,asset_type,coverage_state,token_count,priced_count:0,traded_count:0,snapshot_date,captured_at:CAPTURED})
 return {
  intel_rwa_coverage_assets:[
   asset('1','commodity','tradeable',3),asset('2','commodity','priced_not_traded',1),asset('3','stock','tradeable',2),
   asset('4','stock','listed_only',1),asset('5','stock','no_tokens_reported',0),asset('6','treasury','not_returned',0),
   asset('1','commodity','tradeable',3,YESTERDAY),
  ],
  intel_rwa_coverage_tokens:[
   {snapshot_date:TODAY,rwa_id:'7',crypto_id:'29000',symbol:'OUSG',name:'Ondo Short-Term US Government Bond Fund',market_cap:6.9e8,volume_24h:0,token_state:'priced_not_traded'},
  ],
  market_assets:[
   // BUIDL is in the catalogue from CoinGecko only: present, but not the CoinMarketCap RWA answer.
   {source_provider:'coingecko',provider_id:'blackrock-usd-institutional-digital-liquidity-fund',symbol:'BUIDL',name:'BlackRock USD Institutional Digital Liquidity Fund',market_cap:2.4e9,volume_24h:null,in_current_catalog:true},
   // BENJI is seen under a name that is not the fund: never counted as present.
   {source_provider:'coinmarketcap',provider_id:'99999',symbol:'BENJI',name:'Benjamin Token',market_cap:1000,volume_24h:5,in_current_catalog:true},
  ],
  intel_rwa_asset_map_counts:[{asset_type:'all',snapshot_date:TODAY,asset_count:6,with_tokens_count:5,truncated:false,captured_at:CAPTURED}],
 }
}

Deno.test('rwa_coverage: headline, states, types and an expected-ticker watch that separates present from the CoinMarketCap answer',async()=>{
 const result=await call(ctx(coverageTables()),'rwa_coverage')
 assertEquals(result.outcome,'served')
 assertGrounded(result.payload,'rwa_coverage')
 assertEquals(result.payload.as_of,CAPTURED,'dated with the capture time, not the snapshot date or now')
 const universe=result.data.universe
 assertEquals(universe.assets_in_snapshot,6)
 assertEquals(universe.with_a_token,4)
 assertEquals(universe.with_a_tradeable_token,2)
 assertEquals(universe.with_tokens_none_traded,2)
 assertEquals(universe.no_token_reported,1)
 assertEquals(universe.not_returned,1)
 assertEquals(universe.is_a_floor,true,'a not_returned asset makes the headline a floor')
 assert(String(result.payload.note).includes('floor'))
 assertEquals(result.data.states.tradeable,2)
 const stock=result.data.by_type.find((t:Record<string,unknown>)=>t.asset_type==='stock')
 assertEquals(stock.with_a_tradeable_token,1)
 const tickers=Object.fromEntries(result.data.expected_tickers.tickers.map((t:Record<string,unknown>)=>[t.symbol,t]))
 assertEquals(tickers.BUIDL.state,'present_with_value')
 assertEquals(tickers.BUIDL.in_rwa_universe,false,'a CoinGecko catalogue row is not the CoinMarketCap RWA answer')
 assertEquals(tickers.BUIDL.seen_in[0].provider,'coingecko')
 assertEquals(tickers.OUSG.in_rwa_universe,true)
 assertEquals(tickers.BENJI.state,'symbol_seen_name_differs')
 assertEquals(tickers.USYC.state,'absent')
 const meaning=String(result.data.expected_meaning)
 assert(meaning.includes('in_rwa_universe')&&meaning.includes('CoinGecko')&&meaning.includes('never counted as present'))
 assert(result.bytes<RESULT_CEILING)
})

// ── rwa_universe_changes ────────────────────────────────────────────────────

Deno.test('rwa_universe_changes: one snapshot is not comparable, and says it is not "no changes"',async()=>{
 const one=coverageTables()
 one.intel_rwa_coverage_assets=one.intel_rwa_coverage_assets.filter(row=>row.snapshot_date===TODAY)
 const result=await call(ctx(one),'rwa_universe_changes')
 assertEquals(result.data.comparable,false)
 assert(String(result.payload.note).includes('not "no changes"'))
 assertEquals(result.data.events.length,0)
})

Deno.test('rwa_universe_changes: counts cover everything, events are capped and filtered, bad arguments refused',async()=>{
 const tables=coverageTables()
 const kinds=['listed','removed','became_tradeable','shelved']
 tables.intel_rwa_coverage_changes=Array.from({length:60},(_,i)=>({
  snapshot_date:i<30?TODAY:YESTERDAY,previous_snapshot_date:i<30?YESTERDAY:'2026-09-20',rwa_id:String(100+i),
  change_kind:kinds[i%4],from_state:null,to_state:'tradeable',symbol:`T${i}`,name:`Token ${i}`,asset_type:'stock',detected_at:CAPTURED,
 }))
 const result=await call(ctx(tables),'rwa_universe_changes',{days:7,limit:10})
 assertEquals(result.outcome,'served')
 assertGrounded(result.payload,'rwa_universe_changes')
 assertEquals(result.data.comparable,true)
 assertEquals(result.data.events.length,10)
 assertEquals(result.data.events_matched,60)
 assertEquals(result.data.counts.listed,15,'counts are over every event, not the page')
 assert(String(result.payload.note).includes('first 10'))
 assertEquals(result.data.events[0].snapshot_date,TODAY,'newest first')
 const shelved=await call(ctx(tables),'rwa_universe_changes',{kind:'shelved'})
 assert(shelved.data.events.every((e:Record<string,unknown>)=>e.kind==='shelved'))
 assertEquals(shelved.data.events_matched,15)
 for(const bad of [{days:31},{days:0},{kind:'renamed'},{limit:101},{since:'2026-01-01'}]){
  assertEquals((await call(ctx(tables),'rwa_universe_changes',bad)).reasonCode,'invalid_arguments',JSON.stringify(bad))
 }
})

// ── rwa_issuer_concentration ────────────────────────────────────────────────

Deno.test('rwa_issuer_concentration: HHI, effective issuers, top five, exclusions, and chain value only where attributable',async()=>{
 const token=(crypto_id:string,issuer_name:string|null,market_cap:number|null,asset_type='commodity')=>({snapshot_date:TODAY,rwa_id:'1',crypto_id,asset_type,symbol:`S${crypto_id}`,issuer_id:null,issuer_name,market_cap})
 const tables:Record<string,Row[]>={
  intel_rwa_coverage_tokens:[token('1','Issuer A',60),token('2','Issuer B',40),token('3',null,10),token('4','Issuer C',null)],
  intel_rwa_token_deployments:[
   {token_key:'cmc:1',platform_key:'ethereum',platform_label:'Ethereum'},
   {token_key:'cmc:2',platform_key:'ethereum',platform_label:'Ethereum'},
   {token_key:'cmc:2',platform_key:'solana',platform_label:'Solana'},
  ],
 }
 const result=await call(ctx(tables),'rwa_issuer_concentration',{top_issuers:1})
 assertEquals(result.outcome,'served')
 assertGrounded(result.payload,'rwa_issuer_concentration')
 assertEquals(result.payload.as_of,TODAY)
 const overall=result.data.overall
 assertAlmostEquals(overall.hhi,5200,0.1)
 assertAlmostEquals(overall.effective_issuers,1.92,0.01)
 assertAlmostEquals(overall.top5_share,1,1e-9)
 assertEquals(overall.excluded_no_issuer,1)
 assertEquals(overall.excluded_no_market_cap,1)
 assertEquals(overall.top_issuers.length,1,'top_issuers is honoured')
 assertEquals(overall.top_issuers[0].issuer,'Issuer A')
 const chains=result.data.chains
 const eth=chains.per_chain.find((c:Record<string,unknown>)=>c.chain==='ethereum')
 assertEquals(eth.deployments,2)
 assertEquals(eth.single_chain_market_cap_usd,60,'only the single-chain token\'s value is on the chain')
 assertEquals(chains.multi_chain_tokens,1)
 assertEquals(chains.multi_chain_market_cap_usd,40)
 assert(String(result.data.chain_meaning).includes('not attributable'))
 assertEquals((await call(ctx(tables),'rwa_issuer_concentration',{top_issuers:11})).reasonCode,'invalid_arguments')
})

// ── rwa_premium_history ─────────────────────────────────────────────────────

function historyTables(wrappers:number):Record<string,Row[]> {
 const assets:Row[]=[],tokens:Row[]=[],backfill:Row[]=[]
 const liveStart=NOW-30*86_400_000
 for(let step=0;step<120;step++){
  const at=new Date(liveStart+step*6*3_600_000).toISOString()
  assets.push({rwa_id:'1',captured_at:at,symbol:'GOLD',name:'Gold',asset_type:'commodity',anchor_kind:'liquid_wrapper_median',anchor_price:4300+step,anchor_reason:null,anchor_members:3,dispersion_bps:50+step%7,weighted_spread_bps:20,cheapest_crypto_id:'5000',cheapest_premium_bps:-40})
  for(let w=0;w<wrappers;w++)tokens.push({rwa_id:'1',crypto_id:String(5000+w),captured_at:at,symbol:`W${w}`,name:`Wrapper ${w}`,wrapper_state:'liquid',premium_bps:w*3+(step%5),accrual_gap_bps:null,in_anchor:w<3,volume_24h:1e6})
 }
 for(let d=40;d>30;d--){
  const dayIso=new Date(NOW-d*86_400_000).toISOString().slice(0,10)
  for(let w=0;w<wrappers;w++)backfill.push({rwa_id:'1',crypto_id:String(5000+w),day:dayIso,method:'ohlcv_daily_close_reconstructed',symbol:`W${w}`,name:`Wrapper ${w}`,wrapper_state:'liquid',premium_bps:w*2,accrual_gap_bps:null,in_anchor:w<3,volume_24h:5e5,anchor_kind:'liquid_wrapper_median',anchor_price:4200,anchor_reason:null,anchor_members:3,asset_dispersion_bps:44,asset_weighted_spread_bps:18,wrapper_set_captured_at:CAPTURED})
 }
 return {intel_rwa_wrapper_assets:assets,intel_rwa_wrapper_tokens:tokens,intel_rwa_wrapper_premium_backfill:backfill}
}

Deno.test('rwa_premium_history: labelled points, the boundary, the calendar, and a shared point budget',async()=>{
 const tables=historyTables(14)
 const result=await call(ctx(tables),'rwa_premium_history',{rwa_id:'1',days:90})
 assertEquals(result.outcome,'served')
 assertGrounded(result.payload,'rwa_premium_history')
 assert(result.payload.as_of,'dated with the newest live capture')
 const data=result.data
 assertEquals(data.wrappers.length,HISTORY_WRAPPER_CAP,'at most twelve wrappers when none is named')
 assertEquals(data.wrappers[0].crypto_id,'5000','the cheapest liquid wrapper leads')
 const points=data.series_points
 assert(points.returned<=SERIES_TOTAL_CAP,`${points.returned} points against the ${SERIES_TOTAL_CAP} budget`)
 for(const wrapper of data.wrappers){
  assert(wrapper.points.length<=points.per_wrapper_cap)
  assert(wrapper.points.length<=SERIES_POINT_CAP)
  // Every point says where it came from; the reconstructed days lead the series.
  for(const point of wrapper.points)assert(point.source==='capture'||point.source==='ohlcv_reconstructed')
  assertEquals(wrapper.points[0].source,'ohlcv_reconstructed')
  assertEquals(wrapper.points.at(-1).source,'capture')
  assertEquals(wrapper.reconstructed_points,10)
  assert(typeof wrapper.summary.mean_bps==='number','a summary over the full series survives the downsample')
 }
 assert(data.anchor.length<=SERIES_POINT_CAP)
 assert(data.anchor.some((a:Record<string,unknown>)=>a.source==='ohlcv_reconstructed')&&data.anchor.some((a:Record<string,unknown>)=>a.source==='capture'))
 assert(data.boundary.live_from&&data.boundary.reconstructed_from&&data.boundary.reconstructed_to)
 assert(Date.parse(data.boundary.reconstructed_to)<Date.parse(data.boundary.live_from),'reconstruction ends before live capture begins')
 assertEquals(data.calendar.rule,'comex_holidays_not_modelled')
 assert(data.calendar.closed_spans.length>0&&/^\d{4}-\d{2}-\d{2}$/.test(data.calendar.closed_spans[0].from))
 const note=String(result.payload.note)
 assert(note.includes('evenly spaced'),'the downsample is said in words')
 assert(note.includes(`${HISTORY_WRAPPER_CAP} with the most points`),'the wrapper cap is said in words')
 assert(result.bytes<RESULT_CEILING,`${result.bytes} bytes`)

 // One wrapper named: its own series, up to the single-series cap.
 const one=await call(ctx(tables),'rwa_premium_history',{rwa_id:'1',crypto_id:'5003'})
 assertEquals(one.data.wrappers.length,1)
 assertEquals(one.data.wrappers[0].crypto_id,'5003')
 assertEquals(one.data.wrappers[0].points.length,SERIES_POINT_CAP)
 // A wrapper that is not there is said, with the ones that are.
 const missing=await call(ctx(tables),'rwa_premium_history',{rwa_id:'1',crypto_id:'1234'})
 assertEquals(missing.data.wrappers.length,0)
 assert(missing.data.wrappers_available.length>0)
 assert(String(missing.payload.note).includes('wrappers_available'))
 // An asset with no history is missing coverage, said in words.
 const none=await call(ctx(tables),'rwa_premium_history',{rwa_id:'999'})
 assert(String(none.payload.note).includes('missing coverage'))
 for(const bad of [{},{rwa_id:'1',days:60},{rwa_id:'01'},{rwa_id:'1',crypto_id:'x'}]){
  assertEquals((await call(ctx(tables),'rwa_premium_history',bad)).reasonCode,'invalid_arguments',JSON.stringify(bad))
 }
})

// ── rwa_exit_capacity ───────────────────────────────────────────────────────

function depthTables(over:Row={},volume:number|null=12_500_000):Record<string,Row[]> {
 return {
  intel_rwa_depth_snapshots:[{
   provider:'coinmarketcap',token_key:'cmc:4705',snapshot_date:TODAY,captured_at:'2026-09-22T03:34:00.000Z',crypto_id:'4705',symbol:'PAXG',token_name:'PAX Gold',
   rwa_id:'1',rwa_name:'Gold',asset_type:'commodity',depth_state:'pools_read',pool_count:3,liquidity_pools:3,total_liquidity_usd:1_200_000,
   pools:[],pool_classification:POOL_CLASSIFICATION,recognised_pool_count:2,recognised_liquidity_pools:2,recognised_liquidity_usd:1_000_000,
   recognised_volume_24h_usd:42_000,unrecognised_pool_count:1,unrecognised_liquidity_usd:200_000,exit_liquidity_usd:null,exit_liquidity_pools:0,
   ...over,
  }],
  intel_rwa_wrapper_tokens:volume==null?[]:[{provider:'coinmarketcap',crypto_id:'4705',volume_24h:volume,captured_at:'2026-09-22T08:47:00.000Z'}],
 }
}

Deno.test('rwa_exit_capacity: both scenarios with the formula written out, and the pool comparison never called slippage',async()=>{
 const result=await call(ctx(depthTables()),'rwa_exit_capacity',{crypto_id:'4705',position_usd:100_000})
 assertEquals(result.outcome,'served')
 assertGrounded(result.payload,'rwa_exit_capacity')
 // Two captures, two clocks: the answer takes the older.
 assertEquals(result.payload.as_of,'2026-09-22T03:34:00.000Z')
 const [pools,venues]=result.data.scenarios
 assertEquals(pools.scenario,'recognised_pools')
 assertEquals(pools.volume_24h_usd,42_000)
 assertEquals(pools.per_day_usd,4_200)
 assertAlmostEquals(pools.days,23.81,0.01)
 assert(String(pools.formula).includes('100000 / (0.1 x 42000 x (1 - 0))'),pools.formula)
 assertEquals(venues.scenario,'all_venues')
 assertAlmostEquals(venues.days,0.08,0.001)
 assertEquals(venues.volume_captured_at,'2026-09-22T08:47:00.000Z')
 const pool=result.data.pool_comparison
 assertEquals(pool.position_pct_of_recognised_pool,10)
 assertEquals(pool.pool_basis,'counted_liquidity')
 assert(String(pool.meaning).includes('not slippage'))
 // Defaults were applied from the schema.
 assertEquals(result.data.inputs.participation_pct,10)
 assertEquals(result.data.inputs.haircut_pct,0)

 // A haircut cuts both the volume and the pool base.
 const stressed=await call(ctx(depthTables()),'rwa_exit_capacity',{crypto_id:'4705',position_usd:100_000,participation_pct:20,haircut_pct:50})
 assertEquals(stressed.data.scenarios[0].per_day_usd,4_200)
 assertEquals(stressed.data.pool_comparison.pool_base_usd,500_000)
})

Deno.test('rwa_exit_capacity: an unavailable scenario says why, and an uncaptured token is missing coverage',async()=>{
 const notCovered=await call(ctx(depthTables({depth_state:'chain_not_covered',pool_classification:null,recognised_pool_count:null,recognised_volume_24h_usd:null,recognised_liquidity_usd:null})),'rwa_exit_capacity',{crypto_id:'4705',position_usd:50_000})
 const [pools,venues]=notCovered.data.scenarios
 assertEquals(pools.days,null,'never zero days for missing data')
 assertEquals(pools.unavailable,'state_chain_not_covered')
 assert(String(pools.unavailable_reason).includes('chain_not_covered'))
 assert(typeof venues.days==='number','the all-venue day count is not gated by the depth state')
 assertEquals(notCovered.data.pool_comparison.position_pct_of_recognised_pool,null)

 const noVolume=await call(ctx(depthTables({},null)),'rwa_exit_capacity',{crypto_id:'4705',position_usd:50_000})
 const allVenues=noVolume.data.scenarios[1]
 assertEquals(allVenues.unavailable,'volume_not_reported')
 assert(String(allVenues.unavailable_reason).includes('48 hours'),'the join reason is named, not the generic one')

 const zero=await call(ctx(depthTables({recognised_volume_24h_usd:0})),'rwa_exit_capacity',{crypto_id:'4705',position_usd:50_000})
 assertEquals(zero.data.scenarios[0].unavailable,'no_reported_trading')

 const uncaptured=await call(ctx({}),'rwa_exit_capacity',{crypto_id:'1',position_usd:50_000})
 assertEquals(uncaptured.data.captured,false)
 assert(String(uncaptured.payload.note).includes('missing coverage'))

 for(const bad of [
  {crypto_id:'4705'},{crypto_id:'4705',position_usd:0},{crypto_id:'4705',position_usd:1e13},
  {crypto_id:'4705',position_usd:1,participation_pct:0},{crypto_id:'4705',position_usd:1,participation_pct:101},
  {crypto_id:'4705',position_usd:1,haircut_pct:91},{crypto_id:'abc',position_usd:1},{crypto_id:'4705',position_usd:'1000'},
 ]){
  assertEquals((await call(ctx(depthTables()),'rwa_exit_capacity',bad)).reasonCode,'invalid_arguments',JSON.stringify(bad))
 }
})

Deno.test('the exit formula port matches src/intel/lib/rwa-exit-capacity.js exactly',()=>{
 const rows:Row[]=[
  {state:'pools_read',classification:'classified',onlyUnrecognised:false,countedLiquidityUsd:1_000_000,countedVolume24hUsd:42_000,exitLiquidityUsd:null,providerVolume24hUsd:12_500_000,providerVolumeReason:null,providerVolumeCapturedAt:'2026-09-22T08:00:00.000Z'},
  {state:'pools_read',classification:'classified',onlyUnrecognised:false,countedLiquidityUsd:1_000_000,countedVolume24hUsd:0,exitLiquidityUsd:250_000,providerVolume24hUsd:null,providerVolumeReason:'not_in_recent_wrapper_capture'},
  {state:'pools_read',classification:'unclassified',onlyUnrecognised:false,countedLiquidityUsd:null,countedVolume24hUsd:null,providerVolume24hUsd:9_000},
  {state:'pools_read',classification:'classified',onlyUnrecognised:true,countedLiquidityUsd:0,countedVolume24hUsd:0,providerVolume24hUsd:100},
  {state:'no_pool_on_read_chains',classification:null,providerVolume24hUsd:3_000_000},
  {state:null,providerVolume24hUsd:'',providerVolumeReason:'no_provider_id'},
 ]
 const inputs=[
  {positionUsd:100_000,participationPct:10,haircutPct:0},
  {positionUsd:2_500_000,participationPct:5,haircutPct:30},
  {positionUsd:1,participationPct:100,haircutPct:89.9},
  {positionUsd:0,participationPct:10,haircutPct:0},
  {positionUsd:1000,participationPct:0,haircutPct:0},
  {positionUsd:1000,participationPct:10,haircutPct:100},
 ]
 for(const row of rows)for(const input of inputs){
  assertEquals(portedScenarios(row,input),originalScenarios(row,input),`${JSON.stringify(row)} ${JSON.stringify(input)}`)
 }
 for(const args of [{positionUsd:'abc',participation:0.1,volumeUsd:5},{positionUsd:10,participation:0.1,haircut:null,volumeUsd:5},{positionUsd:10,participation:0.1,volumeUsd:-1,gate:'state_x',gateVolume:false}]){
  assertEquals(portedEstimate(args),originalEstimate(args),JSON.stringify(args))
 }
})

// ── market_structure ────────────────────────────────────────────────────────

Deno.test('market_structure: each figure takes only its own arguments, and the refusal names them',async()=>{
 const context=ctx({})
 const refused=async(args:Record<string,unknown>,expect:string)=>{
  const result=await call(context,'market_structure',args)
  assertEquals(result.reasonCode,'invalid_arguments',JSON.stringify(args))
  assert(String(result.payload.message).includes(expect),`${JSON.stringify(args)} said: ${result.payload.message}`)
 }
 await refused({figure:'breadth',rows:5},'does not take rows')
 await refused({figure:'categories',days:90},'must be one of: 1, 7, 30')
 await refused({figure:'liquidations'},'needs provider_ids')
 await refused({figure:'liquidations',provider_ids:['1'],hours:48},'24 or less')
 await refused({figure:'attention'},'needs provider_id')
 await refused({figure:'exchange_reserves',rows:30},'20 or less')
 await refused({figure:'venue_share',kind:'options'},'must be one of')
 // The shared schema refuses before the figure is ever consulted.
 for(const args of [{},{figure:'fx'},{figure:'regime'},{figure:'rank_map',top:31},{figure:'liquidations',provider_ids:Array.from({length:11},(_,i)=>String(i+1))},{figure:'unusual_moves',day:'22-09-2026'},{figure:'breadth',page:2}]){
  assertEquals((await call(context,'market_structure',args)).reasonCode,'invalid_arguments',JSON.stringify(args))
 }
})

Deno.test('market_structure: breadth, unusual moves and network stats are grounded and shaped for a conversation',async()=>{
 const rank=Array.from({length:20},(_,i)=>({snapshot_date:TODAY,source:'listings_latest',provider_id:String(i+1),symbol:`A${i}`,rank:i+1,market_cap:1e9/(i+1),change_24h_pct:i%3-1,observed_at:CAPTURED}))
 const windows=[{days:90,n:90,distribution:Array.from({length:40},(_,i)=>({from:i,to:i+1,count:i}))}]
 const unusual=Array.from({length:40},(_,i)=>({asset_key:`cmc:${i+1}`,subject_day:YESTERDAY,cmc_id:String(i+1),symbol:`U${i}`,name:`Unusual ${i}`,captured_at:CAPTURED,scored:true,move_percentile:99-i,liquidity_usd:1e6,lead_window_days:90,windows}))
 const tables={intel_rank_history:rank,intel_unusual_move_scores:unusual}
 const breadth=await call(ctx(tables),'market_structure',{figure:'breadth'})
 assertEquals(breadth.outcome,'served')
 assertGrounded(breadth.payload,'market_structure')
 assertEquals(breadth.payload.calculated_by,'investor_intel')
 assertEquals(breadth.data.figure,'breadth')
 assert(typeof breadth.data.spreadPts==='number')
 assertEquals(breadth.payload.as_of,CAPTURED)

 const moves=await call(ctx(tables),'market_structure',{figure:'unusual_moves',rows:5})
 assertEquals(moves.data.rows.length,5)
 assert(!('windows' in moves.data.rows[0]),'the per-window distributions are left out')
 assertEquals(moves.data.params.rows,5)
 assert(String(moves.payload.note).includes('first 5'))
 const defaulted=await call(ctx(tables),'market_structure',{figure:'unusual_moves'})
 assertEquals(defaulted.data.rows.length,20,'the figure default applies when rows is omitted')

 const network=await call(ctx({}),'market_structure',{figure:'network_stats'})
 assert(String(network.payload.note).includes('Growth plan'),'an empty lane on a lower plan says so')
})

Deno.test('market_structure: big figures stay inside the result ceiling and say what they cut',async()=>{
 const reserves:Row[]=[]
 for(let d=0;d<31;d+=1){
  const date=new Date(NOW-d*86_400_000).toISOString().slice(0,10)
  for(let e=1;e<=30;e++)for(let a=1;a<=40;a++)reserves.push({exchange_id:e,snapshot_date:date,provider_id:String(a),platform_symbol:'ETH',exchange_slug:`ex-${e}`,symbol:`R${a}`,balance:1000,usd_value:1e6*a+e,wallet_count:3})
 }
 const index=['cmc20','cmc100'].flatMap(code=>Array.from({length:400},(_,i)=>({index_code:code,captured_at:new Date(NOW-i*3_600_000).toISOString(),index_value:100+i,value_24h_pct:0.1,constituents:Array.from({length:250},(_,c)=>({id:c,symbol:`C${c}`,weight:1/250}))})))
 const categories=Array.from({length:30},(_,c)=>Array.from({length:200},(_,h)=>({category_id:`cat-${c}`,captured_at:new Date(NOW-h*3_600_000).toISOString(),name:`Category ${c}`,title:`Category ${c}`,num_tokens:50,avg_price_change:1,market_cap:1e9*(30-c),market_cap_change:0.5,volume:1e7,volume_change:1,observed_at:CAPTURED}))).flat()
 const tables={intel_exchange_reserve_snapshots:reserves,intel_index_constituent_snapshots:index,intel_category_snapshots:categories}

 const r=await call(ctx(tables),'market_structure',{figure:'exchange_reserves'})
 assertEquals(r.outcome,'served')
 assertEquals(r.data.exchanges.length,10)
 assert(r.data.series.every((p:Record<string,unknown[]>)=>p.byExchange.length<=10),'the series follows the exchanges returned')
 assert(String(r.payload.note).includes('30 exchanges matched'))
 assert(r.bytes<RESULT_CEILING,`exchange_reserves ${r.bytes} bytes`)

 const i=await call(ctx(tables),'market_structure',{figure:'index_constituents',rows:5})
 assertEquals(i.data.latest.cmc100.constituents.length,5)
 assertEquals(i.data.latest.cmc100.constituent_count,250)
 assert(i.data.series_points.returned<=SERIES_TOTAL_CAP)
 assert(i.bytes<RESULT_CEILING,`index_constituents ${i.bytes} bytes`)

 const c=await call(ctx(tables),'market_structure',{figure:'categories',days:30,top:30})
 assertEquals(c.data.rows.length,30)
 assert(c.data.series_points.returned<=SERIES_TOTAL_CAP,`${c.data.series_points.returned} category points`)
 assert(String(c.payload.note).includes('evenly spaced'))
 // Thirty series at the per-series floor would be 360 points, so the tail keeps
 // its row and loses its series, and the answer says so.
 assertEquals(c.data.series.filter((s:Record<string,unknown[]>)=>s.points.length>0).length,15)
 assert(String(c.payload.note).includes('left out'))
 assert(c.bytes<RESULT_CEILING,`categories ${c.bytes} bytes`)
})

// ── The last-resort budget ──────────────────────────────────────────────────

Deno.test('fitToBudget trims every list until the payload fits, keeps scalars, and says so',()=>{
 const big={total:42,rows:Array.from({length:500},(_,i)=>({rank:i,label:'x'.repeat(200)})),series:[{points:Array.from({length:400},(_,i)=>({t:i,v:i}))}]}
 const fitted=fitToBudget(big)
 assert(JSON.stringify(fitted.data).length<=RESULT_BYTE_BUDGET)
 assertEquals(fitted.data.total,42,'a scalar is never altered')
 assertEquals(fitted.data.rows[0].rank,0,'a ranked list keeps its head')
 const points=fitted.data.series[0].points
 assertEquals(points[points.length-1].t,399,'a series keeps its newest point')
 assertEquals(points[0].t,0,'and its oldest')
 assert(String(fitted.note).includes('bytes'))
 const small={rows:[1,2,3]}
 assertEquals(fitToBudget(small),{data:small,note:null,bytes:JSON.stringify(small).length})
})
