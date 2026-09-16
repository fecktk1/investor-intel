// Reads the retained observations the evidentiary standard needs, and nothing
// else. No provider transport, no credit, no write: this is the same bounded
// `intel_market_observations` window `cached-asset-quote.ts` already reads.
//
// WHY THIS IS A SEPARATE READER. `readCachedAssetQuote` collapses to the NEWEST
// observation per field, which is exactly right for showing a quote and exactly
// wrong here: market capitalisation is published as a LEVEL, so a single newest
// reading carries no direction at all. Deriving a signed change needs two dated
// levels roughly a window apart, which means keeping the window rather than
// collapsing it.
//
// WHAT EACH SOURCE CAN ACTUALLY DATE (measured, not assumed):
//   * CoinMarketCap quotes / listings  price change (24h) and volume change
//     (24h) arrive already signed and dated at the quote clock
//     (investigation-normalize.ts). Market capitalisation arrives as a dated
//     LEVEL, so a change is derivable only when two levels a window apart are
//     retained. PROBED IN PRODUCTION ON 2026-09-16 (figures at
//     CAP_WINDOW_TOLERANCE_MS): those pairs are abundant, not scarce. Market
//     capitalisation is one of the densest things we retain, about one reading
//     every 20 minutes, and 2,059 of 2,114 subjects carried two or more. Full
//     corroboration is the ORDINARY outcome for this source, not an edge case.
//   * Birdeye token overview  the retained response has a CAPTURE clock only
//     (`clockBasis:'cache_capture'`), never a provider observation time, so
//     nothing on it may be presented as a dated market-cap change.
//   * CoinMarketCap DEX discovery cohorts  market capitalisation is explicitly
//     undated at the source (dex-cohort-service.ts sets initialMarketCapUsd to
//     null on purpose). It can never corroborate.
// Each of those degrades to a stated reason rather than a claimed agreement.

import {finite,instant} from './investigation-evidence.ts'
import {AGREEMENT_MAX_AGE_MS,metricAgreement,type MetricAgreementResult,type MetricChangeInput} from './metric-agreement.ts'

/** Two market-cap levels must span something close to the window the price and
 * volume changes describe, or the derived change answers a different question.
 *
 * THE BAND IS ONE HOUR, SIZED ON MEASURED DATA rather than left at a guess.
 * Probed against production on 2026-09-16, `intel_market_observations` metric
 * `market_cap` over the preceding three days:
 *
 *     subjects with market cap           2,114
 *     observations                     462,704
 *     subjects with 2 or more            2,059
 *     mean observations per subject        218.9   (about one every 20 minutes)
 *     subjects spanning 20 to 28 hours     691
 *     subjects spanning over 28 hours    1,184
 *     widest span seen                      71.9 hours
 *
 * Two things follow. First, dated pairs are ABUNDANT: effectively every subject
 * with two readings and a span past a day can form one, so 'corroborated' is a
 * reachable state for most CoinMarketCap-sourced subjects and not an edge case.
 *
 * Second, and the reason this moved from four hours to one: the derived change
 * is LABELLED as the 86,400-second window so it can be compared with the price
 * and volume changes, and the band is exactly how far that label may be from the
 * truth. At four hours it could misstate its own window by up to 17%; at one
 * hour it cannot be out by more than about 4%. At one sample every 20 minutes
 * the nearest reading to the 24-hour target is typically within 10 minutes, so
 * four hours was slop nobody needed. One hour still absorbs two consecutive
 * missed captures, so it costs coverage only where the retained history does not
 * reach back a day, which is precisely the case that SHOULD degrade to
 * `market_cap_single_observation` instead of quietly presenting a 20-hour change
 * as a daily one. */
export const CAP_WINDOW_SECONDS=86_400
export const CAP_WINDOW_TOLERANCE_MS=60*60*1000

const QUOTE_SOURCE=/^coinmarketcap:\/v\d+\/cryptocurrency\/(?:quotes|listings)\/latest:/

// deno-lint-ignore no-explicit-any
type Row=Record<string,any>

/** Usable retained observations for ONE subject, already checked for identity,
 * clock sanity and retention, newest first. */
