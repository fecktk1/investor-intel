// Every tool against a stub database, and the three gates in the order they run.
//
// The stub is a small PostgREST-shaped fake: `from(table)` returns a chainable
// builder that resolves to whatever rows the fixture holds for that table, and
// `rpc(name, args)` returns whatever the fixture says. That is enough to exercise
// every handler, because no tool here calls a provider: if one ever did, it would
// fail in this file rather than on a member's credit bill, which is the point.

import {assert,assertEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {MCP_TOOLS,callMcpTool,buildToolContext,findTool,SERVER_INSTRUCTIONS,MCP_RESOURCES,MCP_PROMPTS,readMcpResource,getMcpPrompt,type ToolContext} from './mcp-tools.ts'
import {FORWARD_TABLE_CONTRACT} from './mcp-rwa-forward.ts'
import {AGENT_SCOPES,type AgentContext,type AgentScope} from './agent-token.ts'

// ── The stub ────────────────────────────────────────────────────────────────

interface Fixture {
 tables?:Record<string,Record<string,unknown>[]>
 /** Tables that must behave as absent, for the not_available_yet path. */
 missing?:string[]
 rpc?:Record<string,unknown>
 /** Surfaces to refuse, so the tier gate can be exercised without a database. */
 lockedSurfaces?:string[]
 /** Column defaults the real schema applies on insert, so a handler reading back
  * an inserted row sees what Postgres would actually have given it. */
 defaults?:Record<string,Record<string,unknown>>
}

function stubDb(fixture:Fixture) {
 const calls:Array<{table:string;filters:Array<[string,unknown,unknown]>}>=[]
 const builder=(table:string)=>{
  const record={table,filters:[] as Array<[string,unknown,unknown]>}
  calls.push(record)
  const rows=()=>{
   if(fixture.missing?.includes(table)){
    return {data:null,error:{code:'PGRST205',message:`Could not find the table 'public.${table}' in the schema cache`}}
   }
   let out=[...(fixture.tables?.[table]??[])]
   for(const [op,column,value] of record.filters){
    if(op==='eq')out=out.filter(row=>String(row[column as string]??'')===String(value))
    if(op==='in')out=out.filter(row=>(value as unknown[]).map(String).includes(String(row[column as string]??'')))
   }
   return {data:out,error:null}
  }
  // deno-lint-ignore no-explicit-any
  const chain:any={
   select:()=>chain,order:()=>chain,limit:()=>chain,gt:()=>chain,gte:()=>chain,lte:()=>chain,lt:()=>chain,
   not:()=>chain,or:()=>chain,is:()=>chain,range:()=>Promise.resolve(rows()),
   eq:(column:string,value:unknown)=>{record.filters.push(['eq',column,value]);return chain},
   in:(column:string,value:unknown)=>{record.filters.push(['in',column,value]);return chain},
   maybeSingle:()=>{const r=rows();return Promise.resolve({data:r.error?null:(r.data?.[0]??null),error:r.error})},
   insert:(row:unknown)=>{
    const inserted=Array.isArray(row)?row:[row]
    const store=(fixture.tables??={})[table]??=[]
    // deno-lint-ignore no-explicit-any
    const defaults=fixture.defaults?.[table]??{}
    const withIds=inserted.map((r:any,index:number)=>({id:`inserted-${table}-${index}`,created_at:'2026-09-20T14:00:00.000Z',sort_order:0,...defaults,...r}))
    store.push(...withIds)
    // deno-lint-ignore no-explicit-any
    const done:any={select:()=>done,maybeSingle:()=>Promise.resolve({data:withIds[0],error:null}),then:(fn:any)=>fn({data:withIds,error:null})}
    return done
   },
   update:()=>({eq:()=>({eq:()=>({eq:()=>({is:()=>({select:()=>({maybeSingle:()=>Promise.resolve({data:null,error:null})})})})})}),select:()=>chain}),
   upsert:()=>Promise.resolve({data:null,error:null}),
   then:(fn:(value:unknown)=>unknown)=>Promise.resolve(rows()).then(fn),
  }
  return chain
 }
 return {
  calls,
  from:builder,
  // deno-lint-ignore no-explicit-any
  rpc:(name:string,args:any)=>{
   if(name==='intel_surface_allowed'){
    return Promise.resolve({data:!fixture.lockedSurfaces?.includes(String(args?.p_surface)),error:null})
   }
   if(Object.hasOwn(fixture.rpc??{},name))return Promise.resolve({data:fixture.rpc![name],error:null})
   return Promise.resolve({data:null,error:null})
  },
 }
}

const TOKEN_ID='11111111-1111-4111-8111-111111111111'
const PLAN_ID='22222222-2222-4222-8222-222222222222'
const LIST_ID='33333333-3333-4333-8333-333333333333'

function agent(scopes:AgentScope[]):AgentContext {
 return {
  tokenId:TOKEN_ID,userId:'user-1',orgId:'org-1',tokenName:'Laptop agent',scopes,role:'owner',
  actor:{human_user_id:'user-1',org_id:'org-1',role:'owner',token_id:TOKEN_ID,source:'agent_token',request_id:'req-1'},
 }
}

const NOW=Date.parse('2026-09-20T15:00:00.000Z')

function ctx(fixture:Fixture,scopes:AgentScope[]=[...AGENT_SCOPES],tier='starter'):ToolContext {
 return {
  // deno-lint-ignore no-explicit-any
  db:stubDb(fixture) as any,
  agent:agent(scopes),now:NOW,tier,
  minTier:{market_boards:'free',market_regime:'free',capture_views:'free',watchlist:'free',agent_access:'starter',alert_evaluation:'starter',investigation:'starter'},
 }
}

/** Every tool call goes through callMcpTool, never straight to a handler, so the
 * gates are always in the path being tested. */
async function call(context:ToolContext,name:string,args:Record<string,unknown>={}) {
 const result=await callMcpTool(context,name,args)
 const payload=result.result.structuredContent as Record<string,unknown>|undefined
 return {...result,payload:payload??{}}
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const CAPTURED='2026-09-20T14:00:00.000Z'

const FULL:Fixture={
 rpc:{intel_effective_tier:'starter',intel_limit_for:2000},
 // intel_agent_plans.status defaults to 'proposed' in the schema.
 defaults:{intel_agent_plans:{status:'proposed'}},
 tables:{
  intel_surface_tiers:[{surface:'capture_views',min_tier:'free'},{surface:'agent_access',min_tier:'starter'}],
  market_assets:[{
   source_provider:'coinmarketcap',provider_id:'1',provider_slug:'bitcoin',symbol:'BTC',name:'Bitcoin',
   normalized_symbol:'BTC',primary_chain:'bitcoin',market_cap_rank:1,current_price:80468.15,market_cap:1.6e12,
   fdv:1.7e12,volume_24h:4.2e10,change_24h_pct:-1.2,circulating_supply:19.9e6,total_supply:19.9e6,
   platforms:{bitcoin:'native'},image_url:null,source_url:'https://coinmarketcap.com/currencies/bitcoin/',
   source_label:'CoinMarketCap',attribution_label:'Data via CoinMarketCap',as_of:CAPTURED,in_current_catalog:true,
  }],
  intel_regime_snapshots:[{captured_at:CAPTURED,fear_greed:42,btc_dominance:57.1,source_observed_at:CAPTURED}],
  watchlists:[{id:LIST_ID,org_id:'org-1',user_id:'user-1',name:'Majors',is_default:true,sort_order:0,created_at:CAPTURED,revision:1,updated_at:CAPTURED}],
  watchlist_items:[{id:'item-1',org_id:'org-1',watchlist_id:LIST_ID,item_type:'token',label:'BTC',notes:null,sort_order:0,created_at:CAPTURED}],
  intel_alert_rules:[{id:'rule-1',org_id:'org-1',user_id:'user-1',trigger_type:'price',config:{asset:'market:coinmarketcap:1',direction:'above',threshold_usd:100000},is_active:true,created_at:CAPTURED,cooldown_minutes:60}],
  intel_alert_events:[{id:'event-1',org_id:'org-1',rule_id:'rule-1',fired_at:CAPTURED,read_at:null,payload:{}}],
  intel_agent_plans:[{
   id:PLAN_ID,org_id:'org-1',user_id:'user-1',token_id:TOKEN_ID,tool_key:'intel_create_alert',
   target:{asset:'market:coinmarketcap:1'},payload:{},plan_hash:'a'.repeat(64),risk_level:2,
   actor:{source:'agent_token',human_user_id:'user-1'},summary:'Create a draft alert',status:'proposed',
   expires_at:'2026-09-21T15:00:00.000Z',created_at:CAPTURED,
  }],
  intel_market_observations:[
   {
    subject:'rwa:coinmarketcap:4705',provider:'investor-intel-editorial',retain_until:'2026-10-20T14:00:00.000Z',
    observation:{
     id:'issuer:denomination',subject:'rwa:coinmarketcap:4705',provider:'investor-intel-editorial',
     metric:'issuer_denomination',value:'One token represents one gram of gold.',unit:'text',
     sourceRef:'issuer-review-3:4705:denomination',
     observedAt:CAPTURED,recordedAt:CAPTURED,expiresAt:null,sourceUrl:'https://example.com/denomination',
     metadata:{cryptoId:'4705',issuerId:'issuer-a',label:'Denomination',reviewVersion:'issuer-review-3',
      terms:{kind:'denomination',unitsPerToken:1,underlyingUnit:'gram_gold_minimum_999_purity',variable:false}},
    },
    observed_at:CAPTURED,recorded_at:CAPTURED,
   },
   {
    subject:'rwa:coinmarketcap:4705',provider:'investor-intel-editorial',retain_until:'2026-10-20T14:00:00.000Z',
    observation:{
     id:'issuer:redemption',subject:'rwa:coinmarketcap:4705',provider:'investor-intel-editorial',
     metric:'issuer_redemption',value:'Redemption starts at 430 tokens for verified holders.',unit:'text',
     sourceRef:'issuer-review-3:4705:redemption',
     observedAt:CAPTURED,recordedAt:CAPTURED,expiresAt:null,sourceUrl:'https://example.com/redemption',
     metadata:{cryptoId:'4705',issuerId:'issuer-a',label:'Redemption',reviewVersion:'issuer-review-3',
      terms:{kind:'redemption',minimum:430,minimumUnit:'token',availability:'unverified',feesIncluded:false}},
    },
    observed_at:CAPTURED,recorded_at:CAPTURED,
   },
  ],
 },
 // The three forward lanes do not exist yet, which is the real state today.
 missing:[FORWARD_TABLE_CONTRACT.wrapper_premiums.table,FORWARD_TABLE_CONTRACT.liquidity_depth.table,FORWARD_TABLE_CONTRACT.underlying_registrant.table],
}

/** Tools that only hand back rows the member already owns, or this token's own
 * state. Nothing in them is computed, so there are no inputs to name. */
const PLAIN_RECORD_TOOLS=['whoami','write_status','watchlist_read','alerts_list']

const READ_TOOLS=['whoami','search_assets','get_asset','market_regime','new_listings','meme_graduations','rwa_universe','rwa_issuer_legitimacy','rwa_yield_provenance','rwa_issuer_terms','rwa_wrapper_premiums','rwa_best_wrapper','rwa_liquidity_depth','rwa_underlying_registrant','rwa_coverage','rwa_universe_changes','rwa_issuer_concentration','rwa_premium_history','rwa_exit_capacity','market_structure','watchlist_read','alerts_list','write_status','data_budget']

const ARGS:Record<string,Record<string,unknown>>={
 search_assets:{query:'BTC'},
 get_asset:{provider:'coinmarketcap',provider_id:'1'},
 rwa_issuer_terms:{subject:'rwa:coinmarketcap:4705',crypto_id:'4705'},
 rwa_best_wrapper:{rwa_id:'1'},
 rwa_premium_history:{rwa_id:'1'},
 rwa_exit_capacity:{crypto_id:'4705',position_usd:100000},
 market_structure:{figure:'breadth'},
 write_status:{proposal_id:PLAN_ID},
 write_run:{proposal_id:PLAN_ID},
 watchlist_add:{item_type:'token',label:'ETH'},
 alert_create:{asset:'market:coinmarketcap:1',direction:'above',threshold_usd:120000,title:'BTC above 120k'},
 save_research_note:{title:'Note',body:'Body.'},
}

// ── The gates ───────────────────────────────────────────────────────────────

Deno.test('every read tool answers against a stub database and grounds its answer',async()=>{
 for(const name of READ_TOOLS){
  const result=await call(ctx(FULL),name,ARGS[name]??{})
  assertEquals(result.outcome,'served',`${name} should serve: ${result.result.content[0].text.slice(0,300)}`)
  const payload=result.payload
  // The grounding contract, on every single result. A model cannot see a page
  // footer, so a result without these is a number it will quote undated.
  assert('as_of' in payload,`${name} must carry as_of`)
  assert('source' in payload,`${name} must carry source`)
  assert(payload.calculated_by==='provider'||payload.calculated_by==='investor_intel',`${name} must say who calculated it, saw ${String(payload.calculated_by)}`)
  const tier=payload.tier as Record<string,unknown>
  assert(tier&&typeof tier==='object',`${name} must carry tier context`)
  assertEquals(tier.tier,'starter',`${name} must report the member's tier`)
  assertEquals(payload.tool,name)
  // Our own figures must name their inputs, so our arithmetic is never quoted as
  // a provider's published number.
  // A DERIVED figure has to name its inputs. Reading back the member's own rows
  // is not a derivation, so those tools are listed rather than exempted silently.
  if(payload.calculated_by==='investor_intel'&&!PLAIN_RECORD_TOOLS.includes(name)){
   assert(Array.isArray(payload.inputs)&&(payload.inputs as unknown[]).length>0,`${name} derives a figure and must name its inputs`)
  }
 }
})

Deno.test('a free token on a Starter tool is refused server side, with nothing withheld attached',async()=>{
 // rwa_issuer_terms sits behind the investigation surface, which is Starter.
 const locked=ctx({...FULL,lockedSurfaces:['investigation']},[...AGENT_SCOPES],'free')
 const result=await call(locked,'rwa_issuer_terms',ARGS.rwa_issuer_terms)
 assertEquals(result.outcome,'refused')
 assertEquals(result.reasonCode,'intel_surface_locked')
 assert(result.tierLocked,'the audit row must record that it was the plan, not a scope')
 assertEquals(result.result.isError,true)
 const payload=result.payload
 assertEquals(payload.withheld,true)
 assertEquals(payload.error,'intel_surface_locked')
 assertEquals(payload.surface,'investigation')
 assertEquals((payload.tier as Record<string,unknown>).tier,'free')
 assertEquals((payload.tier as Record<string,unknown>).open,false)
 assert(String(payload.message).includes('starter'),'the refusal must name the plan that opens it')
 // The security property: NOTHING of the withheld reading is in the body. Not a
 // row, not a count, not a sample, not a truncated form.
 for(const forbidden of ['data','facts','rows','state','denomination','redemption','coverage'])
  assert(!(forbidden in payload),`a withheld body must not carry ${forbidden}`)
 // And a free token still reaches the free surfaces.
 assertEquals((await call(locked,'rwa_universe')).outcome,'served')
})

Deno.test('a write is refused on a read-only token, before the target is ever read',async()=>{
 const readOnly=ctx(FULL,['read:portfolio','read:thesis','read:alerts','read:charts','read:watchlists','read:evidence'])
 for(const [name,scope] of [['alert_create','write:alerts'],['watchlist_add','write:watchlists'],['save_research_note','write:research']] as const){
  const result=await call(readOnly,name,ARGS[name])
  assertEquals(result.outcome,'refused',`${name} must be refused without ${scope}`)
  assertEquals(result.reasonCode,'scope_missing')
  assertEquals(result.result.isError,true)
  assertEquals(result.payload.scope_required,scope)
  assert(Array.isArray(result.payload.scopes_held))
  // The scope check runs BEFORE the target read, so a read-only token cannot use
  // the difference between "no such row" and "no such scope" as a membership
  // oracle. Nothing was written either.
  assertEquals((FULL.tables!.watchlist_items??[]).filter(row=>row.label==='ETH').length,0)
 }
 // read:alerts alone still reads.
 assertEquals((await call(readOnly,'alerts_list')).outcome,'served')
})

Deno.test('an oversize or undeclared argument is refused before any query runs',async()=>{
 const context=ctx(FULL)
 const over=await call(context,'new_listings',{limit:500})
 assertEquals(over.outcome,'refused')
 assertEquals(over.reasonCode,'invalid_arguments')
 assert(String(over.payload.message).includes('50'),'the ceiling must be named')
 // The schema travels with the refusal, so a model can correct itself in one turn.
 assert(over.payload.schema,'the refusal must carry the schema')
 const unknown=await call(context,'search_assets',{query:'BTC',page:9})
 assertEquals(unknown.reasonCode,'invalid_arguments')
 assert(String(unknown.payload.message).includes('page'))
 const missing=await call(context,'rwa_issuer_terms',{subject:'rwa:coinmarketcap:1'})
 assertEquals(missing.reasonCode,'invalid_arguments')
 assert(String(missing.payload.message).includes('crypto_id'))
 // A bad uuid never reaches the database.
 const badId=await call(context,'write_status',{proposal_id:'not-a-uuid'})
 assertEquals(badId.reasonCode,'invalid_arguments')
})

Deno.test('an unknown tool is refused by name',async()=>{
 const result=await call(ctx(FULL),'drop_tables',{})
 assertEquals(result.outcome,'refused')
 assertEquals(result.reasonCode,'unknown_tool')
 assertEquals(result.result.isError,true)
})

// ── Individual readings ─────────────────────────────────────────────────────

Deno.test('get_asset returns identity, contracts, the stored quote and our agreement verdict',async()=>{
 const result=await call(ctx(FULL),'get_asset',{provider:'coinmarketcap',provider_id:'1'})
 const data=result.payload.data as Record<string,unknown>
 const asset=data.asset as Record<string,unknown>
 assertEquals(asset.symbol,'BTC')
 assertEquals(asset.canonical_key,'market:coinmarketcap:1')
 assertEquals(asset.provider_id,'1')
 assertEquals(data.contracts,[{chain:'bitcoin',contract_address:'native'}])
 // No retained quote in the fixture, so the note says the price is the catalogue
 // snapshot rather than pretending it is a corroborated observation.
 assertEquals(data.quote,null)
 assert(String(result.payload.note).includes('catalogue snapshot'))
 // The source names both stores, because the answer joins two.
 assert(Array.isArray(result.payload.source))
 const misses=await call(ctx(FULL),'get_asset',{provider:'coinmarketcap',provider_id:'999999'})
 assertEquals(misses.outcome,'served','a miss is a served answer with a reason, not an error')
 assert(String(misses.payload.note).includes('999999'),'an empty answer must say why in words')
})

Deno.test('market_regime labels our breadth figure as ours and names its inputs',async()=>{
 const result=await call(ctx(FULL),'market_regime',{range:'7d'})
 const data=result.payload.data as Record<string,unknown>
 const breadth=data.breadth as Record<string,unknown>
 assertEquals(breadth.calculated_by,'investor_intel')
 assert(Array.isArray(breadth.inputs)&&(breadth.inputs as unknown[]).length>0)
 // The regime series itself is the provider's, so the envelope says provider.
 assertEquals(result.payload.calculated_by,'provider')
})

Deno.test('meme_graduations carries the CoinGecko attribution, which is a licence condition',async()=>{
 const result=await call(ctx(FULL),'meme_graduations',{})
 const data=result.payload.data as Record<string,unknown>
 const attribution=data.attribution as Record<string,unknown>
 assertEquals(attribution.text,'Powered by CoinGecko')
 assertEquals(attribution.url,'https://www.coingecko.com')
 // And on the source ref too, so a client reading either place finds it.
 const source=result.payload.source as Record<string,unknown>
 assertEquals((source.attribution as Record<string,unknown>).text,'Powered by CoinGecko')
 // The instructions tell the model it must be shown.
 assert(SERVER_INSTRUCTIONS.includes('ATTRIBUTION'))
})

Deno.test('the three forward RWA tools say not_available_yet, which is not the same as empty',async()=>{
 for(const [name,reading] of [['rwa_wrapper_premiums','wrapper_premiums'],['rwa_liquidity_depth','liquidity_depth'],['rwa_underlying_registrant','underlying_registrant']] as const){
  const result=await call(ctx(FULL),name,{})
  assertEquals(result.outcome,'served')
  const data=result.payload.data as Record<string,unknown>
  assertEquals(data.state,'not_available_yet',`${name} must distinguish a missing lane from an empty one`)
  assertEquals(data.rows,[])
  assertEquals(result.payload.as_of,null,'a reading with no capture must not invent one')
  assertEquals(data.expected_store,FORWARD_TABLE_CONTRACT[reading].table)
  // The distinction the note has to make, in words a model can repeat.
  assert(String(result.payload.note).includes('not built yet'))
  assert(String(result.payload.note).includes('not as an absence'))
 }
 // A table that exists but holds nothing is a DIFFERENT state.
 const present=await call(ctx({...FULL,missing:[],tables:{...FULL.tables,[FORWARD_TABLE_CONTRACT.liquidity_depth.table]:[]}}),'rwa_liquidity_depth',{})
 assertEquals((present.payload.data as Record<string,unknown>).state,'empty')
 assert(String(present.payload.note).includes('exists but is empty'))
})

Deno.test('rwa_best_wrapper names three wrappers from the stored capture and says why when it cannot',async()=>{
 const ANCHOR=4369.87655050591
 // The wrapper token table is the forward lane FULL marks absent; here it exists.
 const wrappers:Fixture={...FULL,missing:FULL.missing!.filter(table=>table!==FORWARD_TABLE_CONTRACT.wrapper_premiums.table),tables:{...FULL.tables,
  intel_rwa_wrapper_assets:[{provider:'coinmarketcap',rwa_id:'1',captured_at:CAPTURED,symbol:'GOLD',name:'Gold',asset_type:'commodity',wrapper_count:3,anchor_kind:'liquid_wrapper_median',anchor_price:ANCHOR,dispersion_bps:75.7,cheapest_crypto_id:'20245',cheapest_premium_bps:-75.7}],
  intel_rwa_wrapper_tokens:[
   {rwa_id:'1',crypto_id:'5176',captured_at:CAPTURED,symbol:'XAUT',price:ANCHOR,normalised_price:ANCHOR,premium_bps:0,volume_24h:70850040,wrapper_state:'liquid',unit_state:'consistent',in_anchor:true},
   {rwa_id:'1',crypto_id:'4705',captured_at:CAPTURED,symbol:'PAXG',price:4372.1,normalised_price:4372.1,premium_bps:5.1,volume_24h:60100000,wrapper_state:'liquid',unit_state:'consistent',in_anchor:true},
   {rwa_id:'1',crypto_id:'20245',captured_at:CAPTURED,symbol:'CGO',price:139.43,normalised_price:4336.79,premium_bps:-75.7,volume_24h:922206,wrapper_state:'liquid',unit_state:'normalised_troy_ounce',in_anchor:true},
   {rwa_id:'1',crypto_id:'31411',captured_at:CAPTURED,symbol:'XAUTT',wrapper_state:'no_price',unit_state:'not_assessed',state_reason:'price_not_reported'},
  ],
 }}
 const result=await call(ctx(wrappers),'rwa_best_wrapper',{crypto_id:'4705'})
 assertEquals(result.outcome,'served')
 assertEquals(result.payload.as_of,CAPTURED,'the answer dates itself with the capture')
 assertEquals(result.payload.calculated_by,'investor_intel')
 assertEquals((result.payload.tier as Record<string,unknown>).surface,'capture_views')
 const data=result.payload.data as Record<string,any>
 assertEquals(data.state,'ready')
 assertEquals(data.picks.cheapest.cryptoId,'20245')
 assertEquals(data.picks.closest.circular,true)
 assertEquals(data.picks.closest.closestOther.cryptoId,'4705')
 assertEquals(data.picks.mostLiquid.cryptoId,'5176')
 assertEquals(data.picks.excluded.map((row:any)=>row.reason),['price_not_reported'])
 assert(String(data.not_advice).includes('not a recommendation'))
 // An asset the capture does not hold is missing coverage, said in words.
 const missing=await call(ctx(wrappers),'rwa_best_wrapper',{rwa_id:'999'})
 assertEquals((missing.payload.data as Record<string,unknown>).state,'not_in_capture')
 assert(String(missing.payload.note).includes('missing coverage'))
 // No asset named is a served answer that says how to name one.
 const none=await call(ctx(wrappers),'rwa_best_wrapper',{})
 assert(String(none.payload.note).includes('rwa_id'))
 // A malformed id never reaches the database.
 assertEquals((await call(ctx(wrappers),'rwa_best_wrapper',{rwa_id:'1 or 1=1'})).reasonCode,'invalid_arguments')
})

Deno.test('rwa_issuer_terms reads stored review facts and never reports a review date as a deadline',async()=>{
 const result=await call(ctx(FULL),'rwa_issuer_terms',{...ARGS.rwa_issuer_terms,quantity:430})
 const data=result.payload.data as Record<string,unknown>
 // The stored review is read, not refetched: nothing here calls an issuer.
 assertEquals(data.state,'reviewed')
 assertEquals(result.payload.as_of,CAPTURED,'the reading dates itself with the review, not with now')
 assertEquals((data.denomination as Record<string,unknown>).unitsPerToken,1)
 assertEquals(data.underlying_units,430,'the unit arithmetic is done for the quantity asked about')
 const redemption=data.redemption as Record<string,unknown>
 assertEquals((redemption.threshold as Record<string,unknown>).meetsQuantity,true)
 const facts=data.facts as Array<Record<string,unknown>>
 assertEquals(facts.length,2)
 for(const fact of facts){
  assertEquals(fact.state,'current')
  assert(String(fact.source_url).startsWith('https://'),'every fact must carry its link')
  assert(fact.reviewed_at,'every fact must carry when it was reviewed')
 }
 // Below the minimum, the shortfall is reported rather than a bare refusal.
 const short=await call(ctx(FULL),'rwa_issuer_terms',{...ARGS.rwa_issuer_terms,quantity:1})
 const shortRedemption=(short.payload.data as Record<string,unknown>).redemption as Record<string,unknown>
 assertEquals((shortRedemption.threshold as Record<string,unknown>).shortfall,429)
 assert(typeof data.expiry_meaning==='string')
 // The owner's standing directive, stated in the payload so a model repeating the
 // reading cannot turn a review date into an expiry.
 assert(String(data.expiry_meaning).includes('no expiry'))
 assert(String(data.not_advice).includes('Not an eligibility decision'))
 for(const forbidden of ['expires_at','expires','current_until','review_due'])
  assert(!(forbidden in data),`an issuer terms reading must not carry ${forbidden}`)
})

Deno.test('rwa_issuer_legitimacy states that a review has no expiry',async()=>{
 const result=await call(ctx(FULL),'rwa_issuer_legitimacy',{})
 const data=result.payload.data as Record<string,unknown>
 assert(String(data.review_meaning).includes('no expiry'))
 assert(String(data.review_meaning).includes('withdraws'))
})

Deno.test('rwa_yield_provenance says which rate is ours and which was published',async()=>{
 const result=await call(ctx(FULL),'rwa_yield_provenance',{})
 const data=result.payload.data as Record<string,unknown>
 assertEquals(result.payload.calculated_by,'investor_intel')
 assert(String(data.realized_meaning).includes('OUR calculation'))
 assert(String(data.realized_meaning).includes('advertisedPct'))
})

// ── The member's own records ────────────────────────────────────────────────

Deno.test('watchlist_read returns the lists and their items',async()=>{
 const result=await call(ctx(FULL),'watchlist_read',{})
 const data=result.payload.data as Record<string,unknown>
 assertEquals((data.watchlists as unknown[]).length,1)
 assertEquals((data.items as unknown[]).length,1)
})

Deno.test('watchlist_add writes, then reads the row back before reporting success',async()=>{
 const fixture:Fixture=JSON.parse(JSON.stringify(FULL))
 fixture.missing=FULL.missing
 const result=await call(ctx(fixture),'watchlist_add',{item_type:'token',label:'ETH',notes:'From my agent'})
 assertEquals(result.outcome,'served')
 const data=result.payload.data as Record<string,unknown>
 assertEquals(data.added,true)
 // Verified by re-reading, not by trusting the insert. An insert that reported
 // success and left nothing behind is a failure here.
 assertEquals(data.verified,true)
 assertEquals((data.watchlist as Record<string,unknown>).id,LIST_ID)
})

Deno.test('watchlist_add refuses rather than creating a watchlist the member never asked for',async()=>{
 const noLists:Fixture={...FULL,tables:{...FULL.tables,watchlists:[]}}
 const result=await call(ctx(noLists),'watchlist_add',{item_type:'token',label:'ETH'})
 assertEquals(result.outcome,'refused')
 assertEquals(result.reasonCode,'no_watchlist')
 assert(String(result.payload.message).includes('Investor Intel'))
})

Deno.test('alerts_list reports the plan ceiling next to the count, not just the rows',async()=>{
 const result=await call(ctx(FULL),'alerts_list',{include_events:true})
 const data=result.payload.data as Record<string,unknown>
 assertEquals((data.alerts as unknown[]).length,1)
 assertEquals((data.events as unknown[]).length,1)
 const limits=data.plan_limits as Record<string,unknown>
 assertEquals(limits.active_alerts,1)
 assertEquals(limits.active_alerts_allowed,2000)
 assert(String(limits.note).length>0)
})

Deno.test('alert_create PROPOSES and creates nothing, and says so unmistakably',async()=>{
 const fixture:Fixture=JSON.parse(JSON.stringify(FULL))
 fixture.missing=FULL.missing
 const before=(fixture.tables!.intel_alert_rules??[]).length
 const result=await call(ctx(fixture),'alert_create',ARGS.alert_create)
 assertEquals(result.outcome,'served')
 const data=result.payload.data as Record<string,unknown>
 // The invariant that matters: no alert exists.
 assertEquals(data.created,false)
 assertEquals((fixture.tables!.intel_alert_rules??[]).length,before,'no alert row may be written by a proposal')
 assert(String(data.next_step).includes('NO ALERT EXISTS YET'))
 assert(String(data.next_step).includes('approve'))
 assert(typeof data.plan_hash==='string'&&String(data.plan_hash).length===64,'the approval signs a hash, so the agent must get it')
 // A proposal is a draft unless it said live, and that is inside the hash.
 const proposal=data.proposal as Record<string,unknown>
 assertEquals(proposal.status,'proposed')
})

Deno.test('write_status tells the agent what to do next for each state',async()=>{
 for(const [status,expected] of [['proposed','waiting'],['approved','Call write_run'],['executed','Nothing further'],['rejected','cannot run']] as const){
  const fixture:Fixture={...FULL,tables:{...FULL.tables,intel_agent_plans:[{...FULL.tables!.intel_agent_plans[0],status}]}}
  const result=await call(ctx(fixture),'write_status',{proposal_id:PLAN_ID})
  assertEquals(result.outcome,'served')
  const next=String((result.payload.data as Record<string,unknown>).next_step)
  assert(next.includes(expected),`status ${status} should advise "${expected}", said "${next}"`)
 }
 // A proposal made by another token is not visible to this one.
 const other:Fixture={...FULL,tables:{...FULL.tables,intel_agent_plans:[{...FULL.tables!.intel_agent_plans[0],token_id:'99999999-9999-4999-8999-999999999999'}]}}
 const refused=await call(ctx(other),'write_status',{proposal_id:PLAN_ID})
 assertEquals(refused.reasonCode,'plan_not_found')
})

Deno.test('save_research_note records that an agent wrote it, and writes no investigation receipt',async()=>{
 const fixture:Fixture=JSON.parse(JSON.stringify(FULL))
 fixture.missing=FULL.missing
 const result=await call(ctx(fixture),'save_research_note',{title:'Thesis check',body:'Body.',tags:['rwa']})
 assertEquals(result.outcome,'served')
 assertEquals((result.payload.data as Record<string,unknown>).saved,true)
 const stored=(fixture.tables!.saved_research??[])[0] as Record<string,unknown>
 assertEquals((stored.tags as string[])[0],'agent')
 const snapshot=stored.snapshot as Record<string,unknown>
 assertEquals(snapshot.source,'mcp')
 assertEquals(snapshot.agent_token_id,TOKEN_ID)
 // investigation_receipt is paired with private_owner_id by a CHECK and means
 // "this came out of a Connected Research run", which a note an agent typed did
 // not. Writing one would be a lie the database would accept.
 assert(!('investigation_receipt' in stored))
})

// ── whoami and data_budget ──────────────────────────────────────────────────

Deno.test('whoami says what the token cannot do, with a reason for each refusal',async()=>{
 const partial=ctx({...FULL,lockedSurfaces:['investigation']},['read:watchlists'],'starter')
 const result=await call(partial,'whoami',{})
 const data=result.payload.data as Record<string,unknown>
 assertEquals(data.scopes,['read:watchlists'])
 const available=data.tools_available as string[]
 const refused=data.tools_refused as Array<{name:string;reason:string}>
 assert(available.includes('watchlist_read'),'a held scope is available')
 assert(available.includes('market_regime'),'market data needs no scope')
 const alerts=refused.find(row=>row.name==='alerts_list')
 assert(alerts&&alerts.reason.includes('read:alerts'),'a missing scope must be named')
 const terms=refused.find(row=>row.name==='rwa_issuer_terms')
 assert(terms&&terms.reason.includes('plan'),'a locked surface must be reported as a plan matter')
 assertEquals(data.writes_require_approval,['alert_create'])
 assert(Array.isArray(data.writes_direct))
 assert((data.budget as Record<string,unknown>).limit===2000)
})

Deno.test('data_budget reports the member figures and refuses to report provider spend',async()=>{
 const result=await call(ctx(FULL),'data_budget',{})
 const data=result.payload.data as Record<string,unknown>
 const calls=data.calls as Record<string,unknown>
 assertEquals(calls.limit,2000)
 assert((calls.per_minute as Record<string,unknown>).tool===60)
 assert(Array.isArray(data.store_freshness))
 // The whole reason this tool is not the admin Data budget page: a member's agent
 // must not be handed the workspace's provider credit spend.
 const serialized=JSON.stringify(result.payload)
 for(const forbidden of ['credits_used','hard_cap','soft_cap','creditLimit','projectedCredits','rateLimit'])
  assert(!serialized.includes(forbidden),`data_budget must not expose ${forbidden}`)
 assert(String(result.payload.note).includes('super-admin'))
})

// ── The catalogue as a whole ────────────────────────────────────────────────

Deno.test('the catalogue is coherent: findTool, scopes and surfaces all resolve',async()=>{
 for(const tool of MCP_TOOLS){
  assertEquals(findTool(tool.name),tool)
  if(tool.scope)assert((AGENT_SCOPES as readonly string[]).includes(tool.scope),`${tool.name} names a scope that does not exist: ${tool.scope}`)
  assert(tool.label.length>0,`${tool.name} needs a label for its refusal sentence`)
 }
 // Only alert_create proposes; the two direct writes are the two named ones and
 // nothing else. If a third direct write appears, this test is where it has to be
 // justified.
 const writes=MCP_TOOLS.filter(tool=>tool.scope?.startsWith('write:')).map(tool=>tool.name).sort()
 assertEquals(writes,['alert_create','save_research_note','watchlist_add'])
 assert(MCP_RESOURCES.length>0&&MCP_PROMPTS.length>0)
 for(const resource of MCP_RESOURCES)assert(resource.uri.startsWith('investor-intel://'))
 // buildToolContext reads the tier and the gate table, and survives both being
 // unreadable rather than guessing a tier.
 // deno-lint-ignore no-explicit-any
 const built=await buildToolContext(stubDb(FULL) as any,agent([]),NOW)
 assertEquals(built.tier,'starter')
 assertEquals(built.minTier.agent_access,'starter')
 // deno-lint-ignore no-explicit-any
 const blind=await buildToolContext(stubDb({}) as any,agent([]),NOW)
 assertEquals(blind.tier,'unknown','an unreadable tier is unknown, never a guess')
})

Deno.test('the instructions tell a model the things it cannot work out for itself',async()=>{
 for(const phrase of ['whoami','as_of','calculated_by','withheld','scope_missing','not_available_yet','PROPOSES','ATTRIBUTION']){
  assert(SERVER_INSTRUCTIONS.includes(phrase),`the instructions must mention ${phrase}`)
 }
 // And that reading again will not produce a fresher number, so a model with a
 // stale as_of does not loop.
 assert(SERVER_INSTRUCTIONS.includes('same reading'))
})

Deno.test('the settings table lists exactly the tools this server offers',async()=>{
 // The member-facing table lives in a .jsx file that no type checker links to
 // this catalogue, so a tool added here and forgotten there would ship as a
 // capability nobody is told about. This is the only thing joining them.
 const jsx=await Deno.readTextFile(new URL('../../../../src/intel/components/AgentMcpConnect.jsx',import.meta.url))
 // One pass captures the name and the plan together, so the two can never be
 // read from different rows.
 const rows=new Map([...jsx.matchAll(/\{\s*name:\s*'([a-z0-9_]+)',\s*plan:\s*'(free|starter)'/g)].map(match=>[match[1],match[2]]))
 assertEquals([...rows.keys()].sort(),MCP_TOOLS.map(tool=>tool.name).sort(),
  'src/intel/components/AgentMcpConnect.jsx MCP_TOOL_ROWS must list exactly the tools in MCP_TOOLS')
 // And the plan column has to agree with the gate, or the table tells a member
 // something the server will contradict.
 for(const tool of MCP_TOOLS){
  const needsStarter=tool.surface==='investigation'||tool.surface==='alert_evaluation'
  assertEquals(rows.get(tool.name),needsStarter?'starter':'free',`${tool.name} is listed under the wrong plan in the settings table`)
 }
})

// ── Result size ─────────────────────────────────────────────────────────────
//
// Measured against production before this cap existed: rwa_universe at days=30
// returned 1400 series points and 520 KB on the wire, roughly 130 thousand tokens
// of a member's context window for one call. Every tool ARGUMENT was already
// bounded; a series is not an argument, which is how it slipped through. These two
// pin the bound and, just as importantly, pin that the trim is SAID rather than
// silent.

/** A regime fixture with more points than any conversation should be handed. */
function bigRegimeFixture(points:number):Fixture {
 const rows=Array.from({length:points},(_,index)=>({
  captured_at:new Date(Date.parse(CAPTURED)-(points-1-index)*3600000).toISOString(),
  fear_greed_value:40+(index%20),fear_greed_class:'Neutral',altcoin_season_index:30,
  btc_dominance:57+(index%3)/10,eth_dominance:11,total_market_cap:2.7e12,total_volume_24h:6e10,
  stablecoin_market_cap:2.8e11,defi_market_cap:8e10,
  source_observed_at:new Date(Date.parse(CAPTURED)-(points-1-index)*3600000).toISOString(),
 }))
 return {...FULL,tables:{...FULL.tables,intel_regime_snapshots:rows}}
}

Deno.test('market_regime bounds its series, keeps the newest capture, and says it trimmed',async()=>{
 const result=await call(ctx(bigRegimeFixture(400)),'market_regime',{range:'90d'})
 const data=result.payload.data as Record<string,unknown>
 const series=data.series as Array<Record<string,unknown>>
 assert(series.length<=60,`the series must be bounded, got ${series.length}`)
 const counts=data.series_points as Record<string,number>
 assertEquals(counts.returned,series.length)
 assert(counts.captured>counts.returned,'the true point count is reported, not hidden')
 // The window the caller asked for is unchanged: the newest observation is still
 // there, which is what makes a downsample honest rather than a cut.
 assertEquals(series[series.length-1].capturedAt,CAPTURED,'the newest capture must survive the trim')
 // latest is taken from the full series, so it is the newest capture whatever the
 // downsample kept.
 assertEquals((data.latest as Record<string,unknown>).capturedAt,CAPTURED)
 assert(String(result.payload.note).includes('evenly spaced'),'a trim must be said in words')
 // A short series is left completely alone, with no note about trimming.
 const small=await call(ctx(FULL),'market_regime',{range:'7d'})
 const smallCounts=(small.payload.data as Record<string,unknown>).series_points as Record<string,number>
 assertEquals(smallCounts.captured,smallCounts.returned)
 assert(!String((small.payload as Record<string,unknown>).note??'').includes('evenly spaced'))
})

Deno.test('rwa_universe bounds its series per asset type, which is where the 520 KB came from',async()=>{
 const types=['stock','commodity','etf','government_security','currency','real_estate','other']
 const rows=types.flatMap(assetType=>Array.from({length:200},(_,index)=>({
  asset_type:assetType,
  captured_at:new Date(Date.parse(CAPTURED)-(199-index)*3600000).toISOString(),
  asset_count:250,assets_scanned:250,assets_with_tokens:193,issuer_count:0,
  total_market_value_usd:1.3e9,volume_24h_usd:3e8,change_24h_pct:null,
  top_assets:[{name:'SpaceX',symbol:'SPCX',value:2.1e8,rwa_id:9}],
 })))
 const result=await call(ctx({...FULL,tables:{...FULL.tables,intel_rwa_universe_snapshots:rows}}),'rwa_universe',{days:90,top_assets:2})
 const data=result.payload.data as Record<string,unknown>
 const series=data.series as Array<Record<string,unknown>>
 assertEquals(series.length,types.length,'the fixture must produce one series per type')
 const counts=data.series_points as Record<string,number>
 // A PER-SERIES cap does not bound an ANSWER. Seven types at 60 points each came
 // back as 420 points and 180 KB in production, and would have grown again with
 // an eighth type. The budget is shared, so the total is what is bounded.
 assert(counts.returned<=counts.total_cap,`${counts.returned} points returned against a ${counts.total_cap} budget`)
 for(const entry of series){
  assert((entry.points as unknown[]).length<=counts.per_type_cap,`${String(entry.assetType)} carries ${(entry.points as unknown[]).length} points`)
 }
 assert(counts.captured>counts.returned,'the true point count is reported')
 assert(String(result.payload.note).includes('evenly spaced'))
 // Each series still keeps the newest observation, so the window is unchanged.
 for(const entry of series){
  const points=entry.points as Array<Record<string,unknown>>
  assertEquals(points[points.length-1].capturedAt,CAPTURED,`${String(entry.assetType)} lost its newest capture`)
 }
 // The whole reason the cap exists: one call has to fit in a conversation.
 const bytes=JSON.stringify(result.result).length
 assert(bytes<120_000,`a single tool result must stay readable, got ${bytes} bytes`)

 // An eighth asset type must not make the answer bigger.
 const wider=[...types,'private_credit']
 const moreRows=wider.flatMap(assetType=>Array.from({length:200},(_,index)=>({
  asset_type:assetType,
  captured_at:new Date(Date.parse(CAPTURED)-(199-index)*3600000).toISOString(),
  asset_count:250,assets_scanned:250,assets_with_tokens:193,issuer_count:0,
  total_market_value_usd:1.3e9,volume_24h_usd:3e8,change_24h_pct:null,
  top_assets:[{name:'SpaceX',symbol:'SPCX',value:2.1e8,rwa_id:9}],
 })))
 const widened=await call(ctx({...FULL,tables:{...FULL.tables,intel_rwa_universe_snapshots:moreRows}}),'rwa_universe',{days:90,top_assets:2})
 const widerCounts=(widened.payload.data as Record<string,unknown>).series_points as Record<string,number>
 assertEquals((widened.payload.data as Record<string,unknown>).asset_types instanceof Array?((widened.payload.data as Record<string,unknown>).asset_types as unknown[]).length:0,wider.length)
 assert(widerCounts.returned<=widerCounts.total_cap,'an eighth type must not widen the budget')
 assert(widerCounts.per_type_cap<counts.per_type_cap,'an eighth type shortens each series rather than growing the answer')
})

// ── Resources and prompts ───────────────────────────────────────────────────
//
// resources/list and prompts/list put these in front of the member in Claude
// Desktop and Cursor. Before this pass the server listed four things and
// implemented neither resources/read nor prompts/get, so every one of them failed
// with METHOD_NOT_FOUND when opened. These exist so that cannot return.

Deno.test('every listed resource can be read, and none of them carries member data',()=>{
 for(const resource of MCP_RESOURCES){
  const contents=readMcpResource(resource.uri)
  assert(contents,`${resource.uri} is listed and must be readable`)
  assertEquals(contents!.uri,resource.uri)
  assertEquals(contents!.mimeType,resource.mimeType,'the mime type must match what was advertised')
  assert(contents!.text.length>0,`${resource.uri} must have contents`)
 }
 assertEquals(readMcpResource('investor-intel://nope'),null,'an unlisted uri is null, never an empty success')

 // The tool catalogue resource has to agree with the catalogue itself, or a client
 // reading it as a resource is told something tools/list contradicts.
 const catalogue=JSON.parse(readMcpResource('investor-intel://tools')!.text) as {tools:Array<Record<string,unknown>>}
 assertEquals(catalogue.tools.map(tool=>tool.name),MCP_TOOLS.map(tool=>tool.name))
 for(const tool of MCP_TOOLS){
  const row=catalogue.tools.find(entry=>entry.name===tool.name)!
  assertEquals(row.scope_required,tool.scope??null,`${tool.name} scope disagrees with the catalogue`)
  assertEquals(row.plan_surface,tool.surface==='agent_access'?null:tool.surface,`${tool.name} surface disagrees with the catalogue`)
 }
 // A resource is documentation about this surface, never a member's rows: the
 // gates live on tools, and a resource holding member data would be a second door
 // into the same room with nothing guarding it.
 const grounding=readMcpResource('investor-intel://grounding')!.text
 for(const field of ['as_of','source','calculated_by','withheld','scope_missing']){
  assert(grounding.includes(field),`the grounding contract must explain ${field}`)
 }
 // The owner's standing directive, in the one document a model is most likely to
 // attach to a conversation.
 assert(/expire|no expiry|withdraws it/i.test(grounding),'the grounding contract must say a review does not expire')
})

Deno.test('every listed prompt renders, with a named blank rather than a dead end',()=>{
 for(const prompt of MCP_PROMPTS){
  const rendered=getMcpPrompt(prompt.name,{})
  assert(rendered,`${prompt.name} is listed and must render`)
  assert(rendered!.description.length>0)
  assertEquals(rendered!.messages.length,1)
  assertEquals(rendered!.messages[0].role,'user')
  // A missing required argument leaves a blank the person fills in. A prompt is a
  // starting message they edit, so refusing it would be worse than a placeholder.
  assert(rendered!.messages[0].content.text.includes('('),`${prompt.name} must name its blank`)
 }
 assertEquals(getMcpPrompt('nope',{}),null)

 const grounded=getMcpPrompt('ground_a_claim',{claim:'BTC is above 80k'})!
 assert(grounded.messages[0].content.text.includes('BTC is above 80k'))
 // Interpolated text is bounded like any other argument.
 const long=getMcpPrompt('ground_a_claim',{claim:'x'.repeat(5000)})!
 assert(long.messages[0].content.text.length<1500,'a prompt argument must be bounded')

 // A prompt that names a tool we do not have walks a model into a refusal on our
 // behalf, so every tool either prompt names has to exist.
 const names=new Set(MCP_TOOLS.map(tool=>tool.name))
 const dd=getMcpPrompt('rwa_due_diligence',{subject:'rwa:coinmarketcap:1'})!.messages[0].content.text
 for(const tool of ['rwa_universe','rwa_issuer_legitimacy','rwa_yield_provenance','rwa_issuer_terms','rwa_wrapper_premiums','rwa_best_wrapper','rwa_liquidity_depth','rwa_underlying_registrant','rwa_coverage','rwa_issuer_concentration','rwa_premium_history','rwa_exit_capacity']){
  assert(names.has(tool)&&dd.includes(tool),`the due diligence prompt must use ${tool}`)
 }
 for(const tool of ['search_assets','get_asset','market_regime']){
  assert(names.has(tool)&&grounded.messages[0].content.text.includes(tool),`the grounding prompt must use ${tool}`)
 }
 assert(/not advice|never advice/i.test(dd),'the due diligence prompt must say it is not advice')
 assert(/not an expiry/i.test(dd),'the due diligence prompt must say a review date is not an expiry')
})
