import assert from 'node:assert/strict'
import {receiptFreshness,fromCmcReceipt,storedReceipt,captureRunReceipts,captureProof,readCaptureReceipts,CAPTURE_RECEIPT_LANES} from './source-receipt.ts'
import {curatedEnvelope,figureEnvelope,ageFreshness,sourceFigureScope,SOURCE_SCOPE_KEYS} from './market-figure-scope.ts'
import {screenProvenance,quoteProvenance,chartProvenance,venueProvenance,tokenChartProvenance,curatedNewsWithEnvelopes} from './market-provenance.ts'
import {withCuratedEnvelope,dashboardFigureProvenance} from './dashboard-reads.ts'

const NOW=Date.parse('2026-09-16T20:00:00.000Z')
const ago=(s:number)=>new Date(NOW-s*1000).toISOString()
const cmc=(over:Record<string,unknown>={})=>({capability:'quotes',endpoint:'/v3/cryptocurrency/quotes/latest',parameters:{id:'1'},httpStatus:200,creditCount:null,elapsedMs:null,
 origin:'cache',keyMode:'keyed',cacheAgeSeconds:30,ttlSeconds:60,staleUntil:ago(-600),fetchedAt:ago(30),reservation:null,...over})

Deno.test('a transport receipt states fresh, cached, stale and unavailable from its own fields',()=>{
 assert.equal(receiptFreshness(cmc({origin:'live',cacheAgeSeconds:0}),NOW),'fresh')
 assert.equal(receiptFreshness(cmc(),NOW),'cached')
 assert.equal(receiptFreshness(cmc({cacheAgeSeconds:90}),NOW),'stale')
 assert.equal(receiptFreshness(cmc({origin:'negative-cache'}),NOW),'unavailable')
 // A refused live call has a status but no retrieved figure.
 assert.equal(receiptFreshness(cmc({origin:'live',httpStatus:403,fetchedAt:null}),NOW),'unavailable')
 assert.equal(receiptFreshness(null,NOW),'unavailable')
 const converted=fromCmcReceipt(cmc(),NOW)!
 assert.equal(converted.provider,'coinmarketcap');assert.equal(converted.freshness,'cached');assert.equal(converted.keyMode,'keyed')
})

Deno.test('a stored receipt measures age against the cadence with grace, and a reported outage wins',()=>{
 const inside=storedReceipt({provider:'coinmarketcap',capability:'regime',origin:'capture',fetchedAt:ago(5000),refreshSeconds:3600},NOW)
 assert.equal(inside.freshness,'cached');assert.equal(inside.cacheAgeSeconds,5000);assert.equal(inside.cadenceSeconds,3600);assert.equal(inside.ttlSeconds,null)
 assert.equal(storedReceipt({provider:'x',capability:'y',fetchedAt:ago(6000),refreshSeconds:3600},NOW).freshness,'stale')
 assert.equal(storedReceipt({provider:'x',capability:'y',fetchedAt:ago(5),refreshSeconds:3600,state:'unavailable'},NOW).freshness,'unavailable')
 assert.equal(storedReceipt({provider:'x',capability:'y',fetchedAt:null,refreshSeconds:3600},NOW).freshness,'unavailable')
 assert.equal(storedReceipt({provider:'birdeye',capability:'ohlcv',origin:'live',fetchedAt:ago(1)},NOW).freshness,'fresh')
})

Deno.test('a capture run collapses to one receipt per endpoint with summed reported credits only',()=>{
 const spec=CAPTURE_RECEIPT_LANES.regime
 const logs=[
  {caller:'intel-capture-regime',endpoint:'/v3/fear-and-greed/latest',cache_status:'live',status_code:200,credits_or_cu:1,ts:ago(3000)},
  {caller:'intel-capture-regime',endpoint:'/v1/global-metrics/quotes/latest',cache_status:'hit',status_code:null,credits_or_cu:null,ts:ago(3001)},
  // The previous hour's run is outside the run window and must not be summed in.
  {caller:'intel-capture-regime',endpoint:'/v3/fear-and-greed/latest',cache_status:'live',status_code:200,credits_or_cu:1,ts:ago(6600)},
  // A caller outside the lane is never read into it.
  {caller:'intel-markets-identity',endpoint:'/v3/cryptocurrency/quotes/latest',cache_status:'live',status_code:200,credits_or_cu:1,ts:ago(10)},
 ]
 const receipts=captureRunReceipts('regime',spec,logs,ago(3420),3600,NOW)
 assert.equal(receipts.length,2)
 const fg=receipts.find(r=>r.endpoint==='/v3/fear-and-greed/latest')!,gm=receipts.find(r=>r.endpoint==='/v1/global-metrics/quotes/latest')!
 assert.equal(fg.creditCount,1);assert.equal(fg.callCount,1);assert.equal(fg.captureCall,'live');assert.equal(fg.origin,'capture');assert.equal(fg.httpStatus,200)
 assert.equal(gm.creditCount,null);assert.equal(gm.captureCall,'cache')
 assert.equal(fg.capturedAt,ago(3420));assert.equal(fg.freshness,'cached')
 for(const r of receipts)for(const key of ['request_id','org_id','user_id','error_message'])assert.ok(!(key in r))
})

