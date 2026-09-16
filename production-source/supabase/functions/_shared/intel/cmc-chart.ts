import {cmcRows,cmcUsdQuote,cmcUsable} from '../market-assets/cmc-capabilities.ts'
import {requestCmc} from '../market-assets/cmc-transport.ts'
import {normalizeBars,type Bar} from './chart-analysis.ts'
import {CHAIN_COINGECKO} from '../chains.ts'
import type {MarketAssetsContext} from '../market-assets/types.ts'

/** The RANGE vocabulary. The last three were added with the stored daily archive
 * (`market_asset_candles`): a provider window alone can never answer them, so a
 * read that offers them merges the archive with the provider's recent tail.
 * 'ALL' is twenty years — it predates every asset the catalogue carries, so a
 * plan built from it can never ask for a period before the asset existed. */
export const CHART_WINDOWS:Record<string,number>={'1H':3600000,'12H':43200000,'24H':86400000,'3D':259200000,'7D':604800000,'1M':2592000000,'3M':7776000000,'6M':15552000000,'1Y':31536000000,'2Y':63072000000,'5Y':157680000000,'ALL':630720000000}
/** The APP interval vocabulary. The four sub-hour keys were added for the
 * CoinMarketCap k-line source (`cmc-kline-chart.ts`), which is the only source
 * that can sample below an hour, and they are accepted by `intel-markets` for a
 * CONTRACT identity only. CMC OHLCV samples hourly at best, so `cmcChartPlan`
 * still refuses everything outside `CMC_OHLCV_INTERVALS`.
 *
 * '1M' HERE IS ONE MINUTE. `CHART_WINDOWS['1M']` is one month. The two maps
 * describe different things and are never interchangeable — a caller that reads
 * a range key out of this map, or an interval key out of CHART_WINDOWS, is a
 * bug, not a fallback. */
export const CHART_INTERVALS:Record<string,number>={'1M':60000,'5M':300000,'15M':900000,'30M':1800000,'1H':3600000,'4H':14400000,'1D':86400000,'1W':604800000}
/** Intervals `/v2/cryptocurrency/ohlcv/historical` can genuinely sample. */
export const CMC_OHLCV_INTERVALS=['1H','4H','1D','1W']
/** Intervals only the k-line source serves. Sub-MINUTE is refused by the
 * registry (`cmc-capabilities.ts`, `klineIntervals`) and has no app key. */
export const SUB_HOUR_INTERVALS=['1M','5M','15M','30M']
export const isSubHourInterval=(interval:unknown)=>SUB_HOUR_INTERVALS.includes(String(interval))
const HOUR=3600000,DAY=86400000
const NATIVE_IDS:Record<string,string>={bitcoin:'1',ethereum:'1027',solana:'5426',binancecoin:'1839','avalanche-2':'5805'}
/** Reuse verified provider IDs. L2 native ETH is ETH; governance tickers never enter this mapping. */
export function nativeCmcId(chain:string){return NATIVE_IDS[CHAIN_COINGECKO[chain]]||null}
export function cmcFallbackCoverage(result:{sourceReason?:string|null;sourceState?:string}|null,interval:string){
 const reasons:Record<string,string>={refreshing:'a shared refresh is in progress',insufficient_entitlement:'this endpoint is not enabled for the current plan',budget_exceeded:'the shared credit allowance has been reached',feature_budget_exceeded:'the history credit allowance has been reached',rate_limited:'the shared request rate is temporarily limited',provider_unavailable:'the provider did not respond',credential_unavailable:'provider credentials are unavailable',account_unavailable:'provider account verification is temporarily unavailable',provider_paused:'provider refresh is paused',malformed_response:'the provider returned an unreadable response',response_too_large:'the response exceeded the allowed size',cache_unavailable:'the shared cache could not be updated',refresh_required:'a refresh is required'}
 const reason=result?.sourceReason||result?.sourceState
 return `CMC ${interval} candles are unavailable: ${reason&&reasons[reason]?reasons[reason]:result?'no complete periods were returned':'this asset has no verified CMC identity'}. Showing CoinGecko observations at their original spacing; volume is unavailable.`
}
/** `lookback` is extra completed periods BEFORE the window, the warm-up a study
 * needs to have a value at the first visible bar. OHLCV pages COST CREDITS (one
 * per 100 daily points), so the warm-up is bounded to 1000 periods by the caller
 * and is only asked for when a study on the chart actually needs it; the
 * `available` cap below still bounds what one read may request either way. */
