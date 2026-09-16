type Result={outcome:'provider_accepted'|'retry'|'failed'|'unknown'|'cancelled';http?:number;message?:string;retrySeconds?:number}
type Target={chatId:string;eventId:string;firedAt:string;trigger:string;title:string;metricAgreement?:string|null}
const VERDICTS=['corroborated','conflicting','incomplete','unmeasured']
/** The evidentiary standard as one line of the message. Delivery text is not
 * localised today, so this follows the rest of the message in English. Only a
 * stored 'corroborated' verdict reads as corroborated: an absent, unreadable or
 * unknown verdict is a research lead, exactly as the database treats one, so a
 * missing label can never upgrade an alert's evidence class. */
export function deliveryEvidenceLabel(verdict:unknown):string {
 return verdict==='corroborated'
  ?'Evidence: Corroborated. Price, market capitalisation and volume moved the same way over one window.'
  :'Evidence: Research lead. Price, market capitalisation and volume did not corroborate this over one window.'
}
/** The stored verdict word for one already-authorised event, and nothing else
 * from its payload. The market and narrative paths keep the receipt under
 * checkpoint.metric_agreement, thesis conditions under the checkpoint
 * observation, and the bridge at payload.metric_agreement. A failed read
 * returns null, which the label reads as a research lead; delivery never fails
 * because a label could not be read. */
export async function readDeliveryAgreement(db:any,eventId:string):Promise<string|null> {
 if(typeof db?.from!=='function'||typeof eventId!=='string'||!/^[a-f0-9-]{36}$/i.test(eventId))return null
 try{
  const {data,error}=await db.from('intel_alert_events').select('checkpoint:payload->checkpoint->metric_agreement->>metric_agreement,observation:payload->checkpoint->observation->agreement->>metric_agreement,bridged:payload->>metric_agreement').eq('id',eventId).maybeSingle()
  if(error||!data)return null
  return [data.checkpoint,data.observation,data.bridged].find(v=>VERDICTS.includes(v))??null
 }catch{return null}
}
// No price history, source excerpts, trade notes, wallet balances, or org-group
// destinations leave the private workspace. Plain text disables source markup.
export function deliveryMessage(target:Target) {
 if(!/^[1-9][0-9]{1,19}$/.test(target.chatId)||!Number.isFinite(Date.parse(target.firedAt))||!/^[a-f0-9-]{36}$/i.test(target.eventId))throw Error('invalid_private_delivery_target')
 return {chat_id:target.chatId,text:`Investor Intel alert\n${String(target.title||'Saved condition').replace(/[\u0000-\u001f]/g,' ').slice(0,160)}\n${deliveryEvidenceLabel(target.metricAgreement)}\nRecorded ${new Date(target.firedAt).toISOString()}\nReview the original condition and evidence in your private workspace:\nhttps://thecontentforge.io/intel/alerts?event=${encodeURIComponent(target.eventId)}`,link_preview_options:{is_disabled:true}}
}
export async function sendIntelAlert(target:Target,token:string,transport:typeof fetch=fetch):Promise<Result> {
 const body=deliveryMessage(target)
 if(!token||/[\s/]/.test(token))throw Error('investor_telegram_token_unavailable')
 try {
  const response=await transport(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(8000)})
  // Bound even a malformed provider body; never log the URL/token or raw errors.
  const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[]
  if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();return {outcome:'unknown',http:response.status}}chunks.push(value)}}finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  let payload:any;try{payload=JSON.parse(new TextDecoder().decode(bytes))}catch{return {outcome:'unknown',http:response.status}}
  if(response.ok&&payload?.ok===true&&Number.isSafeInteger(payload.result?.message_id)&&payload.result.message_id>0)return {outcome:'provider_accepted',http:response.status,message:String(payload.result.message_id)}
  if(response.status===429&&payload?.ok===false&&payload.error_code===429)return {outcome:'retry',http:429,retrySeconds:Number.isInteger(payload.parameters?.retry_after)?Math.max(1,Math.min(payload.parameters.retry_after,3600)):60}
  if([400,401,403,404].includes(response.status)&&payload?.ok===false)return {outcome:'failed',http:response.status}
  return {outcome:'unknown',http:response.status}
 }catch{return {outcome:'unknown'}}
}
export async function runAlertDeliveries(db:any,{enabled,token,transport=fetch}:{enabled:boolean;token:string;transport?:typeof fetch}) {
 if(!enabled)return {enabled:false,claimed:0,accepted:0}
 if(!token)throw Error('investor_telegram_token_unavailable')
 const rpc=async(name:string,args:any)=>{const r=await db.rpc(name,args);if(r.error)throw Error('alert_delivery_storage_unavailable');return r.data}
 const claims=await rpc('intel_claim_alert_deliveries',{p_limit:5})
 if(!Array.isArray(claims)||claims.length>5)throw Error('invalid_delivery_claims')
 let accepted=0
 for(const claim of claims){
  const target=await rpc('intel_alert_delivery_target',{p_id:claim.id,p_lease:claim.lease})
  const result:Result=target?await sendIntelAlert({...target,metricAgreement:await readDeliveryAgreement(db,target.eventId)},token,transport):{outcome:'cancelled'}
  const committed=await rpc('intel_finish_alert_delivery',{p_id:claim.id,p_lease:claim.lease,p_outcome:result.outcome,p_http:result.http??null,p_message:result.message??null,p_retry_seconds:result.retrySeconds??60})
  if(committed!==true)throw Error('alert_delivery_receipt_conflict')
  if(result.outcome==='provider_accepted')accepted++
 }
 return {enabled:true,claimed:claims.length,accepted}
}