// deno-lint-ignore no-explicit-any
export async function readAgreementObservations(db:any,subject:string,now:number):Promise<{rows:Row[];error:string|null}>{
 if(typeof subject!=='string'||!/^market:coinmarketcap:[1-9][0-9]{0,9}$/.test(subject))return {rows:[],error:'subject_not_a_coinmarketcap_listing'}
 try{
  const {data,error}=await db.from('intel_market_observations').select('observation').eq('subject',subject).eq('provider','coinmarketcap')
   .gte('observed_at',new Date(now-AGREEMENT_MAX_AGE_MS-CAP_WINDOW_TOLERANCE_MS).toISOString())
   .lte('observed_at',new Date(now).toISOString())
   .gt('retain_until',new Date(now).toISOString())
   .order('observed_at',{ascending:false}).limit(192)
  if(error)throw error
  const rows:Row[]=[]
  for(const entry of (Array.isArray(data)?data:data?[data]:[])){
   const o=entry?.observation
   // Identity, provenance and clocks are re-checked on the row itself. A row is
   // admitted on what it says about itself, never on the filter that found it.
   if(!o||o.subject!==subject||o.provider!=='coinmarketcap'||!QUOTE_SOURCE.test(String(o.sourceRef||'')))continue
   const observed=instant(o.observedAt),recorded=instant(o.recordedAt),expires=instant(o.expiresAt)
   if(observed==null||recorded==null||observed>now||recorded>now)continue
   if(expires!=null&&expires<=now)continue
   if(finite(o.value)==null)continue
   rows.push(o)
  }
  rows.sort((a,b)=>(instant(b.observedAt)??0)-(instant(a.observedAt)??0))
  return {rows,error:null}
 }catch{return {rows:[],error:'agreement_observations_read_failed'}}
}

/** The newest dated change of one metric, as the standard wants it. */
function changeInput(rows:Row[],metric:string,periodSeconds:number):MetricChangeInput{
 const match=rows.find(o=>o.metric===metric&&o.unit==='%'&&finite(o.periodSeconds)===periodSeconds)
 if(!match)return {unavailable:'metric_not_supplied'}
 return {changePct:match.value,observedAt:match.observedAt,periodSeconds}
}

/** Market capitalisation, derived from two dated levels a window apart. Returns
 * the reason instead when the source retained only one, because one level is a
 * position and not a move. */
export function marketCapChangeInput(rows:Row[]):MetricChangeInput{
 const levels=rows.filter(o=>o.metric==='market_cap'&&o.unit==='USD'&&finite(o.value)!=null&&instant(o.observedAt)!=null)
 if(!levels.length)return {unavailable:'metric_not_supplied'}
 const newest=levels[0],newestAt=instant(newest.observedAt)!
 const target=newestAt-CAP_WINDOW_SECONDS*1000
 let baseline:Row|null=null,best=Infinity
 for(const level of levels.slice(1)){
  const at=instant(level.observedAt)!
  const distance=Math.abs(at-target)
  if(distance<=CAP_WINDOW_TOLERANCE_MS&&distance<best){baseline=level;best=distance}
 }
 if(!baseline)return {unavailable:'market_cap_single_observation'}
 const from=finite(baseline.value)!,to=finite(newest.value)!
 // A zero or negative baseline gives no scale for a percentage. Reporting one
 // anyway would invent a number, and reporting zero would claim no change.
 if(!(from>0))return {unavailable:'market_cap_single_observation'}
 return {changePct:((to-from)/from)*100,observedAt:newest.observedAt,periodSeconds:CAP_WINDOW_SECONDS}
}

/** The standard applied to one asset from retained records only. */
// deno-lint-ignore no-explicit-any
export async function readMetricAgreement(db:any,subject:string,now:number):Promise<MetricAgreementResult>{
 const {rows,error}=await readAgreementObservations(db,subject,now)
 if(error){
  // A read failure is not a market that failed to agree. Every metric carries
  // the failure so no surface can read the result as a measured disagreement.
  const unavailable:MetricChangeInput={unavailable:error==='subject_not_a_coinmarketcap_listing'?'market_cap_undated_by_source':'metric_not_supplied'}
  return metricAgreement({price:unavailable,market_cap:unavailable,volume:unavailable},now)
 }
 return metricAgreement({
  price:changeInput(rows,'price_change',CAP_WINDOW_SECONDS),
  market_cap:marketCapChangeInput(rows),
  volume:changeInput(rows,'volume_change',CAP_WINDOW_SECONDS),
 },now)
}
