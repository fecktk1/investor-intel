// Investor Intel public MCP demo: which tools a visitor with no account may call,
// and the guards every call passes.
//
// The authenticated server (../intel-mcp) is untouched. This module reuses its
// protocol layer (_shared/intel/mcp-protocol.ts) and its tool implementations
// (_shared/intel/mcp-tools.ts) exactly as they are, and adds only what a public,
// unauthenticated endpoint needs on top of them:
//
//   1. AN ALLOWLIST. Of the 28 tools, the 18 that read stored captures on a FREE
//      plan surface. Left out: every write, every tool that reads or reports a
//      member's own records, a token or its budget, and the one read that sits
//      behind a paid surface (rwa_issuer_terms, on Connected Research). tools/list
//      never names them, and tools/call refuses them by name before anything runs.
//   2. NO ACCOUNT, BY CONSTRUCTION. The tool context carries no agent: reading
//      any field of ctx.agent throws, so a handler that reached for a member, an
//      org or a token id could not run here even if it were allowlisted.
//   3. READ ONLY, BY CONSTRUCTION. The tools see the database through readOnlyDb:
//      table reads pass; insert, update, upsert and delete throw; and every
//      database function (rpc) is refused, because a function can do anything.
//   4. NO PROVIDER CALL, BY CONSTRUCTION. Every allowlisted tool reads stored
//      captures only (traced 2026-09-23: none of their read modules issues a
//      fetch or an rpc). installOutboundGuard makes that a runtime rule as well:
//      the only outbound request the function can make is to its own database's
//      REST path, so a code path that tried to reach CoinMarketCap, CoinGecko or
//      any other provider would fail instead of spending a credit.
//   5. TRACKED ASSETS ONLY. A tool that names one asset answers only when one of
//      our capture lanes observed that asset in the last seven days, which is the
//      rule intel-demo-read applies (public.intel_demo_tracked_assets). Anything
//      else gets state not_tracked_in_demo, as an answer and not as an error.
//   6. A DEMO MARKER on every result: read only, stored data, and its as_of.
//
// Pure apart from installOutboundGuard: no Supabase client, no env. index.ts
// wires the production client; the tests drive this module with a stub.

import {
 MCP_TOOLS,MCP_PROMPTS,toolDefinitions,readMcpResource,getMcpPrompt,
 type ToolContext,type ToolSpec,
} from '../_shared/intel/mcp-tools.ts'
import {
 jsonToolResult,errorToolResult,
 type McpToolDefinition,type McpToolResult,type McpResourceContents,type McpPromptResult,
} from '../_shared/intel/mcp-protocol.ts'
import {parseToolArguments,SchemaError} from '../_shared/intel/mcp-schema.ts'
import {withTimeLabels} from '../_shared/intel/mcp-time-labels.ts'
import {AgentAuthError,type AgentContext} from '../_shared/intel/agent-token.ts'
import {suggestMarketAssets,SUGGEST_MAX_LIMIT} from '../_shared/intel/market-asset-suggest.ts'

// deno-lint-ignore no-explicit-any
type Db=any
type Args=Record<string,unknown>

export const DEMO_SERVER_INFO={name:'investor-intel-demo',title:'TheContentForge Investor Intel (public read-only demo)',version:'1.0.0'} as const

/** The tools the demo serves, in the order the full server lists them. */
export const DEMO_TOOL_NAMES=[
 'search_assets','get_asset','market_regime','market_structure','new_listings','meme_graduations',
 'rwa_universe','rwa_issuer_legitimacy','rwa_yield_provenance','rwa_wrapper_premiums','rwa_best_wrapper',
 'rwa_liquidity_depth','rwa_underlying_registrant','rwa_coverage','rwa_universe_changes',
 'rwa_issuer_concentration','rwa_premium_history','rwa_exit_capacity',
] as const

/** Every tool the demo leaves out, and why. A tool added to the full server is in
 * neither list until someone decides, and the tests fail until they do. */
