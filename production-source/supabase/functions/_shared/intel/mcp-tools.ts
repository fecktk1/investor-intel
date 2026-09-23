// The tools a connected agent gets, and the three gates each one passes.
//
// ORDER OF CHECKS, and why it is this order:
//
//   1. SCHEMA. Cheapest, and it happens before anything is read, so an oversize
//      page or an undeclared argument costs one function call rather than a query.
//   2. SCOPE. Before the tier gate and before the read. A read-only token asking
//      for a write must be told it lacks the scope, not told about the plan, and
//      must never learn whether the row it named exists.
//   3. TIER, through requireIntelSurface, the same call the app makes. The
//      refusal is produced INSTEAD OF the reading, never alongside it: see the
//      note at the top of intel-surface-access.ts. A withheld tool result carries
//      the surface, the tier and the plan that opens it, and no row, count or
//      sample of what was withheld.
//
// READS SPEND NOTHING. Every read tool here reads a precomputed capture, a cached
// observation or the member's own rows. Not one of them calls a provider, which is
// what makes it safe to hand a model a tool it can call sixty times a minute: the
// worst case is database load we already bound, not a credit bill. The one place
// that could have spent — a live quote — reads the retained observation instead
// (readCachedAssetQuote), and says how old it is rather than refreshing it.
//
// WRITES ARE PROPOSALS, NOT WRITES. alert_create does not create an alert. It
// records a proposal through the existing validateAgentPlan pipeline and returns
// the plan hash; a person approves it in Investor Intel and the agent then calls
// write_run. That pipeline, its hash, its approval and its post-write verification
// already exist (agent-plan.ts, agent-write.ts) and exist precisely so software
// cannot change a member's book unattended. Giving MCP its own direct path to
// intel_alert_rules would have been a second, weaker door to the same room, so
// there isn't one. The two writes that are direct — watchlist_add and
// save_research_note — touch objects the approval pipeline never covered, are
// reversible by the member in one click, and are bounded by the same per-tier
// triggers the app is bounded by.
//
// NO SCOPE FOR MARKET AND RWA DATA, deliberately. Those readings are the product's
// shared intelligence, not the member's private records, and they are gated by
// tier alone. Requiring a new read scope for them would refuse every token minted
// before today on every new tool, which is a migration problem dressed up as a
// security control. The member's OWN records keep their existing scopes exactly.

import {requireIntelSurface,IntelSurfaceLockedError,type IntelSurface} from './intel-surface-access.ts'
import {AgentAuthError,requireScope,type AgentContext,type AgentScope} from './agent-token.ts'
import {validateAgentPlan} from './agent-plan.ts'
import {executeAgentPlan} from './agent-write.ts'
import {projectPlan,projectAlerts,projectWatchlists,projectWatchlistItems} from './agent-projection.ts'
import {parseToolArguments,SchemaError,LIMIT_PROPERTY,ISO_DAYS,QUERY_PATTERN,SYMBOL_PATTERN,UUID_PATTERN,CHAIN_PATTERN,type JsonSchema} from './mcp-schema.ts'
import {grounded,withheld,emptyNote,reasonSentence,oldestOf,type SourceRef,type CalculatedBy} from './mcp-grounding.ts'
import {jsonToolResult,errorToolResult,type McpToolResult,type McpToolDefinition,type McpResourceContents,type McpPromptResult} from './mcp-protocol.ts'
import {readForwardTable,FORWARD_TABLE_CONTRACT} from './mcp-rwa-forward.ts'
import {readDailyBudget,MINUTE_LIMITS} from './mcp-quota.ts'
import {readRegime,readRwaUniverse,readBreadth} from './capture-read.ts'
import {readNewListings} from './capture-listings-read.ts'
import {readMemeGraduation} from './capture-meme-read.ts'
import {readRwaIssuerLegitimacy} from './capture-rwa-issuer-read.ts'
import {readRwaYield} from './capture-rwa-yield-read.ts'
import {readRwaWrapperPicks} from './capture-rwa-wrappers-read.ts'
import {suggestMarketAssets,SUGGEST_MAX_LIMIT,SUGGEST_MIN_LENGTH,SUGGEST_MAX_LENGTH} from './market-asset-suggest.ts'
import {readCachedAssetQuote} from './cached-asset-quote.ts'
import {readMetricAgreement} from './metric-agreement-read.ts'
import {metricAgreementReceipt} from './metric-agreement.ts'
import {rwaTermsProjection} from './rwa-terms.ts'
import {COINGECKO_ATTRIBUTION} from './launchpad-registry.ts'
import {SERIES_TOTAL_CAP,perGroupCap,trimSeries,trimNote,notes} from './mcp-size.ts'
import {withTimeLabels} from './mcp-time-labels.ts'
import {rwaCoverage,rwaUniverseChanges,rwaIssuerConcentration,rwaPremiumHistory,rwaExitCapacity,marketStructure,MARKET_FIGURE_NAMES,HISTORY_WRAPPER_CAP} from './mcp-readings.ts'

// deno-lint-ignore no-explicit-any
type Db=any

/** Store names, written out so a `source.store` in a result is a table a person
 * can actually go and look at. */
const STORE={
 regime:'intel_regime_snapshots',
 breadth:'coinmarketcap_listings_latest',
 listings:'intel_new_listing_snapshots',
 meme:'intel_meme_stage_snapshots',
 rwaUniverse:'intel_rwa_universe_snapshots',
 rwaIssuer:'intel_rwa_issuer_filings',
 rwaYield:'intel_rwa_yield_snapshots',
 catalogue:'market_assets',
 observations:'intel_market_observations',
} as const

const CMC=(family:string,store:string):SourceRef=>({provider:'coinmarketcap',endpoint_family:family,store})
const OURS=(store:string):SourceRef=>({provider:'investor_intel',endpoint_family:null,store})

// Result size: SERIES_POINT_CAP, SERIES_TOTAL_CAP, perGroupCap, trimSeries,
// trimNote and the last-resort fitToBudget live in mcp-size.ts, with the reasons.
// Every tool here, old and new, is held to them.

// ── Request-scoped context ──────────────────────────────────────────────────

export interface ToolContext {
 db:Db
 agent:AgentContext
 now:number
 /** Effective tier of the token's pinned org, read once per request. */
 tier:string
 /** surface -> min_tier, from intel_surface_tiers. SQL stays the authority for
  * the decision; this is only for naming the plan in a refusal. */
 minTier:Record<string,string>
}

export async function buildToolContext(db:Db,agent:AgentContext,now:number):Promise<ToolContext> {
 const [tierResult,tiers]=await Promise.all([
  db.rpc('intel_effective_tier',{p_org:agent.orgId}),
  db.from('intel_surface_tiers').select('surface,min_tier').limit(64),
 ])
 const minTier:Record<string,string>={}
 for(const row of (tiers?.data??[]) as Array<{surface?:unknown;min_tier?:unknown}>){
  if(typeof row.surface==='string'&&typeof row.min_tier==='string')minTier[row.surface]=row.min_tier
 }
 // A tier that cannot be read is reported as unknown rather than guessed at.
 // Nothing is decided from this value: intel_surface_allowed decides, and it
 // reads the tier itself.
 const tier=typeof tierResult?.data==='string'&&tierResult.data?tierResult.data:'unknown'
 return {db,agent,now,tier,minTier}
}

// ── Tool spec ───────────────────────────────────────────────────────────────

