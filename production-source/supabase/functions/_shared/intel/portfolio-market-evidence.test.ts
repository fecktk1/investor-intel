import {assertEquals as eq,assert} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {portfolioMarketEvidence} from './portfolio-market-evidence.ts'
import {portfolioResearchFacts,portfolioResearchFingerprint} from './portfolio-research.ts'
Deno.test('portfolio market context is bounded and receives public identities only',async()=>{
 const requests:any[]=[]
 const db={rpc(name:string,args:any){requests.push({name,args});return Promise.resolve({data:[],error:null})},from(table:string){requests.push({table});const q:any={};for(const k of ['select','eq','in','gte','lte','gt','order','ilike'])q[k]=()=>q;q.limit=()=>Promise.resolve({data:[]});q.maybeSingle=()=>Promise.resolve({data:null});return q}}
 const holdings=Array.from({length:14},(_,i)=>({canonicalAssetKey:'eip155:1:0x'+i.toString(16).padStart(40,'0'),symbol:'asset '+i,privateNote:'DO NOT SEND'}))
 const result=await portfolioMarketEvidence(db,holdings,Date.parse('2026-09-12T03:00:00Z'))
 eq(result.rows.length,10);eq(result.coverage.omitted,4);eq(requests.filter(r=>r.name==='intel_cmc_contract_chart_identity').length,10)
 assert(!JSON.stringify(requests).includes('DO NOT SEND'));assert(!JSON.stringify(result).includes('DO NOT SEND'))
})
Deno.test('portfolio analysis reuses identical retained evidence despite a new evaluation clock, but changes for material facts',async()=>{
 const input=portfolioResearchFacts({holdings:[]}),scope={orgId:'org',userId:'user',portfolioId:'portfolio'}
 input.facts.marketEvidence=[{cmc_contract_state:{evaluated_at:'2026-09-12T03:00:00Z',observations:[{id:'record',value:0,observedAt:'2026-09-12T00:00:00Z',sourceRef:'source'}]}}]
 const before=await portfolioResearchFingerprint(scope,input,'test')
 input.facts.marketEvidence[0].cmc_contract_state.evaluated_at='2026-09-12T03:01:00Z'
 eq(await portfolioResearchFingerprint(scope,input,'test'),before)
 input.facts.marketEvidence[0].cmc_contract_state.observations[0].value=1
 assert(await portfolioResearchFingerprint(scope,input,'test')!==before)
})
Deno.test('portfolio membership refresh reuses unchanged analysis while original receipt clocks stay saved',async()=>{
 const input=portfolioResearchFacts({holdings:[]}),scope={orgId:'org',userId:'user',portfolioId:'portfolio'}
 input.facts.narrativeExposure={status:'available',positions:[{canonicalAssetKey:'market:coinmarketcap:1',valueUsd:50,priceStatus:'priced',positionObservedAt:'2026-09-12T12:00:00Z',memberships:[{id:'membership',narrativeId:'payments',source:'Original source',membershipRecordedAt:'2026-09-12T12:00:00Z',taxonomyRecordedAt:'2026-09-12T12:00:00Z',effectiveAt:null}]}]}
 const before=await portfolioResearchFingerprint(scope,input,'test')
 input.facts.narrativeExposure.positions[0].memberships[0].membershipRecordedAt='2026-09-12T12:10:00Z'
 input.facts.narrativeExposure.positions[0].positionObservedAt='2026-09-12T12:10:00Z'
 eq(await portfolioResearchFingerprint(scope,input,'test'),before)
 eq(input.facts.narrativeExposure.positions[0].memberships[0].membershipRecordedAt,'2026-09-12T12:10:00Z')
 input.facts.narrativeExposure.positions[0].memberships[0].narrativeId='changed-group'
 assert(await portfolioResearchFingerprint(scope,input,'test')!==before)
})