export const DEMO_EXCLUDED:Record<string,string>={
 whoami:'Reports an agent token, its workspace, its plan and its daily budget. The demo has no account.',
 watchlist_read:'Reads a member\'s own watchlists.',
 watchlist_add:'Writes to a member\'s watchlist.',
 alerts_list:'Reads a member\'s own alert rules.',
 alert_create:'Proposes a write to a member\'s alerts.',
 write_status:'Reads a proposal an agent token made.',
 write_run:'Runs a write a member approved.',
 save_research_note:'Writes to a member\'s saved research.',
 data_budget:'Reports an agent token\'s daily call budget.',
 rwa_issuer_terms:'Sits on Connected Research, a Starter plan surface. A reading must not be cheaper through the demo than through the app.',
}

/** The plan surfaces the demo may serve: the ones a free account already opens
 * (intel_surface_tiers, min_tier free, read 2026-09-23). */
export const DEMO_SURFACES=['market_boards','market_regime','capture_views'] as const

const DEMO_TOOLS=new Map<string,ToolSpec>(
 MCP_TOOLS.filter(tool=>(DEMO_TOOL_NAMES as readonly string[]).includes(tool.name)).map(tool=>[tool.name,tool]),
)

export const TRACKED_WINDOW_DAYS=7
export const NOT_TRACKED='not_tracked_in_demo'
const NOT_TRACKED_TEXT=`Not among the assets this demo tracks. The demo answers for an asset only when one of our capture lanes observed it in the last ${TRACKED_WINDOW_DAYS} days. This is a fact about the demo, not about the asset. The full server, with an Investor Intel account, can look it up.`

/** Tools that name one asset, and so pass the tracked-asset check. */
const GATED=new Set(['search_assets','get_asset','market_structure','rwa_wrapper_premiums','rwa_best_wrapper','rwa_liquidity_depth','rwa_underlying_registrant','rwa_premium_history','rwa_exit_capacity'])

// ── What a client is told ──────────────────────────────────────────────────

export function demoToolDefinitions():McpToolDefinition[] {
 return toolDefinitions().filter(tool=>DEMO_TOOLS.has(tool.name)).map(tool=>({
  ...tool,
  description:`${tool.description} Public demo: read only, stored data only${GATED.has(tool.name)?', and only for assets our capture lanes track':''}.`,
 }))
}

export const DEMO_INSTRUCTIONS=[
 'Investor Intel public demo: a read-only MCP server for market and tokenized real-world-asset intelligence. No account and no token.',
 '',
 `WHAT THIS IS. ${DEMO_TOOL_NAMES.length} of the 28 Investor Intel tools: the read tools that answer from stored captures. Every answer comes from data our scheduled capture lanes already stored. Nothing here calls CoinMarketCap or any other provider, runs AI, or writes anything, so a stale as_of means the capture is stale and asking again returns the same reading.`,
 '',
 `TRACKED ASSETS ONLY. A tool that names one asset answers only for assets a capture lane observed in the last ${TRACKED_WINDOW_DAYS} days. Anything else comes back with state ${NOT_TRACKED}, which is a fact about this demo and not evidence about the asset.`,
 '',
 'GROUNDING. Every result carries demo (read only, stored data, and the as_of), as_of (the capture time the answer rests on), source and calculated_by. When calculated_by is "investor_intel" the figure is OURS, not the provider\'s: say so when you quote it. as_of can be null, which means nothing has been captured yet; never substitute the current time for it.',
 '',
 'TIME. Every timestamp is ISO 8601 in UTC. time_labels maps each one in a result to a readable label with its weekday (for example "Tue 22 Sep 2026, 16:58:36 UTC"): quote those labels rather than working out a weekday yourself.',
 '',
 'NOT HERE. Watchlists, alerts, research notes, write proposals, whoami, data_budget and rwa_issuer_terms need an Investor Intel account (Starter plan or above) and an agent token on the full server.',
 '',
 'LIMITS. Tool calls are limited per network address, per minute and per day. A 429 says when to retry.',
 '',
 'ATTRIBUTION. meme_graduations carries a CoinGecko attribution on its result. Show it wherever you show those figures; it is a licence condition.',
].join('\n')

