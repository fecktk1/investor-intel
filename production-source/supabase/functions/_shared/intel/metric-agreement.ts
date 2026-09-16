// The stated evidentiary standard for a market move (pure, no reads).
//
// A move is CORROBORATED only when price, market capitalisation AND volume all
// describe the SAME window, each carries its OWN observation clock, and all of
// them point the same way. Anything else is a research lead, and this module
// records WHICH shortfall made it one so a reader never has to guess whether a
// metric disagreed or was simply never measured.
//
// VOCABULARY. The field is `metric_agreement` and the word "confirmed" is
// deliberately absent. This codebase already spends "confirmed" on four
// unrelated ideas: narrative-scoring's *_confirmation_score components, its
// clarity labels and its 'confirmed' lifecycle stage; intel-signals'
// `market_confirmed`, which is a 24-hour price move ALONE; thesis-evidence's
// EngineStatus 'confirmed' / 'partially_confirmed'; and the portfolio
// classifier's 'confirmed' classification. A fifth sense of one word would be
// unreadable, so the code term shares no morpheme with any of them.
//
// A LEVEL IS NOT A CHANGE. A single market-capitalisation reading says nothing
// about direction, so it may never enter this test. Callers pass a signed change
// with the clock that change is dated by, or they pass the reason they cannot,
// and the result degrades honestly instead of asserting an agreement nobody
// measured.

import {finite,instant} from './investigation-evidence.ts'

/** The three metrics the standard names. Order is display order. */
export const AGREEMENT_METRICS=['price','market_cap','volume'] as const
export type AgreementMetric=typeof AGREEMENT_METRICS[number]

/** `corroborated` is the only value that is not a research lead.
 *  `conflicting`  at least two usable metrics point opposite ways.
 *  `incomplete`   one or two usable metrics; the full set could not be completed.
 *  `unmeasured`   no usable dated change at all. */
export type MetricAgreement='corroborated'|'conflicting'|'incomplete'|'unmeasured'
export type MetricDirection='up'|'down'|'flat'

/** A metric's own dated change over the window, or the reason there is none. */
export interface MetricChangeInput{
 /** Signed change across the window, in percent. Never a level. */
 changePct?:unknown
 /** The clock the CHANGE is dated by. Without one there is no window to agree
  * about, so the metric is dropped rather than assumed to be current. */
 observedAt?:unknown
 /** The window the change covers. Two different windows are two different
  * questions and cannot corroborate each other. */
 periodSeconds?:unknown
 /** A reason code the caller already knows (see AGREEMENT_REASONS). It is kept
  * verbatim so the receipt says why, not merely that something was missing. */
 unavailable?:unknown
}

export interface MetricReading{
 metric:AgreementMetric
 direction:MetricDirection|null
 changePct:number|null
 observedAt:string|null
 periodSeconds:number|null
 usable:boolean
 reason:string|null
}

export interface MetricAgreementResult{
 agreement:MetricAgreement
 /** True for every value except 'corroborated'. Carried explicitly so callers
  * and receipts never re-derive the standard and drift from it. */
 researchLead:boolean
 readings:MetricReading[]
 usable:number
 periodSeconds:number|null
 /** Distinct reason codes, in AGREEMENT_METRICS order, for the shortfalls. */
 reasons:string[]
}

export interface MetricAgreementOptions{
 /** How old a change may be and still describe "now". Defaults to one day. */
 maxAgeMs?:number
 /** How far the three clocks may sit apart and still describe one window.
  * Defaults to one hour. A wider spread is reported, never averaged away. */
 maxSpreadMs?:number
}

export const AGREEMENT_MAX_AGE_MS=86_400_000
export const AGREEMENT_MAX_SPREAD_MS=3_600_000

/** Plain English for every reason this module records. An unknown code is never
 * invented into a sentence; the caller keeps whatever wording it already had. */
