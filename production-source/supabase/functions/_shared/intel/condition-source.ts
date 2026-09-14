// Scope selectors identify a provider + venue + contract, never a ticker.
import {researchIdentity} from './research-identity.ts'
export const conditionMaxAgeSeconds=(metric:string)=>metric==='holder_count'?172800:1200
export const CONDITION_WINDOWS:Record<string,number>={'15m':900,'30m':1800,'1h':3600,'2h':7200,'4h':14400,'8h':28800,'24h':86400,'7d':604800}
export function conditionPeriod(window:unknown):number|undefined {
 if(typeof window!=='string')return undefined
 const seconds=/^([1-9][0-9]{0,5})s$/.exec(window)
 return CONDITION_WINDOWS[window]??(seconds&&Number(seconds[1])<=604800?Number(seconds[1]):undefined)
}
export function conditionSource(o:any):string|null {
 const m=o.metadata||{}
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
 const scoped=['open_interest','funding_rate','depth_notional','holder_count','liquidity_event_usd'].includes(metric)||metric.startsWith('liquidations_')
 // Legacy non-venue source labels are descriptive, not new identity joins.
 if(!scoped)return typeof source!=='string'||!/^(venue|depth|liquidation|contract):/.test(source)
 if(metric==='holder_count'&&(o.unit!=='accounts'||!Number.isSafeInteger(o.value)||o.value<0||o.periodSeconds!==86400))return false
 if(metric==='liquidity_event_usd'&&(o.unit!=='USD'||typeof o.value!=='number'||!Number.isFinite(o.value)||!o.metadata?.transaction||o.metadata?.logIndex==null))return false
 if(metric==='open_interest'&&(o.metadata?.compatibleQuote!==true||o.metadata?.excluded===true||o.unit!=='USD'||typeof o.value!=='number'||!Number.isFinite(o.value)||o.value<0))return false
 return typeof source==='string'&&source.length<=80&&source===conditionSource(o)
}