export interface ToolSpec {
 name:string
 title:string
 description:string
 schema:JsonSchema
 /** The surface whose tier decides this tool. 'agent_access' means "no gate
  * beyond the one already passed at the door", which every token has by
  * definition, so those tools are never withheld. */
 surface:IntelSurface
 /** What a refusal calls this reading, in words. */
 label:string
 scope?:AgentScope
 handler(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>>
}

const object=(properties:Record<string,JsonSchema>,required:readonly string[]=[]):JsonSchema=>
 ({type:'object',properties,required,additionalProperties:false})

// ── Handlers: market and RWA (shared precomputed captures) ──────────────────

async function searchAssets(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const result=await suggestMarketAssets(ctx.db,args.query,args.limit)
 const note=result.error
  ?reasonSentence(result.error)
  :result.matches.length?null:`Nothing in the catalogue matches "${String(args.query)}". Try a ticker, a full name, or a contract address written as chain:address.`
 return grounded({
  tool:'search_assets',
  // The catalogue row carries its own as_of; the suggest read does not return
  // one, so the honest answer here is the oldest as_of among what came back.
  as_of:null,
  source:OURS(STORE.catalogue),
  calculated_by:'investor_intel',
  inputs:[`${STORE.catalogue} identity columns (symbol, name, platforms)`],
  tier:{tier:ctx.tier,surface:'market_boards',open:true},
  note,
 },{query:result.q,limit:result.limit,matches:result.matches})
}

/** One asset: who it is, where it is deployed, the newest retained quote and what
 * our own cross-source agreement check says about that quote. */
async function getAsset(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const provider=args.provider as string|undefined,providerId=args.provider_id as string|undefined
 let row:Record<string,unknown>|null=null
 let note:string|null=null
 if(provider&&providerId){
  const {data}=await ctx.db.from(STORE.catalogue)
   .select('source_provider,provider_id,provider_slug,symbol,name,normalized_symbol,primary_chain,market_cap_rank,current_price,market_cap,fdv,volume_24h,change_24h_pct,circulating_supply,total_supply,platforms,image_url,source_url,source_label,attribution_label,as_of,in_current_catalog')
   .eq('source_provider',provider).eq('provider_id',providerId).maybeSingle()
  row=(data as Record<string,unknown>|null)??null
  if(!row)note=`${provider} has no asset ${providerId} in our catalogue.`
 }else{
  const suggest=await suggestMarketAssets(ctx.db,args.query,1)
  const best=suggest.matches[0]
  if(!best){
   note=suggest.error?reasonSentence(suggest.error):`Nothing in the catalogue matches "${String(args.query??'')}". Call search_assets to see near matches.`
  }else{
   const {data}=await ctx.db.from(STORE.catalogue)
    .select('source_provider,provider_id,provider_slug,symbol,name,normalized_symbol,primary_chain,market_cap_rank,current_price,market_cap,fdv,volume_24h,change_24h_pct,circulating_supply,total_supply,platforms,image_url,source_url,source_label,attribution_label,as_of,in_current_catalog')
    .eq('source_provider',best.sourceProvider).eq('provider_id',best.providerId).maybeSingle()
   row=(data as Record<string,unknown>|null)??null
   if(!row)note=`${best.sourceProvider}:${best.providerId} matched the search but its catalogue row could not be read.`
  }
 }
 if(!row){
  return grounded({
   tool:'get_asset',as_of:null,source:OURS(STORE.catalogue),calculated_by:'investor_intel',
   tier:{tier:ctx.tier,surface:'market_boards',open:true},note,
  },{asset:null,contracts:[],quote:null,evidence:null})
 }

 const platforms=row.platforms&&typeof row.platforms==='object'&&!Array.isArray(row.platforms)
  ?Object.entries(row.platforms as Record<string,unknown>).filter(([,address])=>typeof address==='string').map(([chain,address])=>({chain,contract_address:address as string}))
  :[]
 const canonicalKey=`market:${row.source_provider}:${row.provider_id}`
 // Both of these read stored observations only. A cache miss is reported as a
 // miss; nothing here refreshes a quote.
 const [quote,agreement]=await Promise.all([
  readCachedAssetQuote(ctx.db,{canonicalKey},ctx.now).catch(()=>null),
  row.source_provider==='coinmarketcap'
   ?readMetricAgreement(ctx.db,canonicalKey,ctx.now).catch(()=>null)
   :Promise.resolve(null),
 ])
 const quoteAsOf=quote?.freshness?.as_of??null
 const receipt=agreement?metricAgreementReceipt(agreement):null
 return grounded({
  tool:'get_asset',
  // The catalogue row and the retained quote have different clocks. The reading
  // is only as fresh as the older of the two, so that is what it dates itself
  // with rather than the flattering one.
  as_of:oldestOf(typeof row.as_of==='string'?row.as_of:null,quoteAsOf)??(typeof row.as_of==='string'?row.as_of:null),
  source:[OURS(STORE.catalogue),CMC('/v*/cryptocurrency/quotes/latest',STORE.observations)],
  calculated_by:'provider',
  tier:{tier:ctx.tier,surface:'market_boards',open:true},
  note:note??(quoteAsOf?null:'No retained quote inside the last 24 hours, so the price shown is the catalogue snapshot rather than a corroborated observation.'),
 },{
  asset:{
   source_provider:row.source_provider,provider_id:row.provider_id,provider_slug:row.provider_slug,
   symbol:row.symbol,name:row.name,primary_chain:row.primary_chain,rank:row.market_cap_rank,
   in_current_catalog:row.in_current_catalog,canonical_key:canonicalKey,
   source_url:row.source_url,attribution:row.attribution_label??row.source_label??null,
   catalogue_as_of:row.as_of,
  },
  catalogue_figures:{
   price_usd:row.current_price,market_cap_usd:row.market_cap,fdv_usd:row.fdv,
   volume_24h_usd:row.volume_24h,change_24h_pct:row.change_24h_pct,
   circulating_supply:row.circulating_supply,total_supply:row.total_supply,
  },
  contracts:platforms,
  quote:quote?.freshness?{...quote.freshness,fields:Object.fromEntries(Object.entries(quote.fields??{}).map(([key,observation]:[string,any])=>[key,{value:observation?.value??null,unit:observation?.unit??null,observed_at:observation?.observedAt??null,source_ref:observation?.sourceRef??null}]))}:null,
  // Our own verdict on whether independently recorded metrics agree. Named as
  // ours, with its reasons, so it is never read as a provider's rating.
  evidence:receipt?{...receipt,calculated_by:'investor_intel' as CalculatedBy,meaning:'Whether separately recorded price, market cap and volume moves point the same way over the same period. Not a rating of the asset.'}:null,
  evidence_note:receipt?null:'Cross-source agreement is only recorded for CoinMarketCap listings, so there is no verdict for this asset.',
 })
}

async function marketRegime(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const [regime,breadth]=await Promise.all([
  readRegime(ctx.db,{range:args.range as string},ctx.now),
  readBreadth(ctx.db,{},ctx.now),
 ])
 const series=(regime.series as Record<string,unknown>[]|undefined)??[]
 // `latest` is taken from the FULL series before the trim, so it is always the
 // newest capture rather than whichever point survived the downsample.
 const latest=series.length?series[series.length-1]:null
 const trimmed=trimSeries(series)
 return grounded({
  tool:'market_regime',
  as_of:regime.asOf,
  source:[CMC('/v1/global-metrics/quotes/latest',STORE.regime),CMC('/v1/cryptocurrency/listings/latest',STORE.breadth)],
  calculated_by:'provider',
  tier:{tier:ctx.tier,surface:'market_regime',open:true},
  coverage:regime.coverage,
  note:notes(emptyNote(series.length,regime.asOf,regime.reason,'the market regime'),trimNote(trimmed.length,series.length,'regime series')),
 },{
  range:regime.range,
  latest,
  series:trimmed,
  series_points:{returned:trimmed.length,captured:series.length},
  // Breadth is ours: a cap-weighted return minus the median, over one stored
  // listings snapshot. Labelled so it is never quoted as a provider figure.
  breadth:{
   snapshot_date:breadth.snapshotDate??null,universe:breadth.universe??null,
   cap_weighted_return_pct:breadth.capWeightedReturnPct??null,median_return_pct:breadth.medianReturnPct??null,
   spread_pts:breadth.spreadPts??null,included:breadth.included??null,
   calculated_by:'investor_intel' as CalculatedBy,
   inputs:['cap-weighted 24h return and median 24h return of one stored listings snapshot'],
   note:reasonSentence(breadth.reason),
  },
 })
}

async function newListings(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const result=await readNewListings(ctx.db,{days:args.days,status:args.status},ctx.now)
 const all=(result.rows as Record<string,unknown>[]|undefined)??[]
 const limit=args.limit as number
 return grounded({
  tool:'new_listings',
  as_of:result.asOf,
  source:CMC('/v1/cryptocurrency/listings/new',STORE.listings),
  calculated_by:'provider',
  tier:{tier:ctx.tier,surface:'capture_views',open:true},
  coverage:result.coverage,
  note:emptyNote(all.length,result.asOf,result.reason,'new listings')
   ??(all.length>limit?`${all.length} listings matched; the ${limit} newest are returned. Raise limit up to its ceiling, or narrow days, to see others.`:null),
 },{
  days:result.days,status:result.status,
  // sinceCapturePct is ours: the move since OUR first capture of the listing,
  // which is not the same as a move since the provider listed it.
  rows:all.slice(0,limit),
  cohort:result.cohort,
  since_listing:result.sinceListing,
  since_capture_meaning:'sinceCapturePct is measured from the first price WE captured for that listing, not from the provider listing date. It is our calculation.',
 })
}

async function memeGraduations(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const result=await readMemeGraduation(ctx.db,{days:args.days,chain:args.chain,launchpad:args.launchpad,source:args.source},ctx.now)
 const recent=(result.recent as Record<string,unknown>[]|undefined)??[]
 const limit=args.limit as number
 const funnel=((result.funnel as Array<Record<string,unknown>>|undefined)??[]).map(stage=>({
  stage:stage.stage,count:stage.count,
  // The per-stage contract list is trimmed hard: a model asking for a stage
  // board does not need 25 contracts per stage to answer a question about the
  // shape of the funnel, and the counts are the answer.
  contracts:Array.isArray(stage.contracts)?(stage.contracts as unknown[]).slice(0,5):[],
  contracts_truncated:true,
 }))
 return grounded({
  tool:'meme_graduations',
  as_of:result.asOf,
  // CoinGecko's onchain terms require the attribution to travel with the data,
  // so it is on the source ref as well as on the payload the read module built.
  source:{provider:'coingecko',endpoint_family:'/onchain/networks/*/new_pools',store:STORE.meme,attribution:COINGECKO_ATTRIBUTION},
  calculated_by:'investor_intel',
  inputs:['stage transitions recorded in intel_meme_stage_snapshots and intel_meme_stage_transitions'],
  tier:{tier:ctx.tier,surface:'capture_views',open:true},
  coverage:result.coverage,
  note:emptyNote(recent.length,result.asOf,result.reason,'launchpad graduations'),
 },{
  days:result.days,chain:result.chain,launchpad:result.launchpad,source:result.source,
  funnel,
  graduation_rate:result.graduationRate,
  cohort:result.cohort,
  time_to_graduate:result.timeToGraduate,
  retention:result.retention,
  recent:recent.slice(0,limit),
  launchpads:result.launchpads,
  chains:result.chains,
  // Required by licence wherever this reading is shown or quoted.
  attribution:result.attribution??COINGECKO_ATTRIBUTION,
 })
}

async function rwaUniverse(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const result=await readRwaUniverse(ctx.db,{days:args.days as number},ctx.now)
 const latest=(result.latest as Record<string,Record<string,unknown>>|undefined)??{}
 const types=Object.keys(latest)
 const topLimit=args.top_assets as number
 const trimmed:Record<string,unknown>={}
 for(const [assetType,reading] of Object.entries(latest)){
  trimmed[assetType]={
   ...reading,
   topAssets:Array.isArray(reading.topAssets)?(reading.topAssets as unknown[]).slice(0,topLimit):[],
  }
 }
 // The series is one entry per asset type, each with its own point list, so the
 // cap is applied per type: seven types at the read module's 200 points came back
 // as 520 KB, which no conversation can hold.
 const rawSeries=(result.series as Array<Record<string,unknown>>|undefined)??[]
 // The allowance is shared across the types, not granted to each of them, so the
 // answer stays the same size when a new asset type starts being captured.
 const cap=perGroupCap(rawSeries.length)
 let capturedPoints=0,returnedPoints=0
 const series=rawSeries.map(entry=>{
  const points=Array.isArray(entry.points)?entry.points as unknown[]:[]
  const kept=trimSeries(points,cap)
  capturedPoints+=points.length;returnedPoints+=kept.length
  return {...entry,points:kept}
 })
 return grounded({
  tool:'rwa_universe',
  as_of:result.asOf,
  source:CMC('/v5/real-world-assets/listings/latest',STORE.rwaUniverse),
  calculated_by:'investor_intel',
  inputs:['per-type totals summed from one stored RWA listings capture (asset count, issuer count, market value, 24h volume)'],
  tier:{tier:ctx.tier,surface:'capture_views',open:true},
  coverage:result.coverage,
  note:notes(emptyNote(types.length,result.asOf,result.reason,'the RWA universe'),trimNote(returnedPoints,capturedPoints,'per-type series')),
 },{
  days:result.days,per_type:trimmed,series,asset_types:types,
  series_points:{returned:returnedPoints,captured:capturedPoints,per_type_cap:cap,total_cap:SERIES_TOTAL_CAP},
 })
}

async function rwaIssuerLegitimacy(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const subject=args.subject as string|undefined
 const result=await readRwaIssuerLegitimacy(ctx.db,subject?{subject}:{},ctx.now)
 const subjects=(result.subjects as Record<string,unknown>[]|undefined)??[]
 const unmapped=(result.unmapped as Record<string,unknown>[]|undefined)??[]
 return grounded({
  tool:'rwa_issuer_legitimacy',
  as_of:result.asOf,
  source:[
   {provider:'sec',endpoint_family:'/cgi-bin/browse-edgar and /submissions',store:STORE.rwaIssuer},
   {provider:'gleif',endpoint_family:'/api/v1/lei-records',store:STORE.rwaIssuer},
  ],
  calculated_by:'investor_intel',
  inputs:['SEC Form D filings, GLEIF LEI records, holder concentration captures and transfer-restriction reads, assembled per subject'],
  tier:{tier:ctx.tier,surface:'capture_views',open:true},
  coverage:result.coverage,
  note:emptyNote(subjects.length+unmapped.length,result.asOf,result.reason,'RWA issuer legitimacy')
   ??(subject&&!subjects.length&&!unmapped.length?`Nothing is recorded for ${subject}. Subjects are written as rwa:coinmarketcap:<id>; call rwa_universe to see which ones are captured.`:null),
 },{
  subject:subject??null,
  subjects:subjects.slice(0,args.limit as number),
  unmapped:unmapped.slice(0,args.limit as number),
  collisions:result.collisions,
  review:result.review,
  // The owner's standing directive: issuer reviews do not expire on a clock.
  // Said in the payload so a model never reports a review date as a deadline.
  review_meaning:'A review has no expiry. A fact stops being current only when a later review explicitly withdraws it, never because time has passed.',
 })
}

async function rwaYieldProvenance(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const result=await readRwaYield(ctx.db,{days:args.days as number},ctx.now)
 const rows=(result.rows as Record<string,unknown>[]|undefined)??[]
 const wanted=args.feed as string|undefined
 const selected=wanted?rows.filter(row=>String(row.feedKey??'').toLowerCase()===wanted.toLowerCase()||String(row.contractAddress??'').toLowerCase()===wanted.toLowerCase()):rows
 return grounded({
  tool:'rwa_yield_provenance',
  as_of:result.asOf,
  source:[
   {provider:'chainlink',endpoint_family:'on-chain NAV and PoR aggregators',store:'intel_rwa_nav_observations'},
   {provider:'us_treasury',endpoint_family:'/services/api/fiscal_service/v2/accounting/od/avg_interest_rates',store:'intel_benchmark_rates'},
  ],
  calculated_by:'investor_intel',
  inputs:['advertised rate as published, realized rate computed from consecutive on-chain NAV rounds over the window, benchmark rate as published, and the spread between realized and benchmark'],
  tier:{tier:ctx.tier,surface:'capture_views',open:true},
  coverage:result.coverage,
  note:emptyNote(selected.length,result.asOf,result.reason,'RWA yield provenance')
   ??(wanted&&!selected.length?`No feed matches "${wanted}". Call this tool without a feed to list the keys that are captured.`:null),
 },{
  days:result.days,
  feeds:selected.slice(0,args.limit as number),
  summary:result.summary,
  benchmarks:result.benchmarks,
  deviation_scope:result.deviationScope,
  market_source_note:result.marketSourceNote,
  realized_meaning:'realizedPct is OUR calculation from consecutive NAV rounds in the window, not a rate the issuer published. advertisedPct is what was published. A gap between them is the point of this tool.',
 })
}

/** The dated issuer review facts: who may redeem, minimums, exclusions, hours.
 *
 * Read from the observation store the investigation path already writes, so this
 * costs nothing. It sits behind the `investigation` surface because that is the
 * surface those facts are produced on, and a reading must not be cheaper to reach
 * through an agent than through the app. */
async function rwaIssuerTerms(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const subject=String(args.subject)
 const cryptoId=String(args.crypto_id)
 const {data,error}=await ctx.db.from(STORE.observations)
  .select('observation,observed_at,recorded_at')
  .eq('subject',subject).eq('provider','investor-intel-editorial')
  .gt('retain_until',new Date(ctx.now).toISOString())
  .order('observed_at',{ascending:false}).limit(200)
 if(error){
  return grounded({
   tool:'rwa_issuer_terms',as_of:null,source:OURS(STORE.observations),calculated_by:'investor_intel',
   tier:{tier:ctx.tier,surface:'investigation',open:true},
   note:'The issuer review store could not be read. Retry when the service is ready.',
  },{subject,crypto_id:cryptoId,state:'unavailable',facts:[]})
 }
 // deno-lint-ignore no-explicit-any
 const observations=((data??[]) as any[]).map(row=>row.observation).filter(Boolean)
 const projection=rwaTermsProjection(observations,subject,cryptoId,ctx.now,args.quantity)
 const asOf=projection.facts.length?String(projection.facts[0].observedAt??'')||null:null
 const note=projection.state==='unavailable'
  ?`No issuer review facts are recorded for ${subject} under token ${cryptoId}. They are written when that asset is investigated in Investor Intel, so a member opening Connected Research on it will fill this store.`
  :projection.state==='review_expired'
   ?'Every structured term for this token was explicitly withdrawn by a later review. That is a withdrawal, not a lapse of time.'
   :null
 return grounded({
  tool:'rwa_issuer_terms',
  as_of:asOf,
  source:{provider:'investor_intel',endpoint_family:'editorial issuer review',store:STORE.observations},
  calculated_by:'investor_intel',
  inputs:['dated editorial review of the issuer\'s own published terms, with a link per fact'],
  tier:{tier:ctx.tier,surface:'investigation',open:true},
  note,
 },{
  subject,crypto_id:cryptoId,state:projection.state,
  denomination:projection.denomination,redemption:projection.redemption,
  quantity:projection.quantity,underlying_units:projection.underlyingUnits,
  // deno-lint-ignore no-explicit-any
  facts:projection.facts.map((fact:any)=>({
   metric:fact.metric,summary:fact.value,label:fact.metadata?.label??null,
   source_url:fact.sourceUrl??null,reviewed_at:fact.observedAt??null,
   review_version:fact.metadata?.reviewVersion??null,
   state:fact.state==='stale'?'withdrawn':'current',
   withdrawn_reason:fact.state==='stale'?fact.reason??null:null,
  })),
  expiry_meaning:'These facts carry no expiry. Never report a review date as a deadline or as data going out of date.',
  not_advice:'Issuer terms as reviewed and linked. Not an eligibility decision, a valuation or a recommendation.',
 })
}

/** Which wrapper to name for one tokenised asset, three ways: cheapest to its
 * anchor, closest to its anchor, most traded. Read from the six-hourly wrapper
 * capture the board uses, so an agent and the page name the same wrappers. */
async function rwaBestWrapper(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const rwaId=typeof args.rwa_id==='string'?args.rwa_id:null
 const cryptoId=typeof args.crypto_id==='string'?args.crypto_id:null
 const result=await readRwaWrapperPicks(ctx.db,{rwaId,cryptoId},ctx.now)
 const asked=rwaId?`rwa id ${rwaId}`:cryptoId?`wrapper ${cryptoId}`:null
 const note=result.state==='no_asset_selected'
  ?'Name the asset with rwa_id (its CoinMarketCap RWA id) or crypto_id (any one of its wrapper tokens). rwa_universe lists the captured assets.'
  :result.state==='not_captured'
   ?reasonSentence(result.reason)??'No wrapper capture is stored yet. The capture runs every six hours; nothing refreshes on a read.'
   :result.state==='not_in_capture'
    ?`The newest wrapper capture holds no multi-wrapper asset matching ${asked}. The capture keeps assets with two or more wrappers, widest dispersion first, so this is missing coverage, not evidence that the asset has no wrappers.`
    :null
 return grounded({
  tool:'rwa_best_wrapper',
  as_of:result.asOf,
  source:[
   CMC('/v5/real-world-assets/quotes/latest','intel_rwa_wrapper_tokens'),
   {provider:'investor_intel',endpoint_family:'wrapper premium lane',store:'intel_rwa_wrapper_assets'},
  ],
  calculated_by:'investor_intel',
  inputs:['each wrapper\'s premium to the stated anchor and its reported 24h volume, from one stored six-hourly wrapper capture; cheapest and closest are chosen among wrappers that cleared the volume floor, most liquid among wrappers that carry a premium; ties go to higher volume, then lower id'],
  tier:{tier:ctx.tier,surface:'capture_views',open:true},
  coverage:result.coverage,
  note,
 },{
  state:result.state,
  rwa_id:rwaId,crypto_id:cryptoId,
  asset:result.asset??null,
  picks:result.picks??null,
  rules:result.pickRules,
  circular_meaning:'closest.circular true means that wrapper set the liquid-wrapper median it is measured against, so its distance of zero is by construction. Quote closest.closestOther as the nearest independent wrapper.',
  not_advice:'Three readings of one capture, not a recommendation. A premium is not a tradable arbitrage, and volume is the provider\'s reported figure across every venue, not an exit capacity.',
 })
}

// ── Handlers: forward-compatible RWA readings ───────────────────────────────

function forwardTool(name:'rwa_wrapper_premiums'|'rwa_liquidity_depth'|'rwa_underlying_registrant',reading:keyof typeof FORWARD_TABLE_CONTRACT,what:string,source:SourceRef,inputs:string[]) {
 return async(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> => {
  const result=await readForwardTable(ctx.db,reading,{
   subject:typeof args.subject==='string'?args.subject:null,
   limit:args.limit as number,what,
  })
  return grounded({
   tool:name,
   as_of:result.as_of,
   source:{...source,store:result.expected_table},
   calculated_by:'investor_intel',
   inputs,
   tier:{tier:ctx.tier,surface:'capture_views',open:true},
   note:result.note||null,
  },{
   state:result.state,
   subject:typeof args.subject==='string'?args.subject:null,
   rows:result.rows,
   // Named on every state, including not_available_yet, so an agent can report
   // WHICH reading is pending rather than just that something was missing.
   expected_store:result.expected_table,
  })
 }
}

// ── Handlers: the member's own records ──────────────────────────────────────

async function watchlistRead(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const {data:lists,error}=await ctx.db.from('watchlists').select('*')
  .eq('org_id',ctx.agent.orgId).eq('user_id',ctx.agent.userId)
  .order('sort_order',{ascending:true}).order('created_at',{ascending:true}).limit(50)
 if(error)throw new AgentAuthError(503,'agent_read_unavailable','Watchlists could not be read. Retry when the service is ready.')
 const rows=(lists??[]) as Record<string,unknown>[]
 const ids=rows.map(row=>row.id)
 let items:unknown[]=[]
 if(ids.length){
  const {data,error:itemError}=await ctx.db.from('watchlist_items')
   .select('id,watchlist_id,item_type,label,notes,sort_order,created_at')
   .eq('org_id',ctx.agent.orgId).in('watchlist_id',ids)
   .order('sort_order',{ascending:true}).limit(args.limit as number)
  if(itemError)throw new AgentAuthError(503,'agent_read_unavailable','Watchlist items could not be read. Retry when the service is ready.')
  items=projectWatchlistItems(data??[])
 }
 return grounded({
  tool:'watchlist_read',
  as_of:new Date(ctx.now).toISOString(),
  source:OURS('watchlists, watchlist_items'),
  calculated_by:'investor_intel',
  tier:{tier:ctx.tier,surface:'watchlist',open:true},
  note:rows.length?null:'This member has no watchlist yet. One is created the first time they add something in Investor Intel.',
 },{watchlists:projectWatchlists(rows),items})
}

/** A direct write, and the only reason it is direct is that it touches an object
 * the approval pipeline never covered, is reversible in one click, and is bounded
 * by tg_intel_watchlist_limit — the SAME per-tier trigger the app is bounded by,
 * which is why no limit is re-implemented here. */
async function watchlistAdd(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const listId=args.watchlist_id as string|undefined
 let list:{id:string;name:string}|null=null
 if(listId){
  const {data}=await ctx.db.from('watchlists').select('id,name')
   .eq('id',listId).eq('org_id',ctx.agent.orgId).eq('user_id',ctx.agent.userId).maybeSingle()
  list=(data as {id:string;name:string}|null)??null
  if(!list)throw new AgentAuthError(404,'watchlist_not_found','That watchlist does not exist in this workspace.')
 }else{
  const {data}=await ctx.db.from('watchlists').select('id,name')
   .eq('org_id',ctx.agent.orgId).eq('user_id',ctx.agent.userId)
   .order('is_default',{ascending:false}).order('created_at',{ascending:true}).limit(1).maybeSingle()
  list=(data as {id:string;name:string}|null)??null
  // A watchlist is NOT created here. Creating one as a side effect of adding an
  // item would mean an agent could make a list the member never asked for.
  if(!list)throw new AgentAuthError(409,'no_watchlist','This member has no watchlist yet. Ask them to create one in Investor Intel, then name it with watchlist_id.')
 }
 const row={
  org_id:ctx.agent.orgId,watchlist_id:list.id,item_type:args.item_type as string,
  label:args.label as string,notes:(args.notes as string|undefined)??null,
 }
 const {data:inserted,error}=await ctx.db.from('watchlist_items').insert(row)
  .select('id,watchlist_id,item_type,label,notes,sort_order,created_at').maybeSingle()
 if(error){
  // The tier trigger raises this, and it is the member's plan talking, not a
  // fault. Reported as such so an agent tells them the right thing.
  if(String(error.message||'').includes('intel_limit_reached:watchlist_items')){
   throw new AgentAuthError(409,'watchlist_limit','This workspace has reached the number of watchlist items its plan allows. Remove one, or upgrade, before adding another.')
  }
  if(String(error.message||'').includes('intel_limit_reached:tracked_wallets')){
   throw new AgentAuthError(409,'tracked_wallet_limit','This workspace has reached the number of tracked wallets its plan allows.')
  }
  throw new AgentAuthError(503,'watchlist_write_failed',`The item was not added: ${error.message}.`)
 }
 // Re-read, because an insert that reported success and left nothing behind is a
 // failure. Same rule the approval pipeline's verification step applies.
 const {data:verify}=await ctx.db.from('watchlist_items').select('id,watchlist_id,label')
  .eq('id',(inserted as {id?:string}|null)?.id??'').maybeSingle()
 return grounded({
  tool:'watchlist_add',
  as_of:new Date(ctx.now).toISOString(),
  source:OURS('watchlist_items'),
  calculated_by:'investor_intel',
  tier:{tier:ctx.tier,surface:'watchlist',open:true},
  note:verify?null:'The insert reported success but the row could not be read back, so this is reported as unverified rather than as done.',
 },{
  added:Boolean(verify),watchlist:{id:list.id,name:list.name},
  item:inserted?projectWatchlistItems([inserted])[0]:null,
  verified:Boolean(verify),
 })
}

async function alertsList(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const {data,error}=await ctx.db.from('intel_alert_rules').select('*')
  .eq('org_id',ctx.agent.orgId).eq('user_id',ctx.agent.userId)
  .order('created_at',{ascending:false}).limit(args.limit as number)
 if(error)throw new AgentAuthError(503,'agent_read_unavailable','Alert rules could not be read. Retry when the service is ready.')
 const rules=(data??[]) as Record<string,unknown>[]
 let events:unknown[]=[]
 if(args.include_events===true){
  const {data:fired}=await ctx.db.from('intel_alert_events').select('id,rule_id,fired_at,read_at,payload')
   .eq('org_id',ctx.agent.orgId).order('fired_at',{ascending:false}).limit(20)
  events=(fired??[]) as unknown[]
 }
 const limit=await ctx.db.rpc('intel_limit_for',{p_org:ctx.agent.orgId,p_key:'alerts_active'})
 const ceiling=limit?.error?null:limit?.data===null||limit?.data===undefined?null:Number(limit.data)
 const active=rules.filter(rule=>rule.is_active===true).length
 return grounded({
  tool:'alerts_list',
  as_of:new Date(ctx.now).toISOString(),
  source:OURS('intel_alert_rules'),
  calculated_by:'investor_intel',
  tier:{tier:ctx.tier,surface:'alert_evaluation',open:true},
  note:rules.length?null:'This member has no alert rules yet.',
 },{
  alerts:projectAlerts(rules),
  // deno-lint-ignore no-explicit-any
  events:(events as any[]).map(event=>({id:event.id,rule_id:event.rule_id,fired_at:event.fired_at,read:Boolean(event.read_at),payload:event.payload})),
  plan_limits:{active_alerts:active,active_alerts_allowed:ceiling,note:ceiling===null?'This plan sets no ceiling on active alerts.':`${active} of ${ceiling} active alerts allowed on this plan.`},
 })
}

/**
 * Propose an alert. Does not create one.
 *
 * This is the existing propose/approve/verify pipeline, reached through MCP. The
 * proposal is validated by the member's own alert contract (chartAlertConfig), a
 * hash is taken over exactly what would be written, and nothing happens until a
 * person approves that hash in Investor Intel. An agent-proposed alert is a DRAFT
 * unless the proposal says live, and whether it is live is inside the hash.
 */
async function alertCreate(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 // validateAgentPlan runs the app's own chartAlertConfig over this, so an agent
 // cannot propose a shape a person could not have drawn. It is not validated
 // twice here: one validator, one refusal message.
 const draft=await validateAgentPlan(ctx.db,ctx.agent,{
  tool:'intel_create_alert',
  config:{
   asset:args.asset,direction:args.direction,threshold_usd:args.threshold_usd,
   title:args.title,note:(args.note as string|undefined)??'',
   repeat:args.repeat,condition:args.condition,
   hysteresis_pct:args.hysteresis_pct,sustain_minutes:args.sustain_minutes,
  },
  active:args.active===true,cooldownMinutes:args.cooldown_minutes as number,
 })
 const {data,error}=await ctx.db.from('intel_agent_plans').insert({
  org_id:ctx.agent.orgId,user_id:ctx.agent.userId,token_id:ctx.agent.tokenId,
  tool_key:draft.toolKey,target:draft.target,payload:draft.payload,plan_hash:draft.planHash,
  risk_level:draft.riskLevel,actor:ctx.agent.actor,summary:draft.summary,
  expires_at:new Date(ctx.now+86400000).toISOString(),
 }).select('*').maybeSingle()
 let plan=data as Record<string,unknown>|null
 let already=false
 if(error||!plan){
  // A retry of an identical proposal finds the live one rather than stacking a
  // second approval request for the same write.
  if(String(error?.message||'').includes('duplicate key')||error?.code==='23505'){
   const {data:existing}=await ctx.db.from('intel_agent_plans').select('*')
    .eq('token_id',ctx.agent.tokenId).eq('plan_hash',draft.planHash).in('status',['proposed','approved']).maybeSingle()
   plan=(existing as Record<string,unknown>|null)??null
   already=Boolean(plan)
  }
  if(!plan)throw new AgentAuthError(503,'agent_plan_unavailable',`The proposal could not be recorded${error?`: ${error.message}`:''}.`)
 }
 const recorded=plan
 return grounded({
  tool:'alert_create',
  as_of:new Date(ctx.now).toISOString(),
  source:OURS('intel_agent_plans'),
  calculated_by:'investor_intel',
  tier:{tier:ctx.tier,surface:'alert_evaluation',open:true},
  note:already?'An identical proposal was already waiting, so this returns that one rather than making a second.':null,
 },{
  created:false,
  proposal:projectPlan(recorded),
  plan_hash:recorded.plan_hash,
  next_step:recorded.status==='approved'
   ?'A person has approved this. Call write_run with this proposal id to make the alert.'
   :'NO ALERT EXISTS YET. A person must approve this in Investor Intel, under Settings then Your own agent. Tell the member that, give them the request fingerprint, and poll write_status rather than proposing again.',
  expires_at:recorded.expires_at,
 })
}

async function writeStatus(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const {data,error}=await ctx.db.from('intel_agent_plans').select('*')
  .eq('id',args.proposal_id).eq('token_id',ctx.agent.tokenId).maybeSingle()
 if(error)throw new AgentAuthError(503,'agent_plan_unavailable','The proposal could not be read. Retry when the service is ready.')
 if(!data)throw new AgentAuthError(404,'plan_not_found','No proposal with that id was made by this token.')
 const plan=data as Record<string,unknown>
 const status=String(plan.status)
 return grounded({
  tool:'write_status',
  as_of:new Date(ctx.now).toISOString(),
  source:OURS('intel_agent_plans'),
  calculated_by:'investor_intel',
  tier:{tier:ctx.tier,surface:'agent_access',open:true},
  note:null,
 },{
  proposal:projectPlan(plan),
  next_step:status==='approved'?'Approved. Call write_run with this id.'
   :status==='proposed'?'Still waiting for a person to approve it in Investor Intel.'
   :status==='executed'?'Done. Nothing further to do.'
   :`This proposal is ${status}, so it cannot run. Propose it again if the member still wants it.`,
 })
}

async function writeRun(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 // The whole gate, the hash recomputation, the write and the read-back
 // verification all live in executeAgentPlan. Nothing is reimplemented here.
 const result=await executeAgentPlan(ctx.db,ctx.agent,args.proposal_id)
 return grounded({
  tool:'write_run',
  as_of:new Date(ctx.now).toISOString(),
  source:OURS('intel_agent_plans, intel_agent_verifications'),
  calculated_by:'investor_intel',
  tier:{tier:ctx.tier,surface:'agent_access',open:true},
  note:result.status==='failed'?'The write did not land. The approval is spent either way, so it cannot be retried on the same approval: propose it again.':null,
 },{...result,verified:result.verification.status==='passed'})
}

/** A note against the member's saved research. Direct, for the same reasons
 * watchlist_add is: a note is the member's own, reversible, and never covered by
 * the approval pipeline. The snapshot records that an agent wrote it and which
 * token did. */
async function saveResearchNote(ctx:ToolContext,args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const tags=Array.isArray(args.tags)?(args.tags as string[]):[]
 const {data,error}=await ctx.db.from('saved_research').insert({
  org_id:ctx.agent.orgId,user_id:ctx.agent.userId,
  title:String(args.title).slice(0,200),
  tags:['agent',...tags].slice(0,11),
  // investigation_receipt is deliberately NOT written. Its CHECK pairs it with
  // private_owner_id and it means "this came out of a Connected Research run",
  // which a note an agent typed did not.
  snapshot:{
   kind:'agent_note',body:String(args.body),
   source:'mcp',agent_token_id:ctx.agent.tokenId,token_name:ctx.agent.tokenName,
   written_at:new Date(ctx.now).toISOString(),
   ...(typeof args.subject==='string'?{subject:args.subject}:{}),
  },
 }).select('id,title,tags,created_at').maybeSingle()
 if(error)throw new AgentAuthError(503,'research_write_failed',`The note was not saved: ${error.message}.`)
 const {data:verify}=await ctx.db.from('saved_research').select('id,org_id')
  .eq('id',(data as {id?:string}|null)?.id??'').maybeSingle()
 return grounded({
  tool:'save_research_note',
  as_of:new Date(ctx.now).toISOString(),
  source:OURS('saved_research'),
  calculated_by:'investor_intel',
  tier:{tier:ctx.tier,surface:'agent_access',open:true},
  note:verify?null:'The note was written but could not be read back, so this is reported as unverified.',
 },{saved:Boolean(verify),note:data,verified:Boolean(verify)})
}

// ── Handlers: what this token can do, and what it has left ──────────────────

async function whoami(ctx:ToolContext,_args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const surfaces=[...new Set(MCP_TOOLS.map(tool=>tool.surface))]
 const decisions=await Promise.all(surfaces.map(async surface=>{
  try{
   await requireIntelSurface(ctx.db,{userId:ctx.agent.userId,orgId:ctx.agent.orgId,isSuperAdmin:false,isService:false},surface)
   return [surface,{open:true,min_tier:ctx.minTier[surface]??null}] as const
  }catch{
   return [surface,{open:false,min_tier:ctx.minTier[surface]??null}] as const
  }
 }))
 const open=Object.fromEntries(decisions)
 const budget=await readDailyBudget(ctx.db,ctx.agent.tokenId,ctx.agent.orgId)
 return grounded({
  tool:'whoami',
  as_of:new Date(ctx.now).toISOString(),
  source:OURS('intel_agent_tokens, intel_surface_tiers'),
  calculated_by:'investor_intel',
  tier:{tier:ctx.tier,surface:'agent_access',open:true},
  note:null,
 },{
  token:{id:ctx.agent.tokenId,name:ctx.agent.tokenName,org_id:ctx.agent.orgId},
  tier:ctx.tier,
  scopes:ctx.agent.scopes,
  // Saying what the token CANNOT do is the answer to most refusals, and an agent
  // that reads it stops retrying.
  tools_available:MCP_TOOLS.filter(tool=>(!tool.scope||ctx.agent.scopes.includes(tool.scope))&&open[tool.surface]?.open!==false).map(tool=>tool.name),
  tools_refused:MCP_TOOLS.filter(tool=>(tool.scope&&!ctx.agent.scopes.includes(tool.scope))||open[tool.surface]?.open===false)
   .map(tool=>({name:tool.name,reason:tool.scope&&!ctx.agent.scopes.includes(tool.scope)?`needs the ${tool.scope} scope`:`needs the ${open[tool.surface]?.min_tier??'a higher'} plan`})),
  surfaces:open,
  writes_require_approval:['alert_create'],
  writes_direct:['watchlist_add','save_research_note'],
  budget,
 })
}

/**
 * The member-visible data budget.
 *
 * NOT the Data budget admin page. That page is super admin only and shows the
 * workspace's provider credit spend, the CMC account's rate limit and the cost
 * projection of every lane. None of that is a member figure and none of it is
 * here: handing an agent token the org's provider spend because the brief called
 * this tool credit_budget would be a privilege escalation with a friendly name.
 *
 * What a member and their agent legitimately need is: how many calls this token
 * has left, what its plan allows, and how fresh each store it can read actually
 * is, so the agent can plan rather than discover a stale board mid-answer. That
 * is what this returns, and it costs no provider credit to produce.
 */
async function dataBudget(ctx:ToolContext,_args:Record<string,unknown>):Promise<Record<string,unknown>> {
 const budget=await readDailyBudget(ctx.db,ctx.agent.tokenId,ctx.agent.orgId)
 const freshness=await Promise.all(([
  ['market_regime',STORE.regime,'captured_at'],
  ['new_listings',STORE.listings,'captured_at'],
  ['meme_graduations',STORE.meme,'captured_at'],
  ['rwa_universe',STORE.rwaUniverse,'captured_at'],
  ['rwa_yield_provenance','intel_rwa_nav_observations','captured_at'],
  ['rwa_coverage','intel_rwa_coverage_assets','captured_at'],
  ['rwa_premium_history','intel_rwa_wrapper_tokens','captured_at'],
  ['rwa_exit_capacity','intel_rwa_depth_snapshots','captured_at'],
  ['market_structure (unusual_moves)','intel_unusual_move_scores','captured_at'],
  ['market_structure (categories)','intel_category_snapshots','captured_at'],
  ['asset_catalogue',STORE.catalogue,'as_of'],
 ] as Array<[string,string,string]>).map(async([reading,table,column])=>{
  try{
   const {data,error}=await ctx.db.from(table).select(column).order(column,{ascending:false}).limit(1).maybeSingle()
   if(error)return {reading,store:table,newest:null,note:'This store could not be read just now.'}
   const newest=(data as Record<string,unknown>|null)?.[column]
   const asOf=typeof newest==='string'?newest:null
   const ageHours=asOf?Math.round(((ctx.now-Date.parse(asOf))/3600000)*10)/10:null
   return {reading,store:table,newest:asOf,age_hours:ageHours,
    note:asOf?null:'Nothing has been captured into this store yet.'}
  }catch{
   return {reading,store:table,newest:null,note:'This store could not be read just now.'}
  }
 }))
 return grounded({
  tool:'data_budget',
  as_of:new Date(ctx.now).toISOString(),
  source:OURS('intel_mcp_daily_usage, intel_plan_limits, the capture stores'),
  calculated_by:'investor_intel',
  inputs:['this token\'s recorded call count for today, the plan ceiling from intel_plan_limits, and the newest capture time of each store'],
  tier:{tier:ctx.tier,surface:'agent_access',open:true},
  note:'These are the member-visible figures. Provider credit spend, the CoinMarketCap account rate limit and per-lane cost projections are super-admin figures and are deliberately not exposed to an agent token.',
 },{
  calls:{...budget,per_minute:{tool:MINUTE_LIMITS.tool,protocol:MINUTE_LIMITS.protocol}},
  tier:ctx.tier,
  store_freshness:freshness,
 })
}

// ── The catalogue ───────────────────────────────────────────────────────────

const SUBJECT_PROPERTY:JsonSchema={type:'string',minLength:3,maxLength:80,pattern:'^[A-Za-z0-9:._-]{3,80}$',description:'An RWA subject key, written as rwa:coinmarketcap:<id>. Omit to read every captured subject.'}

export const MCP_TOOLS:ToolSpec[]=[
 {
  name:'whoami',
  title:'What this connection can do',
  description:'Start here when anything refuses. Reports this token\'s scopes, the member\'s plan tier, which tools are available and which are refused with the reason for each, and how many calls are left today. Costs nothing.',
  schema:object({}),
  surface:'agent_access',label:'Agent access',
  handler:whoami,
 },
 {
  name:'search_assets',
  title:'Find an asset',
  description:'Search the asset catalogue by ticker, name or contract address. A contract may be written as chain:address. Returns identity only, ranked with exact matches first; call get_asset for figures.',
  schema:object({
   query:{type:'string',minLength:SUGGEST_MIN_LENGTH,maxLength:SUGGEST_MAX_LENGTH,pattern:QUERY_PATTERN,description:'A ticker (BTC), a name (Bitcoin), or a contract as chain:address.'},
   limit:LIMIT_PROPERTY(SUGGEST_MAX_LIMIT,8,`How many matches to return, at most ${SUGGEST_MAX_LIMIT}.`),
  },['query']),
  surface:'market_boards',label:'Market boards',
  handler:searchAssets,
 },
 {
  name:'get_asset',
  title:'One asset in full',
  description:'Identity, contract address per chain, the newest retained quote with its observation time, and our cross-source agreement verdict on that quote. Name the asset with query, or exactly with provider and provider_id. Reads stored observations only: it never refreshes a price, and says how old the one it has is.',
  schema:object({
   query:{type:'string',minLength:1,maxLength:SUGGEST_MAX_LENGTH,pattern:QUERY_PATTERN,description:'Ticker, name or chain:address. Ignored when provider and provider_id are given.'},
   provider:{type:'string',enum:['coinmarketcap','coingecko'],description:'Use with provider_id to name an asset exactly.'},
   provider_id:{type:'string',minLength:1,maxLength:64,pattern:SYMBOL_PATTERN,description:'The provider\'s own id, for example 1 for Bitcoin on CoinMarketCap.'},
  }),
  surface:'market_boards',label:'Market boards',
  handler:getAsset,
 },
 {
  name:'market_regime',
  title:'Market pulse',
  description:'The regime series (fear and greed, altcoin season, BTC and ETH dominance, total market cap, stablecoin and DeFi market cap) plus our own breadth reading: the cap-weighted 24h return minus the median, which says whether a move is broad or concentrated.',
  schema:object({
   range:{type:'string',enum:['7d','30d','90d','1y'],default:'30d',description:'How far back the series runs.'},
  }),
  surface:'market_regime',label:'Market regime',
  handler:marketRegime,
 },
 {
  name:'market_structure',
  title:'Market structure figures',
  description:'One tool for the precomputed market figures the Structure pages show: unusual_moves (each asset\'s move ranked against its own history), liquidations (needs provider_ids), attention (trending and gainer list membership, needs provider_id), breadth, categories, category_disagreement, exchange_reserves, venue_share, index_constituents (CMC20 and CMC100), rank_map, airdrops and network_stats. Name the figure; each takes only its own arguments and refuses the others by name: unusual_moves rows, day; liquidations provider_ids, hours (1 to 24); attention provider_id, hours (1 to 168); breadth nothing; categories days (1, 7 or 30), top (up to 30); category_disagreement min_members, rows; exchange_reserves days (7, 30 or 90), exchange_id, rows (up to 20); venue_share days (30, 90 or 365), kind; index_constituents days (up to 90), rows; rank_map top (up to 30), weeks (up to 26); airdrops status, days, rows; network_stats rows. Long lists and series are trimmed to stay readable and the note says so. The market regime is not here: market_regime covers it.',
  schema:object({
   figure:{type:'string',enum:MARKET_FIGURE_NAMES,description:'Which figure to read.'},
   days:{type:'integer',minimum:1,maximum:365,description:'Window in days, where the figure takes one. Each figure accepts its own values: see the tool description.'},
   hours:{type:'integer',minimum:1,maximum:168,description:'Window in hours, for liquidations (1 to 24) and attention (1 to 168).'},
   top:{type:'integer',minimum:1,maximum:30,description:'How many categories (categories) or assets by rank (rank_map), at most 30.'},
   weeks:{type:'integer',minimum:1,maximum:26,description:'How many weekly rank samples, for rank_map. At most 26.'},
   rows:{type:'integer',minimum:1,maximum:50,description:'How many rows of the figure\'s main list to return. Each figure applies its own default when omitted, and exchange_reserves takes at most 20.'},
   kind:{type:'string',enum:['spot','derivatives'],description:'For venue_share: spot volume or derivatives volume and open interest.'},
   status:{type:'string',enum:['ongoing','upcoming','all'],description:'For airdrops.'},
   min_members:{type:'integer',minimum:2,maximum:50,description:'For category_disagreement: the smallest category to include.'},
   exchange_id:{type:'integer',minimum:1,maximum:1000000000,description:'For exchange_reserves: one exchange\'s CoinMarketCap id.'},
   provider_id:{type:'string',minLength:1,maxLength:16,pattern:'^[1-9][0-9]{0,11}$',description:'For attention: the asset\'s CoinMarketCap id, digits only.'},
   provider_ids:{type:'array',minItems:1,maxItems:10,items:{type:'string',minLength:1,maxLength:16,pattern:'^[1-9][0-9]{0,11}$'},description:'For liquidations: up to 10 CoinMarketCap ids, digits only.'},
   day:{type:'string',minLength:10,maxLength:10,pattern:'^[0-9]{4}-[0-9]{2}-[0-9]{2}$',description:'For unusual_moves: a scored day as YYYY-MM-DD. Omit for the newest.'},
  },['figure']),
  surface:'capture_views',label:'Recorded captures',
  handler:marketStructure,
 },
 {
  name:'new_listings',
  title:'New listings',
  description:'Assets newly listed by the provider, with chain and contract where known, the security-inspection state, and the move since OUR first capture of each one. Also a cohort summary and the distribution of those moves.',
  schema:object({
   days:{type:'integer',enum:[7,30,90],default:7,description:'Window in days.'},
   status:{type:'string',enum:['flagged','inspected','all'],default:'all',description:'Filter by security-inspection state.'},
   limit:LIMIT_PROPERTY(50,20,'How many listings to return, newest first, at most 50.'),
  }),
  surface:'capture_views',label:'Recorded captures',
  handler:newListings,
 },
 {
  name:'meme_graduations',
  title:'Launchpad stage board',
  description:'The launchpad funnel (new creations, about to graduate, graduated), the graduation rate, time to graduate, post-graduation retention and recent graduations, per chain and per pad. Data is CoinGecko onchain: the attribution on the result must be shown wherever these figures are.',
  schema:object({
   days:{type:'integer',enum:[1,7,30],default:7,description:'Window in days.'},
   chain:{type:'string',maxLength:32,pattern:CHAIN_PATTERN,description:'Limit to one chain, for example solana or bsc.'},
   launchpad:{type:'string',maxLength:40,pattern:'^[a-z0-9._-]{1,40}$',description:'Limit to one launchpad, for example pumpfun or fourmeme.'},
   source:{type:'string',maxLength:40,pattern:'^[a-z0-9._-]{1,40}$',description:'Limit to one capture source.'},
   limit:LIMIT_PROPERTY(50,20,'How many recent graduations to return, at most 50.'),
  }),
  surface:'capture_views',label:'Recorded captures',
  handler:memeGraduations,
 },
 {
  name:'rwa_universe',
  title:'Tokenized real-world assets',
  description:'Per type (stock, commodity, ETF, government security, currency, real estate): how many assets, how many issuers, total market value, 24h volume, and the largest assets. Plus the series over the window.',
  schema:object({
   days:ISO_DAYS(90,30),
   top_assets:LIMIT_PROPERTY(25,5,'How many top assets to list per type, at most 25.'),
  }),
  surface:'capture_views',label:'Recorded captures',
  handler:rwaUniverse,
 },
 {
  name:'rwa_issuer_legitimacy',
  title:'Who the issuer actually is',
  description:'For a tokenized asset: the legal entity and how it was identified (LEI, CIK), SEC Form D admission history and what has drifted in it, risk signals, holder concentration, and transfer restrictions such as KYC gating, pausability and freezability. Omit subject to see every captured subject.',
  schema:object({
   subject:SUBJECT_PROPERTY,
   limit:LIMIT_PROPERTY(25,10,'How many subjects to return, at most 25.'),
  }),
  surface:'capture_views',label:'Recorded captures',
  handler:rwaIssuerLegitimacy,
 },
 {
  name:'rwa_yield_provenance',
  title:'Advertised yield against realized yield',
  description:'Per NAV feed: the advertised rate as published, the realized rate WE computed from consecutive on-chain NAV rounds, the benchmark rate, the spread between realized and benchmark, the deviation of market price from NAV, and feed health (staleness, heartbeat, rounds read). The gap between advertised and realized is the point.',
  schema:object({
   days:{type:'integer',enum:[7,30,90],default:30,description:'Window for the realized-rate calculation.'},
   feed:{type:'string',maxLength:80,pattern:'^[A-Za-z0-9:._x-]{1,80}$',description:'One feed key or contract address. Omit to list every captured feed.'},
   limit:LIMIT_PROPERTY(50,25,'How many feeds to return, at most 50.'),
  }),
  surface:'capture_views',label:'Recorded captures',
  handler:rwaYieldProvenance,
 },
 {
  name:'rwa_issuer_terms',
  title:'Issuer terms, as reviewed',
  description:'The dated review of an issuer\'s own published terms: who may redeem, minimums, exclusions and hours, each with a link. Optionally does the unit arithmetic for a quantity of tokens. These facts have no expiry; a fact stops being current only when a later review withdraws it.',
  schema:object({
   subject:{...SUBJECT_PROPERTY,description:'The RWA subject key, written as rwa:coinmarketcap:<id>.'},
   crypto_id:{type:'string',minLength:1,maxLength:16,pattern:'^[1-9][0-9]{0,11}$',description:'The token\'s CoinMarketCap id.'},
   quantity:{type:'number',minimum:0,maximum:1e12,description:'Optional token quantity, to convert into underlying units and test against the redemption minimum.'},
  },['subject','crypto_id']),
  surface:'investigation',label:'Connected Research',
  handler:rwaIssuerTerms,
 },
 {
  name:'rwa_wrapper_premiums',
  title:'Wrapper premium or discount',
  description:'Premium or discount, in basis points, of each wrapper token against its asset anchor: the volume-weighted median of the liquid wrappers (anchor_kind liquid_wrapper_median). A published_nav anchor is used only for a fund mapped to its own NAV feed; no asset has one mapped today, so expect the median. A wrapper that accrues yield inside its price carries accrual_gap_bps and no premium. wrapper_state says whether a wrapper was liquid enough to count. An empty result is missing coverage, NOT the absence of a premium. For a tokenized stock or ETF, underlying_ref_bps is the same wrapper against the listed share\'s Chainlink price when the wrapper prices were observed (underlying_ref_price, underlying_ref_observed_at, underlying_ref_session), and underlying_ref_within_band true means that gap is inside the feed\'s own update band, so it is not distinguishable from zero and is not a premium.',
  schema:object({
   subject:{type:'string',maxLength:80,pattern:'^[A-Za-z0-9:._-]{1,80}$',description:'The CoinMarketCap crypto id of one wrapper token, digits only. Omit for every wrapper.'},
   limit:LIMIT_PROPERTY(50,25,'Rows to return, at most 50.'),
  }),
  surface:'capture_views',label:'Recorded captures',
  handler:forwardTool('rwa_wrapper_premiums','wrapper_premiums','wrapper premiums',{provider:'investor_intel',endpoint_family:'wrapper premium lane'},['wrapper price and anchor price from the same six-hourly capture, differenced in basis points; gold wrappers priced per gram are restated per troy ounce first']),
 },
 {
  name:'rwa_best_wrapper',
  title:'Which wrapper to name',
  description:'For one tokenized real-world asset with several wrapper tokens: the CHEAPEST wrapper to its anchor, the CLOSEST to its anchor (flagged circular when it set the liquid-wrapper median, with the nearest other wrapper beside it), and the MOST LIQUID by reported 24h volume, each with its premium in basis points. Cheapest and closest only consider wrappers that cleared the volume floor. Every wrapper eligible for none is listed under excluded with its state and reason. With no anchor, cheapest and closest are unavailable with the reason. Name the asset by rwa_id or by any one wrapper\'s crypto_id.',
  schema:object({
   rwa_id:{type:'string',minLength:1,maxLength:16,pattern:'^[1-9][0-9]{0,11}$',description:'The CoinMarketCap RWA id of the underlying asset, digits only.'},
   crypto_id:{type:'string',minLength:1,maxLength:16,pattern:'^[1-9][0-9]{0,11}$',description:'The CoinMarketCap crypto id of any one wrapper token of the asset, digits only. Used when rwa_id is omitted.'},
  }),
  surface:'capture_views',label:'Recorded captures',
  handler:rwaBestWrapper,
 },
 {
  name:'rwa_liquidity_depth',
  title:'Pools and exitability',
  description:'On-chain pool depth per tokenized-asset token: chains deployed, chains we can read, pool count, liquidity, 24h volume, holder count and a depth_state that says in words why a token has no pool reading (chain not covered, issuer redemption only, no deployment known). TWO SETS OF LIQUIDITY COLUMNS, do not mix them. recognised_liquidity_usd, recognised_pool_count, recognised_volume_24h_usd and deepest_recognised_* cover ONLY pools whose other leg is a major quote asset on that chain or another tokenized asset we captured, matched by contract address and never by symbol: quote these when asked where a token can actually be sold. total_liquidity_usd and deepest_pool_* are CoinMarketCap figures over EVERY pool found, and CoinMarketCap values both legs of a pool, so they include pools against tokens nobody can value (on 2026-09-20 XAUt deepest_pool_pair was XAUt / GOLDGR at 16.5M USD on 812 USD of daily volume). unrecognised_pool_count and unrecognised_liquidity_usd are what the difference is made of, and a token whose recognised_pool_count is 0 with a positive unrecognised_pool_count has pools but none anyone could sell into, which is not the same as having no pool. exit_liquidity_usd is the quote legs own reported sizes summed over the exit_liquidity_pools pools that reported one, so it is a floor and not a capacity. pool_classification null means the capture predates the leg addresses and every recognised_ column is null. This is not a slippage model. An empty result is missing coverage, NOT a token having no liquidity.',
  schema:object({
   subject:{type:'string',maxLength:80,pattern:'^[A-Za-z0-9:._-]{1,80}$',description:'One token key, written cmc:<crypto id>. Omit for every token.'},
   limit:LIMIT_PROPERTY(50,25,'Rows to return, at most 50.'),
  }),
  surface:'capture_views',label:'Recorded captures',
  handler:forwardTool('rwa_liquidity_depth','liquidity_depth','liquidity depth',{provider:'investor_intel',endpoint_family:'liquidity depth lane'},['CoinMarketCap DEX pool liquidity and 24h volume per readable deployment, split by what the OTHER leg of each pool is (recognised quote asset, another captured tokenized asset, or a token we cannot value) and summed per group by us']),
 },
 {
  name:'rwa_underlying_registrant',
  title:'The underlying\'s SEC filer',
  description:'SEC filer facts for the listed company UNDERLYING a tokenized stock or fund (never the token issuer): the CIK CoinMarketCap asserts, the registrant name EDGAR holds for it, whether the two names match, SIC, state, fiscal year end and the latest annual, quarterly and current filings. state not_found means EDGAR has no such filer, which is a finding about the provider number.',
  schema:object({
   subject:{type:'string',minLength:10,maxLength:10,pattern:'^[0-9]{10}$',description:'A ten-digit SEC CIK, zero padded. Omit for every captured registrant.'},
   limit:LIMIT_PROPERTY(25,10,'Rows to return, at most 25.'),
  }),
  surface:'capture_views',label:'Recorded captures',
  handler:forwardTool('rwa_underlying_registrant','underlying_registrant','underlying registrant facts',{provider:'sec',endpoint_family:'/submissions'},['SEC submissions records for the registrant behind the underlying']),
 },
 {
  name:'rwa_coverage',
  title:'How much of the RWA universe trades',
  description:'The daily coverage headline: of the tokenized real-world assets CoinMarketCap lists, how many have a token with a price and reported 24h volume, how many have tokens that do not trade, how many report no token, and how many were not answered; the same per state and per asset type. Also the expected-ticker watch (BUIDL, BENJI, OUSG, USYC): present means a name-matched row exists in our catalogue, which can be a non-CoinMarketCap row, while in_rwa_universe is whether CoinMarketCap\'s RWA capture itself carries it.',
  schema:object({}),
  surface:'capture_views',label:'Recorded captures',
  handler:rwaCoverage,
 },
 {
  name:'rwa_universe_changes',
  title:'What changed in the RWA universe',
  description:'Dated events between consecutive daily coverage snapshots: listed, removed (only when the asset map itself stopped seeing the asset after a complete run), became_tradeable and shelved. comparable false means fewer than two snapshots exist, which is not the same as no changes.',
  schema:object({
   days:{type:'integer',minimum:1,maximum:30,default:7,description:'How many days of snapshots to read, 1 to 30.'},
   kind:{type:'string',enum:['listed','removed','became_tradeable','shelved'],description:'Only this kind of event. Omit for all four.'},
   limit:LIMIT_PROPERTY(100,50,'How many events to return, newest first, at most 100. The counts always cover every event.'),
  }),
  surface:'capture_views',label:'Recorded captures',
  handler:rwaUniverseChanges,
 },
 {
  name:'rwa_issuer_concentration',
  title:'How concentrated RWA issuers are',
  description:'Issuer concentration of tokenized real-world assets by market cap on the newest daily snapshot: HHI on the 0 to 10,000 scale, the effective number of issuers, the top five issuers\' share, and how many tokens were excluded for having no market cap or no issuer, overall and per asset type. Plus deployment counts per chain; market cap per chain is given only for single-chain tokens, because a multi-chain token\'s value cannot be split by chain.',
  schema:object({
   top_issuers:{type:'integer',minimum:1,maximum:10,default:5,description:'How many largest issuers to name overall, at most 10 (per type at most 5).'},
  }),
  surface:'capture_views',label:'Recorded captures',
  handler:rwaIssuerConcentration,
 },
 {
  name:'rwa_premium_history',
  title:'Wrapper premiums over time',
  description:`For one tokenized asset: the anchor and dispersion series and each wrapper's premium series in basis points, every point labelled capture (the six-hourly live capture) or ohlcv_reconstructed (daily closes, only before the first live capture), with the boundary between them and the market-closed calendar for the underlying. Downsampled to stay readable: at most ${HISTORY_WRAPPER_CAP} wrappers sharing one point budget, or one wrapper's 60-point series when crypto_id is given, each with a summary over its full series.`,
  schema:object({
   rwa_id:{type:'string',minLength:1,maxLength:16,pattern:'^[1-9][0-9]{0,11}$',description:'The CoinMarketCap RWA id of the underlying asset, digits only.'},
   days:{type:'integer',enum:[30,90,180,365],default:90,description:'Window in days.'},
   crypto_id:{type:'string',minLength:1,maxLength:16,pattern:'^[1-9][0-9]{0,11}$',description:'Optional: one wrapper\'s CoinMarketCap crypto id, to return only its series at full length.'},
  },['rwa_id']),
  surface:'capture_views',label:'Recorded captures',
  handler:rwaPremiumHistory,
 },
 {
  name:'rwa_exit_capacity',
  title:'How long a position takes to sell',
  description:'For one tokenized-asset token: how many days selling a position takes if the seller keeps to participation_pct of each day\'s volume, cut by haircut_pct, in two scenarios: the recognised on-chain pools\' volume, and CoinMarketCap\'s all-venue volume. Each scenario gives the per-day amount, the day count and the formula written out, or the reason it cannot be computed. Plus the position as a percent of the recognised pool size, which is a size comparison and not slippage. Reads the stored depth capture only.',
  schema:object({
   crypto_id:{type:'string',minLength:1,maxLength:16,pattern:'^[1-9][0-9]{0,11}$',description:'The token\'s CoinMarketCap crypto id, digits only.'},
   position_usd:{type:'number',minimum:0.01,maximum:1e12,description:'The position to sell, in USD. More than zero.'},
   participation_pct:{type:'number',minimum:0.1,maximum:100,default:10,description:'The share of each day\'s volume the seller takes, in percent.'},
   haircut_pct:{type:'number',minimum:0,maximum:90,default:0,description:'A stress cut applied to volume and pool size, in percent.'},
  },['crypto_id','position_usd']),
  surface:'capture_views',label:'Recorded captures',
  handler:rwaExitCapacity,
 },
 {
  name:'watchlist_read',
  title:'The member\'s watchlists',
  description:'Watchlists and their items, with labels and notes. Needs the read:watchlists scope.',
  schema:object({
   limit:LIMIT_PROPERTY(200,100,'How many items across all lists, at most 200.'),
  }),
  surface:'watchlist',label:'Watchlist',scope:'read:watchlists',
  handler:watchlistRead,
 },
 {
  name:'watchlist_add',
  title:'Add one watchlist item',
  description:'Adds one item to a watchlist the member already has. Needs the write:watchlists scope, which read-only tokens do not carry. Does not create a watchlist, and is bounded by the plan\'s item ceiling exactly as the app is.',
  schema:object({
   item_type:{type:'string',enum:['token','wallet','narrative','ecosystem','protocol','defi'],description:'What kind of thing this is.'},
   label:{type:'string',minLength:1,maxLength:120,description:'What to show, for example a ticker or a wallet name.'},
   notes:{type:'string',maxLength:1000,description:'Optional note for the member.'},
   watchlist_id:{type:'string',pattern:UUID_PATTERN,maxLength:36,description:'Which list. Omit for the member\'s default list.'},
  },['item_type','label']),
  surface:'watchlist',label:'Watchlist',scope:'write:watchlists',
  handler:watchlistAdd,
 },
 {
  name:'alerts_list',
  title:'The member\'s alert rules',
  description:'Alert rules, whether each is live or a draft, optionally what recently fired, and how many active alerts the plan allows. Needs the read:alerts scope.',
  schema:object({
   limit:LIMIT_PROPERTY(50,25,'How many rules, at most 50.'),
   include_events:{type:'boolean',default:false,description:'Also return the 20 most recent alerts that fired.'},
  }),
  surface:'alert_evaluation',label:'Alerts',scope:'read:alerts',
  handler:alertsList,
 },
 {
  name:'alert_create',
  title:'Ask to create an alert',
  description:'PROPOSES a price alert. It does not create one. A person must approve the exact request in Investor Intel before write_run can make it. Needs the write:alerts scope. Poll write_status; do not propose the same alert twice.',
  schema:object({
   asset:{type:'string',minLength:3,maxLength:120,pattern:'^[A-Za-z0-9:._$/-]{3,120}$',description:'The asset key the alert watches, for example market:coinmarketcap:1. Get it from get_asset as canonical_key.'},
   direction:{type:'string',enum:['above','below'],description:'Fire when the price goes above or below the threshold.'},
   threshold_usd:{type:'number',minimum:0,maximum:1e12,description:'The price in USD. Must be greater than zero.'},
   title:{type:'string',minLength:1,maxLength:120,description:'What the member will see in the alert. Write it for them, not for yourself.'},
   note:{type:'string',maxLength:2000,default:'',description:'Optional context shown with the alert, for example why this level matters.'},
   active:{type:'boolean',default:false,description:'Propose a live alert rather than a draft. Whether it is live is part of what the member approves, so it cannot be flipped afterwards.'},
   cooldown_minutes:{type:'integer',minimum:15,maximum:10080,default:60,description:'Minimum gap between firings, 15 minutes to one week.'},
   repeat:{type:'string',enum:['once','rearm'],default:'rearm',description:'Fire once and stop, or re-arm after each firing.'},
   condition:{type:'string',enum:['crossing','sustained'],default:'crossing',description:'Fire the moment the level is crossed, or only after it has held. A sustained alert needs sustain_minutes of at least 15; a crossing alert needs sustain_minutes of 0.'},
   sustain_minutes:{type:'integer',minimum:0,maximum:1440,default:0,description:'How long the level must hold. 0 for a crossing alert, 15 to 1440 for a sustained one.'},
   hysteresis_pct:{type:'number',minimum:0,maximum:50,default:0,description:'Percentage the price must move back before the alert re-arms, to stop it firing on noise.'},
  },['asset','direction','threshold_usd','title']),
  surface:'alert_evaluation',label:'Alerts',scope:'write:alerts',
  handler:alertCreate,
 },
 {
  name:'write_status',
  title:'Has the member approved it yet',
  description:'The state of a proposal this token made: waiting, approved, executed, rejected or expired, and what to do next.',
  schema:object({
   proposal_id:{type:'string',pattern:UUID_PATTERN,maxLength:36,description:'The proposal id returned when it was made.'},
  },['proposal_id']),
  surface:'agent_access',label:'Agent access',
  handler:writeStatus,
 },
 {
  name:'write_run',
  title:'Run an approved proposal',
  description:'Runs exactly the proposal a person approved, then re-reads the row to confirm it landed. Refuses if the proposal changed after approval, if the approval expired, or if it already ran. A write that cannot be read back afterwards is reported as failed, never as done.',
  schema:object({
   proposal_id:{type:'string',pattern:UUID_PATTERN,maxLength:36,description:'The approved proposal id.'},
  },['proposal_id']),
  surface:'agent_access',label:'Agent access',
  handler:writeRun,
 },
 {
  name:'save_research_note',
  title:'Save a research note',
  description:'Saves one note to the member\'s saved research, tagged as agent-written and recording which token wrote it. Needs the write:research scope.',
  schema:object({
   title:{type:'string',minLength:1,maxLength:200,description:'A short title.'},
   body:{type:'string',minLength:1,maxLength:20000,description:'The note.'},
   subject:{type:'string',maxLength:120,pattern:'^[A-Za-z0-9:._$/-]{1,120}$',description:'Optional asset or subject key this note is about.'},
   tags:{type:'array',maxItems:10,items:{type:'string',minLength:1,maxLength:40,pattern:'^[A-Za-z0-9._-]{1,40}$'},description:'Up to 10 tags.'},
  },['title','body']),
  surface:'agent_access',label:'Agent access',scope:'write:research',
  handler:saveResearchNote,
 },
 {
  name:'data_budget',
  title:'Calls left, and how fresh each store is',
  description:'How many calls this token has used today and what its plan allows, plus the newest capture time of every store the read tools use, so an answer can be planned rather than discovered stale. Does not report provider credit spend, which is a super-admin figure.',
  schema:object({}),
  surface:'agent_access',label:'Agent access',
  handler:dataBudget,
 },
]

export function toolDefinitions():McpToolDefinition[] {
 return MCP_TOOLS.map(tool=>({
  name:tool.name,title:tool.title,
  // The scope and the plan a tool needs are part of its description, because a
  // model choosing between tools cannot see our gate table and should not have
  // to discover a refusal by being refused.
  description:[
   tool.description,
   tool.scope?`Scope required: ${tool.scope}.`:'',
   tool.surface==='agent_access'?'':`Plan surface: ${tool.surface}.`,
  ].filter(Boolean).join(' '),
  inputSchema:tool.schema as Record<string,unknown>,
 }))
}

export function findTool(name:string):ToolSpec|undefined {
 return MCP_TOOLS.find(tool=>tool.name===name)
}

/**
 * Run one tool through the three gates.
 *
 * Returns an MCP tool result in every case. A refusal is a result with isError
 * and a reason a model can act on, not a transport fault, because a model that
 * sees a transport fault retries and a model that reads "this token does not
 * carry write:alerts" tells the member what to change.
 */
export async function callMcpTool(ctx:ToolContext,name:string,args:Record<string,unknown>):Promise<{result:McpToolResult;outcome:'served'|'refused'|'failed';reasonCode:string|null;tierLocked:boolean}> {
 const tool=findTool(name)
 if(!tool){
  return {result:errorToolResult('unknown_tool',`${name} is not a tool this server offers. Call tools/list.`),outcome:'refused',reasonCode:'unknown_tool',tierLocked:false}
 }
 // 1. Schema.
 let parsed:Record<string,unknown>
 try{
  parsed=parseToolArguments(tool.schema,args)
 }catch(error){
  const message=error instanceof SchemaError?error.message:'The arguments could not be read.'
  return {result:errorToolResult('invalid_arguments',message,{tool:name,schema:tool.schema}),outcome:'refused',reasonCode:'invalid_arguments',tierLocked:false}
 }
 // 2. Scope, before the tier gate and before any read.
 if(tool.scope){
  try{
   requireScope(ctx.agent,tool.scope)
  }catch(error){
   const message=error instanceof AgentAuthError?error.message:`This token does not carry ${tool.scope}.`
   return {result:errorToolResult('scope_missing',message,{tool:name,scope_required:tool.scope,scopes_held:ctx.agent.scopes}),outcome:'refused',reasonCode:'scope_missing',tierLocked:false}
  }
 }
 // 3. Tier, server side, INSTEAD OF the reading.
 if(tool.surface!=='agent_access'){
  try{
   await requireIntelSurface(ctx.db,{userId:ctx.agent.userId,orgId:ctx.agent.orgId,isSuperAdmin:false,isService:false},tool.surface)
  }catch(error){
   if(error instanceof IntelSurfaceLockedError){
    const opensAt=ctx.minTier[tool.surface]??'a higher'
    return {result:jsonToolResult(withheld(name,tool.surface,ctx.tier,opensAt,tool.label),true),outcome:'refused',reasonCode:'intel_surface_locked',tierLocked:true}
   }
   throw error
  }
 }
 try{
  return {result:jsonToolResult(withTimeLabels(await tool.handler(ctx,parsed))),outcome:'served',reasonCode:null,tierLocked:false}
 }catch(error){
  if(error instanceof AgentAuthError){
   return {result:errorToolResult(error.code,error.message,{tool:name}),outcome:'refused',reasonCode:error.code,tierLocked:false}
  }
  const message=error instanceof Error?error.message:'tool_failed'
  // The app's own validators throw named, member-safe messages in this shape.
  if(/^(invalid_|chart_|thesis_|duplicate_|drawing_|alert_)/.test(message)){
   return {result:errorToolResult(message,`That request was refused by the same validation the app applies: ${message}.`,{tool:name}),outcome:'refused',reasonCode:message.slice(0,60),tierLocked:false}
  }
  console.error(`[intel-mcp] ${name}:`,message)
  return {result:errorToolResult('tool_unavailable',`${name} could not be answered right now. Retry when the service is ready.`,{tool:name}),outcome:'failed',reasonCode:'tool_unavailable',tierLocked:false}
 }
}

export const SERVER_INSTRUCTIONS=[
 'Investor Intel: market and tokenized real-world-asset intelligence for the workspace this token belongs to.',
 '',
 'CALL whoami FIRST when anything refuses. It lists this token\'s scopes, the member\'s plan, every tool that is available and every tool that is refused with the reason.',
 '',
 'GROUNDING. Every result carries as_of (the capture time the answer rests on), source (provider, endpoint family and our own store), and calculated_by. When calculated_by is "investor_intel" the figure is OURS, not the provider\'s, and inputs says what it was made from: say so when you quote it. as_of can be null, which means nothing has been captured yet; never substitute the current time for it.',
 '',
 'TIME. Every timestamp is ISO 8601 in UTC. time_labels maps each one in a result to a readable label with its weekday (for example "Tue 22 Sep 2026, 16:58:36 UTC"): quote those labels rather than working out a weekday yourself.',
 '',
 'NOTHING HERE SPENDS A PROVIDER CREDIT. Every read comes from a precomputed capture or a retained observation, so a stale as_of means the capture is stale, not that you should retry. Reading again will return the same reading.',
 '',
 'WRITES. alert_create PROPOSES an alert and creates nothing. A person approves the exact request in Investor Intel, then write_run makes it. Poll write_status; never propose the same alert twice. watchlist_add and save_research_note write directly and need their own scopes.',
 '',
 'REFUSALS. "withheld: true" means the member\'s plan does not include that reading and the data was never produced, so there is nothing to work around: tell them which plan opens it. "scope_missing" means the member has to mint a token with that scope. "not_available_yet" on an RWA tool means WE have not built that lane, which is not evidence about the market.',
 '',
 'ATTRIBUTION. meme_graduations carries a CoinGecko attribution on its result. Show it wherever you show those figures; it is a licence condition, not a courtesy.',
].join('\n')

export const MCP_RESOURCES=[
 {
  uri:'investor-intel://tools',
  name:'Tool catalogue',
  title:'Every tool, its scope and its plan surface',
  description:'The same list tools/list returns, with the scope and plan each tool needs, for a client that prefers to read it as a resource.',
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

/** The grounding contract, written out. This is the one piece of prose a model
 * needs in order to quote a figure from this server honestly, so it is a resource
 * a client can attach to a conversation rather than only a line of instructions. */
const GROUNDING_CONTRACT=[
 '# How to quote a figure from Investor Intel',
 '',
 'Every tool result carries three fields. None of them is decoration.',
 '',
 '## as_of',
 '',
 'The capture time the answer rests on, not the time you asked. A reading is only',
 'as fresh as this. `as_of: null` means nothing has been captured into that store',
 'yet: say so. Never substitute the current time for a null as_of, and never',
 'present a reading as current without naming this time.',
 '',
 '## source',
 '',
 '`provider` is who the figure came from, `endpoint_family` is which of their',
 'endpoints, and `store` is the table we hold it in, so a person can go and look.',
 'Some results carry an array of sources because the reading joins more than one.',
 'When `source.attribution` is present it is a licence condition: show it wherever',
 'you show those figures. meme_graduations always carries one.',
 '',
 '## calculated_by',
 '',
 '`provider` means the number is theirs, unchanged. `investor_intel` means WE',
 'computed it, and `inputs` says from what. Say whose number it is when you quote',
 'it. A breadth spread, a realized yield, a premium in basis points and a 24 hour',
 'change reconstructed from our own snapshots are all ours.',
 '',
 '## What a refusal means',
 '',
 '- `withheld: true`: the plan does not include that reading and the data was never',
 '  produced. There is nothing to work around. Name the plan that opens it.',
 '- `scope_missing`: the member must mint a token carrying that scope.',
 '- `not_available_yet`: we have not built that lane. It is a fact about us, never',
 '  evidence about the market.',
 '- `state: served` with no rows is missing coverage, not an absence in the world.',
 '',
 '## Reviews do not expire',
 '',
 'An issuer review and an alias assertion carry a review date, never a deadline. A',
 'fact stops being current only when a later review withdraws it. Never report a',
 'review date as an expiry or as data going out of date.',
 '',
 '## Nothing here spends a provider credit',
 '',
 'Every read comes from a precomputed capture or a retained observation. A stale',
 'as_of is a stale capture, not a reason to retry: the same call returns the same',
 'reading.',
].join('\n')

/** What a client gets when it opens one of the listed resources.
 *
 * Both are static. A resource on this server is documentation about the surface,
 * never a member's data: member data is behind a tool, where the scope and tier
 * gates are, and moving any of it into a resource would be a second door into the
 * same room with no gate on it. */
export function readMcpResource(uri:string):McpResourceContents|null {
 if(uri==='investor-intel://tools'){
  return {
   uri,mimeType:'application/json',
   text:JSON.stringify({
    tools:MCP_TOOLS.map(tool=>({
     name:tool.name,title:tool.title,description:tool.description,
     scope_required:tool.scope??null,
     plan_surface:tool.surface==='agent_access'?null:tool.surface,
     writes:tool.name==='alert_create'?'proposal, needs a person to approve it'
      :tool.name==='watchlist_add'||tool.name==='save_research_note'?'direct write'
      :'read only',
    })),
    note:'A tool that needs a scope only works on a token carrying it. A tool with a plan_surface is withheld server side when the plan does not include it: no rows, no counts, no sample.',
   }),
  }
 }
 if(uri==='investor-intel://grounding')return {uri,mimeType:'text/markdown',text:GROUNDING_CONTRACT}
 return null
}

export const MCP_PROMPTS=[
 {
  name:'ground_a_claim',
  title:'Check a claim against captured data',
  description:'Takes a claim about an asset and answers it only from what this server can date and source, naming the capture time and saying plainly when the data does not settle it.',
  arguments:[{name:'claim',description:'The claim to check, in one sentence.',required:true}],
 },
 {
  name:'rwa_due_diligence',
  title:'Tokenized asset due diligence',
  description:'Walks one tokenized real-world asset: universe position and coverage, issuer legal identity, admission history and concentration, advertised against realized yield, issuer terms, wrapper premiums and their history, and exit capacity, refusing to fill gaps with guesses.',
  arguments:[{name:'subject',description:'The RWA subject key, written as rwa:coinmarketcap:<id>.',required:true}],
 },
]

/** A prompt's messages, rendered with whatever the client passed.
 *
 * A missing required argument is not a refusal here. The spec has no error shape
 * for "argument missing" on prompts/get that clients render usefully, and a prompt
 * is a starting message a person then edits, so the argument is left as a named
 * blank the person fills in rather than a dead end. */
export function getMcpPrompt(name:string,args:Record<string,unknown>):McpPromptResult|null {
 const arg=(key:string,fallback:string):string => {
  const value=args[key]
  // Bounded: a prompt argument is interpolated into text a model reads, so the
  // same ceiling a tool argument gets applies here.
  return typeof value==='string'&&value.trim()?value.trim().slice(0,400):fallback
 }
 if(name==='ground_a_claim'){
  const claim=arg('claim','(write the claim here, in one sentence)')
  return {
   description:'Check a claim against captured data, and say plainly when the data does not settle it.',
   messages:[{role:'user',content:{type:'text',text:[
    `Check this claim using Investor Intel only: ${claim}`,
    '',
    'How to do it:',
    '1. search_assets to identify the asset, then get_asset for its figures and our cross-source agreement verdict.',
    '2. market_regime if the claim is about the market rather than one asset.',
    '3. Quote as_of, source and calculated_by for every figure you use. Say when a number is ours rather than the provider\'s.',
    '4. If the captured data does not settle the claim, say that it does not and say what is missing. Do not fill the gap from memory, and do not treat a stale as_of as a reason to retry: nothing here refreshes on a read.',
   ].join('\n')}}],
  }
 }
 if(name==='rwa_due_diligence'){
  const subject=arg('subject','(the subject key, written rwa:coinmarketcap:<id>)')
  return {
   description:'Walk one tokenized real-world asset through the readings that exist, without filling gaps with guesses.',
   messages:[{role:'user',content:{type:'text',text:[
    `Work through the tokenized asset ${subject} using Investor Intel only.`,
    '',
    'In this order:',
    '1. rwa_universe for where its type sits: asset count, issuer count, market value, 24h volume. rwa_coverage for how much of the universe has a token that actually trades.',
    '2. rwa_issuer_legitimacy for the legal entity and how it was identified, the SEC Form D admission history and what has drifted in it, holder concentration and transfer restrictions. rwa_issuer_concentration for how concentrated the issuers of its type are.',
    '3. rwa_yield_provenance for the advertised rate against the realized rate we computed from on-chain NAV rounds. The gap between them is the point.',
    '4. rwa_issuer_terms for who may redeem, minimums, exclusions and hours, each with its link.',
    '5. rwa_wrapper_premiums and rwa_liquidity_depth for what a wrapper trades at against its anchor and whether there is anywhere to sell it. rwa_premium_history, with the id in the subject as rwa_id, for how those premiums moved, capture and reconstructed points kept apart.',
    '6. rwa_best_wrapper for which wrapper is cheapest to the anchor, which is closest, and which trades most, and which wrappers were excluded and why. A closest wrapper flagged circular set the anchor itself. rwa_exit_capacity on a wrapper\'s crypto id for how many days a position takes to sell in both scenarios, with the reason when one cannot be computed.',
    '7. rwa_underlying_registrant when there is a listed company underneath, using its ten-digit CIK.',
    '',
    'Rules: an empty result is missing coverage on our side, never evidence that the thing does not exist. A review date is not an expiry. Date and source every figure, and name the ones we calculated. This is not advice, an eligibility decision or a valuation.',
   ].join('\n')}}],
  }
 }
 return null
}
