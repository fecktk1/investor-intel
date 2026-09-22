// The MCP handlers for readings the app already shows and no tool covered before
// 2026-09-22: RWA universe coverage, the daily universe changes feed, issuer
// concentration, wrapper premium history, the exit-capacity simulator, and one
// tool over the remaining precomputed market-structure figures.
//
// SAME RULES AS mcp-tools.ts. Every handler reads a stored capture through the
// read module the app's intel-capture function uses, so an agent and the page read
// the same rows; not one of them calls a provider. Every result goes out in the
// grounded() envelope with an honest as_of, source, calculated_by and inputs, and
// an empty reading always says why in words.
//
// SIZE. A read module is shaped for a chart; these are shaped for a conversation.
// Each handler applies its own named caps first (and says what it cut), then
// fitToBudget as the last resort. See mcp-size.ts.

import {AgentAuthError} from './agent-token.ts'
import {grounded,emptyNote,reasonSentence,oldestOf,type SourceRef} from './mcp-grounding.ts'
import {SERIES_POINT_CAP,SERIES_TOTAL_CAP,SERIES_MIN_PER_GROUP,perGroupCap,trimSeries,trimNote,listNote,notes,fitToBudget} from './mcp-size.ts'
import type {ToolContext} from './mcp-tools.ts'
import {readRwaCoverage,readRwaUniverseChanges,readRwaConcentration,CONCENTRATION_FORMULA} from './capture-rwa-coverage-read.ts'
import {COVERAGE_ASSET_TABLE,COVERAGE_TOKEN_TABLE,COVERAGE_CHANGE_TABLE} from './capture-rwa-coverage.ts'
import {readRwaWrapperHistory} from './capture-rwa-wrapper-history-read.ts'
import {ASSET_TABLE as WRAPPER_ASSET_TABLE,TOKEN_TABLE as WRAPPER_TOKEN_TABLE} from './capture-rwa-wrappers.ts'
import {BACKFILL_TABLE} from './capture-rwa-wrapper-backfill.ts'
import {readRwaTokenDepth,EXITABILITY_METHOD} from './capture-rwa-depth-read.ts'
import {DEPTH_TABLE} from './capture-rwa-depth.ts'
import {EXIT_LIQUIDITY_SCOPE,COUNTED_SCOPE} from './rwa-counter-leg.ts'
import {rowExitScenarios,type ExitEstimate} from './rwa-exit-capacity.ts'
import {readBreadth,readRankMap,readIndexConstituents,readLiquidations,readAttention} from './capture-read.ts'
import {readUnusualMoves} from './capture-unusual-read.ts'
import {readCategories,readCategoryDisagreement,readAirdrops,readNetworkStats} from './capture-categories-read.ts'
import {readExchangeReserves,readVenueShare} from './capture-venues-read.ts'

type Args=Record<string,unknown>
type Payload=Record<string,unknown>
// deno-lint-ignore no-explicit-any
type Any=any

const CMC=(family:string,store:string):SourceRef=>({provider:'coinmarketcap',endpoint_family:family,store})
const OURS=(store:string):SourceRef=>({provider:'investor_intel',endpoint_family:null,store})
const tier=(ctx:ToolContext)=>({tier:ctx.tier,surface:'capture_views' as const,open:true})

const round=(value:unknown,places:number):number|null => {
 if(typeof value!=='number'||!Number.isFinite(value))return null
 const f=10**places
 return Math.round(value*f)/f
}
const iso=(ms:unknown):string|null => typeof ms==='number'&&Number.isFinite(ms)?new Date(ms).toISOString():null
const day=(ms:unknown):string|null => iso(ms)?.slice(0,10)??null

/** Place the size budget over a finished payload and fold its note in. */
function budgeted(envelopeNote:string|null,data:Payload):{data:Payload;note:string|null} {
 const fitted=fitToBudget(data)
 return {data:fitted.data,note:notes(envelopeNote,fitted.note)}
}

// ── rwa_coverage ────────────────────────────────────────────────────────────

const COVERAGE_STATE_MEANING={
 tradeable:'At least one token has a price AND reported 24h volume. Reported trading, not proof anyone can buy it: a permissioned fund token can trade only between whitelisted holders.',
 priced_not_traded:'Its best token has a price but no reported 24h volume.',
 listed_only:'Its best token is listed with no price.',
 no_tokens_reported:'CoinMarketCap answered for the asset and reported no token at all.',
 not_returned:'The asset was asked about and not answered (a failed batch, an id left out of the response, or past the day\'s credit ceiling). Unknown, never counted as no tokens.',
}

