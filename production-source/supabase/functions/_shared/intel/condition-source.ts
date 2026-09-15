// Scope selectors identify a provider + venue + contract, never a ticker.
import {researchIdentity} from './research-identity.ts'
/** Derived history measures. They describe a window of the asset's own price
 * series, so their clock is the newest point of that series, not a live tick. */
export const HISTORY_CONDITION_METRICS:Record<string,{unit:string;periodSeconds:number|null}>={
 realized_volatility_30d:{unit:'%',periodSeconds:2592000},
 drawdown_pct:{unit:'%',periodSeconds:null},
 days_since_high:{unit:'days',periodSeconds:null},
}
/** Market-wide regime readings. One subject for every asset: the market itself. */
export const REGIME_CONDITION_METRICS:Record<string,{unit:string}>={
 regime_fear_greed:{unit:'index'},
 regime_altcoin_season:{unit:'index'},
 regime_btc_dominance:{unit:'%'},
}
export const REGIME_SUBJECT='macro:coinmarketcap:regime'
export const historyConditionMetric=(metric:unknown)=>typeof metric==='string'&&Object.hasOwn(HISTORY_CONDITION_METRICS,metric)?HISTORY_CONDITION_METRICS[metric]:null
export const regimeConditionMetric=(metric:unknown)=>typeof metric==='string'&&Object.hasOwn(REGIME_CONDITION_METRICS,metric)?REGIME_CONDITION_METRICS[metric]:null
// A daily history window and an hourly regime capture are both older than a
// live quote by design; their own cadence is what makes them still known.
export const conditionMaxAgeSeconds=(metric:string)=>metric==='holder_count'||historyConditionMetric(metric)?172800:regimeConditionMetric(metric)?7200:1200
// '30d' exists so a rule can state the window a 30-day realised volatility was
// derived for. The free-form seconds form stays capped at seven days.
export const CONDITION_WINDOWS:Record<string,number>={'15m':900,'30m':1800,'1h':3600,'2h':7200,'4h':14400,'8h':28800,'24h':86400,'7d':604800,'30d':2592000}
export function conditionPeriod(window:unknown):number|undefined {
 if(typeof window!=='string')return undefined
 const seconds=/^([1-9][0-9]{0,5})s$/.exec(window)
 return CONDITION_WINDOWS[window]??(seconds&&Number(seconds[1])<=604800?Number(seconds[1]):undefined)
}
export function conditionSource(o:any):string|null {
 const m=o.metadata||{}
 // Derived history and market regime carry their own scope: the asset's CMC
 // listing, or the single market-regime subject. Neither is a venue selector.
 if(historyConditionMetric(o.metric))return o.provider==='coinmarketcap'&&/^market:coinmarketcap:[1-9][0-9]{0,9}$/.test(String(o.subject))?`history:coinmarketcap:${o.metric}`:null
 if(regimeConditionMetric(o.metric))return o.provider==='coinmarketcap'&&o.subject===REGIME_SUBJECT?`regime:coinmarketcap:${o.metric}`:null
 if(['holder_count','liquidity_event_usd'].includes(o.metric)){
  const identity=researchIdentity({canonicalKey:o.subject})
  return o.provider==='coinmarketcap'&&identity.tokenAddress&&identity.chain&&identity.tokenAddress===m.contract&&identity.chain===m.chain?`contract:coinmarketcap:${o.metric}`:null
 }
 if(['open_interest','funding_rate'].includes(o.metric))return o.provider&&m.venueId&&m.contractId?`venue:${o.provider}:${m.venueId}:${m.contractId}`:null
 if(o.metric==='depth_notional')return m.venue&&m.pair&&['buy','sell'].includes(m.side)?`depth:${m.venue}:${encodeURIComponent(m.pair)}:${m.side}`:null
 if(/^liquidations_(1h|4h|24h)$/.test(o.metric))return o.provider?`liquidation:${o.provider}:${m.venueId||'asset'}`:null
 return null
}
export function matchesConditionSource(o:any,source:unknown,metric:string):boolean {
 const history=historyConditionMetric(metric),regime=regimeConditionMetric(metric)
 const scoped=['open_interest','funding_rate','depth_notional','holder_count','liquidity_event_usd'].includes(metric)||metric.startsWith('liquidations_')||!!history||!!regime
 // Legacy non-venue source labels are descriptive, not new identity joins.
 if(!scoped)return typeof source!=='string'||!/^(venue|depth|liquidation|contract|history|regime):/.test(source)
 // A derived measure must state the unit and window it was derived for: an
 // annualised percentage is not a drawdown, and neither is a day count.
 if(history&&(o.unit!==history.unit||typeof o.value!=='number'||!Number.isFinite(o.value)||(o.periodSeconds??null)!==history.periodSeconds))return false
 if(history&&metric!=='drawdown_pct'&&o.value<0)return false
 if(history&&metric==='drawdown_pct'&&o.value>0)return false
 if(regime&&(o.unit!==regime.unit||typeof o.value!=='number'||!Number.isFinite(o.value)||o.periodSeconds!=null))return false
 if(metric==='holder_count'&&(o.unit!=='accounts'||!Number.isSafeInteger(o.value)||o.value<0||o.periodSeconds!==86400))return false
 if(metric==='liquidity_event_usd'&&(o.unit!=='USD'||typeof o.value!=='number'||!Number.isFinite(o.value)||!o.metadata?.transaction||o.metadata?.logIndex==null))return false
 if(metric==='open_interest'&&(o.metadata?.compatibleQuote!==true||o.metadata?.excluded===true||o.unit!=='USD'||typeof o.value!=='number'||!Number.isFinite(o.value)||o.value<0))return false
 return typeof source==='string'&&source.length<=80&&source===conditionSource(o)
}
