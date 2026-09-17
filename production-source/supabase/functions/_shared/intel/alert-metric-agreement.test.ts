import assert from 'node:assert/strict'
import {AGREEMENT_METRICS,agreementReason,metricAgreement,metricAgreementReceipt,notAMarketMoveReceipt} from './metric-agreement.ts'
import {marketCapChangeInput,readMetricAgreement} from './metric-agreement-read.ts'

const NOW=Date.parse('2026-09-16T12:00:00Z')
const AT=new Date(NOW-60_000).toISOString()
const change=(changePct:number,observedAt=AT,periodSeconds=86400)=>({changePct,observedAt,periodSeconds})

Deno.test('price, market capitalisation and volume all rising is the only shape that counts as corroborated',()=>{
 const result=metricAgreement({price:change(4),market_cap:change(3.6),volume:change(22)},NOW)
 assert.equal(result.agreement,'corroborated')
 assert.equal(result.researchLead,false)
 assert.equal(result.usable,3)
 assert.equal(result.periodSeconds,86400)
})

Deno.test('two metrics agreeing and one disagreeing is not corroborated, it is conflicting',()=>{
 const result=metricAgreement({price:change(4),market_cap:change(3.6),volume:change(-18)},NOW)
 assert.equal(result.agreement,'conflicting')
 assert.equal(result.researchLead,true)
 // The contradiction is named rather than softened into "not enough evidence".
 assert.equal(result.usable,3)
})

Deno.test('two metrics agreeing with the third never measured is a research lead, not a corroborated move',()=>{
 const result=metricAgreement({price:change(4),volume:change(22),market_cap:{unavailable:'market_cap_undated_by_source'}},NOW)
 assert.equal(result.agreement,'incomplete')
 assert.equal(result.researchLead,true)
 assert.equal(result.usable,2)
 assert.ok(result.reasons.includes('market_cap_undated_by_source'))
})

Deno.test('a missing dated market capitalisation degrades to a stated reason rather than an assumed agreement',()=>{
 for(const reason of ['market_cap_undated_by_source','market_cap_single_observation','metric_level_only']){
  const result=metricAgreement({price:change(5),volume:change(9),market_cap:{unavailable:reason}},NOW)
  assert.equal(result.agreement,'incomplete')
  assert.ok(result.reasons.includes(reason))
  assert.ok(agreementReason(reason),'every reason this module records has plain English')
  const cap=result.readings.find(r=>r.metric==='market_cap')!
  assert.equal(cap.usable,false)
  assert.equal(cap.direction,null,'an unmeasured metric never receives a direction')
 }
})

Deno.test('a market capitalisation level supplied without its own clock cannot join the agreement',()=>{
 const result=metricAgreement({price:change(5),volume:change(9),market_cap:{changePct:3}},NOW)
 assert.equal(result.agreement,'incomplete')
 assert.ok(result.reasons.includes('metric_undated'))
})

Deno.test('metrics covering different windows are two questions and never corroborate each other',()=>{
 const result=metricAgreement({price:change(5),volume:change(9),market_cap:change(4,AT,604800)},NOW)
 assert.equal(result.agreement,'incomplete')
 assert.ok(result.reasons.includes('metric_window_mismatch'))
 assert.equal(result.periodSeconds,86400,'the window under test is the one most readings describe')
})

Deno.test('observations taken hours apart are not evidence about one window',()=>{
 const stale=new Date(NOW-6*3600_000).toISOString()
 const result=metricAgreement({price:change(5),volume:change(9),market_cap:change(4,stale)},NOW)
 assert.equal(result.agreement,'unmeasured')
 assert.ok(result.reasons.includes('metric_clock_spread'))
})

Deno.test('a valid zero stays a zero: a flat window corroborates flatness and a lone flat metric does not conflict',()=>{
 const flat=metricAgreement({price:change(0),market_cap:change(0),volume:change(0)},NOW)
 assert.equal(flat.agreement,'corroborated','three measured zeros are a measured flat window')
 const partly=metricAgreement({price:change(4),market_cap:change(0),volume:change(11)},NOW)
 assert.equal(partly.agreement,'incomplete','a metric that did not move neither supports nor contradicts')
 assert.notEqual(partly.agreement,'conflicting')
 assert.equal(partly.readings.find(r=>r.metric==='market_cap')!.reason,'metric_flat')
})

Deno.test('nothing measured at all is reported as unmeasured rather than as a quiet market',()=>{
 const result=metricAgreement({},NOW)
 assert.equal(result.agreement,'unmeasured')
 assert.equal(result.usable,0)
 assert.deepEqual(result.reasons,['metric_not_supplied'])
})

Deno.test('future and expired observations are refused instead of being read as current',()=>{
 const future=metricAgreement({price:change(5,new Date(NOW+60_000).toISOString())},NOW)
 assert.ok(future.reasons.includes('metric_dated_in_future'))
 const old=metricAgreement({price:change(5,new Date(NOW-2*86_400_000).toISOString())},NOW)
 assert.ok(old.reasons.includes('metric_stale'))
})