export async function rwaCoverage(ctx:ToolContext,_args:Args):Promise<Payload> {
 const r:Any=await readRwaCoverage(ctx.db,{},ctx.now)
 const headline=r.headline as Any
 const states=(r.states??{}) as Record<string,number>
 const expected=(r.expected??{}) as Any
 const tickers=((expected.tickers??[]) as Any[]).map(t=>({
  symbol:t.symbol,expected_name:t.expectedName,state:t.state,in_rwa_universe:t.inRwaUniverse===true,
  seen_in:((t.matched??[]) as Any[]).slice(0,6).map(m=>({
   store:m.source==='rwa_coverage'?COVERAGE_TOKEN_TABLE:'market_assets',
   provider:m.sourceProvider??null,id:m.id??null,symbol:m.symbol??null,name:m.name??null,
   market_cap_usd:m.marketCap??null,volume_24h_usd:m.volume24h??null,
  })),
  other_names_under_symbol:((t.otherNames??[]) as string[]).slice(0,5),
 }))
 const withTokens=Number(headline?.withTokens??0),noTradeable=Number(headline?.noTradeable??0)
 const universe=headline?{
  assets_in_snapshot:headline.assets,
  with_a_token:withTokens,
  with_a_tradeable_token:withTokens-noTradeable,
  with_tokens_none_traded:noTradeable,
  no_token_reported:states.no_tokens_reported??0,
  not_returned:headline.notReturned,
  asset_map_with_tokens:headline.mapWithTokens??null,
  asset_map_truncated:headline.mapTruncated??null,
  is_a_floor:headline.truncated===true,
 }:null
 const byType=((r.byType??[]) as Any[]).map(b=>({
  asset_type:b.assetType,assets:b.assets,with_a_token:b.withTokens,with_a_tradeable_token:b.tradeable,
  with_tokens_none_traded:Math.max(0,Number(b.withTokens??0)-Number(b.tradeable??0)),not_returned:b.notReturned,
 }))
 const note=notes(
  emptyNote(universe?1:0,r.asOf,r.reason,'RWA universe coverage'),
  universe?.is_a_floor?'The headline is a floor: the asset map stopped at its page ceiling, or some assets were not returned, so the true counts may be higher.':null,
  r.asOf?null:'The expected-ticker watch below is still answered, from the catalogue alone.',
 )
 return grounded({
  tool:'rwa_coverage',
  as_of:r.capturedAt??r.asOf??null,
  source:[CMC('/v5/real-world-assets/quotes/latest',`${COVERAGE_ASSET_TABLE}, ${COVERAGE_TOKEN_TABLE}`),OURS('market_assets')],
  calculated_by:'investor_intel',
  inputs:[
   'one daily CoinMarketCap RWA quotes capture of every asset the asset map lists: each token is tradeable (price and 24h volume), priced_not_traded or listed_only, and an asset takes the state of its best token',
   'the expected-ticker watch matches BUIDL, BENJI, OUSG and USYC by symbol AND a fragment of the expected fund name, across the market_assets catalogue and that day\'s coverage tokens',
  ],
  tier:tier(ctx),
  coverage:r.coverage,
  note,
 },{
  snapshot_date:r.asOf??null,previous_snapshot_date:r.previousSnapshotDate??null,
  universe,
  states,
  by_type:byType,
  expected_tickers:{
   present:expected.presentCount??0,in_rwa_universe:expected.inUniverseCount??0,
   tickers,
   note:reasonSentence(expected.reason),
  },
  state_meaning:COVERAGE_STATE_MEANING,
  expected_meaning:'present_with_value or present_but_empty means a row whose NAME matches the fund was found, in either store. market_assets is our whole catalogue and holds rows from more than one provider (CoinGecko as well as CoinMarketCap: see seen_in[].provider), so present can come from a non-CoinMarketCap row. in_rwa_universe is the CoinMarketCap RWA answer: true only when the name-matched row is in the day\'s CoinMarketCap RWA coverage capture. symbol_seen_name_differs means the ticker exists under other names only and is never counted as present. absent means no row anywhere carries the symbol.',
  schedule:r.schedule??null,
 })
}

// ── rwa_universe_changes ────────────────────────────────────────────────────

const CHANGE_KIND_MEANING={
 listed:'Answered today and absent from the previous snapshot entirely.',
 removed:'In the previous snapshot, absent today, AND the asset map stopped seeing it before today\'s complete map run. Anything short of that is silence, not a removal.',
 became_tradeable:'Answered both days, not tradeable before, tradeable today.',
 shelved:'Answered both days, tradeable before, not tradeable today.',
}

export async function rwaUniverseChanges(ctx:ToolContext,args:Args):Promise<Payload> {
 const r:Any=await readRwaUniverseChanges(ctx.db,{days:args.days},ctx.now)
 const kind=typeof args.kind==='string'?args.kind:null
 const all=((r.rows??[]) as Any[]).filter(row=>!kind||row.kind===kind)
 const limit=Number(args.limit)
 const rows=all.slice(0,limit).map(row=>({
  snapshot_date:row.snapshotDate,previous_snapshot_date:row.previousSnapshotDate,kind:row.kind,
  rwa_id:row.rwaId,symbol:row.symbol,name:row.name,asset_type:row.assetType,
  from_state:row.fromState,to_state:row.toState,
 }))
 const note=r.comparable===false
  ?(r.asOf
   ?`Only one daily coverage snapshot exists (${r.asOf}), so there is nothing to compare it with yet. This is not "no changes": events exist only between two snapshots, and the first one produces none.`
   :'No coverage snapshot has been captured yet, so there are no changes to report. This is not "no changes".')
  :notes(
   reasonSentence(r.reason),
   all.length?null:`No ${kind?`${kind} `:''}events in the last ${r.days} days of snapshots.`,
   listNote(rows.length,all.length,'events','Narrow days, filter by kind, or raise limit up to 100.'),
   r.coverage?.truncated?'The read stopped at its row cap, so the oldest events in the window are missing.':null,
  )
 return grounded({
  tool:'rwa_universe_changes',
  as_of:r.asOf??null,
  source:[CMC('/v5/real-world-assets/quotes/latest',COVERAGE_CHANGE_TABLE),OURS('intel_rwa_asset_map')],
  calculated_by:'investor_intel',
  inputs:['the difference between two consecutive daily coverage snapshots, with removals confirmed against the asset map\'s own last-seen time'],
  tier:tier(ctx),
  coverage:r.coverage,
  note,
 },{
  days:r.days,kind,comparable:r.comparable===true,
  snapshot_dates:r.snapshotDates??null,
  counts:r.counts??{},
  events:rows,
  events_returned:rows.length,events_matched:all.length,
  kind_meaning:CHANGE_KIND_MEANING,
  comparable_meaning:'comparable false means fewer than two snapshots exist. The feed is then not comparable, which is different from comparable with no events.',
 })
}

// ── rwa_issuer_concentration ────────────────────────────────────────────────

function concentrationOut(c:Any,topIssuers:number) {
 if(!c)return null
 return {
  available:c.available===true,unavailable_reason:c.reason??null,
  hhi:round(c.hhi,1),effective_issuers:round(c.effectiveIssuers,2),top5_share:round(c.top5Share,4),
  total_market_cap_usd:c.totalWeight??null,included_tokens:c.includedTokens??0,
  excluded_no_market_cap:c.excludedNoWeight??0,excluded_no_issuer:c.excludedNoIssuer??0,
  top_issuers:((c.groups??[]) as Any[]).slice(0,topIssuers).map(g=>({
   issuer:g.label??g.key,key:g.key,market_cap_usd:g.weight,share:round(g.share,4),tokens:g.tokens,
  })),
 }
}

