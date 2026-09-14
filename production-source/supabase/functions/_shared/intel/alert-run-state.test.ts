import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { thesisEvidencePass, alertRunState } from './alert-run-state.ts'
const outside=new Date('2026-09-11T09:02:00Z')
Deno.test('nonobject cron bodies preserve the ordinary schedule without throwing',()=>{
  for(const input of [null,undefined,[],true,'true',0])eq(thesisEvidencePass(input,outside),{run:false,limit:50})
  eq(thesisEvidencePass(null,new Date('2026-09-11T12:01:00Z')),{run:true,limit:50})
  eq(thesisEvidencePass({},new Date('2026-09-11T12:15:00Z')),{run:false,limit:50})
})
Deno.test('explicit operator evidence passes require a boolean and enforce the cap',()=>{
  eq(thesisEvidencePass({thesisEvidenceNow:'true'},outside).run,false)
  for(const [value,limit] of [[undefined,1],['bad',1],[0,1],[-5,1],[2.9,2],[51,50],[10000,50]])eq(thesisEvidencePass({thesisEvidenceNow:true,thesisEvidenceLimit:value},outside),{run:true,limit})
})
Deno.test('thesis, chart and maintenance failures produce an honest partial service response',()=>{
  eq(alertRunState(false,0,false),{ok:true,partial:false,status:200})
  for(const [chart,thesis,maintenance] of [[true,0,false],[false,1,false],[false,0,true],[true,3,true]] as const)eq(alertRunState(chart,thesis,maintenance),{ok:false,partial:true,status:503})
})