export const AGREEMENT_REASONS:Record<string,string>={
 metric_not_supplied:'This metric was not supplied, so it could not take part in the agreement test.',
 metric_level_only:'This source reports a level for this metric and no change, and a level has no direction.',
 metric_undated:'This metric carries no observation time of its own, so there is no window it can be said to agree about.',
 metric_not_a_number:'The supplied value is not a finite number, so no direction can be read from it.',
 metric_dated_in_future:'The supplied observation time is in the future, so it is not a reading of a window that has closed.',
 metric_stale:'The supplied observation is older than this test accepts, so it does not describe the current window.',
 metric_window_mismatch:'This metric covers a different window from the others, and two windows are two questions.',
 metric_clock_spread:'The supplied observation times sit too far apart to describe one window.',
 metric_flat:'This metric did not move, so it neither supports nor contradicts the others.',
 market_cap_undated_by_source:'This source publishes market capitalisation without an observation time of its own, so no dated change can be derived from it.',
 market_cap_single_observation:'Only one dated market capitalisation reading is retained, and a change needs two.',
 not_a_market_move:'This alert reports a recorded event rather than a market move, so price, market capitalisation and volume have nothing to agree about.',
 narrative_scores_exclude_market_cap:'A narrative score carries price and volume components but no market capitalisation, so the full agreement test cannot be run on it.',
}
export const agreementReason=(code:unknown):string|null=>
 typeof code==='string'&&Object.hasOwn(AGREEMENT_REASONS,code)?AGREEMENT_REASONS[code]:null

/** Zero is a real reading, not a missing one: a metric that did not move is
 * FLAT. No tolerance band is invented here, because any tolerance would be a
 * threshold nobody stated and would quietly turn small real moves into
 * agreement. A caller that wants a band must round before it calls. */
const directionOf=(changePct:number):MetricDirection=>changePct>0?'up':changePct<0?'down':'flat'

function read(metric:AgreementMetric,input:MetricChangeInput|null|undefined,now:number,options:Required<MetricAgreementOptions>):MetricReading{
 const blank:MetricReading={metric,direction:null,changePct:null,observedAt:null,periodSeconds:null,usable:false,reason:'metric_not_supplied'}
 if(!input||typeof input!=='object')return blank
 // A caller that already knows why it cannot supply this metric keeps its own
 // reason. Re-deriving one here would replace a specific answer with a generic.
 if(typeof input.unavailable==='string'&&input.unavailable)return {...blank,reason:input.unavailable}
 const changePct=finite(input.changePct)
 if(changePct==null)return {...blank,reason:input.changePct==null?'metric_not_supplied':'metric_not_a_number'}
 const observed=instant(input.observedAt)
 if(observed==null)return {...blank,changePct,reason:'metric_undated'}
 const observedAt=new Date(observed).toISOString()
 const periodSeconds=finite(input.periodSeconds)
 const partial={metric,direction:null,changePct,observedAt,periodSeconds,usable:false} as const
 if(observed>now)return {...partial,reason:'metric_dated_in_future'}
 if(observed<=now-options.maxAgeMs)return {...partial,reason:'metric_stale'}
 return {metric,direction:directionOf(changePct),changePct,observedAt,periodSeconds,usable:true,reason:null}
}

/** The standard itself. Same inputs, same verdict: no clocks are read here
 * beyond the `now` the caller states, so a receipt replays exactly. */