const CHAIN_ROW_CAP=30

export async function rwaIssuerConcentration(ctx:ToolContext,args:Args):Promise<Payload> {
 const r:Any=await readRwaConcentration(ctx.db,{},ctx.now)
 const topIssuers=Number(args.top_issuers)
 const chains=r.chains as Any
 const chainRows=((chains?.chains??[]) as Any[])
 const note=notes(
  emptyNote(r.overall?1:0,r.asOf,r.reason,'RWA issuer concentration'),
  r.overall&&r.overall.available===false?'No token in the snapshot carried both a market cap and an issuer, so no concentration figure can be computed.':null,
  chains===null&&r.asOf?'The deployment table could not be read, so the chain counts are missing from this answer.':null,
  listNote(Math.min(CHAIN_ROW_CAP,chainRows.length),chainRows.length,'chains','Only the chains with the most deployments are listed.'),
 )
 return grounded({
  tool:'rwa_issuer_concentration',
  as_of:r.asOf??null,
  source:[CMC('/v5/real-world-assets/quotes/latest',COVERAGE_TOKEN_TABLE),OURS('intel_rwa_token_deployments')],
  calculated_by:'investor_intel',
  inputs:[CONCENTRATION_FORMULA,'weights are each token\'s CoinMarketCap market cap on the newest daily coverage snapshot; issuers are grouped by issuer id, else by normalised issuer name','chain counts are deployments already stored by the depth lane'],
  tier:tier(ctx),
  coverage:r.coverage,
  note,
 },{
  snapshot_date:r.asOf??null,
  weight:'market_cap',
  overall:concentrationOut(r.overall,topIssuers),
  by_type:((r.byType??[]) as Any[]).map(t=>({asset_type:t.assetType,...concentrationOut(t,Math.min(topIssuers,5))})),
  chains:chains?{
   tokens:chains.tokens??null,
   per_chain:chainRows.slice(0,CHAIN_ROW_CAP).map(c=>({
    chain:c.chain,label:c.label??c.chain,deployments:c.deployments,
    single_chain_tokens:c.singleChainTokens,single_chain_market_cap_usd:c.singleChainValue,
   })),
   multi_chain_tokens:chains.multiChainTokens,multi_chain_market_cap_usd:chains.multiChainValue,
   no_deployment_tokens:chains.noDeploymentTokens,no_deployment_market_cap_usd:chains.noDeploymentValue,
  }:null,
  hhi_meaning:'HHI on the 0 to 10,000 scale. effective_issuers is the number of equal-sized issuers that would give the same HHI. top5_share is 0 to 1.',
  chain_meaning:'Deployment counts cover every token. Market cap per chain is given ONLY for tokens deployed on exactly one chain: a multi-chain token\'s market cap is one provider figure with no per-chain split, so it is reported once as multi_chain_market_cap_usd and is not attributable to any chain.',
 })
}

// ── rwa_premium_history ─────────────────────────────────────────────────────

/** Wrappers returned when no crypto_id is named. */
export const HISTORY_WRAPPER_CAP=12

const CALENDAR_MEANING:Record<string,string>={
 nyse_weekends_and_holidays:'The underlying is a stock or ETF: NYSE is closed on the listed weekends and holidays, so a wrapper can trade against a stale anchor on those days and a premium on them is not comparable with a weekday premium.',
 comex_holidays_not_modelled:'The underlying is a commodity: weekends are listed as closed, exchange holidays are not modelled.',
 no_calendar_for_asset_type:'No trading calendar is modelled for this asset type, so no day is marked closed.',
}

function premiumStats(points:Any[]) {
 const values=points.map(p=>p.premiumBps).filter((v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v))
 if(!values.length)return {latest_bps:null,min_bps:null,max_bps:null,mean_bps:null,points_with_premium:0}
 const latest=[...points].reverse().find(p=>typeof p.premiumBps==='number')
 return {
  latest_bps:round(latest?.premiumBps,2),latest_at:iso(latest?.t),latest_source:latest?.source??null,
  min_bps:round(Math.min(...values),2),max_bps:round(Math.max(...values),2),
  mean_bps:round(values.reduce((s,v)=>s+v,0)/values.length,2),points_with_premium:values.length,
 }
}

const premiumPoint=(p:Any)=>({
 t:iso(p.t),premium_bps:round(p.premiumBps,2),accrual_gap_bps:round(p.accrualGapBps,2),
 state:p.state??null,in_anchor:p.inAnchor===true,source:p.source,
})