Deno.test('the receipt carries the verdict, the window and every metric clock',()=>{
 const receipt=metricAgreementReceipt(metricAgreement({price:change(4),market_cap:change(3),volume:change(8)},NOW))
 assert.equal(receipt.metric_agreement,'corroborated')
 assert.equal(receipt.research_lead,false)
 assert.equal(receipt.period_seconds,86400)
 assert.equal(receipt.readings.length,AGREEMENT_METRICS.length)
 for(const reading of receipt.readings)assert.equal(reading.observed_at,AT)
})

Deno.test('an alert about a recorded event says so rather than reporting a failed market test',()=>{
 const receipt=notAMarketMoveReceipt()
 assert.equal(receipt.metric_agreement,'unmeasured')
 assert.equal(receipt.research_lead,true)
 assert.deepEqual(receipt.reasons,['not_a_market_move'])
})

// ── The reader ───────────────────────────────────────────────────────────────

const SUBJECT='market:coinmarketcap:1'
const SOURCE_REF='coinmarketcap:/v2/cryptocurrency/quotes/latest:{"id":"1"}'
const observation=(over:Record<string,unknown>)=>({
 id:String(over.id??Math.random()),subject:SUBJECT,provider:'coinmarketcap',sourceRef:SOURCE_REF,
 observedAt:AT,recordedAt:AT,expiresAt:new Date(NOW+3600_000).toISOString(),
 metric:'price_change',unit:'%',periodSeconds:86400,value:1,...over,
})
// deno-lint-ignore no-explicit-any
const database=(rows:any[])=>{
 // deno-lint-ignore no-explicit-any
 const chain:any={select:()=>chain,eq:()=>chain,in:()=>chain,gte:()=>chain,lte:()=>chain,gt:()=>chain,order:()=>chain,
  limit:()=>Promise.resolve({data:rows.map(observation_=>({observation:observation_})),error:null})}
 return {from:()=>chain}
}

Deno.test('the reader corroborates only when market capitalisation has two dated levels a window apart',async()=>{
 const dayAgo=new Date(NOW-86_400_000).toISOString()
 const corroborated=await readMetricAgreement(database([
  observation({metric:'price_change',value:5}),
  observation({metric:'volume_change',value:31}),
  observation({metric:'market_cap',unit:'USD',periodSeconds:null,value:1_100}),
  observation({metric:'market_cap',unit:'USD',periodSeconds:null,value:1_000,observedAt:dayAgo,recordedAt:dayAgo}),
 ]),SUBJECT,NOW)
 assert.equal(corroborated.agreement,'corroborated')

 const single=await readMetricAgreement(database([
  observation({metric:'price_change',value:5}),
  observation({metric:'volume_change',value:31}),
  observation({metric:'market_cap',unit:'USD',periodSeconds:null,value:1_100}),
 ]),SUBJECT,NOW)
 assert.equal(single.agreement,'incomplete')
 assert.ok(single.reasons.includes('market_cap_single_observation'))
})

Deno.test('a source that cannot date market capitalisation degrades honestly instead of asserting agreement',async()=>{
 // A DEX cohort subject is not a CoinMarketCap listing, and its market
 // capitalisation is undated at source. It must never reach 'corroborated'.
 const result=await readMetricAgreement(database([]),'solana:So11111111111111111111111111111111111111112',NOW)
 assert.equal(result.agreement,'unmeasured')
 assert.equal(result.researchLead,true)
 assert.ok(result.reasons.includes('market_cap_undated_by_source'))
})

Deno.test('a read failure is never reported as a market that did not move',async()=>{
 const broken={from:()=>{throw new Error('boom')}}
 const result=await readMetricAgreement(broken,SUBJECT,NOW)
 assert.equal(result.agreement,'unmeasured')
 assert.equal(result.researchLead,true)
})

Deno.test('a market capitalisation pair outside the window band is not presented as a one-day change',()=>{
 const threeDaysAgo=new Date(NOW-3*86_400_000).toISOString()
 const input=marketCapChangeInput([
  {metric:'market_cap',unit:'USD',value:1_100,observedAt:AT},
  {metric:'market_cap',unit:'USD',value:1_000,observedAt:threeDaysAgo},
 ])
 assert.equal(input.unavailable,'market_cap_single_observation')
})

Deno.test('the market capitalisation pair band is one hour, sized to the measured sampling cadence',()=>{
 const spanning=(hours:number)=>marketCapChangeInput([
  {metric:'market_cap',unit:'USD',value:1_100,observedAt:AT},
  {metric:'market_cap',unit:'USD',value:1_000,observedAt:new Date(Date.parse(AT)-hours*3600_000).toISOString()},
 ])
 // Production samples market capitalisation about every 20 minutes (probed
 // 2026-09-16), so a reading within an hour of the 24-hour mark is always there
 // when the history reaches back a day. Inside the band the change is derived.
 for(const hours of [24,24.75,23.25])assert.equal(typeof spanning(hours).changePct,'number',`${hours}h is inside the band`)
 // Outside it the pair answers a different question. A 22-hour change may not be
 // labelled as the 86,400-second window the price and volume changes describe,
 // so it degrades honestly rather than being stretched to fit.
 for(const hours of [22,26])assert.equal(spanning(hours).unavailable,'market_cap_single_observation',`${hours}h is outside the band`)
})