export const DEMO_RESOURCES=[
 {
  uri:'investor-intel://tools',
  name:'Tool catalogue',
  title:'The tools this demo serves, and the ones it leaves out',
  description:'The demo tool list, plus every tool of the full server this demo leaves out and why.',
  mimeType:'application/json',
 },
 {
  uri:'investor-intel://grounding',
  name:'Grounding contract',
  title:'What as_of, source and calculated_by mean',
  description:'How to quote a figure from this server: which fields date it, which name its provider, and when a number is our calculation rather than a provider\'s.',
  mimeType:'text/markdown',
 },
]

export function readDemoResource(uri:string):McpResourceContents|null {
 if(uri==='investor-intel://tools'){
  return {
   uri,mimeType:'application/json',
   text:JSON.stringify({
    server:DEMO_SERVER_INFO.name,
    tools:[...DEMO_TOOLS.values()].map(tool=>({name:tool.name,title:tool.title,description:tool.description,plan_surface:tool.surface,writes:'read only',tracked_assets_only:GATED.has(tool.name)})),
    not_in_demo:Object.entries(DEMO_EXCLUDED).map(([name,reason])=>({name,reason})),
    note:`The full server has ${MCP_TOOLS.length} tools and needs an Investor Intel account (Starter plan or above) and an agent token.`,
   }),
  }
 }
 // The grounding contract is static prose about the envelope, the same for both.
 if(uri==='investor-intel://grounding')return readMcpResource(uri)
 return null
}

export const DEMO_PROMPTS=MCP_PROMPTS

export function getDemoPrompt(name:string,args:Args):McpPromptResult|null {
 const prompt=getMcpPrompt(name,args)
 if(!prompt||name!=='rwa_due_diligence')return prompt
 // The walk names rwa_issuer_terms, which this demo does not serve.
 return {
  ...prompt,
  messages:prompt.messages.map(message=>({...message,content:{...message.content,text:`${message.content.text}\n\nIn this public demo, rwa_issuer_terms is not available (it needs an account), so skip step 4 and say that you skipped it.`}})),
 }
}

// ── The context the tools run in ───────────────────────────────────────────

export class DemoReadOnlyError extends Error {
 constructor(what:string){super(`demo_read_only: ${what}`);this.name='DemoReadOnlyError'}
}

const WRITE_METHODS=new Set(['insert','upsert','update','delete'])
const CLOSED_CLIENT_PROPERTIES=new Set(['functions','storage','schema','channel','realtime','auth','removeChannel','removeAllChannels'])

/**
 * The database as the tools see it: table reads only.
 *
 * `from(table)` returns the real query builder with its four write methods
 * replaced by a throw, so a read chain (select, filters, order, limit) is
 * untouched. `rpc` answers with an error rather than running anything, because
 * a database function can write or reach out. The client's other doors (Edge
 * Function invocation, storage, realtime, auth) throw on access.
 */
export function readOnlyDb(db:Db):Db {
 return new Proxy(db,{
  get(target,prop){
   if(prop==='rpc')return (name:unknown)=>Promise.resolve({data:null,error:{code:'demo_read_only',message:`demo_read_only: the public demo runs no database function (${String(name)})`}})
   if(prop==='from'){
    return (table:string)=>{
     const builder=target.from(table)
     return new Proxy(builder,{
      get(inner,key){
       if(typeof key==='string'&&WRITE_METHODS.has(key))return ()=>{throw new DemoReadOnlyError(`${key} on ${table}`)}
       const value=inner[key]
       return typeof value==='function'?value.bind(inner):value
      },
     })
    }
   }
   if(typeof prop==='string'&&CLOSED_CLIENT_PROPERTIES.has(prop))throw new DemoReadOnlyError(prop)
   const value=target[prop]
   return typeof value==='function'?value.bind(target):value
  },
 })
}