Deno.test('a capture receipt carries the proof its own call kept, dated against the run it describes',()=>{
 const spec=CAPTURE_RECEIPT_LANES.rwa
 const logs=[{caller:'intel-capture-rwa',endpoint:'/v5/real-world-assets/assets/list',cache_status:'live',status_code:200,credits_or_cu:1,ts:ago(600)}]
 const row={caller:'intel-capture-rwa',endpoint:'/v5/real-world-assets/assets/list',request:{capability:'rwaList',endpoint:'/v5/real-world-assets/assets/list',parameters:{limit:'250',start:'1',asset_type:1}},
  http_status:200,credit_count:1,error_code:'0',responded_at:ago(601),retrieved_at:ago(600),excerpt:{status:{credit_count:1},data:{rwa_assets:[]},lists:[],shortened:0,trimmed:false,dataOmitted:false},excerpt_missing:null}
 const [receipt]=captureRunReceipts('rwa',spec,logs,ago(590),3600,NOW,[row])
 assert.equal(receipt.proof?.source,'capture-record');assert.equal(receipt.proof?.inRun,true)
 assert.equal(receipt.proof?.creditCount,1);assert.equal(receipt.proof?.httpStatus,200)
 // Only string parameters survive: a recorded request is data, never trusted shape.
 assert.deepEqual(receipt.proof?.request,{capability:'rwaList',endpoint:'/v5/real-world-assets/assets/list',parameters:{limit:'250',start:'1'}})
 // A proof kept from an earlier run is still shown, and says it is not this run's.
 const [older]=captureRunReceipts('rwa',spec,logs,ago(590),3600,NOW,[{...row,retrieved_at:ago(90000)}])
 assert.equal(older.proof?.inRun,false)
 // Another caller's or endpoint's proof never attaches, and none is none.
 assert.equal(captureRunReceipts('rwa',spec,logs,ago(590),3600,NOW,[{...row,caller:'intel-capture-rwa-depth'}])[0].proof,null)
 assert.equal(captureRunReceipts('rwa',spec,logs,ago(590),3600,NOW)[0].proof,null)
 // The receipt's parameters are the ones this run's call sent (its recorded
 // request), never an empty set beside a command that carries them. An earlier
 // run's request does not stand in for this run's.
 assert.deepEqual(receipt.parameters,{limit:'250',start:'1'})
 assert.deepEqual(older.parameters,{})
 assert.deepEqual(captureRunReceipts('rwa',spec,logs,ago(590),3600,NOW)[0].parameters,{})
 const missing=captureProof({...row,excerpt:null,excerpt_missing:'failure_body_not_kept'},ago(600))
 assert.equal(missing?.excerpt,null);assert.equal(missing?.excerptMissing,'failure_body_not_kept')
 assert.equal(captureProof({...row,excerpt:null,excerpt_missing:'anything else'},ago(600))?.excerptMissing,'not_recorded')
})

