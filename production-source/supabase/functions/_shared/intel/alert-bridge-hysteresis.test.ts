import assert from 'node:assert/strict'
import {BRIDGE_TRIGGERS,HYSTERESIS_BRIDGE_TRIGGERS,bridgeTriggerUsesCondition,stepBridgedCondition} from './alert-bridge.ts'

Deno.test('only the bridge triggers that are oscillating levels take the condition state machine',()=>{
 assert.equal(bridgeTriggerUsesCondition('supply_shock'),true,'a signed percentage against a threshold can flap')
 // Each of these is a DISCRETE recorded row, already permanently deduped by
 // (rule, source_table, source_ref). A re-arm gate would silence real separate
 // events rather than debounce one flapping level.
 for(const trigger of ['wallet_activity','unlock','metadata_migration','holder_shift']){
  assert.equal(bridgeTriggerUsesCondition(trigger),false,`${trigger} is a discrete record, not a level`)
 }
 for(const trigger of HYSTERESIS_BRIDGE_TRIGGERS){
  assert.ok((BRIDGE_TRIGGERS as readonly string[]).includes(trigger),`${trigger} is still a bridge trigger`)
 }
})

// A faithful mirror of app_private.intel_condition_step for the crossing case
// (sustain_minutes = 0), so the oscillation contract is proved here rather than
// merely asserted about SQL this suite cannot execute.
function conditionMachine(level:number,hysteresisPct:number,maxGapMinutes:number){
 const margin=level*hysteresisPct/100
 let previous:{value:number;at:number;armed:boolean}|null=null
 return (value:number,at:number)=>{
  const contiguous=previous!=null&&at>previous.at&&at-previous.at<=maxGapMinutes*60_000
  let armed:boolean,candidate=false,state='watching'
  if(!contiguous){armed=value<=level-margin;state='baseline'}
  else{
   armed=previous!.armed||value<=level-margin
   candidate=armed&&previous!.value<=level&&value>level
   if(candidate){armed=false;state='crossed'}
  }
  previous={value,at,armed}
  return {candidate,state}
 }
}

// deno-lint-ignore no-explicit-any
function bridgeDatabase(level:number,hysteresisPct:number,maxGapMinutes=2880){
 const step=conditionMachine(level,hysteresisPct,maxGapMinutes)
 const calls:any[]=[]
 return {
  calls,
  // deno-lint-ignore no-explicit-any
  rpc(name:string,args:any){
   assert.equal(name,'intel_step_bridged_condition')
   calls.push(args)
   const {value,observedAt}=args.p_observation
   return Promise.resolve({data:step(Number(value),Date.parse(observedAt)),error:null})
  },
 }
}
const at=(hours:number)=>new Date(Date.parse('2026-09-16T00:00:00Z')+hours*3600_000).toISOString()
// deno-lint-ignore no-explicit-any
const run=(db:any,value:number,hours:number)=>stepBridgedCondition(db,{
 ruleId:'rule-1',orgId:'org-1',revision:3,observationId:`supply:${hours}`,observedAt:at(hours),
 value,provider:'defillama',subject:'stablecoin_supply_snapshots:supply_change_pct',
})

Deno.test('a bridge trigger no longer double-fires across an oscillating threshold',async()=>{
 // Threshold 5%, reset margin 20% (so the rule re-arms only below 4%).
 const db=bridgeDatabase(5,20)
 const fired:number[]=[]
 // Baseline below, cross above, fall back to 4.5 (inside the margin, so the rule
 // stays disarmed), rise above again: the second rise is NOT a new crossing.
 for(const [value,hours] of [[3,0],[6,1],[4.5,2],[6.2,3]] as const){
  const step=await run(db,value,hours)
  if(step.candidate)fired.push(value)
 }
 assert.deepEqual(fired,[6],'one crossing, not two')

 // Only a genuine return below the reset margin re-arms the rule.
 assert.equal((await run(db,3.5,4)).candidate,false,'falling back through the margin is not itself a firing')
 assert.equal((await run(db,6.5,5)).candidate,true,'after re-arming, the next crossing fires again')
})

Deno.test('the first observation of a rule is a baseline and never a firing',async()=>{
 const db=bridgeDatabase(5,20)
 const first=await run(db,99,0)
 assert.equal(first.candidate,false)
 assert.equal(first.state,'baseline')
})

Deno.test('a gap wider than the trigger cadence starts a new baseline rather than inventing a crossing',async()=>{
 const db=bridgeDatabase(5,20,2880)
 assert.equal((await run(db,3,0)).candidate,false)
 // Four days later the previous sample says nothing about the path between.
 const afterGap=await run(db,9,96)
 assert.equal(afterGap.candidate,false)
 assert.equal(afterGap.state,'baseline')
})

Deno.test('a refused or malformed step is never read as a crossing',async()=>{
 const failed={rpc:()=>Promise.resolve({data:null,error:{message:'boom'}})}
 await assert.rejects(()=>run(failed,9,1),/alert_condition_step_failed/)
 const malformed={rpc:()=>Promise.resolve({data:{candidate:true},error:null})}
 await assert.rejects(()=>run(malformed,9,1),/alert_condition_step_response_invalid/)
})

Deno.test('the step carries the rule revision, so an edited rule cannot reuse an old baseline',async()=>{
 const db=bridgeDatabase(5,0)
 await run(db,3,0)
 assert.equal(db.calls[0].p_revision,3)
 assert.equal(db.calls[0].p_rule,'rule-1')
 assert.equal(db.calls[0].p_org,'org-1')
})
