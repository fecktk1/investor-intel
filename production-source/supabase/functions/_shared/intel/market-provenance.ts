// Receipts and provenance envelopes for the Markets surfaces (Play 1 and Play 7).
//
// Pure: every function here assembles from values a read already produced. None
// of them reads a table or calls a provider, so attaching their output to a
// response can never add a per-user provider call.

import {figureEnvelope,figureScope,ageFreshness,curatedEnvelope,type FigureEnvelope,type FigureFreshness} from './market-figure-scope.ts'
import {fromCmcReceipt,storedReceipt,receiptFreshness,type SourceReceipt} from './source-receipt.ts'

/** The catalogue refresh policy row (`catalogue`, 300 seconds). */
export const CATALOGUE_REFRESH_SECONDS=300
/** The exchange ticker layer refreshes within five minutes (markets-screen.ts). */
export const EXCHANGE_REFRESH_SECONDS=300

const newest=(values:unknown[]):string|null=>{
 const stamps=values.map(v=>Date.parse(String(v??''))).filter(Number.isFinite)
 return stamps.length?new Date(Math.max(...stamps)).toISOString():null
}
const dominant=(values:unknown[]):string|null=>{
 const tally=new Map<string,number>()
 for(const v of values)if(typeof v==='string'&&v)tally.set(v,(tally.get(v)??0)+1)
 return [...tally.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]??null
}

/** The screen reads the stored catalogue only. Its receipt describes that stored
 * snapshot, and every figure group on it carries the same clock. */
export function screenProvenance(screen:any,now=Date.now()):{receipt:SourceReceipt;figureProvenance:Record<string,FigureEnvelope>} {
 const rows=Array.isArray(screen?.rows)?screen.rows:[]
 const provider=dominant(rows.map((r:any)=>r?.sourceProvider))??'market_assets'
 const freshness=screen?.snapshot?.freshness
 const receipt=storedReceipt({provider,capability:'market_catalogue',origin:'stored',fetchedAt:screen?.lastUpdated??null,refreshSeconds:CATALOGUE_REFRESH_SECONDS,
  state:freshness==='unavailable'?'unavailable':freshness==='degraded'?'stale':null},now)
 const at=receipt.fetchedAt,f=receipt.freshness
 const cexAt=newest(rows.flatMap((r:any)=>(r?.providers||[]).map((p:any)=>p?.asOf??p?.as_of)))
 return {receipt,figureProvenance:{
  catalogue:figureEnvelope('stored',provider,at,f,'market_catalogue'),
  price:figureEnvelope('stored',provider,at,f,figureScope('price')),
  price_change:figureEnvelope('stored',provider,at,f,figureScope('price_change')),
  market_cap:figureEnvelope('stored',provider,at,f,figureScope('market_cap')),
  volume_24h:figureEnvelope('stored',provider,at,f,figureScope('volume_24h')),
  cex:figureEnvelope('stored','exchange',cexAt??at,cexAt?ageFreshness(cexAt,EXCHANGE_REFRESH_SECONDS,now):f,'exchange_ticker'),
  dex:figureEnvelope('stored','dex_pair_snapshots',at,f,'dex_pool'),
 }}
}

const worst=(states:FigureFreshness[]):FigureFreshness|null=>
 !states.length?null:states.includes('unavailable')?'unavailable':states.includes('stale')?'stale':states.every(s=>s==='fresh')?'fresh':'cached'

const CHART_SCOPE:Record<string,string>={coinmarketcap:'cmc_ohlcv',coinmarketcap_kline:'dex_ohlcv',coingecko:'coingecko_ohlc',birdeye:'birdeye_ohlcv',geckoterminal:'dex_ohlcv',dexscreener:'dex_pool'}
/** Chart provenance for any candle source. CMC charts carry transport receipts;
 * other rungs carry their own state and clock and are described as stored. */
/** A series built from stored prices (stored-candles.ts) names its own scope:
 * candles grouped from stored quotes, or daily rows. Mirrored in
 * src/intel/lib/source-receipt.js chartSnapshotProvenance. */
