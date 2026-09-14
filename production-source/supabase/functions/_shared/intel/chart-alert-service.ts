import {chartAsset,chartAnchor,isUuid} from './chart-workspace-contract.ts'
import {chartProofAsset} from './chart-capture-proof.ts'
import {CHAINS} from '../chains.ts'
import {chartPricesReadable} from './chart-capture-proof.ts'
import {researchCmcId} from './research-identity.ts'

export function chartAlertAssetAliases(input:unknown) {
 const asset=chartAsset(input),mainNative:Record<string,string>={'market:coinmarketcap:1':'native:bitcoin','market:coingecko:bitcoin':'native:bitcoin','market:coinmarketcap:1027':'native:ethereum','market:coingecko:ethereum':'native:ethereum','market:coinmarketcap:5426':'native:solana','market:coingecko:solana':'native:solana','market:coinmarketcap:1839':'native:bnb','market:coingecko:binancecoin':'native:bnb','market:coinmarketcap:5805':'native:avalanche','market:coingecko:avalanche-2':'native:avalanche'}
 const canonical=chartProofAsset(mainNative[asset]||asset),aliases=new Set([asset,canonical])
 const chain=CHAINS.find(c=>canonical===(c.evmChainId!=null?`eip155:${c.evmChainId}:native`:`${c.namespace}:native:${c.nativeSymbol}`))
 if(chain){const native=`native:${chain.id}`;aliases.add(native);aliases.add(`${chain.namespace}:${chain.caip2Ref}/native:${chain.nativeSymbol.toLowerCase()}`);for(const [key,value] of Object.entries(mainNative))if(value===native)aliases.add(key)}
 const evm=/^eip155:([1-9][0-9]*):(0x[a-f0-9]{40})$/.exec(canonical)
 if(evm)aliases.add(`eip155:${evm[1]}/erc20:${evm[2]}`)
 const sol=/^solana:(?:mainnet\/spl:)?([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(canonical)
 if(sol){aliases.add(`solana:${sol[1]}`);aliases.add(`solana:mainnet/spl:${sol[1]}`)}
 return [...aliases]
}

export function chartAlertConfig(input:any) {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('invalid_chart_alert')
 const asset=chartProofAsset(chartAsset(input.asset)),level=Number(input.threshold_usd)
 if(typeof input.threshold_usd!=='number'||!Number.isFinite(level)||level<=0||level>1e18||!['above','below'].includes(input.direction))throw new Error('invalid_chart_alert_level')
 if(typeof input.title!=='string'||!input.title.trim()||input.title.length>120||typeof input.note!=='string'||input.note.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.title+input.note))throw new Error('invalid_chart_alert_text')
 const anchor=input.anchor==null?null:chartAnchor(input.anchor)
 const repeat=input.repeat??'rearm',condition=input.condition??'crossing',hysteresis=input.hysteresis_pct??0,sustain=input.sustain_minutes??0
 if(!['once','rearm'].includes(repeat)||!['crossing','sustained'].includes(condition)||typeof hysteresis!=='number'||!Number.isFinite(hysteresis)||hysteresis<0||hysteresis>50||!Number.isInteger(sustain)||sustain<0||sustain>1440||condition==='sustained'&&sustain<15||condition==='crossing'&&sustain!==0)throw Error('invalid_chart_alert_behavior')
 return {asset,threshold_usd:level,direction:input.direction,title:input.title.trim(),note:input.note,anchor,currency:'USD',delivery:'in_app',method:'sampled_quote_condition_v2',repeat,condition,hysteresis_pct:hysteresis,sustain_minutes:sustain}
}
export async function chartAlertService(db:any,actor:{orgId:string;userId:string},body:any,options:{env?:(key:string)=>string|undefined;now?:number}={}) {
 const read=async(query:any)=>{const {data,error}=await query;if(error)throw new Error(/^(chart_alert_|forbidden)/.test(error.message)?error.message:'chart_alert_storage_unavailable');return data}
 if(body.operation==='alert_general_save'){
  if(!isUuid(body.operationId)||body.id!=null&&!isUuid(body.id)||body.entityId!=null&&!isUuid(body.entityId)||!Number.isInteger(body.revision)||body.revision<0||typeof body.active!=='boolean'||!Number.isInteger(body.cooldownMinutes)||body.cooldownMinutes<15||body.cooldownMinutes>10080||!body.config||typeof body.config!=='object'||Array.isArray(body.config)||JSON.stringify(body.config).length>8000||!['price_move','volume_spike','liquidity_drop','wallet_activity','narrative_heat','holder_shift','unlock','supply_shock','metadata_migration'].includes(body.trigger))throw Error('chart_alert_general_invalid')
  return read(db.rpc('intel_save_general_alert',{p_org:actor.orgId,p_user:actor.userId,p_id:body.id??null,p_revision:body.revision,p_operation:body.operationId,p_entity:body.entityId??null,p_trigger:body.trigger,p_config:body.config,p_active:body.active,p_cooldown:body.cooldownMinutes}))
 }
 if(['alert_delivery_status','alert_delivery_preference'].includes(body.operation)){
  if(!isUuid(body.id))throw Error('invalid_chart_alert_id')
  const rule=await read(db.from('intel_alert_rules').select('id').eq('id',body.id).eq('org_id',actor.orgId).eq('user_id',actor.userId).maybeSingle())
  if(!rule)throw Error('chart_alert_not_found')
  if(body.operation==='alert_delivery_preference'){
   if(typeof body.enabled!=='boolean')throw Error('invalid_delivery_preference')
   return read(db.rpc('intel_set_alert_delivery',{p_org:actor.orgId,p_user:actor.userId,p_rule:body.id,p_enabled:body.enabled}))
  }
  const page=body.page??0;if(!Number.isInteger(page)||page<0||page>1000)throw Error('invalid_delivery_page')
  const [preference,link,deliveries]=await Promise.all([
   read(db.from('intel_alert_delivery_preferences').select('telegram_enabled,consent_at').eq('org_id',actor.orgId).eq('user_id',actor.userId).eq('rule_id',body.id).maybeSingle()),
   read(db.from('intel_telegram_links').select('allows_private_alerts').eq('org_id',actor.orgId).eq('user_id',actor.userId).eq('status','active').maybeSingle()),
   read(db.from('intel_alert_deliveries').select('id,event_id,state,created_at,expires_at,attempt_count,reason,intel_alert_delivery_attempts(attempt,started_at,finished_at,outcome,http_status,provider_message_id,reason)').eq('org_id',actor.orgId).eq('user_id',actor.userId).eq('rule_id',body.id).order('created_at',{ascending:false}).order('id',{ascending:false}).range(page*20,page*20+20))
  ])
  if(!Array.isArray(deliveries))throw Error('chart_alert_storage_unavailable')
  return {enabled:preference?.telegram_enabled===true,consentAt:preference?.consent_at??null,linked:link?.allows_private_alerts===true,workerEnabled:options.env?.('INTEL_ALERT_DELIVERY_ENABLED')==='true',rows:deliveries.slice(0,20),hasOlder:deliveries.length>20,page}
 }
 if(body.operation==='alert_history'){
  const assets=chartAlertAssetAliases(body.asset),{from,to,cursor}=body
  if(typeof from!=='number'||typeof to!=='number'||!Number.isFinite(from)||!Number.isFinite(to)||from<0||to>4102444800000||from>to||to-from>366*86400000||cursor!=null&&(!isUuid(cursor.id)||typeof cursor.at!=='string'||!Number.isFinite(Date.parse(cursor.at))))throw new Error('invalid_chart_alert_history')
  return read(db.rpc('intel_chart_alert_history',{p_org:actor.orgId,p_user:actor.userId,p_assets:assets,p_from:new Date(from).toISOString(),p_to:new Date(to).toISOString(),p_cursor:cursor??null}))
 }
 if(body.operation==='alert_save'){
  if(!isUuid(body.operationId)||body.id!=null&&!isUuid(body.id)||!Number.isInteger(body.revision)||body.revision<0||typeof body.active!=='boolean'||!Number.isInteger(body.cooldownMinutes)||body.cooldownMinutes<15||body.cooldownMinutes>10080)throw new Error('invalid_chart_alert_save')
  return read(db.rpc('intel_save_chart_alert',{p_org:actor.orgId,p_user:actor.userId,p_id:body.id??null,p_revision:body.revision,p_operation:body.operationId,p_config:chartAlertConfig(body.config),p_active:body.active,p_cooldown:body.cooldownMinutes}))
 }
 if(body.operation==='alert_preview'){
  if(!isUuid(body.id))throw new Error('invalid_chart_alert_id')
  const result=await read(db.rpc('intel_evaluate_chart_alerts',{p_limit:1,p_rule:body.id,p_org:actor.orgId,p_user:actor.userId,p_commit:false}))
  if(!result?.results?.length)throw new Error('chart_alert_not_found')
  return result
 }
 if(body.operation==='alert_market_rehearsal'){
  if(!isUuid(body.id))throw new Error('invalid_chart_alert_id')
  const rule=await read(db.from('intel_alert_rules').select('id,entity:entities(canonical_ref_key)').eq('id',body.id).eq('org_id',actor.orgId).eq('user_id',actor.userId).maybeSingle())
  if(!rule)throw Error('chart_alert_not_found')
  const now=options.now??Date.now(),env=options.env??(()=>undefined),cmc=researchCmcId({canonicalKey:rule.entity?.canonical_ref_key})
  const result=await read(db.rpc('intel_rehearse_market_alert',{p_org:actor.orgId,p_user:actor.userId,p_rule:body.id,p_source_subject:cmc?`market:coinmarketcap:${cmc}`:null,p_from:new Date(now-86400000).toISOString(),p_to:new Date(now).toISOString(),p_allowed:chartPricesReadable({source:{provider:'coinmarketcap'},createdAt:now},env,now)}))
  if(result?.previewOnly!==true||!Array.isArray(result.examples))throw Error('chart_alert_storage_unavailable')
  return result
 }
 if(body.operation==='alert_rehearsal'){
  if(!isUuid(body.id))throw new Error('invalid_chart_alert_id')
  const now=options.now??Date.now(),env=options.env??(()=>undefined)
  const providers=['coinmarketcap','coingecko','birdeye','geckoterminal'].filter(provider=>chartPricesReadable({source:{provider},createdAt:now},env,now))
  const result=await read(db.rpc('intel_rehearse_chart_alert',{p_org:actor.orgId,p_user:actor.userId,p_rule:body.id,p_from:new Date(now-86400000).toISOString(),p_to:new Date(now).toISOString(),p_allowed_providers:providers}))
  if(result?.previewOnly!==true||!Array.isArray(result.examples))throw Error('chart_alert_storage_unavailable')
  return result
 }
 if(body.operation==='alert_audit'){
  if(!isUuid(body.id)||!Number.isInteger(body.page??0)||(body.page??0)<0||(body.page??0)>1000)throw new Error('invalid_chart_alert_page')
  const page=body.page??0,rows=await read(db.from('intel_chart_alert_audit').select('id,action,recorded_at,detail,revision').eq('org_id',actor.orgId).eq('user_id',actor.userId).eq('rule_id',body.id).order('recorded_at',{ascending:false}).order('id',{ascending:false}).range(page*20,page*20+20))??[]
  return {rows:rows.slice(0,20),hasMore:rows.length>20,page}
 }
 throw new Error('invalid_chart_alert_operation')
}
