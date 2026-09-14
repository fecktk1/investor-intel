import { assertEquals } from 'jsr:@std/assert'
import { readNarrativeBrief } from './narrative-brief-read.ts'
Deno.test('cached narrative brief states distinguish source failure, absence and original evidence',async()=>{
 for(const result of [{error:{message:'denied'}},{},{data:[]},{data:{structured:{summary:'Original'},evidence_hash:'version-original',created_at:'2026-09-12T07:00:00Z'}},{data:null}]){
  const calls:any[]=[]
  const q={select:(...args:any[])=>{calls.push(['select',...args]);return q},eq:(...args:any[])=>{calls.push(args);return q},order:()=>q,limit:(n:number)=>{assertEquals(n,1);return q},maybeSingle:()=>Promise.resolve(result)}
  const response=await readNarrativeBrief({from:(table:string)=>{assertEquals(table,'intel_shared_artifacts');return q}},'rwa')
  assertEquals(response.briefState, 'data' in result && result.data===null?'empty':'data' in result&&result.data&&!Array.isArray(result.data)?'available':'error')
  if(response.briefState==='available')assertEquals(response.brief,result.data)
  assertEquals(calls.some(args=>args[0]==='entity_ref'&&args[1]==='narrative:rwa'),true)
 }
})
