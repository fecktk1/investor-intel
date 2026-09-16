// Source call receipts for a portfolio VALUATION.
//
// intel-portfolio never calls a provider to value a portfolio: every position is
// valued from the price the canonical pricing pass already stored on the holding
// (`market_context.priceSourceRef`, `priceExpiresAt`, `last_priced_at`). So the
// honest receipt for this surface is a CACHE receipt in the same `CmcReceipt`
// shape the research drawer already renders: the capability and parameters that
// answered, and the plain statement that no call was made for this view.
//
// Nothing here is estimated. The stored holding does not retain the originating
// HTTP status, credit charge, elapsed time or fetch clock, so every one of those
// is null and reads as "not reported". The observation clock the valuation used
// is carried separately as `observedAt`, exactly as the research drawer takes it.

import {CMC_CAPABILITIES} from '../_shared/market-assets/cmc-capabilities.ts'
import type {CmcReceipt} from '../_shared/market-assets/cmc-transport.ts'

type Row=Record<string,any>
export const VALUATION_RECEIPT_LIMIT=25
const SOURCE_REF=/^coinmarketcap:(quotes|listings):([1-9][0-9]{0,11})$/

export interface ValuationReceipt{
 canonicalAssetKey:string
 symbol:string|null
 observedAt:string|null
 expiresAt:string|null
 receipt:CmcReceipt
}

const clock=(value:unknown):string|null=>{
 if(typeof value!=='string'&&typeof value!=='number')return null
 const at=typeof value==='number'?value:Date.parse(value)
 return Number.isFinite(at)?new Date(at).toISOString():null
}

/** One receipt per provider-priced open holding, largest value first, bounded.
 * A holding priced by anything other than a stored CoinMarketCap reference gets
 * no receipt rather than an invented one. */
export function valuationReceipts(holdings:Row[]):ValuationReceipt[]{
 const out:ValuationReceipt[]=[]
 const ordered=[...(Array.isArray(holdings)?holdings:[])].filter(h=>h&&!h.isClosed&&typeof h.canonicalAssetKey==='string'&&h.canonicalAssetKey)
  .sort((a,b)=>(Number(b.currentValue)||-1)-(Number(a.currentValue)||-1)||String(a.canonicalAssetKey).localeCompare(String(b.canonicalAssetKey)))
 const seen=new Set<string>()
 for(const h of ordered){
  if(out.length>=VALUATION_RECEIPT_LIMIT)break
  const context=h.marketContext&&typeof h.marketContext==='object'?h.marketContext:{}
  const match=SOURCE_REF.exec(String(context.priceSourceRef??''))
  if(!match||seen.has(h.canonicalAssetKey))continue
  const capability=match[1],spec=CMC_CAPABILITIES[capability]
  if(!spec)continue
  seen.add(h.canonicalAssetKey)
  out.push({
   canonicalAssetKey:h.canonicalAssetKey,
   symbol:typeof h.assetSymbol==='string'&&h.assetSymbol?h.assetSymbol.slice(0,80):null,
   observedAt:clock(h.lastPricedAt),
   expiresAt:clock(context.priceExpiresAt),
   receipt:{
    capability,endpoint:spec.path,
    // A quotes read names the listing it asked for. A listings value came from
    // the shared catalogue snapshot, which is not a per-asset request.
    parameters:capability==='quotes'?{id:match[2]}:{},
    httpStatus:null,creditCount:null,elapsedMs:null,
    origin:'cache',keyMode:'keyed',
    cacheAgeSeconds:null,ttlSeconds:spec.ttl??null,staleUntil:null,fetchedAt:null,reservation:null,
   },
  })
 }
 return out
}