export async function rwaPremiumHistory(ctx:ToolContext,args:Args):Promise<Payload> {
 const rwaId=String(args.rwa_id)
 const cryptoId=typeof args.crypto_id==='string'?args.crypto_id:null
 const r:Any=await readRwaWrapperHistory(ctx.db,{rwaId,days:args.days},ctx.now)
 const all=(r.wrappers??[]) as Any[]
 const selected=cryptoId?all.filter(w=>w.cryptoId===cryptoId):all.slice(0,HISTORY_WRAPPER_CAP)
 const cap=cryptoId?SERIES_POINT_CAP:perGroupCap(selected.length)
 let captured=0,returned=0
 const wrappers=selected.map(w=>{
  const points=(w.points??[]) as Any[]
  const kept=trimSeries(points,cap)
  captured+=points.length;returned+=kept.length
  return {
   crypto_id:w.cryptoId,symbol:w.symbol,name:w.name,latest_state:w.latestState,
   cheapest_liquid_now:w.cheapestLiquid===true,
   captured_points:w.captured,reconstructed_points:w.reconstructed,
   summary:premiumStats(points),
   points:kept.map(premiumPoint),
  }
 })
 const anchorAll=(r.anchor??[]) as Any[]
 const anchor=trimSeries(anchorAll,SERIES_POINT_CAP).map(a=>({
  t:iso(a.t),anchor_kind:a.anchorKind??null,anchor_price:a.anchorPrice??null,anchor_reason:a.anchorReason??null,
  anchor_members:a.anchorMembers??null,dispersion_bps:round(a.dispersionBps,2),weighted_spread_bps:round(a.weightedSpreadBps,2),
  source:a.source,
 }))
 const calendar=r.calendar as Any
 const boundary=r.boundary as Any
 const empty=!all.length&&!anchorAll.length
 const note=notes(
  empty
   ?`No wrapper premium history is stored for rwa id ${rwaId} in the last ${r.days} days. The wrapper capture keeps assets with two or more wrappers, widest dispersion first, so this is missing coverage, not evidence that the asset has no wrappers. assets_captured lists what the newest capture holds.`
   :reasonSentence(r.reason),
  cryptoId&&!selected.length&&!empty?`Wrapper ${cryptoId} has no premium history under rwa id ${rwaId} in this window. wrappers_available lists the ones that do.`:null,
  !cryptoId&&all.length>HISTORY_WRAPPER_CAP?`${all.length} wrappers have history; the ${HISTORY_WRAPPER_CAP} with the most points (the cheapest liquid wrapper first) are returned. Name one with crypto_id for its own ${SERIES_POINT_CAP}-point series.`:null,
  trimNote(returned,captured,'per-wrapper premium series'),
  trimNote(anchor.length,anchorAll.length,'anchor series'),
  r.truncated?'A read cap was reached, so the OLDEST rows of the window are missing; the newest are intact.':null,
 )
 const shaped=budgeted(note,{
  rwa_id:rwaId,crypto_id:cryptoId,days:r.days,
  asset:r.asset?{rwa_id:r.asset.rwaId,symbol:r.asset.symbol,name:r.asset.name,asset_type:r.asset.assetType,anchor_kind:r.asset.anchorKind,cheapest_crypto_id:r.asset.cheapestCryptoId}:null,
  boundary:boundary?{
   live_from:boundary.liveFrom,reconstructed_from:boundary.reconstructedFrom,reconstructed_to:boundary.reconstructedTo,
   reconstructed_days:boundary.reconstructedDays,reconstructed_dropped:boundary.reconstructedDropped,
  }:null,
  anchor,
  wrappers,
  series_points:{returned,captured,per_wrapper_cap:cap,total_cap:cryptoId?SERIES_POINT_CAP:SERIES_TOTAL_CAP,anchor_returned:anchor.length,anchor_captured:anchorAll.length,wrappers_returned:wrappers.length,wrappers_with_history:all.length},
  wrappers_available:cryptoId&&!selected.length?all.map(w=>({crypto_id:w.cryptoId,symbol:w.symbol})).slice(0,40):undefined,
  assets_captured:empty?((r.assets??[]) as Any[]).slice(0,20).map(a=>({rwa_id:a.rwaId,symbol:a.symbol,name:a.name,wrapper_count:a.wrapperCount})):undefined,
  calendar:calendar?{
   kind:calendar.kind,rule:calendar.note,meaning:CALENDAR_MEANING[calendar.note]??null,source_url:calendar.sourceUrl??null,
   closed_days:Array.isArray(calendar.days)?calendar.days.length:0,
   closed_spans:((calendar.spans??[]) as Any[]).map(s=>({from:day(s.from),to:day(s.to),kind:s.kind})),
  }:null,
  source_meaning:'Every point says where it came from. capture is the six-hourly live wrapper capture. ohlcv_reconstructed is the daily close run through the same arithmetic, and exists only for days BEFORE the asset\'s first live capture (boundary.live_from); a reconstructed point is a daily close, not an intraday reading.',
  summary_meaning:'summary is computed over every point the read returned for that wrapper (up to 400), before this answer downsampled it.',
  scope:r.scope??null,
 })
 return grounded({
  tool:'rwa_premium_history',
  as_of:r.asOf??r.coverage?.to??null,
  source:[
   CMC('/v5/real-world-assets/quotes/latest',`${WRAPPER_ASSET_TABLE}, ${WRAPPER_TOKEN_TABLE}`),
   CMC('/v2/cryptocurrency/ohlcv/historical',BACKFILL_TABLE),
  ],
  calculated_by:'investor_intel',
  inputs:['each wrapper\'s price against the asset\'s stated anchor, in basis points, from the six-hourly wrapper capture; for days before the first live capture, the same arithmetic over daily OHLCV closes','dispersion and weighted spread across the wrappers of the asset at each capture'],
  tier:tier(ctx),
  coverage:r.coverage,
  note:shaped.note,
 },shaped.data)
}

// ── rwa_exit_capacity ───────────────────────────────────────────────────────

const EXIT_REASON:Record<string,string>={
 invalid_position:'The position must be a positive dollar amount.',
 invalid_participation:'Participation must be above 0 and at most 100 percent.',
 invalid_haircut:'The haircut must be from 0 up to (not including) 100 percent.',
 volume_not_reported:'No 24h volume is recorded for this scenario, so no day count can be given. That is missing data, not an instant exit.',
 no_reported_trading:'The reported 24h volume is zero, so no day count can be given. That is not "never": nothing traded in the window reported.',
 counter_legs_unclassified:'This depth capture predates the pool leg addresses, so pools a seller could use cannot be told from pools against tokens nobody can value.',
 only_unrecognised_pools:'The token has pools, but none whose other leg can be valued, so there is no recognised pool to sell into. That is not the same as having no pool.',
 no_recognised_pool_size:'No recognised pool reported a liquidity size, so the position cannot be compared with one.',
 no_provider_id:'The token has no CoinMarketCap id to join its all-venue volume on.',
 not_in_recent_wrapper_capture:'The wrapper capture of the last 48 hours does not name this token, so its all-venue volume is not recorded here.',
 wrapper_read_failed:'The wrapper capture holding the all-venue volume could not be read just now.',
}
const exitReason=(code:string|null):string|null => {
 if(!code)return null
 if(EXIT_REASON[code])return EXIT_REASON[code]
 if(code.startsWith('state_'))return `The depth capture state is ${code.slice(6)}: no pool reading exists for this token (not a finding that it has no liquidity unless the state is no_pool_on_read_chains).`
 return code
}

const usd=(v:number)=>Math.round(v*100)/100