// A database that applies the filters and the limit the way PostgREST does, so
// a read that is truncated by its own limit fails here as it did in production.
// deno-lint-ignore no-explicit-any
const filteringDatabase=(rows:any[])=>({from:()=>{
 // deno-lint-ignore no-explicit-any
 const filters:((o:any)=>boolean)[]=[]
 // deno-lint-ignore no-explicit-any
 const chain:any={
  select:()=>chain,
  eq:(column:string,value:unknown)=>{if(column==='metric')filters.push(o=>o.metric===value);return chain},
  in:(column:string,values:unknown[])=>{if(column==='metric')filters.push(o=>values.includes(o.metric));return chain},
  gte:(column:string,value:string)=>{if(column==='observed_at')filters.push(o=>Date.parse(o.observedAt)>=Date.parse(value));return chain},
  lte:(column:string,value:string)=>{if(column==='observed_at')filters.push(o=>Date.parse(o.observedAt)<=Date.parse(value));return chain},
  gt:()=>chain,order:()=>chain,
  limit:(n:number)=>Promise.resolve({data:rows.filter(o=>filters.every(f=>f(o))).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)).slice(0,n).map(o=>({observation:o})),error:null}),
 }
 return chain
}})

Deno.test('a heavily quoted asset still finds its day-old market capitalisation baseline',async()=>{
 // Production retains thousands of rows a day for a liquid asset across many
 // metrics. A single newest-first read with a row limit never reached back a
 // day, so the asset could not be corroborated however it moved.
 const rows=[]
 for(let minute=0;minute<25*60;minute+=5){
  const at=new Date(NOW-minute*60_000).toISOString()
  // Production quote rows expire from the cache 60 seconds after recording.
  const expiresAt=new Date(NOW-minute*60_000+60_000).toISOString()
  for(const metric of ['price','volume_24h','tvl','liquidations_1h','liquidations_4h','liquidations_24h'])rows.push(observation({metric,unit:'USD',periodSeconds:null,value:1,observedAt:at,recordedAt:at,expiresAt}))
  for(const periodSeconds of [3600,86400,604800])rows.push(observation({metric:'price_change',periodSeconds,value:2,observedAt:at,recordedAt:at,expiresAt}))
  rows.push(observation({metric:'volume_change',value:12,observedAt:at,recordedAt:at,expiresAt}))
  rows.push(observation({metric:'market_cap',unit:'USD',periodSeconds:null,value:1_000+(25*60-minute),observedAt:at,recordedAt:at,expiresAt}))
 }
 const result=await readMetricAgreement(filteringDatabase(rows),SUBJECT,NOW)
 assert.equal(result.agreement,'corroborated')
 assert.ok(!result.reasons.includes('market_cap_single_observation'))
})

Deno.test('with no retained history a day back the heavily quoted asset still degrades to the stated reason',async()=>{
 const rows=[]
 for(let minute=0;minute<6*60;minute+=5){
  const at=new Date(NOW-minute*60_000).toISOString()
  rows.push(observation({metric:'price_change',value:2,observedAt:at,recordedAt:at}))
  rows.push(observation({metric:'volume_change',value:12,observedAt:at,recordedAt:at}))
  rows.push(observation({metric:'market_cap',unit:'USD',periodSeconds:null,value:1_000,observedAt:at,recordedAt:at}))
 }
 const result=await readMetricAgreement(filteringDatabase(rows),SUBJECT,NOW)
 assert.equal(result.agreement,'incomplete')
 assert.ok(result.reasons.includes('market_cap_single_observation'))
})

Deno.test('a quote whose cache freshness lapsed is still dated evidence for the agreement test',async()=>{
 // The last quote was recorded ten minutes ago and left the display cache after
 // one. Its dated readings are still what the market did, so they still count.
 const at=new Date(NOW-600_000).toISOString(),expiresAt=new Date(NOW-540_000).toISOString()
 const dayAgo=new Date(NOW-600_000-86_400_000).toISOString(),dayAgoExpires=new Date(NOW-540_000-86_400_000).toISOString()
 const result=await readMetricAgreement(filteringDatabase([
  observation({metric:'price_change',value:5,observedAt:at,recordedAt:at,expiresAt}),
  observation({metric:'volume_change',value:31,observedAt:at,recordedAt:at,expiresAt}),
  observation({metric:'market_cap',unit:'USD',periodSeconds:null,value:1_100,observedAt:at,recordedAt:at,expiresAt}),
  observation({metric:'market_cap',unit:'USD',periodSeconds:null,value:1_000,observedAt:dayAgo,recordedAt:dayAgo,expiresAt:dayAgoExpires}),
 ]),SUBJECT,NOW)
 assert.equal(result.agreement,'corroborated')
})
