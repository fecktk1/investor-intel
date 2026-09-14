import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {adoptionAttention,readAdoptionAttention} from './adoption-attention.ts'
import type {Observation} from './investigation-evidence.ts'
const at=Date.parse('2026-09-12T03:00:00Z'),end=Date.parse('2026-09-12T00:00:00Z'),start=end-7*86400000,contract='eip155:8453:0x'+'a'.repeat(40),market='market:coinmarketcap:29270'
const o=(id:string,metric:string,value:number,time:number):Observation=>({id,subject:metric==='holder_count'?contract:market,metric,value,unit:metric==='holder_count'?'accounts':metric==='attention_rank'?'rank':'USD',provider:'coinmarketcap',sourceRef:'original:'+id,observedAt:new Date(time).toISOString(),recordedAt:new Date(time+1000).toISOString(),expiresAt:null,aiAllowed:true,periodSeconds:metric==='attention_rank'?null:86400,universe:metric==='attention_rank'?'cmc:trending:24h':metric==='holder_count'?'interval:'+time:null,metadata:metric==='holder_count'?{population:'accounts'}:{}})
const rows=()=>[o('holders-now','holder_count',0,end),o('holders-before','holder_count',100,start),o('rank-now','attention_rank',2,end+10000),o('rank-before','attention_rank',10,start+10000),o('volume-now','volume_24h',0,end+20000),o('volume-before','volume_24h',50,start+20000)]
Deno.test('aligned participation and attention preserve zeros and complete original citations',()=>{
 const r=adoptionAttention(rows(),contract,market,at);eq(r.status,'comparable');eq(r.holderChange,-100);eq(r.holderChangePercent,-100);eq(r.rankImprovement,8);eq(r.volumeChangePercent,-100);eq(r.observations.map(o=>o.sourceRef),rows().map(o=>o.sourceRef))
})
Deno.test('different populations, rank universes, missing ranks, delayed knowledge and misaligned clocks are not comparisons',()=>{
 for(const index of [2,3])for(const patch of [{observedAt:new Date(end+7200000).toISOString()},{recordedAt:new Date(at+1).toISOString()},{subject:'market:coinmarketcap:1'},{universe:'cmc:mostVisited:24h'},{value:0}]){
  const input=rows();input[index]={...input[index],...patch};eq(adoptionAttention(input,contract,market,at).rankImprovement,null)
 }
 const input=rows();input[1].metadata={population:'different sample'};eq(adoptionAttention(input,contract,market,at).status,'baseline_needed')
 eq(adoptionAttention(rows().filter(o=>o.metric!=='attention_rank'),contract,market,at).rankImprovement,null)
})
Deno.test('a zero baseline has no percentage denominator, while absolute holder change survives',()=>{
 const input=rows();input[1].value=0;input[5].value=0;const r=adoptionAttention(input,contract,market,at);eq(r.holderChange,0);eq(r.holderChangePercent,null);eq(r.volumeChangePercent,null)
})
Deno.test('retained reads are bounded, permission-filtered and storage failure remains failure',async()=>{
 const calls:any[]=[];let error:any=null,data:any[]=rows().slice(2).map(observation=>({observation}));const q:any=new Proxy({},{get:(_,name)=>name==='then'?(resolve:any)=>Promise.resolve({data,error}).then(resolve):(...args:any[])=>{calls.push([name,...args]);return q}}),db={from:()=>q}
 eq((await readAdoptionAttention(db,rows().slice(0,2),contract,market,at)).status,'comparable');eq(calls.find(c=>c[0]==='limit'),['limit',129]);eq(calls.find(c=>c[0]==='eq'),['eq','subject',market])
 data=data.map(r=>({observation:{...r.observation,aiAllowed:false}}));eq((await readAdoptionAttention(db,rows().slice(0,2),contract,market,at)).rankImprovement,null)
 error={message:'offline'};eq((await readAdoptionAttention(db,rows().slice(0,2),contract,market,at)).status,'error')
})