function scenarioOut(name:'recognised_pools'|'all_venues',e:ExitEstimate&{volumeReason?:string|null;volumeCapturedAt?:string|null}) {
 const f=e.formula
 const written=e.days!=null&&f.positionUsd!=null&&f.participation!=null&&f.haircut!=null&&f.volumeUsd!=null
  ?`days = position_usd / (participation x volume_24h_usd x (1 - haircut)) = ${f.positionUsd} / (${f.participation} x ${usd(f.volumeUsd)} x (1 - ${f.haircut})) = ${f.positionUsd} / ${usd(e.perDayUsd!)} = ${round(e.days,2)}`
  :'days = position_usd / (participation x volume_24h_usd x (1 - haircut))'
 return {
  scenario:name,
  volume_basis:name==='recognised_pools'
   ?'24h volume of the recognised on-chain pools only (the pools whose other leg can be valued)'
   :'CoinMarketCap\'s own 24h volume for the token, across every venue including centralised exchanges',
  volume_24h_usd:f.volumeUsd,
  volume_captured_at:name==='all_venues'?e.volumeCapturedAt??null:undefined,
  per_day_usd:e.perDayUsd==null?null:usd(e.perDayUsd),
  days:round(e.days,2),
  formula:written,
  unavailable:e.unavailable,
  unavailable_reason:exitReason(name==='all_venues'&&e.volumeReason?e.volumeReason:e.unavailable)??null,
 }
}

export async function rwaExitCapacity(ctx:ToolContext,args:Args):Promise<Payload> {
 const cryptoId=String(args.crypto_id)
 const inputs={positionUsd:args.position_usd,participationPct:args.participation_pct,haircutPct:args.haircut_pct}
 const r:Any=await readRwaTokenDepth(ctx.db,{cryptoId},ctx.now)
 const base={
  crypto_id:cryptoId,
  inputs:{position_usd:args.position_usd,participation_pct:args.participation_pct,haircut_pct:args.haircut_pct},
 }
 const source=[CMC('/v1/dex/token/pools',DEPTH_TABLE),CMC('/v5/real-world-assets/quotes/latest',WRAPPER_TOKEN_TABLE)]
 const inputsNamed=['recognised-pool 24h volume, recognised-pool liquidity and the quote-leg exit liquidity from the newest daily depth capture of this token','CoinMarketCap\'s all-venue 24h volume for the token from the six-hourly wrapper capture of the last 48 hours','the position, participation and haircut given in this call']
 if(!r.captured){
  return grounded({
   tool:'rwa_exit_capacity',as_of:null,source,calculated_by:'investor_intel',inputs:inputsNamed,tier:tier(ctx),
   coverage:r.coverage,
   note:reasonSentence(r.reason)??`No depth capture of token ${cryptoId} is stored from the last 14 days. The depth lane covers tokenised real-world-asset tokens only, so this is missing coverage, not a finding about the token.`,
  },{...base,captured:false,token:null,scenarios:[],pool_comparison:null})
 }
 const token=r.token as Any
 const scenarios=rowExitScenarios(token,inputs)
 const pool=scenarios.recognised_pools
 return grounded({
  tool:'rwa_exit_capacity',
  // Two captures with two clocks. The answer is only as fresh as the older.
  as_of:oldestOf(token.capturedAt,scenarios.all_venues.volumeCapturedAt)??token.capturedAt??null,
  source,
  calculated_by:'investor_intel',
  inputs:inputsNamed,
  tier:tier(ctx),
  coverage:r.coverage,
  note:reasonSentence(r.reason),
 },{
  ...base,captured:true,
  token:{
   crypto_id:token.cryptoId,symbol:token.symbol,name:token.tokenName,rwa_id:token.rwaId,rwa_name:token.rwaName,asset_type:token.assetType,
   depth_state:token.state,classification:token.classification,only_unrecognised_pools:token.onlyUnrecognised===true,
   recognised_liquidity_usd:token.countedLiquidityUsd,recognised_volume_24h_usd:token.countedVolume24hUsd,
   exit_liquidity_usd:token.exitLiquidityUsd,all_venue_volume_24h_usd:token.providerVolume24hUsd,
   depth_captured_at:token.capturedAt,all_venue_volume_captured_at:token.providerVolumeCapturedAt,
  },
  scenarios:[scenarioOut('recognised_pools',scenarios.recognised_pools),scenarioOut('all_venues',scenarios.all_venues)],
  pool_comparison:{
   position_pct_of_recognised_pool:round(pool.positionPctOfPool,4),
   pool_base_usd:pool.poolBaseUsd==null?null:usd(pool.poolBaseUsd),
   pool_basis:pool.poolBasis,
   formula:'position_pct_of_recognised_pool = position_usd / ((exit_liquidity_usd if reported, else recognised_liquidity_usd) x (1 - haircut)) x 100',
   unavailable:pool.poolUnavailable,
   unavailable_reason:exitReason(pool.poolUnavailable),
   meaning:'A size relative to the recognised pools, not slippage and not a price: no curve, fee tier, reserve split or price impact is in the data. exit_liquidity is the quote side a seller receives where CoinMarketCap reported it; otherwise both legs of the recognised pools are used.',
  },
  method:'A turnover reading: it assumes the seller never exceeds participation of each day\'s volume, and that each day looks like the last reported 24 hours cut by the haircut. Nothing here models price impact.',
  exit_liquidity_scope:EXIT_LIQUIDITY_SCOPE,
  counted_scope:COUNTED_SCOPE,
  exitability_method:EXITABILITY_METHOD,
  not_advice:'An arithmetic reading of stored figures, not a quote, a forecast or a recommendation.',
 })
}

// ── market_structure ────────────────────────────────────────────────────────

/** Bounds one parameter of one figure, narrower than the shared schema allows. */
interface ParamRule {
 /** An explicit set of allowed values. */
 oneOf?:readonly (number|string)[]
 min?:number
 max?:number
 default?:unknown
}

interface FigureSpec {
 params:Record<string,ParamRule>
 required?:string[]
 what:string
 source:SourceRef|SourceRef[]
 calculatedBy:'provider'|'investor_intel'
 inputs?:string[]
 run(ctx:ToolContext,p:Args):Promise<{result:Any;data:Payload;note:string|null}>
}

const clip=<T,>(rows:T[]|undefined,max:number):T[] => (rows??[]).slice(0,max)

