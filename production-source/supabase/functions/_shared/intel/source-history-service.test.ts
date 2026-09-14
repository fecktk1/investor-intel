import {assertEquals as eq,assertRejects,assertThrows} from 'jsr:@std/assert'
import {readSourceHistoryPage} from './source-history-service.ts'
import {sourceHistoryCursor,parseSourceHistoryCursor} from './market-source-versions.ts'
const now=Date.parse('2026-09-12T06:00:00Z'),subject='eip155:8453:0x'+'a'.repeat(40),family='security' as const
const row=(i:number)=>({id:'cmc-source:'+i.toString(16).padStart(64,'0'),subject,family,content_hash:'hash',document:{exists:false,level:0,items:[]},source_reference:{},fetched_at:new Date(now-i*1000).toISOString(),recorded_at:new Date(now-100).toISOString(),expires_at:new Date(now+10000).toISOString(),retain_until:new Date(now+86400000).toISOString(),ai_allowed:false,export_allowed:false})
function database(){
 const calls:any[]=[],data={rows:Array.from({length:26},(_,i)=>row(i+1)),failed:false}
 const db={from(table:string){const q:any=new Proxy({},{get:(_,method)=>method==='then'?(resolve:any)=>Promise.resolve({data:data.rows,error:data.failed?{message:'offline'}:null}).then(resolve):(...args:any[])=>{calls.push([table,method,...args]);if(method==='maybeSingle')return Promise.resolve({data:{config:{CMC_ALLOW_HISTORICAL_RETENTION:'true',CMC_ALLOW_AI_PROCESSING:'false'}},error:null});return q}});return q}}
 return {db,calls,data}
}
Deno.test('source cursor is bound to exact family, identity, original knowledge cutoff and validated SQL-filter scalars',()=>{
 const last={id:row(25).id,fetchedAt:row(25).fetched_at},cursor=sourceHistoryCursor(subject,family,now,last)
 eq(parseSourceHistoryCursor(cursor,subject,family,now+1000),{knownAt:now,fetchedAt:last.fetchedAt,id:last.id})
 const precise={...last,fetchedAt:'2026-09-12T05:59:00.123456+00:00'}
 eq(parseSourceHistoryCursor(sourceHistoryCursor(subject,family,now,precise),subject,family,now)?.fetchedAt,precise.fetchedAt)
 for(const [s,f] of [[subject.replace(':8453:',':1:'),family],[subject,'rwa_relationship']] as const)assertThrows(()=>parseSourceHistoryCursor(cursor,s,f,now),Error,'invalid_source_history_cursor')
 assertThrows(()=>parseSourceHistoryCursor(cursor,subject,family,now-1),Error,'invalid_source_history_cursor')
 assertThrows(()=>parseSourceHistoryCursor(sourceHistoryCursor(subject,family,now,{...last,fetchedAt:'2026-09-12T05:00:00Z),id.gt.0'}),subject,family,now),Error,'invalid_source_history_cursor')
})
Deno.test('source pages retain the first cutoff, stable tie ordering, current retention and bounded display-only reads',async()=>{
 const {db,calls}=database(),first=await readSourceHistoryPage(db,{subject,family},now)
 eq(first.versions.length,25);eq(first.versions[0].document.level,0);eq(first.versions[0].document.exists,false);eq(first.has_more,true)
 const later=await readSourceHistoryPage(db,{subject,family,cursor:first.nextCursor},now+5000)
 eq(later.knownAt,now);eq(calls.some(c=>c[1]==='lte'&&c[2]==='recorded_at'&&c[3]===new Date(now).toISOString()),true)
 eq(calls.some(c=>c[1]==='gt'&&c[2]==='retain_until'&&c[3]===new Date(now+5000).toISOString()),true)
 eq(calls.some(c=>c[1]==='limit'&&c[2]===26),true);eq(calls.some(c=>c[1]==='order'&&c[2]==='id'),true)
 eq(calls.some(c=>c[1]==='or'&&c[2]===`fetched_at.lt.${row(25).fetched_at},and(fetched_at.eq.${row(25).fetched_at},id.lt.${row(25).id})`),true)
 eq(calls.some(c=>c[1]==='eq'&&c[2]==='ai_allowed'),false)
})
Deno.test('unsupported identities, excess rows, malformed cursors and unknown parameters fail before storage; read failures stay failures',async()=>{
 const {db,calls,data}=database()
 for(const params of [{subject:'BTC',family},{subject,family,limit:26},{subject,family,cursor:'bad'},{subject,family,refresh:true}])await assertRejects(()=>readSourceHistoryPage(db,params,now))
 eq(calls.length,0);data.failed=true
 const failed=await readSourceHistoryPage(db,{subject,family},now);eq(failed.status,'error');eq(failed.has_more,false);eq(failed.nextCursor,null)
})