Deno.test('the capture receipts view reads only named lanes and only safe call-log columns',async()=>{
 const calls:any[]=[]
 const db={from:(table:string)=>{const call:any={table,ops:[]};calls.push(call);const q:any=new Proxy({then:(yes:any)=>Promise.resolve({data:table==='provider_call_logs'?[{caller:'intel-capture-airdrops',endpoint:'/v1/cryptocurrency/airdrops',cache_status:'live',status_code:200,credits_or_cu:1,ts:ago(3600)}]:table==='provider_schedule_policy'?[{provider:'coinmarketcap',feature:'airdrops',cadence_seconds:86400}]:[{last_seen_at:ago(3500)}],error:null}).then(yes)},{get:(t:any,p:string)=>p==='then'?t.then:(...a:any[])=>{call.ops.push([p,...a]);return q}});return q}}
 const result:any=await readCaptureReceipts(db,{lanes:['airdrops','not_a_lane']},NOW)
 assert.equal(result.lanes.length,1);assert.equal(result.reason,'unsupported_lane')
 assert.equal(result.lanes[0].receipts[0].creditCount,1);assert.equal(result.lanes[0].freshness,'cached');assert.equal(result.lanes[0].cadenceSeconds,86400)
 const log=calls.find(c=>c.table==='provider_call_logs')
 assert.deepEqual(log.ops.find((o:any[])=>o[0]==='select')[1],'caller,endpoint,cache_status,status_code,credits_or_cu,ts')
 assert.deepEqual(log.ops.find((o:any[])=>o[0]==='in'),['in','caller',['intel-capture-airdrops']])
 assert.ok(log.ops.some((o:any[])=>o[0]==='limit'))
 // The capture's own kept proof is read by caller, and only its proof columns.
 const proofs=calls.find(c=>c.table==='intel_cmc_call_proofs')
 assert.deepEqual(proofs.ops.find((o:any[])=>o[0]==='select')[1],'caller,endpoint,request,http_status,credit_count,error_code,responded_at,retrieved_at,excerpt,excerpt_missing')
 assert.deepEqual(proofs.ops.find((o:any[])=>o[0]==='in'),['in','caller',['intel-capture-airdrops']])
 assert.ok(!calls.some(c=>!['provider_call_logs','provider_schedule_policy','intel_airdrop_snapshots','intel_cmc_call_proofs'].includes(c.table)))
 const empty:any=await readCaptureReceipts(db,{lanes:[]},NOW)
 assert.equal(empty.reason,'no_lane_selected')
})

Deno.test('curated content past its window is a different kind, and its summary leaves analysis',()=>{
 assert.equal(curatedEnvelope('intel_curated_news',ago(60),ago(-60),'news_curated',NOW).kind,'curated')
 assert.equal(curatedEnvelope('intel_curated_news',ago(60),ago(1),'news_curated',NOW).kind,'curated_stale')
 assert.equal(curatedEnvelope('intel_curated_news',ago(60),null,'news_curated',NOW).kind,'curated_stale')
 const card={title:'t',analysis:{what_happened:'x'}}
 const current=withCuratedEnvelope(card,{updated_at:ago(60),stale_after:ago(-60)},NOW) as any
 assert.equal(current.provenance.kind,'curated');assert.deepEqual(current.analysis,{what_happened:'x'})
 const expired=withCuratedEnvelope(card,{updated_at:ago(60),stale_after:ago(10)},NOW) as any
 assert.equal(expired.provenance.kind,'curated_stale');assert.equal(expired.analysis,null);assert.deepEqual(expired.stale_analysis,{what_happened:'x'})
 assert.equal(expired.provenance.scopeKey,'news_curated')
})

Deno.test('every non-CMC scope key has a sentence and envelopes never invent a clock',()=>{
 for(const key of SOURCE_SCOPE_KEYS){assert.ok(sourceFigureScope(key).length>40);assert.ok(!sourceFigureScope(key).includes('\u2014'))}
 const env=figureEnvelope('stored','birdeye',null,'cached','birdeye_price')
 assert.equal(env.fetchedAt,null);assert.equal(env.scopeKey,'birdeye_price')
 assert.equal(figureEnvelope('stored','coinmarketcap',ago(1),'cached','Plain sentence.').scopeKey,null)
 assert.equal(ageFreshness(null,60,NOW),null);assert.equal(ageFreshness(ago(-3600),60,NOW),null);assert.equal(ageFreshness(ago(30),60,NOW),'cached');assert.equal(ageFreshness(ago(90),60,NOW),'stale')
})