/** Series under one shared budget, first and last point always kept.
 *
 * perGroupCap floors each series at SERIES_MIN_PER_GROUP points so a short one
 * stays readable, which means enough groups could still add up past the budget
 * (30 categories x 12 = 360). So only the first SERIES_TOTAL_CAP /
 * SERIES_MIN_PER_GROUP groups carry points; the rest keep their identity with an
 * empty point list, and the omission is counted and said. */
function seriesBudget(groups:Any[],pointsKey='points'):{groups:Any[];returned:number;captured:number;cap:number;omitted:number} {
 const maxGroups=Math.floor(SERIES_TOTAL_CAP/SERIES_MIN_PER_GROUP)
 const cap=perGroupCap(Math.min(groups.length,maxGroups))
 let returned=0,captured=0,omitted=0
 const out=groups.map((g,index)=>{
  const points=Array.isArray(g[pointsKey])?g[pointsKey]:[]
  captured+=points.length
  if(index>=maxGroups){if(points.length)omitted+=1;return {...g,[pointsKey]:[],points_omitted:points.length}}
  const kept=trimSeries(points,cap)
  returned+=kept.length
  return {...g,[pointsKey]:kept}
 })
 return {groups:out,returned,captured,cap,omitted}
}

const omittedNote=(omitted:number,what:string):string|null =>
 omitted?`The series of the last ${omitted} ${what} are left out to keep the answer inside its point budget; their latest figures are still in the rows.`:null

