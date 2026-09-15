import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {makeChartCaptureProof,verifyChartCapture,chartCapturePolicy,chartProofAsset,chartRetentionDeadline} from './chart-capture-proof.ts'
import {chartSeriesResponse} from './chart-series-contract.ts'
const secret='local-test-only-key-not-a-deployment-secret',now=1789050000000
const series=chartSeriesResponse({source:'coingecko',candles:[{t:now-1000,o:10,h:12,l:9,c:11}]},now)
const make=()=>makeChartCaptureProof('native:bitcoin',series.candles,series.source,secret,now)
Deno.test('a chart capture binds the server series, source, currency and canonical asset',async()=>{const proof=await make(),verified=await verifyChartCapture(proof,series.candles,'bip122:native:BTC',secret,now+100);eq(verified.hash,proof.hash);eq(verified.source.provider,'coingecko')})
Deno.test('client relabeling cannot grant source export permissions',async()=>{const proof=await make();await assertRejects(()=>verifyChartCapture({...proof,source:{...proof.source,provider:'example'}},series.candles,'native:bitcoin',secret,now),Error,'expired_or_invalid');eq(chartCapturePolicy('example',()=> 'true'),{retain:false,export:false})})
Deno.test('changed prices, missing bars, different assets and expired proofs are rejected',async()=>{const proof=await make();await assertRejects(()=>verifyChartCapture(proof,[{...series.candles[0],c:10}],'native:bitcoin',secret,now),Error,'series_changed');await assertRejects(()=>verifyChartCapture(proof,[],'native:bitcoin',secret,now),Error,'series_changed');await assertRejects(()=>verifyChartCapture(proof,series.candles,'native:ethereum',secret,now),Error,'asset_mismatch');await assertRejects(()=>verifyChartCapture(proof,series.candles,'native:bitcoin',secret,now+3600000),Error,'expired_or_invalid')})
Deno.test('policy defaults to references and requires independent explicit retention and export',()=>{eq(chartCapturePolicy('coinmarketcap',()=>undefined),{retain:false,export:false});eq(chartCapturePolicy('coinmarketcap',key=>key==='CMC_ALLOW_EXPORT'?'true':undefined),{retain:false,export:false});eq(chartCapturePolicy('coingecko',key=>key==='INTEL_CHART_COINGECKO_RETENTION'?'true':undefined),{retain:true,export:false})})
Deno.test('a stitched archive source needs every part to permit retention and export',()=>{
 const binance=(key:string)=>['INTEL_CHART_BINANCE_RETENTION','INTEL_CHART_BINANCE_EXPORT'].includes(key)?'true':undefined
 eq(chartCapturePolicy('binance',binance),{retain:true,export:true})
 eq(chartCapturePolicy('binance+coinmarketcap',binance),{retain:false,export:false})
 eq(chartCapturePolicy('binance+coinmarketcap',key=>binance(key)??(key==='CMC_ALLOW_HISTORICAL_RETENTION'?'true':undefined)),{retain:true,export:false})
 eq(chartCapturePolicy('binance+example',()=>'true'),{retain:false,export:false})
 eq(chartCapturePolicy('',()=>'true'),{retain:false,export:false})
 // The CoinMarketCap part keeps CoinMarketCap's retention terms for the whole series.
 const env=(key:string)=>key==='CMC_HISTORY_RETENTION_DAYS'?'3':key==='CMC_SOURCE_POLICY_EXPIRES_AT'?new Date(now+86400000).toISOString():undefined
 eq(chartRetentionDeadline({source:{provider:'binance+coinmarketcap'},createdAt:now},env),now+86400000)
 eq(chartRetentionDeadline({source:{provider:'binance'},createdAt:now},env),now+30*86400000)
})
Deno.test('signing canonicalization never crosses native networks or guesses a ticker',()=>{eq(chartProofAsset('native:arbitrum'),'eip155:42161:native');eq(chartProofAsset('native:ethereum'),'eip155:1:native')})
