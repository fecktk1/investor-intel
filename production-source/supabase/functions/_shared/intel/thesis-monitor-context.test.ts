import { assertEquals as eq, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { readThesisContextRows } from './thesis-monitor-context.ts'
const thesis={id:'thesis',org_id:'org',user_id:'owner'}
const row=(n:number)=>({id:String(n).padStart(8,'0'),impact:'supports'})
function database(respond:(cursor:string|null)=>any){
  const requests:any[]=[]
  return {requests,from(table:string){
    const request:any={table,filters:[],cursor:null};requests.push(request)
    const q:any={select:(fields:string)=>{request.fields=fields;return q},eq:(k:string,v:string)=>{request.filters.push([k,v]);return q},order:(field:string)=>{request.order=field;return q},limit:(n:number)=>{request.limit=n;return q},gt:(field:string,value:string)=>{request.cursor=value;request.cursorField=field;return q},then:(resolve:any,reject:any)=>Promise.resolve(respond(request.cursor)).then(resolve,reject)}
    return q
  }}
}
Deno.test('journal context reads beyond the PostgREST default with stable bounded owner-scoped pages',async()=>{
  const data=Array.from({length:1003},(_,i)=>row(i+1))
  const db=database(cursor=>({data:data.filter(r=>!cursor||r.id>cursor).slice(0,500)}))
  const result=await readThesisContextRows(db,'intel_thesis_evidence','impact',thesis)
  eq(result.length,1003);eq(result.at(-1),row(1003));eq(db.requests.length,3)
  for(const req of db.requests){eq(req.limit,500);eq(req.order,'id');eq(req.filters,[['thesis_id','thesis'],['org_id','org'],['user_id','owner']])}
  eq(db.requests[1].cursor,row(500).id);eq(db.requests[2].cursor,row(1000).id)
})
Deno.test('later context page failure cannot return a truncated successful calculation',async()=>{
  const db=database(cursor=>cursor?{error:{message:'internal detail'}}:{data:Array.from({length:500},(_,i)=>row(i+1))})
  await assertRejects(()=>readThesisContextRows(db,'intel_thesis_evidence','impact',thesis),Error,'thesis_context_unavailable')
})
Deno.test('nonadvancing and malformed context pages fail explicitly',async()=>{
  for(const respond of [()=>({data:[{}]}),()=>({data:null}),()=>({data:Array.from({length:500},(_,i)=>row(i+1))})]){
    await assertRejects(()=>readThesisContextRows(database(respond),'intel_thesis_evidence','impact',thesis),Error,'thesis_context_unavailable')
  }
})
Deno.test('journal context safety ceiling cannot silently truncate a large journal',async()=>{
  const db=database(cursor=>({data:Array.from({length:500},(_,i)=>row(Number(cursor||0)+i+1))}))
  await assertRejects(()=>readThesisContextRows(db,'intel_thesis_evidence','impact',thesis),Error,'thesis_context_limit_reached')
  eq(db.requests.length,20)
})