export const MARKET_FIGURES:Record<string,FigureSpec>={
 unusual_moves:{
  what:'unusual moves',
  params:{rows:{min:1,max:50,default:20},day:{}},
  source:OURS('intel_unusual_move_scores'),
  calculatedBy:'investor_intel',
  inputs:['each asset\'s move on the scored day ranked against its own trailing daily returns from the stored candle archive (percentile, robust z, volume percentile, beta-adjusted residual against the market reference)'],
  async run(ctx,p){
   const r:Any=await readUnusualMoves(ctx.db,{limit:p.rows,...(p.day?{day:p.day}:{})},ctx.now)
   const rows=((r.rows??[]) as Any[]).map(({windows:_w,imageUrl:_i,fallbackImageUrl:_f,metricAgreement,...row}:Any)=>({
    ...row,
    metric_agreement:metricAgreement?{verdict:metricAgreement.metric_agreement,research_lead:metricAgreement.research_lead,reasons:metricAgreement.reasons}:null,
   }))
   return {result:r,note:notes(r.empty==='no_scored_day'?'No day has been scored yet.':null,listNote(rows.length,Number(r.scoredAssets??0),'scored assets','Raise rows up to 50 to see more.')),data:{
    subject_day:r.subjectDay??null,rows,scored_assets:r.scoredAssets??0,tracked_assets:r.trackedAssets??0,
    excluded:r.excluded??{},short_history:clip(r.shortHistory,12),market_reference:r.marketReference??null,
    lead_window_days:r.leadWindowDays,min_sample_days:r.minSampleDays,liquidity_floor_usd:r.liquidityFloorUsd,
    meaning:'percentile and exceeded are read over the lead window (lead_window_days, with leadWindowN observations), not over sampleDays. The per-window distributions are left out of this answer.',
   }}
  },
 },
 liquidations:{
  what:'liquidations',
  params:{provider_ids:{},hours:{min:1,max:24,default:24}},
  required:['provider_ids'],
  source:CMC('/v5/derivatives/liquidations/cryptocurrency/list/latest','intel_liquidation_snapshots'),
  calculatedBy:'provider',
  async run(ctx,p){
   const r:Any=await readLiquidations(ctx.db,{providerIds:p.provider_ids,hours:p.hours as number},ctx.now)
   const perAsset=seriesBudget((r.rows??[]) as Any[])
   const total=(r.series??[]) as Any[]
   const series=trimSeries(total,SERIES_POINT_CAP)
   return {result:r,note:notes(trimNote(perAsset.returned,perAsset.captured,'per-asset liquidation series'),omittedNote(perAsset.omitted,'assets'),trimNote(series.length,total.length,'7-day hourly total')),data:{
    hours:r.hours,provider_ids:r.providerIds??[],total_provider_ids:r.totalProviderIds??[],
    assets:perAsset.groups,hourly_total_7d:series,
    series_points:{returned:perAsset.returned,captured:perAsset.captured,per_asset_cap:perAsset.cap},
    meaning:'Per-asset figures are CoinMarketCap\'s rolling liquidation totals as captured. hourly_total_7d is OUR sum of one sample per asset per hour, over the first three assets named, so overlapping rolling windows are never added twice.',
   }}
  },
 },
 attention:{
  what:'attention list membership',
  params:{provider_id:{},hours:{min:1,max:168,default:24}},
  required:['provider_id'],
  source:CMC('/v1/cryptocurrency/trending/latest and /v1/cryptocurrency/trending/gainers-losers','intel_attention_snapshots'),
  calculatedBy:'provider',
  async run(ctx,p){
   const r:Any=await readAttention(ctx.db,{providerId:p.provider_id,hours:p.hours},ctx.now)
   const lists:Record<string,unknown>={}
   let trimmedAny=false
   for(const [name,entries] of Object.entries((r.lists??{}) as Record<string,Any[]>)){
    const ranks=entries.map(e=>e.rank).filter((v:unknown):v is number=>typeof v==='number')
    const kept=trimSeries(entries,48)
    if(kept.length<entries.length)trimmedAny=true
    lists[name]={hours_present:entries.length,best_rank:ranks.length?Math.min(...ranks):null,latest:entries.at(-1)??null,entries:kept}
   }
   const captures=(r.captures??[]) as string[]
   return {result:r,note:trimmedAny?'A list with more than 48 hourly entries is downsampled evenly, keeping the first and the last; hours_present and best_rank are over every entry.':null,data:{
    provider_id:r.providerId,hours:r.hours,lists,
    captures:{count:captures.length,first:captures[0]??null,last:captures.at(-1)??null},
    meaning:'An hour in captures with no entry on a list means the asset was captured off that list, not that nobody captured. Aggregate list membership only; nothing about who looked.',
   }}
  },
 },
 breadth:{
  what:'market breadth',
  params:{},
  source:CMC('/v1/cryptocurrency/listings/latest','intel_rank_history'),
  calculatedBy:'investor_intel',
  inputs:['cap-weighted 24h return and median 24h return over the newest daily listings capture (top 1,000 by rank)'],
  async run(ctx){
   const r:Any=await readBreadth(ctx.db,{},ctx.now)
   const {view:_v,asOf:_a,coverage:_c,reason:_r,...rest}=r
   return {result:r,note:null,data:{...rest,meaning:'spreadPts is the cap-weighted return minus the median return, in percentage points: large and positive means a few large assets carried the move. top lists the largest weights in it.'}}
  },
 },
 categories:{
  what:'categories',
  params:{days:{oneOf:[1,7,30],default:30},top:{min:1,max:30,default:10}},
  source:CMC('/v1/cryptocurrency/categories','intel_category_snapshots'),
  calculatedBy:'provider',
  async run(ctx,p){
   const r:Any=await readCategories(ctx.db,{days:p.days,top:p.top},ctx.now)
   const series=seriesBudget((r.series??[]) as Any[])
   return {result:r,note:notes(trimNote(series.returned,series.captured,'per-category market cap series'),omittedNote(series.omitted,'categories')),data:{
    days:r.days,top:r.top,rows:r.rows??[],series:series.groups,
    series_points:{returned:series.returned,captured:series.captured,per_category_cap:series.cap,total_cap:SERIES_TOTAL_CAP},
   }}
  },
 },
 category_disagreement:{
  what:'category disagreement',
  params:{min_members:{min:2,max:50,default:5},rows:{min:1,max:50,default:25}},
  source:[CMC('/v1/cryptocurrency/category','intel_category_members'),OURS('market_assets')],
  calculatedBy:'investor_intel',
  inputs:['each captured category\'s members compared with the categories on each member\'s own catalogue row, after normalising both (normaliser version in the payload)'],
  async run(ctx,p){
   const r:Any=await readCategoryDisagreement(ctx.db,{minMembers:p.min_members},ctx.now)
   const all=(r.rows??[]) as Any[]
   const rows=all.slice(0,Number(p.rows))
   return {result:r,note:listNote(rows.length,all.length,'categories','They are ordered by lowest agreement first. Raise rows up to 50.'),data:{
    min_members:r.minMembers??p.min_members,normaliser:r.normaliser,rows,categories:all.length,
    compared_assets:r.comparedAssets??null,catalogue_rows:r.catalogueRows??null,
    meaning:'share is agreeing / (agreeing + disagreeing). A member with no catalogue categories is unknown and counted in neither.',
   }}
  },
 },
 exchange_reserves:{
  what:'exchange reserves',
  params:{days:{oneOf:[7,30,90],default:30},exchange_id:{min:1,max:1e9},rows:{min:1,max:20,default:10}},
  source:CMC('/v1/exchange/assets','intel_exchange_reserve_snapshots'),
  calculatedBy:'investor_intel',
  inputs:['per-exchange asset balances and USD values as reported, summed per exchange by us, with drift against the capture days before'],
  async run(ctx,p){
   const r:Any=await readExchangeReserves(ctx.db,{days:p.days,exchangeId:p.exchange_id},ctx.now)
   const all=(r.exchanges??[]) as Any[]
   const limit=Number(p.rows)
   const exchanges=all.slice(0,limit)
   const keep=new Set(exchanges.map(e=>e.exchangeId))
   const series=((r.series??[]) as Any[]).map(point=>({...point,byExchange:((point.byExchange??[]) as Any[]).filter(e=>keep.has(e.exchangeId))}))
   return {result:r,note:listNote(exchanges.length,all.length,'exchanges','Ordered by reserve value. Name one with exchange_id, or raise rows up to 20.'),data:{
    days:r.days,exchange_id:r.exchangeId??null,prior_date:r.priorDate??null,exchanges,series,
    meaning:'A day with no capture for a venue leaves its drift null: an absence is never read as a zero balance. other in composition is exact, the earlier total less the named assets.',
   }}
  },
 },
 venue_share:{
  what:'venue share',
  params:{days:{oneOf:[30,90,365],default:30},kind:{oneOf:['spot','derivatives'],default:'spot'}},
  source:CMC('/v1/exchange/listings/latest and /v5/exchange/derivatives/list','intel_venue_share_snapshots'),
  calculatedBy:'investor_intel',
  inputs:['per-exchange 24h volume and open interest as reported; each venue\'s share of the day\'s total is ours'],
  async run(ctx,p){
   const r:Any=await readVenueShare(ctx.db,{days:p.days,kind:p.kind},ctx.now)
   const {view:_v,asOf:_a,coverage:_c,reason:_r,...rest}=r
   return {result:r,note:null,data:{...rest,meaning:'The ten largest venues by the newest day\'s volume, with every other venue summed as other. A venue absent from a day has no share that day; nothing is carried forward.'}}
  },
 },
 index_constituents:{
  what:'index constituents',
  params:{days:{min:1,max:90,default:30},rows:{min:1,max:50,default:20}},
  source:CMC('/v3/index/cmc20-latest and /v3/index/cmc100-latest','intel_index_constituent_snapshots'),
  calculatedBy:'provider',
  async run(ctx,p){
   const r:Any=await readIndexConstituents(ctx.db,{days:p.days as number},ctx.now)
   const limit=Number(p.rows)
   const latest:Record<string,unknown>={}
   let cut=0,total=0
   for(const [code,value] of Object.entries((r.latest??{}) as Record<string,Any>)){
    const constituents=(value.constituents??[]) as unknown[]
    total+=constituents.length;cut+=Math.min(limit,constituents.length)
    latest[code]={...value,constituents:constituents.slice(0,limit),constituent_count:constituents.length}
   }
   const series=seriesBudget((r.series??[]) as Any[])
   return {result:r,note:notes(total>cut?`Each index lists its first ${limit} constituents in the stored order; constituent_count is the full number. Raise rows up to 50.`:null,trimNote(series.returned,series.captured,'index value series'),omittedNote(series.omitted,'indexes')),data:{
    days:r.days,latest,series:series.groups,series_points:{returned:series.returned,captured:series.captured,per_index_cap:series.cap},
   }}
  },
 },
 rank_map:{
  what:'the rank map',
  params:{top:{min:1,max:30,default:25},weeks:{min:1,max:26,default:12}},
  source:CMC('/v1/cryptocurrency/listings/latest and /v1/cryptocurrency/listings/historical','intel_rank_history'),
  calculatedBy:'provider',
  async run(ctx,p){
   const r:Any=await readRankMap(ctx.db,{top:p.top as number,weeks:p.weeks as number},ctx.now)
   return {result:r,note:null,data:{
    top:r.top??p.top,dates:r.dates??[],series:r.series??[],entries:r.entries??[],exits:r.exits??[],previous_date:r.previousDate??null,
    meaning:'One rank per asset per sampled week. entries and exits compare the newest week with the one before; with a single captured week both are empty rather than calling everything new.',
   }}
  },
 },
 airdrops:{
  what:'airdrops',
  params:{status:{oneOf:['ongoing','upcoming','all'],default:'all'},days:{min:1,max:365,default:90},rows:{min:1,max:50,default:25}},
  source:CMC('/v1/cryptocurrency/airdrops','intel_airdrop_snapshots'),
  calculatedBy:'provider',
  async run(ctx,p){
   // providerIds (the member's holdings) is deliberately not passed: this tool
   // reads shared intelligence, and holdings are the member's own records.
   const r:Any=await readAirdrops(ctx.db,{status:p.status,days:p.days},ctx.now)
   const all=(r.rows??[]) as Any[]
   const rows=all.slice(0,Number(p.rows))
   return {result:r,note:notes(listNote(rows.length,all.length,'airdrops','Ordered by start date. Raise rows up to 50, or filter by status.'),!all.length&&r.recorded?.total?`The provider's list holds ${r.recorded.total} entries, none inside this window; the newest ended ${r.recorded.newestEndDate??'on an unknown date'}.`:null),data:{
    status:r.status,days:r.days,rows,lanes:r.lanes??null,recorded:r.recorded??null,
   }}
  },
 },
 network_stats:{
  what:'network statistics',
  params:{rows:{min:1,max:50,default:25}},
  source:CMC('/v1/blockchain/statistics/latest','intel_network_stats_snapshots'),
  calculatedBy:'provider',
  async run(ctx,p){
   const r:Any=await readNetworkStats(ctx.db,{},ctx.now)
   const all=(r.rows??[]) as Any[]
   const rows=all.slice(0,Number(p.rows))
   return {result:r,note:listNote(rows.length,all.length,'chains'),data:{rows}}
  },
 },
}

