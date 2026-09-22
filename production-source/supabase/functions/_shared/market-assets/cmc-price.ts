import { requestCmc } from './cmc-transport.ts'
import { cmcRows, cmcUsable } from './cmc-capabilities.ts'
import type { MarketAssetsContext } from './types.ts'

// Stable identities for the common assets the content detector recognizes.
// Other ticker aliases fall through; a symbol's first result is never identity.
export const CMC_TICKER_IDS:Record<string,number>={BTC:1,ETH:1027,SOL:5426,XRP:52,ADA:2010,AVAX:5805,SUI:20947,DOT:6636,LINK:1975,DOGE:74,SHIB:5994,BNB:1839,ATOM:3794,UNI:7083,NEAR:6535,ARB:11841,OP:11840,INJ:7226,APT:21794,TON:11419,LTC:2,BCH:1831,ETC:1321,FIL:2280,AAVE:7278,ALGO:4030,ICP:8916,XLM:512,VET:3077,HBAR:4642,GRT:6719}
export async function cmcPriceAssets(tickers:string[],ctx?:MarketAssetsContext,request=requestCmc) {
  // This CMC account is registered for Investor Intel. Cross-product generation
  // stays disabled until the commercial rights are explicitly verified.
  let contentAllowed=false
  try{contentAllowed=Deno.env.get('CMC_ALLOW_CONTENT_CREATION')==='true'}catch{/* closed */}
  if(!contentAllowed)return []
  const requested=[...new Set(tickers)].filter(t=>Object.hasOwn(CMC_TICKER_IDS,t)&&Number.isSafeInteger(CMC_TICKER_IDS[t])&&CMC_TICKER_IDS[t]>0).slice(0,3)
  if(!requested.length)return []
  // A saved draft cannot present a stale response as a current price. Existing
  // specialized fallbacks stay available when this source cannot be used.
  let result
  try { result=await request('quotes',{id:requested.map(t=>CMC_TICKER_IDS[t]).sort((a,b)=>a-b).join(',')},ctx) }
  catch { return [] }
  // A snapshot inside its TTL is as good a price as a live one here; the hard
  // 15-minute observation bound below is what actually keeps a draft honest.
  if(!cmcUsable(result.state))return []
  return cmcRows('quotes',result.payload).rows.flatMap(row=>{
    const ticker=requested.find(t=>CMC_TICKER_IDS[t]===Number(row.id)), q=row.quote
    const observed=Date.parse(q?.last_updated||row.last_updated||'')
    if(!ticker||!Number.isFinite(q?.price)||q.price<=0||!Number.isFinite(observed)||observed>Date.now()+300000||observed<Date.now()-900000)return []
    return [{ticker,price_usd:q.price,change_24h_pct:Number.isFinite(q.percent_change_24h)?q.percent_change_24h:null,high_24h_usd:null,low_24h_usd:null,as_of_utc:new Date(observed).toISOString(),source:'coinmarketcap' as const}]
  })
}