/** No account. Any read of an agent field is a bug, and throws as one. */
export const DEMO_AGENT=new Proxy({} as AgentContext,{
 get(_target,prop){
  if(prop==='then'||typeof prop==='symbol')return undefined
  throw new DemoReadOnlyError(`the demo has no account (agent.${String(prop)})`)
 },
})

export function demoContext(db:Db,now:number):ToolContext {
 return {db:readOnlyDb(db),agent:DEMO_AGENT,now,tier:'demo',minTier:{}}
}

// ── Tracked assets ─────────────────────────────────────────────────────────

export interface Identity {sourceProvider:string;providerId:string}

export interface TrackedReaders {
 /** The tracked subset of these catalogue identities, as 'provider:id'. */
 assets(identities:Identity[]):Promise<Set<string>>
 /** The tracked subset of these CoinMarketCap RWA ids. */
 rwaIds(ids:string[]):Promise<Set<string>>
 /** The tracked subset of these ten-digit SEC CIKs. */
 ciks(ciks:string[]):Promise<Set<string>>
}

const CMC_ID=/^[1-9][0-9]{0,11}$/
const DEMO_PROVIDERS=['coinmarketcap','coingecko']

/**
 * The production readers. Assets go through public.intel_demo_tracked_assets,
 * the function intel-demo-read uses: a catalogue row refreshed in the window, or
 * a CoinMarketCap id one of the RWA wrapper, depth or coverage lanes captured in
 * it. An RWA id is tracked when the wrapper or coverage lane captured it in the
 * same window, and a CIK when the underlying-registrant lane holds it for a
 * tracked RWA id. All reads, through the service role; nothing here writes.
 */
export function trackedReaders(db:Db,now:number):TrackedReaders {
 const cutoff=new Date(now-TRACKED_WINDOW_DAYS*86_400_000).toISOString()
 const rwaIds=async(ids:string[]):Promise<Set<string>>=>{
  const wanted=[...new Set(ids.filter(id=>CMC_ID.test(id)))].slice(0,50)
  if(!wanted.length)return new Set()
  const [wrappers,coverage]=await Promise.all([
   db.from('intel_rwa_wrapper_assets').select('rwa_id').in('rwa_id',wanted).gte('captured_at',cutoff).limit(500),
   db.from('intel_rwa_coverage_assets').select('rwa_id').in('rwa_id',wanted).gte('captured_at',cutoff).limit(500),
  ])
  if(wrappers.error||coverage.error)throw new Error('tracked_read_failed')
  return new Set([...(wrappers.data??[]),...(coverage.data??[])].map((row:{rwa_id?:unknown})=>String(row.rwa_id)))
 }
 return {
  async assets(identities){
   const asked=identities.filter(identity=>DEMO_PROVIDERS.includes(identity.sourceProvider)).slice(0,200)
   if(!asked.length)return new Set()
   const {data,error}=await db.rpc('intel_demo_tracked_assets',{p_identities:asked})
   if(error)throw new Error('tracked_read_failed')
   return new Set((Array.isArray(data)?data:[]).map((row:{source_provider?:unknown;provider_id?:unknown})=>`${row.source_provider}:${row.provider_id}`))
  },
  rwaIds,
  async ciks(ciks){
   const wanted=[...new Set(ciks.filter(cik=>/^[0-9]{10}$/.test(cik)))].slice(0,10)
   if(!wanted.length)return new Set()
   const {data,error}=await db.from('intel_rwa_underlying_registrants').select('cik,rwa_id').in('cik',wanted).limit(50)
   if(error)throw new Error('tracked_read_failed')
   const rows=(Array.isArray(data)?data:[]) as Array<{cik?:unknown;rwa_id?:unknown}>
   const tracked=await rwaIds(rows.map(row=>String(row.rwa_id)))
   return new Set(rows.filter(row=>tracked.has(String(row.rwa_id))).map(row=>String(row.cik)))
  },
 }
}

type Gate={ok:true;args:Args;note?:string}|{ok:false;asked:Record<string,unknown>}

