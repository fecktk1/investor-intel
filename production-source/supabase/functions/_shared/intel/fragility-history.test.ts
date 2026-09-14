import {assert,assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {fragilityHistory,derivativeVenueObservation,currentFragility} from './fragility-history.ts'
import {normalizeCmcInvestigation} from './investigation-normalize.ts'
import {marketFragility} from './investigation-calculations.ts'
import type {Observation} from './investigation-evidence.ts'
const subject='market:coinmarketcap:1',at=Date.parse('2026-09-10T18:00:00Z'),iso=(t:number)=>new Date(t).toISOString()
function batch(time:number,key:string,values=[100,100],ids=['a','b']):Observation[]{return values.map((value,i)=>({id:`${key}:${i}`,subject,provider:'synthetic',sourceRef:'synthetic:page1',metric:'open_interest',unit:'USD',value,observedAt:iso(time),recordedAt:iso(time+1000),expiresAt:iso(time+300000),universe:`contract:${ids[i]}`,metadata:{contractId:ids[i],venueId:`venue:${ids[i]}`,venue:`Venue ${ids[i]}`,compatibleQuote:true,batchId:key.repeat(64),batchContractCount:values.length,batchHasMore:true}}))}
Deno.test('OI history compares the identical covered set with transparent HHI and percentage-point change',()=>{
 const input=[...batch(at-120000,'a'),...batch(at-60000,'b',[300,100])],r=fragilityHistory(input,subject,at-180000,at)
 eq(r.rows.length,2);eq(r.rows[0].concentrationHhi,0.5);eq(r.rows[1].concentrationHhi,0.625);eq(r.rows[1].largestVenueShareChange,25);eq(r.rows[1].openInterestChangePercent,100);assert(r.rows[1].comparisonReason.includes('not whole-market'))
})
Deno.test('OI history does not compare changed contract sets, partially loaded batches, or query coverage',()=>{
 const first=batch(at-120000,'a'),second=batch(at-60000,'b',[300,100],['a','c'])
 eq(fragilityHistory([...first,...second],subject,at-180000,at).rows[1].largestVenueShareChange,null)
 const partial=fragilityHistory([...first,...batch(at-60000,'b').slice(0,1)],subject,at-180000,at).rows[1]
 eq(partial.complete,false);eq(partial.largestVenueShare,null);eq(partial.totalOpenInterestUsd,null);assert(partial.comparisonReason.includes('incomplete'))
 const newPage=batch(at-60000,'b').map(o=>({...o,sourceRef:'synthetic:page2'}));eq(fragilityHistory([...first,...newPage],subject,at-180000,at).rows[1].largestVenueShareChange,null)
 const newCoverage=batch(at-60000,'b').map(o=>({...o,metadata:{...o.metadata,batchHasMore:false}}));eq(fragilityHistory([...first,...newCoverage],subject,at-180000,at).rows[1].largestVenueShareChange,null)
})
Deno.test('OI history never leaks later recordings, reuses earliest duplicate clocks and rejects stale batches',()=>{
 const first=batch(at-120000,'a'),late=batch(at-60000,'b').map(o=>({...o,recordedAt:iso(at+1)}))
 eq(fragilityHistory([...first,...late],subject,at-180000,at).rows.length,1)
 const duplicate=first.map(o=>({...o,recordedAt:iso(at-1000)}));eq(fragilityHistory([...first,...duplicate],subject,at-180000,at).rows[0].knownAt,at-119000)
 const stale=batch(at-60000,'b').map(o=>({...o,observedAt:iso(at-700000)}));const r=fragilityHistory(stale,subject,at-800000,at).rows[0];eq(r.largestVenueShare,null);eq(r.result.excluded.length,2)
})
Deno.test('legacy membership and unknown currencies never produce historical concentration or false USD',()=>{
 const old=batch(at-60000,'a').map(o=>({...o,metadata:{...o.metadata,batchId:undefined}}));eq(fragilityHistory(old,subject,at-180000,at).rows.length,0);eq(fragilityHistory(old,subject,at-180000,at).legacyObservations,2)
 const other=batch(at-60000,'b').map(o=>({...o,unit:'BTC'}));const r=fragilityHistory(other,subject,at-180000,at).rows[0];eq(r.totalOpenInterestUsd,null)
 eq(marketFragility(other.map(derivativeVenueObservation),subject,at).coveredContracts,0)
 eq(marketFragility([{...derivativeVenueObservation(other[0]),venueId:''}],subject,at).excluded[0].reason,'Missing venue or contract identity')
})
Deno.test('concentration views bound plotted snapshots and expose omitted history',()=>{
 const many=Array.from({length:130},(_,i)=>batch(at-260000+i*1000,'a').map(o=>({...o,id:`${i}:${o.id}`,metadata:{...o.metadata,batchId:i.toString(16).padStart(64,'0')}}))).flat()
 const r=fragilityHistory(many,subject,at-300000,at);eq(r.totalSnapshots,130);eq(r.rows.length,120);eq(r.omittedSnapshots,10)
})
const quote=(id:number,time:string,oi:number,funding=0.01)=>({market_id:id,market_pair_base:{crypto_id:1},exchange:{exchange_id:id,name:`Venue ${id}`},quotes:[{convert_id:2781,convert_symbol:'USD',last_updated:time,open_interest:oi}],exchange_reported_quotes:[{convert_id:2781,convert_symbol:'USD',funding_rate:funding,funding_interval_seconds:28800}]})
const normalize=(rows:any[],fetched=at)=>normalizeCmcInvestigation('derivativePairs',{data:{crypto_id:1,market_pairs:rows,has_more:true}},{crypto_id:'1',start:'1',limit:'50'},iso(fetched),iso(fetched+300000),iso(fetched+3600000))
Deno.test('CMC response fingerprints keep unchanged contracts in changed batches and ignore fetch-only refreshes and order',async()=>{
 const rows=[quote(1,iso(at-1000),100),quote(2,iso(at-1000),100)],first=await normalize(rows),again=await normalize([...rows].reverse(),at+1000)
 eq(first.observations.map(o=>o.id).sort(),again.observations.map(o=>o.id).sort());assert(first.observations.every(o=>o.metadata?.batchContractCount===2));eq(new Set(first.observations.map(o=>o.metadata?.batchId)).size,1)
 const changed=await normalize([rows[0],quote(2,iso(at-1000),300)])
 assert(first.observations.every(o=>!changed.observations.some(c=>c.id===o.id)));eq(changed.observations.length,2)
})
Deno.test('funding-only revisions change history IDs and cannot overwrite original source metadata',async()=>{
 const first=await normalize([quote(1,iso(at-1000),100)]),changed=await normalize([quote(1,iso(at-1000),100,0.02)])
 assert(first.observations[0].id!==changed.observations[0].id);eq(first.observations[0].metadata?.fundingRateRaw,0.01);eq(changed.observations[0].metadata?.fundingRateRaw,0.02)
})
Deno.test('live and legacy CMC funding values retain precision without assuming percent units',()=>{
 const source={id:'funding',subject,metric:'open_interest',value:100,unit:'USD',provider:'coinmarketcap',sourceRef:'source',observedAt:iso(at-1000),recordedAt:iso(at-900),expiresAt:iso(at+60000),metadata:{contractId:'c',venueId:'v',venue:'Venue',compatibleQuote:true,fundingRateRaw:-0.00000123,fundingUnit:'unknown',fundingPeriodSeconds:28800}} as any
 const mapped=derivativeVenueObservation(source),funding=marketFragility([mapped],subject,at).venues[0].funding[0]
 eq(funding.rateRaw,-0.00000123);eq(funding.ratePercent,null);eq(funding.comparable,false)
 const legacy=derivativeVenueObservation({...source,metadata:{...source.metadata,fundingRateRaw:undefined,fundingRatePercent:0.00004289}})
 eq(legacy.fundingUnit,'unknown');eq(marketFragility([legacy],subject,at).venues[0].funding[0].rateRaw,0.00004289)
})

Deno.test('current concentration never resurrects removed contracts or falls back from an incomplete newer batch',()=>{
 const old=batch(at-120000,'a',[100,100],['a','b']),recent=batch(at-60000,'b',[200,50],['a','c'])
 const current=currentFragility([...old,...recent],subject,at);eq(current.suppliedContracts,2);eq(current.coveredContracts,2);eq(current.totalOpenInterestUsd,250);eq(current.venues.map(v=>v.id).sort(),['venue:a','venue:c'])
 const incomplete=currentFragility([...old,...recent.slice(0,1)],subject,at);eq(incomplete.batchComplete,false);eq(incomplete.venues.length,0);eq(incomplete.totalOpenInterestUsd,null);eq(incomplete.expectedContracts,2)
 const future=recent.map(o=>({...o,recordedAt:iso(at+1)}));eq(currentFragility([...old,...future],subject,at).totalOpenInterestUsd,200)
 eq(currentFragility([...old,...recent],subject,at+600000).coveredContracts,0)
})

Deno.test('equivalent normalization versions preserve the original batch without double-counting contracts',()=>{
 const original=batch(at-120000,'a').map(o=>({...o,provider:'coinmarketcap',metadata:{...o.metadata,fundingRatePercent:0.00004289}}))
 const revised=original.map(o=>({...o,id:o.id+'-new',recordedAt:iso(at-60000),metadata:{...o.metadata,fundingRatePercent:undefined,fundingRateRaw:0.00004289,fundingUnit:'unknown'}}))
 const r=fragilityHistory([...original,...revised],subject,at-180000,at).rows[0];eq(r.complete,true);eq(r.receivedContracts,2);eq(r.totalOpenInterestUsd,200);eq(r.knownAt,at-119000);assert(r.observations.every(o=>!o.id.endsWith('-new')))
 const conflict=revised.map(o=>({...o,value:999}));eq(fragilityHistory([...original,...conflict],subject,at-180000,at).rows[0].complete,false)
})