export function cmcChartPlan(id:string,range='1M',interval='auto',now=Date.now(),lookback=0){
 // A sub-hour interval is a valid APP interval but not a valid OHLCV sampling:
 // the provider has no period shorter than one hour, so it is refused here
 // rather than silently answered with hourly bars under a one-minute label.
 if(!/^[1-9][0-9]{0,9}$/.test(id)||!CHART_WINDOWS[range]||(interval!=='auto'&&!CMC_OHLCV_INTERVALS.includes(interval))||!Number.isFinite(now))throw new Error('invalid_chart_parameters')
 const duration=CHART_WINDOWS[range],selected=interval==='auto'?(duration<=7*DAY?'1H':'1D'):interval
 const step=CHART_INTERVALS[selected],base=step<DAY?HOUR:DAY
 const granted=Number.isFinite(Number(lookback))?Math.max(0,Math.trunc(Number(lookback))):0
 // The requested span is the window plus its warm-up; both are read at the same spacing.
 const span=duration+granted*step
 // Startup intraday history is one month. Keep older requested periods as visible gaps.
 const available=Math.min(span,base===HOUR?30*DAY:365*DAY)
 // Shared parameters change at a UTC boundary, after the documented publication delay.
 const end=Math.floor((now-10*60000)/base)*base,start=end-Math.ceil(available/base)*base
 const pages:Record<string,unknown>[]=[]
 for(let until=end;until>start;){const first=Math.max(start,until-240*base),count=(until-first)/base
  pages.push({id,time_period:base===HOUR?'hourly':'daily',interval:base===HOUR?'hourly':'daily',time_start:new Date(first-1).toISOString(),time_end:new Date(until-1).toISOString(),count:count+1});until=first}
 return {pages,base,step,selected,from:now-span,to:now,limited:available<span,lookback:granted}
}
/** Aggregate only complete UTC buckets of genuine, contiguous OHLC bars. Never decimate hourly bars into fake 4h candles. */
export function aggregateOhlcv(input:Bar[],base:number,step:number,now:number){
 if(!Number.isSafeInteger(base)||base<=0||!Number.isSafeInteger(step)||step<base||step%base)throw new Error('invalid_bar_interval')
 const offset=step===7*DAY?4*DAY:0 // Monday 00:00 UTC
 const groups=new Map<number,Bar[]>()
 for(const bar of input){const bucket=Math.floor((bar.t-offset)/step)*step+offset;groups.set(bucket,[...(groups.get(bucket)||[]),bar])}
 const bars:Bar[]=[];let incomplete=0
 for(const [t,rows] of groups){rows.sort((a,b)=>a.t-b.t)
  if(t+step>now||rows.length!==step/base||rows.some((r,i)=>r.t!==t+i*base||r.closedAt!==r.t+base-1||r.o==null||r.h==null||r.l==null)){incomplete++;continue}
  const snapshot=rows.some(r=>r.volumeKind==='snapshot')
  bars.push({t,o:rows[0].o,h:Math.max(...rows.map(r=>r.h!)),l:Math.min(...rows.map(r=>r.l!)),c:rows.at(-1)!.c,v:snapshot?rows.at(-1)!.v:rows.every(r=>r.v!=null)?rows.reduce((s,r)=>s+r.v!,0):null,closedAt:t+step-1,
   ...(snapshot?{volumeKind:'snapshot' as const}:rows.every(r=>r.volumeKind==='period')?{volumeKind:'period' as const}:{}),...(rows.every(r=>r.volumeUnit==='USD')?{volumeUnit:'USD' as const}:{}),
   ...(rows.every(r=>r.recordedAt!=null)?{recordedAt:Math.max(...rows.map(r=>r.recordedAt!))}:{})})
 }
 return {bars:bars.sort((a,b)=>a.t-b.t),incomplete}
}
export function cmcOhlcvBars(payload:unknown,id:string,recordedAt:number|null,base:number){
 const raw=cmcRows('ohlcv',payload).rows.filter(r=>String(r.id)===id).flatMap(r=>Array.isArray(r.quotes)?r.quotes:[])
 const bars=raw.flatMap(point=>{const t=Date.parse(point.time_open),closedAt=Date.parse(point.time_close),q=cmcUsdQuote(point)
  if(!Number.isFinite(t)||closedAt!==t+base-1||t%base!==0)return []
  // Live hourly responses repeat overlapping adjusted-volume observations. Their
  // final hourly value matches the daily volume; summing hours overstates flow.
  return [{t,closedAt,o:q.open,h:q.high,l:q.low,c:q.close,v:q.volume,volumeKind:base===HOUR?'snapshot':'period',volumeUnit:'USD',...(recordedAt!=null?{recordedAt}:{})}]})
 return normalizeBars(bars).bars.filter(b=>b.o!=null)
}
export async function loadCmcChart(admin:any,id:string,range='1M',interval='auto',now=Date.now(),request=requestCmc,context:MarketAssetsContext={},lookback=0){
 const plan=cmcChartPlan(id,range,interval,now,lookback),all:Bar[]=[],states:string[]=[],reasons:string[]=[],provenance:any[]=[]
 const ctx={...context,supabase:admin,kind:'request' as const,caller:'canonical-ohlcv-chart',maxCalls:4}
 for(const params of plan.pages){
  const result=await request('ohlcv',params,ctx)
  states.push(result.state);if(result.reason)reasons.push(result.reason);provenance.push(result.provenance)
  const recorded=Date.parse(result.provenance?.fetchedAt||'')
  all.push(...cmcOhlcvBars(result.payload,id,Number.isFinite(recorded)?recorded:null,plan.base))
  if(!result.payload)break // no repeated requests after denial, exhausted budget or outage
 }
 const aggregate=aggregateOhlcv(normalizeBars(all).bars,plan.base,plan.step,now)
 const candles=aggregate.bars.filter(b=>b.t>=plan.from&&b.closedAt!<=plan.to)
 const coverage=[`${plan.selected} completed OHLCV candles; UTC periods.`,plan.base===HOUR?'CMC adjusted volume is a snapshot in USD; grouped candles use the final reading, not a sum of hours.':'CMC adjusted volume is in USD for each completed period.',plan.limited?(plan.base===HOUR?'Startup intraday coverage is limited to the most recent 30 days.':'One OHLCV read reaches back 365 days; older periods come from the stored daily archive, not from this request.'):null,aggregate.incomplete?`${aggregate.incomplete} incomplete candle periods omitted.`:null,reasons.length?`Some history is unavailable (${[...new Set(reasons)].join(', ')}).`:null].filter(Boolean).join(' ')
 return {candles,source:'coinmarketcap',timestampMeaning:'open',barIntervalMs:plan.step,volumeUnit:'USD',coverage,sourceState:states.every(s=>cmcUsable(s))?'fresh':candles.length?'stale':states[0]||'unavailable',sourceReason:reasons[0]||null,provenance,bestPair:null,bestProvider:candles.length?'coinmarketcap':null}
}