const key=(identity:Identity)=>`${identity.sourceProvider}:${identity.providerId}`
const cmc=(id:string):Identity=>({sourceProvider:'coinmarketcap',providerId:id})

async function trackedCmc(tracked:TrackedReaders,id:unknown):Promise<boolean> {
 if(typeof id!=='string'||!CMC_ID.test(id))return false
 return (await tracked.assets([cmc(id)])).has(key(cmc(id)))
}

/** Decide, before a tool reads anything, whether the asset it names is tracked.
 * Returns the arguments to run with (which for get_asset are the exact identity
 * a query resolved to), or what was asked for a not_tracked_in_demo answer. */
async function gate(ctx:ToolContext,tracked:TrackedReaders,name:string,args:Args):Promise<Gate> {
 switch(name){
  case 'search_assets':
   // Ask for the most the catalogue returns, since untracked rows are removed
   // afterwards; the requested limit is applied to what is left.
   return {ok:true,args:{...args,limit:SUGGEST_MAX_LIMIT}}
  case 'get_asset':{
   if(typeof args.provider==='string'&&typeof args.provider_id==='string'){
    // An exact identity is checked BEFORE anything is read about it.
    const identity={sourceProvider:args.provider,providerId:args.provider_id}
    return (await tracked.assets([identity])).has(key(identity))
     ?{ok:true,args}
     :{ok:false,asked:{provider:args.provider,provider_id:args.provider_id}}
   }
   // A query is resolved the way the full tool resolves it (the best catalogue
   // match), then that identity is checked, then read exactly.
   const suggest=await suggestMarketAssets(ctx.db,args.query,1)
   const best=suggest.matches[0]
   if(!best)return {ok:true,args}
   const identity={sourceProvider:best.sourceProvider,providerId:String(best.providerId)}
   if(!DEMO_PROVIDERS.includes(identity.sourceProvider)||!(await tracked.assets([identity])).has(key(identity))){
    return {ok:false,asked:{query:args.query??null,best_match:{provider:identity.sourceProvider,provider_id:identity.providerId,symbol:best.symbol??null}}}
   }
   return {ok:true,args:{provider:identity.sourceProvider,provider_id:identity.providerId}}
  }
  case 'market_structure':{
   if(args.figure==='attention'&&args.provider_id!==undefined){
    return await trackedCmc(tracked,args.provider_id)?{ok:true,args}:{ok:false,asked:{figure:'attention',provider_id:args.provider_id}}
   }
   if(args.figure==='liquidations'&&Array.isArray(args.provider_ids)){
    const ids=(args.provider_ids as unknown[]).map(String)
    const known=await tracked.assets(ids.filter(id=>CMC_ID.test(id)).map(cmc))
    const kept=ids.filter(id=>known.has(key(cmc(id))))
    if(!kept.length)return {ok:false,asked:{figure:'liquidations',provider_ids:ids}}
    const left=ids.filter(id=>!kept.includes(id))
    return {ok:true,args:{...args,provider_ids:kept},...(left.length?{note:`Left out because this demo does not track them: ${left.join(', ')}.`}:{})}
   }
   return {ok:true,args}
  }
  case 'rwa_wrapper_premiums':
   if(args.subject===undefined)return {ok:true,args}
   return await trackedCmc(tracked,args.subject)?{ok:true,args}:{ok:false,asked:{subject:args.subject}}
  case 'rwa_liquidity_depth':{
   if(args.subject===undefined)return {ok:true,args}
   // The demo names a token by its CoinMarketCap id; a contract key is not a
   // tracked identity here.
   const match=/^cmc:([1-9][0-9]{0,11})$/.exec(String(args.subject))
   return match&&await trackedCmc(tracked,match[1])?{ok:true,args}:{ok:false,asked:{subject:args.subject,hint:'Name the token as cmc:<crypto id>.'}}
  }
  case 'rwa_best_wrapper':
  case 'rwa_premium_history':{
   if(args.crypto_id!==undefined&&!await trackedCmc(tracked,args.crypto_id))return {ok:false,asked:{crypto_id:args.crypto_id}}
   if(args.rwa_id!==undefined){
    const id=String(args.rwa_id)
    if(!(await tracked.rwaIds([id])).has(id))return {ok:false,asked:{rwa_id:args.rwa_id}}
   }
   return {ok:true,args}
  }
  case 'rwa_exit_capacity':
   return await trackedCmc(tracked,args.crypto_id)?{ok:true,args}:{ok:false,asked:{crypto_id:args.crypto_id}}
  case 'rwa_underlying_registrant':{
   if(args.subject===undefined)return {ok:true,args}
   const cik=String(args.subject)
   return (await tracked.ciks([cik])).has(cik)?{ok:true,args}:{ok:false,asked:{subject:args.subject}}
  }
  default:
   return {ok:true,args}
 }
}

