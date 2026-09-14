import {assert} from 'jsr:@std/assert'
Deno.test('alert explanations resolve the authorized stored event before cache or synthesis',async()=>{
 const code=await Deno.readTextFile(new URL('../../intel-generate/index.ts',import.meta.url))
 const receipt=code.indexOf('await loadAlertExplanationReceipt(')
 assert(receipt>code.indexOf('await requireIntelAccess('),'Resolve a server-owned alert receipt after access verification')
 assert(receipt<code.indexOf('const inputHash ='),'Receipt identity must govern cache reuse')
 assert(code.includes("artifactType!=='alert_explanation'"),'Exclude latest general evidence from historical alert explanations')
 assert(code.includes('attachAlertExplanationReceipt(structured, alertReceipt)'),'Persist exact receipt after synthesis')
})