Deno.test('market surfaces carry receipts and envelopes assembled from the response alone',()=>{
 const screen=screenProvenance({rows:[{sourceProvider:'coingecko'},{sourceProvider:'coingecko'},{sourceProvider:'coinmarketcap'}],snapshot:{freshness:'fresh'},lastUpdated:ago(100)},NOW)
 assert.equal(screen.receipt.provider,'coingecko');assert.equal(screen.receipt.origin,'stored');assert.equal(screen.receipt.freshness,'cached')
 assert.ok(screen.figureProvenance.price.scope.length>0);assert.equal(screen.figureProvenance.catalogue.scopeKey,'market_catalogue')
 const quote=quoteProvenance({quoteProvider:'coinmarketcap',asOf:ago(20),provenance:{fetchedAt:ago(20)}},[cmc(),cmc({capability:'metadata',ttlSeconds:86400,cacheAgeSeconds:5000})],NOW)
 assert.equal(quote.receipts.length,2);assert.equal(quote.figureProvenance.price.freshness,'cached')
 const fallback=quoteProvenance({quoteProvider:'coingecko',asOf:ago(60)},[cmc({origin:'negative-cache'})],NOW)
 assert.equal(fallback.receipts[0].provider,'coingecko');assert.equal(fallback.receipts[1].origin,'negative-cache');assert.equal(fallback.figureProvenance.price.freshness,'cached')
 const chart=chartProvenance({bestProvider:'coinmarketcap',candles:[{}],receipts:[cmc({capability:'ohlcv'}),cmc({capability:'ohlcv',cacheAgeSeconds:900})]},NOW)
 assert.equal(chart.envelope.freshness,'stale');assert.equal(chart.envelope.scopeKey,'cmc_ohlcv')
 const venues=venueProvenance({tickers:[{as_of:ago(30)}],orderbookAsOf:ago(900),dex:{fetchedAt:ago(10),staleAfter:ago(-10)}},NOW)
 assert.equal(venues.cex.freshness,'cached');assert.equal(venues.orderbook.freshness,'stale');assert.equal(venues.dex.freshness,'cached')
 const birdeye=tokenChartProvenance({source:'birdeye',candles:[{}],sourceState:'fresh',sourceRefreshed:false,last_refreshed_at:ago(60)},NOW)
 assert.equal(birdeye.receipts[0].origin,'cache');assert.equal(birdeye.receipts[0].keyMode,'keyed');assert.equal(birdeye.receipts[0].freshness,'cached')
 // No clock in the response: no receipt is claimed.
 const gecko=tokenChartProvenance({source:'geckoterminal',candles:[{}],overview:{price:1}},NOW)
 assert.equal(gecko.receipts.length,0);assert.equal(gecko.figureProvenance.chart.freshness,null);assert.equal(gecko.figureProvenance.overview.scopeKey,'dex_pool')
 const snap=tokenChartProvenance({source:'geckoterminal',candles:[{}],sourceSnapshot:{fetchedAt:ago(100),staleAfter:ago(5)}},NOW)
 assert.equal(snap.receipts[0].keyMode,'keyless');assert.equal(snap.figureProvenance.chart.freshness,'stale')
})

Deno.test('dashboard figure groups each name a source, clock, freshness and scope',()=>{
 const p=dashboardFigureProvenance({chainPerf:[{source:'coinmarketcap',as_of:ago(100),stale:false}],movers:[],marketMovers:[{}],exchangeAsOf:[ago(30),ago(700)],news:[{provenance:{kind:'curated',fetchedAt:ago(40)}}],newsSource:'curated',signals:[{generated_at:ago(50),stale_after:ago(-100)}],signalsSource:'signal_store'},NOW)
 assert.equal(p.chain_perf.source,'coinmarketcap');assert.equal(p.chain_perf.freshness,'cached')
 assert.equal(p.movers.freshness,'unavailable');assert.equal(p.market_movers.freshness,'cached');assert.equal(p.market_movers.fetchedAt,ago(30))
 assert.equal(p.news.scopeKey,'news_curated');assert.equal(p.signals.freshness,'cached')
 for(const env of Object.values(p))assert.ok(env.scope&&env.source)
})

Deno.test('an asset page catalyst story past its window keeps its title but not its current summary',()=>{
 const [current,expired,unwindowed]=curatedNewsWithEnvelopes([
  {title:'a',why_it_matters:'now',stale_after:ago(-60),updated_at:ago(60)},
  {title:'b',why_it_matters:'then',summary:'old',stale_after:ago(60),updated_at:ago(600)},
  {title:'c',why_it_matters:'unknown window'},
 ],NOW)
 assert.equal(current.provenance.kind,'curated');assert.equal(current.why_it_matters,'now')
 assert.equal(expired.provenance.kind,'curated_stale');assert.equal(expired.why_it_matters,null);assert.equal(expired.summary,null)
 assert.deepEqual(expired.stale_summary,{summary:'old',why_it_matters:'then',crypto_impact:null,watch_next:null});assert.equal(expired.title,'b')
 assert.equal(unwindowed.provenance.kind,'curated_stale');assert.equal(unwindowed.why_it_matters,null)
})
