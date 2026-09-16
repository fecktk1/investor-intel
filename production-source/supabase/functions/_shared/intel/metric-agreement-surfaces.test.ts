import assert from 'node:assert/strict'
import {conditionAgreementReceipt,metricAgreement,MARKET_MOVE_CONDITION_METRICS} from './metric-agreement.ts'
import {BRIDGE_TRIGGERS,bridgedAlertAgreement,emitBridgedAlert,withBridgedAgreement} from './alert-bridge.ts'
import {deliveryEvidenceLabel,deliveryMessage,readDeliveryAgreement,runAlertDeliveries} from './alert-delivery.ts'
import {computeThesisStatus} from './thesis-evidence.ts'

const NOW=Date.parse('2026-09-16T12:00:00Z')
const AT=new Date(NOW-60_000).toISOString()
const change=(changePct:number)=>({changePct,observedAt:AT,periodSeconds:86400})
const corroborated=metricAgreement({price:change(4),market_cap:change(3),volume:change(20)},NOW)

Deno.test('every bridged trigger carries an explicit unmeasured research lead, never nothing',()=>{
 for(const trigger of BRIDGE_TRIGGERS){
  const payload=withBridgedAgreement(trigger,{source_ref:'row-1'})
  assert.equal(payload.metric_agreement,'unmeasured')
  const receipt=payload.metric_agreement_receipt as any
  assert.equal(receipt.research_lead,true)
  assert.deepEqual(receipt.reasons,['not_a_market_move'])
  assert.equal(payload.source_ref,'row-1')
 }
 // A trigger the bridge does not own is left untouched.
 assert.equal(bridgedAlertAgreement('price_move'),null)
 assert.deepEqual(withBridgedAgreement('price_move',{a:1}),{a:1})
})

Deno.test('a candidate field can never claim an agreement the bridge did not measure',()=>{
 const payload=withBridgedAgreement('wallet_activity',{metric_agreement:'corroborated'})
 assert.equal(payload.metric_agreement,'unmeasured')
})

Deno.test('the bridge emit sends the verdict inside the payload the database merges',async()=>{
 let sent:any=null
 const db={rpc:async(_name:string,args:any)=>{sent=args;return {data:'fired',error:null}}}
 const result=await emitBridgedAlert(db,{revision:1,ruleId:'r',orgId:'o',triggerType:'unlock',sourceSystem:'unlock',sourceTable:'token_unlocks',sourceRef:'u1',metric:null,value:null,cooldownMinutes:null,payload:{title:'Unlock'}})
 assert.equal(result,'fired')
 assert.equal(sent.p_payload.metric_agreement,'unmeasured')
 assert.equal(sent.p_payload.title,'Unlock')
 assert.ok(JSON.stringify(sent.p_payload).length<16000)
})

Deno.test('a thesis condition on a market move takes the asset verdict; any other metric is not a market move',()=>{
 for(const metric of MARKET_MOVE_CONDITION_METRICS)assert.equal(conditionAgreementReceipt(metric,corroborated).metric_agreement,'corroborated')
 for(const metric of ['tvl_change','holder_count','liquidity_event_usd','depth_notional',null]){
  const receipt=conditionAgreementReceipt(metric,corroborated)
  assert.equal(receipt.metric_agreement,'unmeasured');assert.deepEqual(receipt.reasons,['not_a_market_move'])
 }
 // No asset verdict is never upgraded.
 const missing=conditionAgreementReceipt('price_change',null)
 assert.equal(missing.metric_agreement,'unmeasured');assert.equal(missing.research_lead,true)
})

Deno.test('thesis status reason stores research_lead and reasons only beside a computed verdict',()=>{
 const lead=computeThesisStatus({metricAgreement:'incomplete',metricAgreementReasons:['market_cap_single_observation'],now:new Date(NOW)})
 assert.equal(lead.status_reason.metric_agreement,'incomplete')
 assert.equal(lead.status_reason.research_lead,true)
 assert.deepEqual(lead.status_reason.metric_agreement_reasons,['market_cap_single_observation'])
 const ok=computeThesisStatus({metricAgreement:'corroborated',now:new Date(NOW)})
 assert.equal(ok.status_reason.research_lead,false)
 const absent=computeThesisStatus({now:new Date(NOW)})
 assert.equal('research_lead' in absent.status_reason,false)
 assert.equal('metric_agreement_reasons' in absent.status_reason,false)
})

const target={chatId:'123456789',eventId:'30000000-0000-4000-8000-000000000001',firedAt:'2026-09-11T12:00:00Z',trigger:'price_move',title:'Saved'}
Deno.test('Telegram text carries the evidence label and only a stored corroborated verdict reads as corroborated',()=>{
 assert.match(deliveryMessage({...target,metricAgreement:'corroborated'}).text,/Evidence: Corroborated\./)
 for(const verdict of ['conflicting','incomplete','unmeasured',null,undefined,'invented'])
  assert.match(deliveryMessage({...target,metricAgreement:verdict as any}).text,/Evidence: Research lead\./)
 assert.equal(deliveryEvidenceLabel('corroborated').includes(String.fromCharCode(0x2014)),false)
})

Deno.test('the delivery verdict read prefers the checkpoint receipt and fails closed to a research lead',async()=>{
 const reader=(row:any,error:any=null)=>({from:(table:string)=>{assert.equal(table,'intel_alert_events');const q:any={select:()=>q,eq:(c:string,v:string)=>{assert.equal(c,'id');assert.equal(v,target.eventId);return q},maybeSingle:async()=>({data:row,error})};return q}})
 assert.equal(await readDeliveryAgreement(reader({checkpoint:'corroborated',observation:null,bridged:'incomplete'}),target.eventId),'corroborated')
 assert.equal(await readDeliveryAgreement(reader({checkpoint:null,observation:'conflicting',bridged:null}),target.eventId),'conflicting')
 assert.equal(await readDeliveryAgreement(reader({checkpoint:null,observation:null,bridged:'unmeasured'}),target.eventId),'unmeasured')
 assert.equal(await readDeliveryAgreement(reader(null,{message:'down'}),target.eventId),null)
 assert.equal(await readDeliveryAgreement({from:()=>{throw Error('boom')}},target.eventId),null)
 assert.equal(await readDeliveryAgreement(reader({}),'not-an-id'),null)
})

Deno.test('delivery sends the stored verdict label read after the consent check',async()=>{
 const calls:string[]=[];let text=''
 const db={
  rpc(name:string){calls.push(name);return {data:name==='intel_claim_alert_deliveries'?[{id:'d',lease:'l'}]:name==='intel_alert_delivery_target'?target:true}},
  from(){calls.push('verdict');const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{checkpoint:'corroborated'},error:null})};return q},
 }
 const result=await runAlertDeliveries(db,{enabled:true,token:'test',transport:async(_url:any,opts:any)=>{text=JSON.parse(opts.body).text;return new Response(JSON.stringify({ok:true,result:{message_id:7}}))}})
 assert.equal(result.accepted,1)
 assert.deepEqual(calls,['intel_claim_alert_deliveries','intel_alert_delivery_target','verdict','intel_finish_alert_delivery'])
 assert.match(text,/Evidence: Corroborated\./)
})
