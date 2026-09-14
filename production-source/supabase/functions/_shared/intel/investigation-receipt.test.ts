import {assertEquals as eq,assertRejects,assert} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {investigationService,readReceiptObservations} from './investigation-service.ts'
const actor={orgId:'org',userId:'owner'},id='saved',operationId='a1bcd8b7-9287-4b26-ad64-70d2304a6a23',input={operation:'receipt',operationId,subject:'native:bitcoin',lens:'receipt',question:'Question',decision:'New notes',observationIds:[]}
const original={schemaVersion:1,question:'Original question',decision:'Original notes',createdAt:'2026-09-10T00:00:00Z'}
function database(previous:any){const calls:any[]=[];return {calls,from:(table:string)=>{calls.push(['from',table]);const q:any={};for(const method of ['select','eq','maybeSingle'])q[method]=(...args:any[])=>{calls.push([table,method,...args]);return q};q.then=(ok:any)=>Promise.resolve(ok({data:table==='intel_receipt_operations'?previous:{investigation_receipt:original}}));return q},rpc:async(name:string,args:any)=>{calls.push(['rpc',name,args]);return {data:id}}}}
Deno.test('committed receipt retry returns saved original content without re-reading mutable thesis conditions',async()=>{
 const db=database({saved_research_id:id});const result=await investigationService(db,actor,{...input,scenario:{thesisId:'now deleted'}},Date.now())
 eq(result,{id,receipt:original});eq(db.calls.some(c=>c[0]==='rpc'),false);eq(db.calls.some(c=>c[1]==='intel_theses'),false)
 for(const table of ['intel_receipt_operations','saved_research'])for(const column of ['org_id','user_id'])assert(db.calls.some(c=>c[0]===table&&c[1]==='eq'&&c[2]===column))
})
Deno.test('deleted receipt retry fails before reconstructing private content',async()=>{
 const db=database({saved_research_id:null});await assertRejects(()=>investigationService(db,actor,input),Error,'receipt_deleted');eq(db.calls.some(c=>c[0]==='rpc'),false);eq(db.calls.some(c=>c[1]==='saved_research'),false)
})
Deno.test('first save returns the committed payload, including concurrent-writer results',async()=>{
 const db=database(null);const result=await investigationService(db,actor,input)
 eq(result,{id,receipt:original});eq(db.calls.filter(c=>c[0]==='rpc').length,1);assert(db.calls.some(c=>c[0]==='saved_research'&&c[1]==='eq'&&c[2]==='private_owner_id'&&c[3]==='owner'))
})
Deno.test('receipt evidence reads all 500 references in bounded URL pages and retains the expiry filter',async()=>{
 const ids=Array.from({length:500},(_,i)=>`cmc:${String(i).padStart(64,'0')}`),pages:string[][]=[],now=Date.parse('2026-09-11T12:00:00Z')
 const db={from:(table:string)=>{eq(table,'intel_market_observations');let page:string[]=[];const q:any={select:()=>q,in:(column:string,values:string[])=>{eq(column,'id');assert(values.length<=50);page=values;pages.push(values);return q},gt:(column:string,value:string)=>{eq(column,'retain_until');eq(value,new Date(now).toISOString());return q},limit:(limit:number)=>{eq(limit,50);return Promise.resolve({data:page.map(id=>({observation:{id}}))})}};return q}}
 const records=await readReceiptObservations(db,ids,now);eq(records.map(r=>r.observation.id),ids);eq(pages.length,10)
 await assertRejects(()=>readReceiptObservations(db,[...ids,'overflow'],now),Error,'invalid_receipt_request');eq(pages.length,10)
})
