import {readMarketAlertEvidence,marketAlertFailure} from './market-alert-evidence.ts'

/** Reads each exact asset/metric once per bounded pass. The database rechecks
 * membership, entitlement, activation and revision while committing the event. */
export async function evaluateMarketAlerts(db:any,onFired:(rule:any,evidence:any,eventId:string)=>Promise<void>,read=readMarketAlertEvidence){
 const {data:rules,error}=await db.from('intel_alert_rules').select('*, entity:entities(*), org:orgs!inner(product_mode)')
  .eq('is_active',true).eq('org.product_mode','intel').in('trigger_type',['price_move','volume_spike','liquidity_drop','metadata_notice','liquidation_cascade','attention_entry'])
  .order('last_evaluation_attempt_at',{ascending:true,nullsFirst:true}).order('id').limit(400)
 if(error||!Array.isArray(rules))return {checked:0,fired:0,failed:1,unavailable:0,rules:[],reason:'Rule loading failed.'}
 let checked=0,fired=0,failed=0,unavailable=0
 const memo=new Map<string,Promise<any>>()
 for(const rule of rules){
  checked++
  try{
   // One read per exact asset/metric, where the metric includes the source
   // selectors a trigger reads by: two rules that ask for different windows,
   // lists or multiples are different reads and must not share one answer.
   const key=JSON.stringify([rule.entity?.canonical_ref_key,rule.trigger_type,rule.config?.window??null,rule.config?.multiple??null,rule.config?.list??null,rule.config?.hours??null])
   if(!memo.has(key))memo.set(key,read(db,rule,Date.now()))
   const evidence=await memo.get(key)
   const result=await db.rpc('intel_record_market_alert',{p_rule:rule.id,p_org:rule.org_id,p_revision:rule.chart_revision,p_observation:evidence.observation})
   if(result.error||!result.data?.state)throw Error('alert_write_failed')
   if(result.data.state==='fired'){
    if(!result.data.eventId)throw Error('alert_event_reference_missing')
    fired++
    // Optional existing signal/memory enrichment cannot roll back or duplicate
    // an already committed canonical firing.
    try{await onFired(rule,evidence,result.data.eventId)}catch{failed++}
   }else if(['same_observation','older_observation_ignored','access_unavailable'].includes(result.data.state)){
    // Advance the fair scheduling cursor without replacing the original receipt.
    const stamp=await db.from('intel_alert_rules').update({last_evaluation_attempt_at:new Date().toISOString()}).eq('id',rule.id).eq('org_id',rule.org_id).eq('chart_revision',rule.chart_revision)
    if(stamp.error)throw Error('alert_cursor_write_failed')
   }
  }catch(error){
   const status=marketAlertFailure(error)
   if(status.status==='evidence_unavailable')unavailable++;else failed++
   const saved=await db.rpc('intel_record_alert_evaluation',{p_rule:rule.id,p_org:rule.org_id,p_revision:rule.chart_revision,p_state:status})
   if(saved.error)failed++
  }
 }
 return {checked,fired,failed,unavailable,rules}
}
