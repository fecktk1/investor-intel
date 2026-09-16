// Thesis conditions — loading the Stage 2 regime and history condition sources.
//
// The pure projections already exist (`venue-condition-sources.ts`) and the pure
// measures already exist (`risk-metrics.ts`). This module is the only thing
// between them and the database, and it is deliberately narrow:
//
//   * it READS retained records only — the newest captured market-regime row and
//     an already-cached provider history payload. It never calls a provider and
//     never spends a credit, so a thesis evaluation can never become a paid
//     polling loop. `loadAssetHistory` is the on-demand, credit-spending path and
//     is NOT used here; only its parser is.
//   * an unavailable source returns NO observations and a REASON. It never
//     returns a substitute value, an older window presented as the current one,
//     or an empty list that would read as "the condition simply did not match".
import {instant,type Observation} from './investigation-evidence.ts'
import {historyConditionObservations,regimeConditionObservations,type HistoryRiskMetrics} from './venue-condition-sources.ts'
import {historyPoints,type AssetHistory,type HistoryInterval} from './asset-history.ts'
import {distanceFromHigh,maxDrawdown,realizedVolatility,timeUnderWaterDays} from './risk-metrics.ts'
import {researchCmcId} from './research-identity.ts'
import {metricAgreement,type MetricAgreementResult} from './metric-agreement.ts'
import {readMetricAgreement} from './metric-agreement-read.ts'

/** A capture older than the regime condition's own max age is not a current
 * reading of the market, so it is reported as stale rather than evaluated. */
export const REGIME_MAX_AGE_MS=2*60*60*1000
export const HISTORY_INTERVALS:HistoryInterval[]=['daily','hourly','5m']

export interface ConditionSourceLoad {observations:Observation[];reason:string|null}
export interface ThesisConditionSources {observations:Observation[];reasons:Record<string,string>}

/** The newest captured market-regime row, projected by the reviewed pure
 * function. One subject for every asset: the market itself. */
// deno-lint-ignore no-explicit-any
export async function loadRegimeConditionObservations(db:any,now=Date.now()):Promise<ConditionSourceLoad>{
 const {data,error}=await db.from('intel_regime_snapshots')
  .select('provider,captured_at,source_observed_at,fear_greed_value,fear_greed_class,altcoin_season_index,btc_dominance')
  .lte('captured_at',new Date(now).toISOString()).order('captured_at',{ascending:false}).limit(1)
 if(error)throw Error('regime_read_failed')
 const row=(Array.isArray(data)?data:data?[data]:[])[0]
 if(!row)return {observations:[],reason:'regime_not_captured'}
 const observations=regimeConditionObservations(row,now)
 if(!observations.length)return {observations:[],reason:'regime_not_captured'}
 const observed=instant(row.source_observed_at??row.captured_at)
 if(observed==null||observed<=now-REGIME_MAX_AGE_MS)return {observations,reason:'regime_capture_stale'}
 return {observations,reason:null}
}

/** Derived history measures from an ALREADY-CACHED provider history payload.
 * The daily window is preferred because the reviewed measures are stated for a
 * daily series; a finer cached interval is used only when no daily one is
 * retained, and the projection records which interval it actually described. */
