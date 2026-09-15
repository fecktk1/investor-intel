import {evidenceAt} from '../../../supabase/functions/_shared/intel/investigation-evidence.ts'
export function dexLiquidityMarkers(observations,subject,at){
 return evidenceAt(observations,at).filter(o=>o.subject===subject&&o.provider==='coinmarketcap'&&['liquidity_event_usd','swap_event_usd'].includes(o.metric)).map(o=>({
  id:o.id,t:Date.parse(o.observedAt),recordedAt:o.recordedAt,canonicalAssetKey:subject,group:'liquidity',type:'liquidity',actorKind:'system',source:'CoinMarketCap',
  action:`${o.metric==='swap_event_usd'?'Public swap':'Pool liquidity'} · ${o.metadata?.eventType||'Unclassified'}`,label:o.metric==='swap_event_usd'?'Public swap':'Pool liquidity',title:'Public pool activity; separate from your portfolio transactions.',transactionRef:o.metadata?.transaction,
  sourceSnapshot:{title:o.metric==='swap_event_usd'?'Reported public swap':'Reported pool liquidity event',source:'CoinMarketCap',url:o.sourceUrl,
   summary:`Reported value: ${o.value??'Unknown'} USD. Base quantity: ${o.metadata?.baseQuantity??'Unknown'} (${o.metadata?.baseAddress??'Unreported'}). Quote quantity: ${o.metadata?.quoteQuantity??'Unknown'} (${o.metadata?.quoteAddress??'Unreported'}). Transaction: ${o.metadata?.transaction??'Unreported'}; log ${o.metadata?.logIndex??'Unreported'}. First recorded: ${o.recordedAt}. ${o.metadata?.excluded?'Provider excludes this record from its aggregates. ':''}This is not an execution price or a personal trade.`},
 }))
}

// ── Streamed rows (CMC plan Stage 4, proposal 28) ────────────────────────────
// `operation:'tape'` answers rows, not stored observations: `{kind, metric,
// value, unit, observedAt, metadata}`. The lease already named the contract, so
// no subject, no row id and no `recordedAt` come back, and `evidenceAt` needs
// all three — plus a `universe`, which is what keeps one swap from collapsing
// into another (observationKey has no transaction in it). Every one of them is
// restated here FROM THE STREAM, never invented: the id and the universe are the
// transaction and log index the provider itself deduplicates on, and the record
// time is the observation time because a streamed event is recorded as it is
// observed. The metadata is already `cmc-dex-evidence.ts`'s key set, so one
// mapper draws a streamed and a retrieved event identically.
export const LIVE_TAPE_SOURCE_URL='https://coinmarketcap.com/api/documentation/pro-api-websocket/overview'
const LIVE_TAPE_KINDS={swap_event_usd:'live_swap',liquidity_event_usd:'live_liquidity'}
const part=value=>value==null||value===''?'unreported':String(value)
export function streamedDexObservations(events,subject){
 return (Array.isArray(events)?events:[]).filter(e=>e&&Object.hasOwn(LIVE_TAPE_KINDS,e.metric)&&Number.isFinite(Date.parse(e.observedAt))).map(e=>{
  const m=e.metadata||{},event=`event:${part(m.transaction)}:${part(m.logIndex)}`
  return {id:`live:${e.metric}:${part(m.transaction)}:${part(m.logIndex)}:${e.observedAt}`,subject,provider:'coinmarketcap',
   metric:e.metric,value:e.value??null,unit:e.unit??'USD',observedAt:e.observedAt,recordedAt:e.observedAt,
   // The same universe shape the retained REST rows carry (investigation-normalize.ts).
   universe:`cmc:dex:${part(m.chain)}:${part(m.contract)}:${event}`,periodSeconds:null,
   sourceRef:'coinmarketcap:onchain@stream',sourceUrl:LIVE_TAPE_SOURCE_URL,metadata:m}
 })
}
/** The live lane: the exact marker shape `dexLiquidityMarkers` produces, with a
 * distinct kind and its own chart layer so a streamed mark is never read as
 * retained history — and never merged into the retained liquidity layer. */
export function liveTapeMarkers(events,subject,at=Date.now()){
 const rows=streamedDexObservations(events,subject),kinds=new Map(rows.map(o=>[o.id,LIVE_TAPE_KINDS[o.metric]]))
 return dexLiquidityMarkers(rows,subject,at)
  .map(marker=>({...marker,kind:kinds.get(marker.id)??null,group:'live_tape',type:'live_tape',
   label:`Live ${String(marker.label).toLowerCase()}`,action:`Live · ${marker.action}`}))
}
