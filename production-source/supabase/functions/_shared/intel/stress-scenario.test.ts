import {assertEquals as eq,assertRejects,assertThrows,assert} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {scenarioRules,scenarioInputs,validateStressScenario} from './stress-scenario-contract.ts'
import {captureStressScenario} from './stress-scenario-service.ts'
import {makeResearchReceipt,verifyReceipt} from './investigation-evidence.ts'
import {interpretStressRules,thesisStress} from './investigation-calculations.ts'
const now=1789041600000,subject='market:coinmarketcap:1',actor={userId:'owner',orgId:'org'},thesisId='c1bcd8b7-9287-4b26-ad64-70d2304a6a23'
const rules=[{id:'r',metric:'price_move',comparator:'lt',threshold:-10,rule_kind:'invalidation',description:'Private prose not copied'}]
const input={thesisId,expectedRules:rules,bases:{r:'price_24h'},overrides:{r:-15},focusRule:'r'}
const observation={id:'o',subject,metric:'price_change',unit:'%',periodSeconds:86400,value:2,provider:'synthetic',sourceRef:'synthetic:test',observedAt:new Date(now-1000).toISOString(),recordedAt:new Date(now-500).toISOString(),expiresAt:new Date(now+1000).toISOString(),exportAllowed:true}
function database(thesis:any={id:thesisId,subject_canonical_key:subject},currentRules=rules){const calls:any[]=[];return {calls,from:(table:string)=>{const q:any={};for(const method of ['select','eq','order','limit','maybeSingle'])q[method]=(...args:any[])=>{calls.push([table,method,...args]);return q};q.then=(ok:any)=>Promise.resolve(ok({data:table==='intel_theses'?thesis:currentRules}));return q}}}
Deno.test('scenario capture bounds and owns both reads, checks the exact asset and retains numeric inputs only',async()=>{
 const db=database(),scenario=await captureStressScenario(db,input,actor,subject,v=>v,now)
 eq(scenario.overrides.r,-15);eq(scenario.bases.r,'price_24h');eq(scenario.capturedAt,new Date(now).toISOString());eq(JSON.stringify(scenario).includes('Private prose'),false)
 for(const table of ['intel_theses','intel_thesis_rules'])for(const [column,val]of [['org_id','org'],['user_id','owner']])assert(db.calls.some(c=>c[0]===table&&c[1]==='eq'&&c[2]===column&&c[3]===val))
 assert(db.calls.some(c=>c[1]==='limit'&&c[2]===51))
 await assertRejects(()=>captureStressScenario(database(null),input,actor,subject,v=>v,now),Error,'scenario_thesis_unavailable')
 await assertRejects(()=>captureStressScenario(database(),input,actor,'market:coinmarketcap:2',v=>v,now),Error,'scenario_asset_mismatch')
})
Deno.test('changed source conditions require a refresh instead of silently saving different assumptions',async()=>{
 await assertRejects(()=>captureStressScenario(database(undefined,[{...rules[0],threshold:-5}]),input,actor,subject,v=>v,now),Error,'scenario_conditions_changed')
})
Deno.test('parameters reject unknown rules, non-finite values, invalid bases and oversized collections',()=>{
 for(const value of [NaN,Infinity,true,'15'])assertThrows(()=>scenarioInputs({overrides:{r:value}},['r']))
 assertThrows(()=>scenarioInputs({overrides:{other:10}},['r']));assertThrows(()=>scenarioInputs({bases:{r:'invented'}},['r']));assertThrows(()=>scenarioInputs({focusRule:'other'},['r']))
 assertThrows(()=>scenarioRules(Array.from({length:51},(_,i)=>({...rules[0],id:String(i)}))));assertThrows(()=>scenarioRules([{...rules[0],threshold:true}]))
})
Deno.test('a receipt reproduces the saved interpretation and hypothetical value independently of later thesis edits',async()=>{
 const scenario=await captureStressScenario(database(),input,actor,subject,v=>v,now)
 const receipt=await makeResearchReceipt({subject,lens:'stress',question:'What challenges this condition?',decision:'My saved decision',cursor:now,observations:[observation],scenario},now)
 const verified=await verifyReceipt(JSON.parse(JSON.stringify(receipt))),saved=verified.receipt.scenario!
 const rows=thesisStress(interpretStressRules(saved.rules,saved.bases),verified.receipt.observations,subject,saved.overrides,now)
 eq(rows[0].currentlyMet,false);eq(rows[0].scenarioMet,true);eq(rows[0].hypothetical,-15)
 await assertRejects(()=>verifyReceipt({...receipt,decision:'Changed words'}),Error,'receipt_content_mismatch')
 await assertRejects(()=>verifyReceipt({...receipt,scenario:{...scenario,overrides:{r:99}}}),Error,'receipt_content_mismatch')
})
Deno.test('reference-only receipts do not refill denied evidence and legacy receipts remain readable',async()=>{
 const scenario=await captureStressScenario(database(),input,actor,subject,v=>v,now),receipt=await makeResearchReceipt({subject,lens:'stress',question:'What if?',cursor:now,observations:[{...observation,exportAllowed:false}],scenario},now)
 eq((await verifyReceipt(receipt)).replay,'references_only');eq(receipt.observations.length,0)
 const legacy=await makeResearchReceipt({subject,lens:'coverage',question:'Original receipt',cursor:now,observations:[observation]},now);delete legacy.contentHash;eq((await verifyReceipt(legacy)).replay,'complete')
 const tampered={...receipt};delete tampered.contentHash;await assertRejects(()=>verifyReceipt(tampered),Error,'invalid_receipt_scenario')
 assertThrows(()=>validateStressScenario({...scenario,methodVersion:'future'}))
})