/** search_assets, with every match that is not a tracked catalogue identity
 * removed and the requested limit applied to what is left. */
async function trackedMatches(payload:Args,limit:number,tracked:TrackedReaders):Promise<Args> {
 const data=(payload.data??{}) as Args
 const matches=(Array.isArray(data.matches)?data.matches:[]) as Array<{sourceProvider?:unknown;providerId?:unknown}>
 const candidates=matches.filter(row=>typeof row.sourceProvider==='string'&&DEMO_PROVIDERS.includes(row.sourceProvider))
 const known=candidates.length
  ?await tracked.assets(candidates.map(row=>({sourceProvider:String(row.sourceProvider),providerId:String(row.providerId)})))
  :new Set<string>()
 const kept=candidates.filter(row=>known.has(`${row.sourceProvider}:${row.providerId}`)).slice(0,limit)
 const dropped=matches.length-kept.length
 const demoNote=kept.length
  ?(dropped>0?`${dropped} catalogue match${dropped===1?' was':'es were'} left out because this demo does not track ${dropped===1?'it':'them'}.`:null)
  :(matches.length?`The catalogue has matches, but none is among the assets this demo tracks.`:null)
 return {
  ...payload,
  ...(demoNote?{note:[payload.note,demoNote].filter(Boolean).join(' ')}:{}),
  data:{...data,limit,matches:kept,...(kept.length?{}:matches.length?{state:NOT_TRACKED}:{})},
 }
}

// ── The demo marker ────────────────────────────────────────────────────────

export function demoMarker(asOf:string|null,now:number):Record<string,unknown> {
 return {
  server:DEMO_SERVER_INFO.name,
  read_only:true,
  data:'stored',
  as_of:asOf,
  served_at:new Date(now).toISOString(),
  notice:`Read-only public demo data from Investor Intel, stored ${asOf?`as of ${asOf}`:'data with no capture time (nothing captured yet for this reading)'}. No provider was called and nothing was written. The full server has ${MCP_TOOLS.length} tools and needs an account.`,
 }
}

function marked(payload:Args,now:number):Args {
 const asOf=typeof payload.as_of==='string'?payload.as_of:null
 return {demo:demoMarker(asOf,now),...payload}
}

function notTracked(tool:ToolSpec,asked:Record<string,unknown>,now:number):Args {
 return marked({
  tool:tool.name,
  as_of:null,
  source:{provider:'investor_intel',endpoint_family:null,store:'intel_demo_tracked_assets'},
  calculated_by:'investor_intel',
  tier:{tier:'demo',surface:tool.surface,open:true},
  note:NOT_TRACKED_TEXT,
  data:{state:NOT_TRACKED,asked,message:NOT_TRACKED_TEXT},
 },now)
}

// ── One call ───────────────────────────────────────────────────────────────

export interface DemoCall {
 result:McpToolResult
 outcome:'served'|'refused'|'failed'
 reasonCode:string|null
}

const refusal=(code:string,message:string,now:number,extra:Args={}):McpToolResult=>
 errorToolResult(code,message,{demo:demoMarker(null,now),...extra})

