import {evidenceAt} from '../../../supabase/functions/_shared/intel/investigation-evidence.ts'
export function dexLiquidityMarkers(observations,subject,at){
 return evidenceAt(observations,at).filter(o=>o.subject===subject&&o.provider==='coinmarketcap'&&['liquidity_event_usd','swap_event_usd'].includes(o.metric)).map(o=>({
  id:o.id,t:Date.parse(o.observedAt),recordedAt:o.recordedAt,canonicalAssetKey:subject,group:'liquidity',type:'liquidity',actorKind:'system',source:'CoinMarketCap',
  action:`${o.metric==='swap_event_usd'?'Public swap':'Pool liquidity'} · ${o.metadata?.eventType||'Unclassified'}`,label:o.metric==='swap_event_usd'?'Public swap':'Pool liquidity',title:'Public pool activity; separate from your portfolio transactions.',transactionRef:o.metadata?.transaction,
  sourceSnapshot:{title:o.metric==='swap_event_usd'?'Reported public swap':'Reported pool liquidity event',source:'CoinMarketCap',url:o.sourceUrl,
   summary:`Reported value: ${o.value??'Unknown'} USD. Base quantity: ${o.metadata?.baseQuantity??'Unknown'} (${o.metadata?.baseAddress??'Unreported'}). Quote quantity: ${o.metadata?.quoteQuantity??'Unknown'} (${o.metadata?.quoteAddress??'Unreported'}). Transaction: ${o.metadata?.transaction??'Unreported'}; log ${o.metadata?.logIndex??'Unreported'}. First recorded: ${o.recordedAt}. ${o.metadata?.excluded?'Provider excludes this record from its aggregates. ':''}This is not an execution price or a personal trade.`},
 }))
}
