import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { comparisonQuoteIds, prepareComparisonQuoteEvidence } from './comparison-quote-evidence.ts'
Deno.test('comparison quotes use exact identities and reject native hints on contracts',()=>{
 assertEquals(comparisonQuoteIds([{canonicalKey:'market:coinmarketcap:1'},{canonicalKey:'native:bitcoin'},{canonicalKey:'eip155:8453:0x'+'a'.repeat(40),sourceProvider:'coingecko',providerId:'ethereum'}]),['1'])
})
Deno.test('comparison registers reusable per-asset demand with at most two concurrent governed reads',async()=>{
 let active=0,maximum=0;const calls:any[]=[],reads:any[]=[]
 const request=async(name:string,params:any,ctx:any)=>{active++;maximum=Math.max(maximum,active);calls.push({name,params,ctx});await new Promise(resolve=>setTimeout(resolve,2));active--;return {payload:null,state:'unavailable' as const,reason:'refresh_required',provenance:{provider:'coinmarketcap' as const,observedAt:null,fetchedAt:null,expiresAt:null,sourceUrl:'https://coinmarketcap.com/'}}}
 const result=await prepareComparisonQuoteEvidence({rpc:(...args:any[])=>{reads.push(args);return {error:null}}},[1,2,3,4].map(id=>({canonicalKey:`market:coinmarketcap:${id}`})),{orgId:'org',userId:'user'},{request:request as any,settings:async()=>({})})
 assertEquals(result.length,4);assertEquals(maximum,2);assertEquals(calls.map(c=>c.params.id),['1','2','3','4']);assert(calls.every(c=>c.ctx.maxCalls===1&&c.ctx.kind==='request'&&c.ctx.waitForFresh&&c.ctx.orgId==='org'));assertEquals(reads.length,0)
})
Deno.test('shared quote evidence retains original clocks and idempotent IDs across comparison reads',async()=>{
 const writes:any[]=[],db={rpc:async(name:string,args:any)=>{writes.push({name,args});return {error:null}}}
 const now=Date.now(),fetched=new Date(now-1000).toISOString(),observed=new Date(now-16000).toISOString(),expires=new Date(now+299000).toISOString()
 const dependencies={settings:async()=>({}),request:async()=>({payload:{data:[{id:42019,name:'Exact asset',quote:{USD:{price:0.003,market_cap:0,volume_24h:120,last_updated:observed}}}]},state:'fresh' as const,reason:null,provenance:{provider:'coinmarketcap' as const,fetchedAt:fetched,observedAt:observed,expiresAt:expires,sourceUrl:'https://coinmarketcap.com/'}})}
 for(let n=0;n<2;n++)await prepareComparisonQuoteEvidence(db,[{canonicalKey:'market:coinmarketcap:42019'}],{orgId:'org',userId:'user'},dependencies as any)
 const first=writes[0].args.p_rows.find((r:any)=>r.metric==='price')
 assertEquals(first.subject,'market:coinmarketcap:42019');assertEquals(first.observedAt,observed);assertEquals(first.recordedAt,fetched);assertEquals(first.expiresAt,expires)
 assertEquals(writes[0].args.p_rows.map((r:any)=>r.id),writes[1].args.p_rows.map((r:any)=>r.id));assert(writes.every(w=>w.name==='intel_record_market_observations'))
})
Deno.test('one failed asset read cannot race or discard the other completed quote read',async()=>{
 let finished=false
 const request=async(_name:string,params:any)=>{if(params.id==='1')throw Error('source failed');await new Promise(resolve=>setTimeout(resolve,3));finished=true;return {payload:null,state:'unavailable',reason:'missing_coverage',provenance:{}}}
 const states=await prepareComparisonQuoteEvidence({},[{canonicalKey:'market:coinmarketcap:1'},{canonicalKey:'market:coinmarketcap:2'}],{orgId:'org',userId:'user'},{request,settings:async()=>({})} as any)
 assert(finished);assertEquals(states.map(s=>s.reason),['comparison_quote_evidence_unavailable','missing_coverage'])
})