// deno-lint-ignore no-explicit-any
export async function loadHistoryConditionObservations(db:any,cmcId:unknown,now=Date.now()):Promise<ConditionSourceLoad>{
 const id=String(cmcId??'')
 if(!/^[1-9][0-9]{0,9}$/.test(id))return {observations:[],reason:'no_coinmarketcap_listing'}
 const {data,error}=await db.from('market_data_response_cache')
  .select('capability,request_params,response_json,observed_at,fetched_at,expires_at')
  .eq('provider','coinmarketcap').eq('capability','history').eq('request_params->>id',id)
  .gt('expires_at',new Date(now).toISOString()).order('fetched_at',{ascending:false}).limit(8)
 if(error)throw Error('history_read_failed')
 const rows=(Array.isArray(data)?data:data?[data]:[]).filter((r:Record<string,unknown>)=>{
  const params=r?.request_params as Record<string,unknown>|null
  const expires=instant(r?.expires_at)
  return !!r&&r.capability==='history'&&String(params?.id??'')===id&&expires!=null&&expires>now
 })
 if(!rows.length)return {observations:[],reason:'history_not_cached'}
 const interval=(row:Record<string,unknown>)=>{
  const value=String((row.request_params as Record<string,unknown>|null)?.interval??'daily')
  return HISTORY_INTERVALS.includes(value as HistoryInterval)?value as HistoryInterval:'daily'
 }
 const newest=(a:Record<string,unknown>,b:Record<string,unknown>)=>(instant(b.fetched_at)??0)-(instant(a.fetched_at)??0)
 const daily=rows.filter(row=>interval(row)==='daily').sort(newest)
 const chosen=(daily.length?daily:[...rows].sort(newest))[0]
 const points=historyPoints(chosen.response_json,id,now)
 // A retained response that carries no usable point for THIS asset is not a
 // history window; nothing may be derived from it.
 if(!points.length)return {observations:[],reason:'history_points_unavailable'}
 const history:AssetHistory={points,interval:interval(chosen),source:'coinmarketcap',
  observedAt:new Date(points[points.length-1].t).toISOString(),
  fetchedAt:instant(chosen.fetched_at)!=null?new Date(instant(chosen.fetched_at) as number).toISOString():null,
  state:'fresh',reason:null,credits:0}
 const metrics:HistoryRiskMetrics={volatility30d:realizedVolatility(points),maxDrawdown:maxDrawdown(points),
  distanceFromHigh:distanceFromHigh(points,now),timeUnderWaterDays:timeUnderWaterDays(points)}
 const observations=historyConditionObservations(history,metrics,`market:coinmarketcap:${id}`,now)
 if(!observations.length)return {observations:[],reason:'history_points_unavailable'}
 return {observations,reason:null}
}

/** The sources the ACTIVATED rules actually name, and nothing else: a thesis
 * whose conditions never mention regime or history costs no extra read. */
// deno-lint-ignore no-explicit-any
export async function loadThesisConditionSources(db:any,subject:string,rules:any[],now=Date.now()):Promise<ThesisConditionSources>{
 const scopes=new Set((Array.isArray(rules)?rules:[]).map(rule=>String(rule?.source_metric??'').split(':')[0]))
 const sources:ThesisConditionSources={observations:[],reasons:{}}
 const apply=(scope:string,load:ConditionSourceLoad)=>{
  sources.observations.push(...load.observations)
  if(load.reason)sources.reasons[scope]=load.reason
 }
 if(scopes.has('regime')){
  // A read failure is an evaluation failure, not an absent market regime. It is
  // reported as a reason so the condition stays unavailable instead of unmet.
  try{apply('regime',await loadRegimeConditionObservations(db,now))}catch{apply('regime',{observations:[],reason:'regime_read_failed'})}
 }
 if(scopes.has('history')){
  const cmcId=researchCmcId({canonicalKey:subject})
  try{apply('history',await loadHistoryConditionObservations(db,cmcId,now))}catch{apply('history',{observations:[],reason:'history_read_failed'})}
 }
 return sources
}

/** The evidentiary standard for the thesis's OWN asset, from retained records
 * only. It spends no credit and calls no provider, exactly like every other
 * loader here, and a read failure returns an unmeasured verdict rather than
 * throwing: a thesis evaluation must never fail because a LABEL could not be
 * computed. An unmeasured verdict is a research lead, which is the safe side. */
// deno-lint-ignore no-explicit-any
export async function loadThesisMetricAgreement(db:any,subject:string,now=Date.now()):Promise<MetricAgreementResult>{
 try{return await readMetricAgreement(db,subject,now)}
 catch{return metricAgreement({},now)}
}

/** Human-readable text for the reasons this module records. Unknown reasons are
 * never invented into a sentence; the caller keeps the engine's own wording. */
export const CONDITION_SOURCE_REASONS:Record<string,string>={
 regime_not_captured:'No market-regime capture is retained yet, so this condition has nothing to test.',
 regime_capture_stale:'The newest retained market-regime capture is older than this condition asserts.',
 regime_read_failed:'The retained market-regime record could not be read. This is not a no-match result.',
 no_coinmarketcap_listing:'This asset has no CoinMarketCap listing, so no price history window can be derived for it.',
 history_not_cached:'No unexpired price-history window is cached for this asset. Open its history once to retain one.',
 history_points_unavailable:'The retained history response carries no usable point for this asset.',
 history_read_failed:'The retained history response could not be read. This is not a no-match result.',
}
export const conditionSourceReason=(reason:unknown):string|null=>
 typeof reason==='string'&&Object.hasOwn(CONDITION_SOURCE_REASONS,reason)?CONDITION_SOURCE_REASONS[reason]:null
export const conditionSourceScope=(sourceMetric:unknown):string=>String(sourceMetric??'').split(':')[0]