export const MARKET_FIGURE_NAMES=Object.keys(MARKET_FIGURES) as readonly string[]

const MARKET_REASON:Record<string,string>={
 plan_below_growth:'Network statistics are captured only on a CoinMarketCap Growth plan, which this capture does not run on, so there is no reading. Not a flat network.',
 no_asset_selected:'Name the asset with provider_id (attention) or provider_ids (liquidations).',
}

/** Per-figure validation, after the shared schema. A parameter the figure does
 * not take is refused by name, never silently ignored, and a value outside the
 * figure's own bounds is refused rather than clamped. */
export function figureParams(figure:string,args:Args):Args {
 const spec=MARKET_FIGURES[figure]
 if(!spec)throw new AgentAuthError(400,'invalid_arguments',`figure must be one of: ${MARKET_FIGURE_NAMES.join(', ')}.`)
 const accepted=Object.keys(spec.params)
 const given=Object.keys(args).filter(key=>key!=='figure'&&args[key]!==undefined&&args[key]!==null)
 const extra=given.filter(key=>!accepted.includes(key))
 if(extra.length)throw new AgentAuthError(400,'invalid_arguments',`figure ${figure} does not take ${extra.join(', ')}. It takes: ${accepted.join(', ')||'nothing'}.`)
 for(const key of spec.required??[]){
  if(!given.includes(key))throw new AgentAuthError(400,'invalid_arguments',`figure ${figure} needs ${key}.`)
 }
 const out:Args={}
 for(const [key,rule] of Object.entries(spec.params)){
  const value=args[key]
  if(value===undefined||value===null){if(rule.default!==undefined)out[key]=rule.default;continue}
  if(rule.oneOf&&!rule.oneOf.includes(value as number|string))throw new AgentAuthError(400,'invalid_arguments',`${key} for figure ${figure} must be one of: ${rule.oneOf.join(', ')}.`)
  if(typeof value==='number'){
   if(rule.min!==undefined&&value<rule.min)throw new AgentAuthError(400,'invalid_arguments',`${key} for figure ${figure} must be ${rule.min} or more.`)
   if(rule.max!==undefined&&value>rule.max)throw new AgentAuthError(400,'invalid_arguments',`${key} for figure ${figure} must be ${rule.max} or less.`)
  }
  out[key]=value
 }
 return out
}

export async function marketStructure(ctx:ToolContext,args:Args):Promise<Payload> {
 const figure=String(args.figure)
 const params=figureParams(figure,args)
 const spec=MARKET_FIGURES[figure]
 const {result,data,note}=await spec.run(ctx,params)
 const reason=typeof result?.reason==='string'?(MARKET_REASON[result.reason]??reasonSentence(result.reason)):null
 const rowsFor=(()=>{
  for(const key of ['rows','series','exchanges','assets','entries']){const v=(data as Any)[key];if(Array.isArray(v))return v.length}
  return result?.asOf?1:0
 })()
 const shaped=budgeted(notes(reason??emptyNote(rowsFor,result?.asOf??null,null,spec.what),note),{figure,params,...data})
 return grounded({
  tool:'market_structure',
  as_of:result?.asOf??null,
  source:spec.source,
  calculated_by:spec.calculatedBy,
  ...(spec.inputs?{inputs:spec.inputs}:{}),
  tier:tier(ctx),
  coverage:result?.coverage??null,
  note:shaped.note,
 },shaped.data)
}