export function storedChartScope(chart:any):string|null {
 const mode=chart?.storedSeries?.mode
 return mode==='quotes'?'stored_quote_candles':mode==='daily'||mode==='weekly'?'stored_daily_prices':null
}
export function chartProvenance(chart:any,now=Date.now()):{receipts:SourceReceipt[];envelope:FigureEnvelope} {
 const source=String(chart?.bestProvider||chart?.source||'unknown')
 const receipts:SourceReceipt[]=(Array.isArray(chart?.receipts)?chart.receipts:[]).map((r:any)=>fromCmcReceipt(r,now)).filter((r:SourceReceipt|null):r is SourceReceipt=>!!r)
 const fetchedAt=newest([...(Array.isArray(chart?.provenance)?chart.provenance.map((p:any)=>p?.fetchedAt):[]),chart?.last_refreshed_at,chart?.lastRefreshedAt])
 const state=String(chart?.sourceState??chart?.chartState??'')
 const freshness=receipts.length?worst(receipts.map(r=>receiptFreshness(r,now))):state==='stale'?'stale':state==='unavailable'||!(chart?.candles?.length)?'unavailable':null
 return {receipts,envelope:figureEnvelope(receipts.some(r=>r.origin==='live')?'live':'stored',source,fetchedAt,freshness,storedChartScope(chart)??CHART_SCOPE[source]??(source.includes('exchange')||['binance','coinbase','kraken','kucoin','okx','bybit'].includes(source)?'exchange_ohlcv':figureScope('price')))}
}

/** Receipts and envelopes for the single-asset detail quote. A CoinMarketCap
 * quote carries the transport receipts of the read that answered it; any other
 * provider is the stored catalogue row and gets a stored receipt. */
export function quoteProvenance(quote:any,cmcReceipts:unknown[],now=Date.now()):{receipts:SourceReceipt[];figureProvenance:Record<string,FigureEnvelope>} {
 const provider=String(quote?.quoteProvider||'unknown')
 const cmc=(Array.isArray(cmcReceipts)?cmcReceipts:[]).map(r=>fromCmcReceipt(r,now)).filter((r):r is SourceReceipt=>!!r)
 // A quote answered by the stored catalogue gets a receipt for that stored row.
 // A CoinMarketCap read that was attempted and did not answer keeps its own
 // receipt beside it, because that is exactly why the stored row is shown.
 const stored=provider==='coinmarketcap'&&cmc.length?null:(provider==='unknown'&&!quote?.asOf?null:storedReceipt({provider,capability:'market_assets',origin:'stored',fetchedAt:quote?.asOf??null,refreshSeconds:CATALOGUE_REFRESH_SECONDS,
  state:quote?.sourceFreshness==='unavailable'?'unavailable':quote?.sourceFreshness==='stale'||quote?.sourceFreshness==='degraded'?'stale':null},now))
 const receipts=stored?[stored,...cmc]:cmc
 // The receipt of the read that answered the PRICE decides freshness; the
 // metadata read answers identity only and never makes a price look fresher.
 const quoteReceipt=stored??cmc.find(r=>r.capability==='quotes')??cmc[0]??null
 const freshness=quoteReceipt?receiptFreshness(quoteReceipt,now):null
 const fetchedAt=quote?.provenance?.fetchedAt??quoteReceipt?.fetchedAt??quote?.asOf??null
 const kind=quoteReceipt?.origin==='live'?'live':'stored'
 return {receipts,figureProvenance:{
  price:figureEnvelope(kind,provider,fetchedAt,freshness,figureScope('price')),
  price_change:figureEnvelope(kind,provider,fetchedAt,freshness,figureScope('price_change')),
  market_cap:figureEnvelope(kind,provider,fetchedAt,freshness,figureScope('market_cap')),
  volume_24h:figureEnvelope(kind,provider,fetchedAt,freshness,figureScope('volume_24h')),
 }}
}

/** Stored exchange, order book and DEX pool figures on the detail page. */
export function venueProvenance(input:{tickers?:any[];orderbookAsOf?:unknown;dex?:any},now=Date.now()):Record<string,FigureEnvelope> {
 const tickerAt=newest((input.tickers||[]).map(t=>t?.as_of))
 const out:Record<string,FigureEnvelope>={}
 if((input.tickers||[]).length)out.cex=figureEnvelope('stored','exchange',tickerAt,ageFreshness(tickerAt,EXCHANGE_REFRESH_SECONDS,now)??'unavailable','exchange_ticker')
 if(input.orderbookAsOf)out.orderbook=figureEnvelope('stored','exchange',input.orderbookAsOf,ageFreshness(input.orderbookAsOf,EXCHANGE_REFRESH_SECONDS,now)??'unavailable','exchange_ticker')
 if(input.dex){
  const staleAfter=Date.parse(String(input.dex.staleAfter??''))
  out.dex=figureEnvelope('stored','dex_pair_snapshots',input.dex.fetchedAt,Number.isFinite(staleAfter)?(staleAfter>now?'cached':'stale'):null,'dex_pool')
 }
 return out
}

