import {normalizeBars,regularBarGrid,type Bar} from './chart-analysis.ts'
export type ChartSource={provider:string;currency:string;timestampMeaning:'close'|'open'|'observation'|'unknown';intervalMs:number|null;observedAt:number|null;servedAt:number;sourceUrl:string|null;volumeUnit?:string}
/** Preserve provider timestamps. Spacing is not an invented candle duration. */
export function chartSeriesResponse(response:any,servedAt=Date.now()) {
 const normalized=normalizeBars(response?.candles||[]),provider=typeof response?.source==='string'?response.source:'unknown'
 // A STORED series (stored-candles.ts) is built on a regular grid whose times are
 // period opens, candles and close-only days alike, so it keeps 'open' and its own
 // closedAt. Every other source keeps the rule below unchanged.
 const stored=!!response?.storedSeries&&response?.timestampMeaning==='open'
 const meaning:ChartSource['timestampMeaning']=stored?'open':provider==='coingecko'&&normalized.ohlc?'close':response?.timestampMeaning==='open'&&normalized.ohlc?'open':normalized.ohlc?'unknown':'observation'
 const grid=regularBarGrid(normalized.bars)
 const bars:Bar[]=normalized.bars.map(b=>({...b,...(meaning==='close'?{closedAt:b.t}:{}),...(meaning==='observation'?{closedAt:b.t}:{})}))
 const source:ChartSource={provider,currency:response?.currency||'USD',timestampMeaning:meaning,intervalMs:Number.isSafeInteger(response?.barIntervalMs)&&response.barIntervalMs>=1000?response.barIntervalMs:grid?.step??null,observedAt:bars.at(-1)?.closedAt??bars.at(-1)?.t??null,servedAt,
  sourceUrl:provider==='coingecko'?'https://www.coingecko.com/':provider==='coinmarketcap'?'https://coinmarketcap.com/':provider==='geckoterminal'?'https://www.geckoterminal.com/':provider==='birdeye'?'https://birdeye.so/':provider==='binance'?'https://www.binance.com/':null,...(response?.volumeUnit?{volumeUnit:String(response.volumeUnit)}:{})}
 return {candles:bars,source,coverage:normalized.rejected?`${normalized.rejected} invalid price observations omitted.`:null}
}
