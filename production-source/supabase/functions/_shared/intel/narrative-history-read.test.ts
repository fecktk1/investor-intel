import { assertEquals, assertRejects } from 'jsr:@std/assert'
import { readNarrativeHistory } from './narrative-history-read.ts'
const now=Date.now()
const row=(i:number)=>({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,snapshot_at:new Date(now-Math.floor(i/2)*100000).toISOString(),momentum_score:0})
function client(all:any[],result?:any){
 const calls:any[]=[],filters:{before?:{at:string,id:string}}={}
 const q:any={select:()=>q,eq:(...args:any[])=>{calls.push(['eq',...args]);return q},gte:()=>q,lte:()=>q,maybeSingle:()=>Promise.resolve({data:{id:'n1'}}),order:(...args:any[])=>{calls.push(['order',...args]);return q},or:(s:string)=>{calls.push(['or',s]);const match=/snapshot_at.lt.(.*),and\(snapshot_at.eq.*?,id.lt.(.*?)\)$/.exec(s)!;filters.before={at:match[1],id:match[2]};return q},limit:(n:number)=>{calls.push(['limit',n]);const b=filters.before;return Promise.resolve(result||{data:all.filter(r=>!b||r.snapshot_at<b.at||r.snapshot_at===b.at&&r.id<b.id).sort((a,b)=>b.snapshot_at.localeCompare(a.snapshot_at)||b.id.localeCompare(a.id)).slice(0,n)})}}
 return {db:{from:(table:string)=>{calls.push(['from',table]);return q}},calls}
}
Deno.test('newest-first bounded history reaches recent rows and preserves equal-time snapshots across cursor pages',async()=>{
 const all=Array.from({length:2153},(_,i)=>row(i)),mock=client(all),first=await readNarrativeHistory(mock.db,'rwa',30)
 assertEquals(mock.calls.filter(c=>c[0]==='order'),[['order','snapshot_at',{ascending:false}],['order','id',{ascending:false}]])
 assertEquals(mock.calls.at(-1),['limit',481]);assertEquals(first.history.length,480)
 assertEquals(first.history.at(-1)?.snapshot_at,all[0].snapshot_at);assertEquals(first.historyCoverage.hasMore,true)
 const next=await readNarrativeHistory(client(all).db,'rwa',30,first.historyCoverage.nextCursor)
 assertEquals(new Set([...next.history,...first.history].map(r=>r.id)).size,960);assertEquals(first.history[0].momentum_score,0)
 const tied=Array.from({length:481},(_,i)=>({...row(i),snapshot_at:all[0].snapshot_at})),tiedFirst=await readNarrativeHistory(client(tied).db,'rwa',30)
 const tiedNext=await readNarrativeHistory(client(tied).db,'rwa',30,tiedFirst.historyCoverage.nextCursor)
 assertEquals(tiedNext.history.length,1);assertEquals(new Set([...tiedFirst.history,...tiedNext.history].map(r=>r.id)).size,481)
 const precise=client([]),at='2026-09-12T07:00:00.123456+00:00'
 await readNarrativeHistory(precise.db,'rwa',30,{at,id:row(0).id})
 assertEquals(precise.calls.find(c=>c[0]==='or')?.[1],`snapshot_at.lt.${at},and(snapshot_at.eq.${at},id.lt.${row(0).id})`)
})
Deno.test('read failures and unsafe cursors never become successful empty history',async()=>{
 for(const result of [{data:null},{data:[{snapshot_at:'bad'}]},{error:{message:'denied'}}])await assertRejects(()=>readNarrativeHistory(client([],result).db,'rwa',30))
 for(const before of [false,'2026-09-12',{at:'bad',id:row(0).id},{at:row(0).snapshot_at,id:'x),snapshot_at.gt.0'}])await assertRejects(()=>readNarrativeHistory({},'rwa',30,before))
 assertEquals((await readNarrativeHistory(client([]).db,'rwa',30)).historyCoverage,{requestedDays:30,returnedRows:0,hasMore:false,nextCursor:null,from:null,to:null})
})
