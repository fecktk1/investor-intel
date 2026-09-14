import { assertEquals as eq, assertRejects, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { coverageMatrix, evidenceAt, evidenceChanges, evidenceFingerprint, makeResearchReceipt, replayDecision, validateReceipt, verifyReceipt, type Observation } from './investigation-evidence.ts'
import { attentionCapital, cohortPerformance, marketFragility, participationQuality, positionLiquidity, liquidityEvents, thesisCounterargument, thesisStress, type VenueObservation } from './investigation-calculations.ts'
import { equitySession, rwaSessionContext } from './investigation-sessions.ts'
const now=Date.parse('2026-09-10T15:00:00Z'), iso=(t:number)=>new Date(t).toISOString(), subject='market:coinmarketcap:1'
const obs=(overrides:Partial<Observation>={}):Observation=>({id:'a',subject,metric:'price',value:100,unit:'USD',provider:'test',sourceRef:'test:quote',observedAt:iso(now-1000),recordedAt:iso(now-900),expiresAt:iso(now+300000),exportAllowed:true,...overrides})
const venue=(overrides:Partial<VenueObservation>={}):VenueObservation=>({id:'contract1',subject,venueId:'1',venue:'Venue one',observedAt:iso(now-1000),expiresAt:iso(now+300000),openInterestUsd:100,quoteCurrency:'USD',compatibleQuote:true,sourceRef:'test:pairs',...overrides})
Deno.test('reported zero OI remains a covered contract while a zero denominator has no concentration share',()=>{const zero=marketFragility([venue({openInterestUsd:0})],subject,now);eq(zero.coveredContracts,1);eq(zero.totalOpenInterestUsd,0);eq(zero.largestVenueShare,null);const mixed=marketFragility([venue({openInterestUsd:0}),venue({id:'second',venueId:'2',openInterestUsd:100})],subject,now);eq(mixed.coveredContracts,2);eq(mixed.venues.find(v=>v.id==='1')?.sharePercent,0)})
Deno.test('decision replay cannot use a future observation or later-recorded correction',()=>{
  const records=[obs(),obs({id:'correction',value:90,recordedAt:iso(now+1)}),obs({id:'future',observedAt:iso(now+2),value:120})]
  eq(evidenceAt(records,now).map(o=>o.value),[100]); eq(evidenceAt(records,now+3).map(o=>o.value),[120])
})
Deno.test('material fingerprint reuses unchanged evidence across fetch clocks but changes with coverage',async()=>{
  eq(await evidenceFingerprint([obs()],now),await evidenceFingerprint([obs({id:'new',observedAt:iso(now-500),recordedAt:iso(now-400)})],now))
  eq(await evidenceFingerprint([obs()],now)===await evidenceFingerprint([obs({universe:'other'})],now),false)
})
for(const [name,overrides,state] of [
  ['stale',{expiresAt:iso(now)},'stale'],['future',{observedAt:iso(now+1)},'missing'],['wrong unit',{unit:'BTC'},'unsupported'],['zero',{value:0},'known'],['missing',{value:null},'missing'],
] as const) Deno.test(`coverage: ${name}`,()=>eq(coverageMatrix([obs(overrides)],[{metric:'price',unit:'USD'}],subject,now)[0].state,state))
Deno.test('coverage reports simultaneous disagreement without averaging providers or different universes',()=>{
  const result=coverageMatrix([obs(),obs({id:'b',provider:'other',value:99})],[{metric:'price'}],subject,now)[0]
  eq(result.state,'contradictory');eq(result.alternatives.length,1)
  eq(coverageMatrix([obs(),obs({id:'b',provider:'other',value:99,universe:'other'})],[{metric:'price'}],subject,now)[0].state,'known')
})
Deno.test('first visit establishes baseline and later deltas preserve original observations',()=>{
  eq(evidenceChanges(null,[obs()],null,now),{baseline:true,changes:[]})
  const changed=obs({id:'b',value:120,observedAt:iso(now),recordedAt:iso(now)})
  const result=evidenceChanges([obs()],[changed],now-1,now)
  eq(result.changes[0].before?.value,100);eq(result.changes[0].after?.value,120);eq(result.changes[0].kind,'changed')
  eq(evidenceChanges([obs()],[obs({value:95})],now-1,now).changes[0].kind,'revised')
})
Deno.test('replay respects sparse prices, actual event timestamps and archived original words',()=>{
  const result=replayDecision([{id:'a',t:now-100,textSnapshot:{notes:'Original words'}},{id:'later',t:now+1}], [{t:now-86400001,price:100}],[],now)
  eq(result.events.length,1);eq(result.selectedEvent?.textSnapshot,{notes:'Original words'});eq(result.priceObservation,null);eq(result.historicalCompleteness,'partial')
})
Deno.test('receipt validates reproducible data and refuses tampered data',async()=>{
  const receipt=await makeResearchReceipt({subject,lens:'coverage',question:'Why?',cursor:now,observations:[obs()]},now)
  eq((await verifyReceipt(receipt)).replay,'complete')
  await assertRejects(()=>verifyReceipt({...receipt,observations:[{...receipt.observations[0],value:999}]}),Error,'integrity')
  await assertRejects(()=>verifyReceipt({...receipt,fingerprint:'0'.repeat(64)}),Error,'fingerprint')
})
Deno.test('receipt respects export prohibition and marks incomplete replay',async()=>{
  const receipt=await makeResearchReceipt({subject,lens:'coverage',question:'Why?',cursor:now,observations:[obs({exportAllowed:false})]},now)
  eq(receipt.observations.length,0);eq(receipt.observationRefs.length,1);eq((await verifyReceipt(receipt)).replay,'references_only')
})
Deno.test('receipt rejects unsafe source links, oversized notes, malformed references and duplicate records',async()=>{
  const receipt=await makeResearchReceipt({subject,lens:'coverage',question:'Why?',cursor:now,observations:[obs({sourceUrl:'javascript:alert(1)'})]},now)
  eq(receipt.observations[0].sourceUrl,null);eq((await verifyReceipt(receipt)).replay,'complete')
  await assertRejects(()=>makeResearchReceipt({subject,lens:'coverage',question:'x'.repeat(8001),cursor:now,observations:[]},now))
  assertThrows(()=>validateReceipt({...receipt,observationRefs:[{}]}))
  await assertRejects(()=>verifyReceipt({...receipt,observations:[...receipt.observations,...receipt.observations]}))
})
Deno.test('fragility groups covered venue OI and never averages funding contracts',()=>{
  const result=marketFragility([venue(),venue({id:'c2',venueId:'2',openInterestUsd:300,fundingRatePercent:0.01}),venue({id:'c3',fundingRatePercent:0.02,fundingPeriodSeconds:28800})],subject,now)
  eq(result.totalOpenInterestUsd,500);eq(result.largestVenueShare,60);eq(result.venues[0].funding[0].comparable,false);eq(result.venues[1].funding.length,2)
})
for(const [name,overrides] of [['identity',{subject:'market:coinmarketcap:2'}],['stale',{expiresAt:iso(now)}],['future',{observedAt:iso(now+1)}],['currency',{quoteCurrency:'USDT'}],['negative',{openInterestUsd:-1}],['flagged',{excluded:true}]] as const)
  Deno.test(`fragility excludes ${name}`,()=>eq(marketFragility([venue(overrides)],subject,now).totalOpenInterestUsd,null))
Deno.test('fragility deduplicates contracts and labels the denominator',()=>{const r=marketFragility([venue(),venue()],subject,now);eq(r.coveredContracts,1);eq(r.excluded[0].reason,'Duplicate contract')})
const attention={subject,name:'Bitcoin',rank:2,rankTime:now,volumeUsd:100,marketCapUsd:1000,quoteTime:now}
Deno.test('attention capital computes comparable changes and turnover by stable identity',()=>{
  const previous={...attention,rank:10,rankTime:now-3600000,quoteTime:now-3600000,volumeUsd:200}
  const result=attentionCapital([attention],[previous])[0]
  eq(result.rankChange,8);eq(result.volumeChangePercent,-50);eq(result.turnover,0.1);eq(result.state,'comparable')
  eq(attentionCapital([attention],[{...previous,subject:'other'}])[0].state,'baseline_needed')
})
Deno.test('attention refuses fabricated ranks and incompatible observation windows',()=>{
  eq(attentionCapital([attention],null)[0].rankChange,null)
  eq(attentionCapital([{...attention,quoteTime:now-7200000}],null)[0].state,'unaligned')
  eq(attentionCapital([attention],[{...attention,rankTime:now+10000}])[0].volumeChangePercent,null)
})
const member={subject,name:'Original member',joinedAt:iso(now-10000),initialPrice:100,initialMarketCapUsd:100,initialObservedAt:iso(now-11000)}
Deno.test('cohort retains unavailable members and does not renormalize surviving returns',()=>{
  const r=cohortPerformance([member,{...member,subject:'missing'}],[{subject,price:120,observedAt:iso(now),available:true}],now)
  eq(r.originalMembers,2);eq(r.comparableMembers,1);eq(r.knownEqualContribution,9.999999999999998);eq(r.completeReturn,false);eq(r.rows[1].returnPercent,null)
})
Deno.test('cohort rejects future membership, hindsight opening quotes and revisions to membership',()=>{
  const quotes=[{subject,price:150,observedAt:iso(now),available:true}]
  eq(cohortPerformance([{...member,joinedAt:iso(now+1)}],quotes,now).originalMembers,0)
  eq(cohortPerformance([{...member,initialObservedAt:iso(now)}],quotes,now).comparableMembers,0)
  eq(cohortPerformance([member,{...member,joinedAt:iso(now),initialPrice:150}],quotes,now).rows[0].initialPrice,100)
})
const rules=[{id:'r',metric:'price',unit:'USD',comparator:'lt',threshold:90,rule_kind:'invalidation'}]
Deno.test('stress rehearsal keeps current observation separate from hypothetical conditions and never mutates inputs',()=>{
  const r=thesisStress(rules,[obs()],subject,{price:80},now)[0]
  eq(r.current,100);eq(r.currentlyMet,false);eq(r.scenarioMet,true);eq(rules[0].threshold,90)
  eq(thesisStress(rules,[obs({unit:'BTC'})],subject,{},now)[0].currentlyMet,null)
})
Deno.test('counterargument challenges explicit invalidation or unmet confirmation and preserves authored prose',()=>{
  const r=thesisCounterargument(rules,[obs({value:80})],subject,now,{opposing:'A precise concern'})
  eq(r.disagreements.length,1);eq(r.authoredQuestions[0].words,'A precise concern');eq(r.changesThesis,false)
  eq(thesisCounterargument(rules,[],subject,now).missing.length,1)
})
const holders={subject,provider:'rpc',observedAt:iso(now-1000),population:'all tracked token accounts',holderCount:100,top1Percent:10,top10Percent:30,uniqueTraders:20,traderPeriodSeconds:86400,sourceRef:'test:holders'}
Deno.test('participation separates concentration percentage points from people and incompatible populations',()=>{
  const before={...holders,observedAt:iso(now-86400000),top10Percent:25,holderCount:90}
  eq(participationQuality(holders,before,now).top10ChangePoints,5);eq(participationQuality(holders,before,now).holderCountChange,10)
  eq(participationQuality(holders,{...before,population:'different'},now).top10ChangePoints,null)
  eq(participationQuality({...holders,top1Percent:50},before,now).inconsistent,true)
  eq(participationQuality({...holders,uniqueTraders:-1},before,now).uniqueTraders,null)
})
Deno.test('liquidity events preserve distinct logs, migrations and boundary times, excluding mirrors',()=>{
  const e={id:'a',subject,pool:'pool',transactionRef:'tx',logIndex:'1',timestamp:now,kind:'add' as const,valueUsd:100,sourceRef:'test:event'}
  const r=liquidityEvents([e,e,{...e,id:'b',kind:'remove',logIndex:'2',valueUsd:40},{...e,id:'c',kind:'migrate',logIndex:'3',valueUsd:999}],subject,now,now)
  eq(r.events.length,3);eq(r.knownNetChangeUsd,60)
  eq(liquidityEvents([e],subject,now+1,now+1000).events.length,0)
})
Deno.test('position liquidity distinguishes TVL from fresh executable depth and explicitly prices fees',()=>{
  eq(positionLiquidity(2,100,10000,null,subject,now).positionToTvlPercent,2)
  const depth={subject,side:'sell' as const,observedAt:iso(now),expiresAt:iso(now+60000),currency:'USD',verifiedQuote:true,feeBps:10,levels:[{price:100,quantity:1},{price:90,quantity:1}],sourceRef:'test:book'}
  const r=positionLiquidity(3,100,10000,depth,subject,now)
  eq(r.execution?.coveredQuantity,2);eq(r.execution?.uncoveredQuantity,1);eq(r.execution?.feeUsd,0.19);eq(r.execution?.complete,false)
  eq(positionLiquidity(2,100,10000,{...depth,subject:'other'},subject,now).execution,null)
  eq(positionLiquidity(2,100,10000,{...depth,feeBps:null},subject,now).execution?.netUsd,null)
})
for(const [date,state,open] of [
  ['2026-03-06T15:00:00Z','scheduled_open','2026-03-06T14:30:00Z'],
  ['2026-03-09T14:00:00Z','scheduled_open','2026-03-09T13:30:00Z'],
  ['2026-11-02T15:00:00Z','scheduled_open','2026-11-02T14:30:00Z'],
  ['2026-09-07T15:00:00Z','scheduled_closed',null],
  ['2026-11-27T18:00:00Z','scheduled_closed',null],
  ['2026-09-12T15:00:00Z','scheduled_closed',null],
] as const) Deno.test(`session calendar ${date}`,()=>{
  const r=equitySession(Date.parse(date),'XNYS');eq(r.state,state);if(open)eq(r.current?.open,Date.parse(open))
})
Deno.test('unknown exchange/year never inherits US equity hours',()=>{eq(equitySession(now,'XLON').state,'unavailable');eq(equitySession(Date.parse('2029-01-02T16:00:00Z'),'XNYS').state,'unavailable')})
Deno.test('RWA comparison requires aligned, identity matched per-token reference independently of redemption terms',()=>{
  const input={subject,issuerId:'i',market:'XNYS',terms:null,token:{price:110,currency:'USD',observedAt:iso(now)},underlying:{price:100,currency:'USD',observedAt:iso(now),sourceUrl:'https://issuer.example/nav',unitsPerToken:1,basis:'nav' as const,subject}}
  const r=rwaSessionContext(input,now);eq(r.comparison?.reference,100);eq(r.redemption.state,'unavailable')
  eq(rwaSessionContext({...input,underlying:{...input.underlying,observedAt:iso(now-3600000)}},now).comparison,null)
  eq(rwaSessionContext({...input,underlying:{...input.underlying,unitsPerToken:null}},now).comparison,null)
  eq(rwaSessionContext({...input,underlying:{...input.underlying,subject:'other'}},now).comparison,null)
})