/** Birdeye OHLCV lives in a shared cache refreshed at most every two minutes
 * (birdeye-chart-cache.ts, and the coverage sentence the chart already shows). */
export const BIRDEYE_CHART_REFRESH_SECONDS=120

/** `intel-token-chart` responses come from four source families with different
 * evidence. Each is described only as far as the response itself proves:
 *  - CoinMarketCap: the transport receipts of the OHLCV pages.
 *  - Birdeye: the shared chart cache state, clock and whether this read refreshed it.
 *  - GeckoTerminal / DEX Screener: a stored pool snapshot when one answered;
 *    otherwise the degen transport does not report whether its own cache or the
 *    public endpoint answered, so no receipt is claimed and the envelope says
 *    the clock was not reported.
 *  - CoinGecko: no clock is returned, so the same applies. */
export function tokenChartProvenance(b:any,now=Date.now()):{receipts:SourceReceipt[];figureProvenance:Record<string,FigureEnvelope>} {
 const source=String(b?.source||'unknown'),out:Record<string,FigureEnvelope>={}
 let receipts:SourceReceipt[]=[]
 if(source==='coinmarketcap'||Array.isArray(b?.receipts)&&b.receipts.length){
  const read=chartProvenance(b,now);receipts=read.receipts;out.chart=read.envelope
 }else if(source==='birdeye'){
  const receipt=storedReceipt({provider:'birdeye',capability:'ohlcv',endpoint:'/defi/ohlcv',origin:b?.sourceRefreshed===true?'live':'cache',keyMode:'keyed',
   fetchedAt:b?.last_refreshed_at??null,refreshSeconds:BIRDEYE_CHART_REFRESH_SECONDS,state:b?.sourceState??null},now)
  receipts=[receipt];out.chart=figureEnvelope(receipt.origin==='live'?'live':'stored','birdeye',receipt.fetchedAt,receipt.freshness,'birdeye_ohlcv')
 }else if(b?.sourceSnapshot?.fetchedAt){
  const staleAfter=Date.parse(String(b.sourceSnapshot.staleAfter??''))
  const receipt=storedReceipt({provider:source,capability:'pool_ohlcv_snapshot',origin:'stored',keyMode:'keyless',fetchedAt:b.sourceSnapshot.fetchedAt,
   state:Number.isFinite(staleAfter)&&staleAfter<=now?'stale':null},now)
  receipts=[receipt];out.chart=figureEnvelope('stored',source,receipt.fetchedAt,Number.isFinite(staleAfter)?(staleAfter>now?'cached':'stale'):null,'dex_ohlcv')
 }else{
  out.chart=figureEnvelope('stored',source,null,b?.candles?.length?null:'unavailable',CHART_SCOPE[source]??figureScope('price'))
 }
 const o=b?.overview
 if(o&&typeof o==='object'){
  const provider=String(o.source||(source==='geckoterminal'||source==='dexscreener'?'dex':source))
  const scope=provider==='coinmarketcap'?figureScope('price'):provider==='birdeye'?'birdeye_price':provider==='coingecko'?'coingecko_price':'dex_pool'
  out.overview=figureEnvelope('stored',provider,o.as_of??b?.last_refreshed_at??null,null,scope)
 }
 return {receipts,figureProvenance:out}
}

/** Curated catalyst stories on the asset page. That read selects by publication
 * date, not by review window, so a summary past its window can reach the page.
 * Each item gets its envelope; a stale item keeps its title and link but its
 * summary fields move under `stale_summary`, so a view drawing `why_it_matters`
 * cannot present an expired summary as current. */
export function curatedNewsWithEnvelopes(items:unknown,now=Date.now()):any[] {
 return (Array.isArray(items)?items:[]).map((item:any)=>{
  const provenance=curatedEnvelope('intel_curated_news',item?.updated_at??null,item?.stale_after??null,'news_curated',now)
  if(provenance.kind==='curated')return {...item,provenance}
  const {summary=null,why_it_matters=null,crypto_impact=null,watch_next=null}=item||{}
  return {...item,summary:null,why_it_matters:null,crypto_impact:null,watch_next:null,stale_summary:{summary,why_it_matters,crypto_impact,watch_next},provenance}
 })
}