export function metricAgreement(
 input:Partial<Record<AgreementMetric,MetricChangeInput|null>>,
 now:number,
 options:MetricAgreementOptions={},
):MetricAgreementResult{
 const resolved:Required<MetricAgreementOptions>={
  maxAgeMs:finite(options.maxAgeMs)??AGREEMENT_MAX_AGE_MS,
  maxSpreadMs:finite(options.maxSpreadMs)??AGREEMENT_MAX_SPREAD_MS,
 }
 const readings=AGREEMENT_METRICS.map(metric=>read(metric,input?.[metric],now,resolved))

 // ONE window or none. The most-represented period among the usable readings is
 // the window under test; a reading on any other period is set aside as a
 // mismatch rather than folded in, because a 24-hour price change and a 7-day
 // volume change are not evidence about the same thing.
 const tally=new Map<string,number>()
 for(const r of readings)if(r.usable)tally.set(String(r.periodSeconds??'none'),(tally.get(String(r.periodSeconds??'none'))??0)+1)
 let window:string|null=null,best=0
 for(const [key,count] of tally)if(count>best||(count===best&&window!=null&&key<window)){window=key;best=count}
 for(const r of readings)if(r.usable&&String(r.periodSeconds??'none')!==window){r.usable=false;r.direction=null;r.reason='metric_window_mismatch'}

 // The clocks must also describe one moment. A wide spread is reported rather
 // than averaged away: it is exactly the case where an agreement would be
 // asserted across readings taken at unrelated times.
 const clocks=readings.filter(r=>r.usable).map(r=>instant(r.observedAt)!).sort((a,b)=>a-b)
 if(clocks.length>1&&clocks[clocks.length-1]-clocks[0]>resolved.maxSpreadMs)
  for(const r of readings)if(r.usable){r.usable=false;r.direction=null;r.reason='metric_clock_spread'}

 const usable=readings.filter(r=>r.usable)
 const directions=new Set(usable.map(r=>r.direction))
 const agreement:MetricAgreement=
  usable.length===0?'unmeasured'
  // A contradiction outranks an absence: two metrics pointing opposite ways is a
  // finding, and it must not be softened into "not enough evidence".
  :directions.has('up')&&directions.has('down')?'conflicting'
  // All three, one direction. Three flat readings corroborate a flat window:
  // valid zeros stay zeros and are not demoted to "no evidence".
  :usable.length===AGREEMENT_METRICS.length&&directions.size===1?'corroborated'
  :'incomplete'

 // A metric that stood still while another moved is recorded as flat, so the
 // receipt distinguishes "did not move" from "was never measured".
 for(const r of readings)if(r.usable&&r.direction==='flat'&&directions.size>1)r.reason='metric_flat'

 return {
  agreement,researchLead:agreement!=='corroborated',readings,usable:usable.length,
  periodSeconds:window==null||window==='none'?null:Number(window),
  reasons:[...new Set(readings.map(r=>r.reason).filter((x):x is string=>!!x))],
 }
}

/** The shape stored on an alert receipt and read back by the UI. Deliberately
 * small: the full readings ride along so a reader can see each clock, but the
 * verdict and its reasons are the part every surface agrees on. */
export interface MetricAgreementReceipt{
 metric_agreement:MetricAgreement
 research_lead:boolean
 period_seconds:number|null
 reasons:string[]
 readings:Array<{metric:AgreementMetric;direction:MetricDirection|null;change_pct:number|null;observed_at:string|null;reason:string|null}>
}
export function metricAgreementReceipt(result:MetricAgreementResult):MetricAgreementReceipt{
 return {
  metric_agreement:result.agreement,research_lead:result.researchLead,period_seconds:result.periodSeconds,reasons:result.reasons,
  readings:result.readings.map(r=>({metric:r.metric,direction:r.direction,change_pct:r.changePct,observed_at:r.observedAt,reason:r.reason})),
 }
}

/** An alert that reports a recorded EVENT (a transfer, an unlock, a metadata
 * change) is not a market move. It gets a receipt that says so, rather than an
 * empty one a reader could mistake for a failed test. */
export function notAMarketMoveReceipt():MetricAgreementReceipt{
 return {metric_agreement:'unmeasured',research_lead:true,period_seconds:null,reasons:['not_a_market_move'],
  readings:AGREEMENT_METRICS.map(metric=>({metric,direction:null,change_pct:null,observed_at:null,reason:'not_a_market_move'}))}
}

/** Thesis condition metrics that describe a MARKET MOVE of the thesis asset, so
 * the asset's own verdict applies to a condition built on them. Every other
 * condition metric (TVL, holders, pool activity, venue depth, the market regime)
 * is not a price, market capitalisation or volume move of this asset, and gets
 * the explicit not-a-market-move receipt instead of borrowing a verdict. */
export const MARKET_MOVE_CONDITION_METRICS=['price','price_change','volume_change','market_cap','price_move','volume_spike'] as const
export function conditionAgreementReceipt(metric:unknown,asset:MetricAgreementResult|null|undefined):MetricAgreementReceipt{
 if(typeof metric!=='string'||!(MARKET_MOVE_CONDITION_METRICS as readonly string[]).includes(metric))return notAMarketMoveReceipt()
 // A missing asset verdict is never upgraded: nothing was measured, so the
 // condition carries an unmeasured research lead rather than no label at all.
 return metricAgreementReceipt(asset??metricAgreement({},Date.now()))
}