/**
 * Run one allowlisted tool: schema, tracked-asset gate, the tool's own handler,
 * then the demo marker. A name outside the allowlist is refused here as well as
 * at tools/list, so nothing but the allowlist can ever reach a handler.
 */
export async function callDemoTool(ctx:ToolContext,tracked:TrackedReaders,name:string,args:Args):Promise<DemoCall> {
 const tool=DEMO_TOOLS.get(name)
 if(!tool){
  const why=DEMO_EXCLUDED[name]
  return {result:refusal('not_in_demo',why?`${name} is not part of the public demo. ${why}`:`${name} is not a tool this demo offers. Call tools/list.`,ctx.now),outcome:'refused',reasonCode:'not_in_demo'}
 }
 let parsed:Args
 try{
  parsed=parseToolArguments(tool.schema,args)
 }catch(error){
  const message=error instanceof SchemaError?error.message:'The arguments could not be read.'
  return {result:refusal('invalid_arguments',message,ctx.now,{tool:name,schema:tool.schema}),outcome:'refused',reasonCode:'invalid_arguments'}
 }
 try{
  const decision=await gate(ctx,tracked,name,parsed)
  if(!decision.ok)return {result:jsonToolResult(notTracked(tool,decision.asked,ctx.now)),outcome:'served',reasonCode:NOT_TRACKED}
  let payload=await tool.handler(ctx,decision.args)
  if(name==='search_assets')payload=await trackedMatches(payload,Number(parsed.limit),tracked)
  if(decision.note)payload={...payload,note:[payload.note,decision.note].filter(Boolean).join(' ')}
  return {result:jsonToolResult(withTimeLabels(marked(payload,ctx.now))),outcome:'served',reasonCode:null}
 }catch(error){
  if(error instanceof AgentAuthError){
   return {result:refusal(error.code,error.message,ctx.now,{tool:name}),outcome:'refused',reasonCode:error.code}
  }
  const message=error instanceof Error?error.message:'tool_failed'
  if(/^(invalid_|chart_)/.test(message)){
   return {result:refusal(message,`That request was refused by the same validation the full server applies: ${message}.`,ctx.now,{tool:name}),outcome:'refused',reasonCode:message.slice(0,60)}
  }
  console.error(`[intel-mcp-demo] ${name}:`,message.slice(0,200))
  return {result:refusal('tool_unavailable',`${name} could not be answered right now. Retry when the service is ready.`,ctx.now,{tool:name}),outcome:'failed',reasonCode:error instanceof DemoReadOnlyError?'demo_read_only':'tool_unavailable'}
 }
}

// ── Outbound requests ──────────────────────────────────────────────────────

export interface OutboundGuard {
 /** Refused outbound requests since the guard was installed. */
 refused():number
 restore():void
}

/**
 * Replace the global fetch with one that only reaches `allowedPrefix` (the
 * project's own PostgREST path, `${SUPABASE_URL}/rest/v1/`). Everything else,
 * a provider API, another Edge Function or any other host, is refused with an
 * error and counted. The real fetch is returned for the one client that needs it.
 */
export function installOutboundGuard(allowedPrefix:string,log:(line:string)=>void=console.warn):OutboundGuard&{fetch:typeof fetch} {
 const realFetch=globalThis.fetch
 const allowed=new URL(allowedPrefix)
 let refused=0
 const guarded:typeof fetch=(input,init)=>{
  const raw=typeof input==='string'?input:input instanceof URL?input.href:(input as Request).url
  let url:URL|null=null
  try{url=new URL(raw)}catch{url=null}
  if(url&&url.origin===allowed.origin&&url.pathname.startsWith(allowed.pathname))return realFetch(input,init)
  refused++
  log(`[intel-mcp-demo] outbound request refused: ${url?url.host:'unparseable url'}`)
  return Promise.reject(new DemoReadOnlyError(`outbound request to ${url?url.host:'an unparseable url'} refused; the demo reads stored data only`))
 }
 globalThis.fetch=guarded
 return {fetch:guarded,refused:()=>refused,restore:()=>{globalThis.fetch=realFetch}}
}
