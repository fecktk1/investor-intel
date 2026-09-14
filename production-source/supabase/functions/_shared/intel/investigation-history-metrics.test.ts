import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {readInvestigationHistory} from './investigation-service.ts'
const now=Date.parse('2026-09-12T03:00:00Z'),input={from:now-86400000,to:now,limit:100},subject='eip155:8453:0x'+'a'.repeat(40)
function database(error:any=null){const calls:any[]=[];const query:any=new Proxy({}, {get:(_t,key)=>key==='then'?(resolve:any)=>Promise.resolve({data:[],error}).then(resolve):(...args:any[])=>{calls.push([key,...args]);return query}});return {calls,from:()=>query}}
Deno.test('chart history filters indexed event metrics server-side within the existing bounded query',async()=>{
 const db=database();await readInvestigationHistory(db,[subject],{...input,metrics:['swap_event_usd','liquidity_event_usd']},now,true)
 eq(db.calls.filter(c=>c[0]==='in'),[['in','subject',[subject]],['in','metric',['swap_event_usd','liquidity_event_usd']]])
 eq(db.calls.find(c=>c[0]==='limit'),['limit',101]);eq(db.calls.find(c=>c[0]==='gte'),['gte','observed_at',new Date(input.from).toISOString()])
})
Deno.test('arbitrary metrics cannot broaden retained chart reads and storage failures are not empty histories',async()=>{
 for(const metrics of [[],['price'],['swap_event_usd','price'],['swap_event_usd','swap_event_usd','swap_event_usd'],'swap_event_usd']){
  const db=database();await assertRejects(()=>readInvestigationHistory(db,[subject],{...input,metrics},now,true),Error,'invalid_history_metrics');eq(db.calls.length,0)
 }
 await assertRejects(()=>readInvestigationHistory(database({message:'offline'}),[subject],input,now,true),Error,'investigation_storage_unavailable')
})
