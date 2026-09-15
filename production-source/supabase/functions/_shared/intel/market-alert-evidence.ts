import {readCachedAssetQuote} from './cached-asset-quote.ts'
import {researchCmcId} from './research-identity.ts'
import {participationContract} from './participation-read.ts'
import {birdeyeChainForApp} from '../chains.ts'
import {finite,instant} from './investigation-evidence.ts'

/** Public, bounded cache reads only. This module has no provider transport,
 * wallet synchronization or private journal reads. */
export async function readMarketAlertEvidence(db:any,rule:any,now=Date.now()){
 const entity=rule.entity,subject=entity?.canonical_ref_key
 if(typeof subject!=='string'||!subject)throw Error('alert_canonical_identity_unavailable')
 const metric=rule.trigger_type==='price_move'?'price_change_24h_pct':rule.trigger_type==='volume_spike'?'volume_change_24h_pct':rule.trigger_type==='liquidity_drop'?'liquidity_usd':rule.trigger_type==='metadata_notice'?'metadata_notice':rule.trigger_type==='liquidation_cascade'?'liquidation_cascade_ratio':rule.trigger_type==='attention_entry'?'attention_persistence_hours':rule.trigger_type==='listing_flag_change'?'listing_flag_change':null
 if(!metric)throw Error('alert_metric_unsupported')
 if(rule.trigger_type==='metadata_notice')return await readMetadataNotice(db,rule,subject,now)
 if(rule.trigger_type==='liquidation_cascade')return await readLiquidationCascade(db,rule,subject,now)
 if(rule.trigger_type==='attention_entry')return await readAttentionEntry(db,rule,subject,now)
 if(rule.trigger_type==='listing_flag_change')return await readListingFlagChange(db,rule,subject,now)
 if(researchCmcId({canonicalKey:subject})){
  if(metric!=='price_change_24h_pct')throw Error('alert_metric_coverage_unavailable')
  const result=await readCachedAssetQuote(db,{canonicalKey:subject},now)
  if(result.error)throw Error('alert_source_read_failed')
  const o=result.fields.change_86400
  if(!o)throw Error('alert_fresh_source_unavailable')
  return {metric,unit:'%',overview:{price:result.fields.price?.value??null,price_change_24h_pct:o.value,symbol:entity.display_symbol},observation:{id:o.id,subject,provider:o.provider,sourceRef:o.sourceRef,providerSubject:o.subject,value:o.value,unit:'%',periodSeconds:86400,observedAt:o.observedAt,recordedAt:o.recordedAt,expiresAt:o.expiresAt,sampleAt:o.observedAt,clockBasis:'provider_observation',coverage:'24-hour change reported by CoinMarketCap. The reference is its rolling window, not your entry price.'}}
 }
 const identity=participationContract(subject)
 if(!identity)throw Error('alert_canonical_identity_unavailable')
 const chain=birdeyeChainForApp(identity.chain)
 if(!chain)throw Error('alert_provider_network_unavailable')
 const {data,error}=await db.from('birdeye_token_overview_cache').select('chain,token_address,normalized_response,fetched_at,expires_at')
  .eq('chain',chain).eq('token_address',identity.address).maybeSingle()
 if(error)throw Error('alert_source_read_failed')
 if(!data)throw Error('alert_source_coverage_unavailable')
 const known=instant(data.fetched_at),expires=instant(data.expires_at)
 if(known==null||expires==null||known>now||expires<=now||known<now-20*60000||data.chain!==chain||data.token_address!==identity.address)throw Error('alert_fresh_source_unavailable')
 const overview=data.normalized_response,value=finite(metric==='liquidity_usd'?overview?.liquidity:overview?.[metric])
 if(value==null||metric==='liquidity_usd'&&value<0)throw Error('alert_metric_coverage_unavailable')
 return {metric,unit:metric==='liquidity_usd'?'USD':'%',overview,observation:{id:`birdeye-overview:${chain}:${identity.address}:${data.fetched_at}`,subject,provider:'birdeye',sourceRef:`birdeye:/defi/token_overview:${chain}:${identity.address}`,value,unit:metric==='liquidity_usd'?'USD':'%',periodSeconds:metric==='liquidity_usd'?null:86400,observedAt:null,recordedAt:data.fetched_at,expiresAt:data.expires_at,sampleAt:data.fetched_at,clockBasis:'cache_capture',coverage:'Values from the dated retained Birdeye response. Original provider observation time is unavailable. Comparisons use capture times and do not establish changes between source observations.'}}
}

/** A listing notice is recorded by the DAILY metadata pass, so its evidence is
 * asserted for two passes and no longer: after 48 hours nothing is claimed. */
export const METADATA_NOTICE_MAX_AGE_MS=48*60*60*1000
/** Presence of a CoinMarketCap listing notice, read from the catalogue row the
 * metadata pass wrote. The observation id carries the notice hash, so the same
 * notice read again is the SAME observation (the database returns
 * 'same_observation' and nothing fires); a changed notice is a new one. Value 1
 * means a notice is recorded, 0 means none is. The wording, cause and severity
 * of a notice are never interpreted here. */
async function readMetadataNotice(db:any,rule:any,subject:string,now:number){
 const cmcId=researchCmcId({canonicalKey:subject})
 if(!cmcId)throw Error('alert_canonical_identity_unavailable')
 const {data,error}=await db.from('market_assets').select('provider_id,facts,facts_at')
  .eq('source_provider','coinmarketcap').eq('provider_id',cmcId).maybeSingle()
 if(error)throw Error('alert_source_read_failed')
 if(!data)throw Error('alert_source_coverage_unavailable')
 const observed=instant(data.facts_at)
 if(observed==null||observed>now||observed<=now-METADATA_NOTICE_MAX_AGE_MS)throw Error('alert_fresh_source_unavailable')
 const facts=data.facts&&typeof data.facts==='object'?data.facts:{}
 const notice=typeof facts.notice==='string'&&facts.notice.trim()?facts.notice.trim():null
 const hash=typeof facts.noticeHash==='string'&&/^[0-9a-f]{64}$/.test(facts.noticeHash)?facts.noticeHash:null
 const at=new Date(observed).toISOString(),excerpt=notice?notice.slice(0,200):null
 return {metric:'metadata_notice',unit:'notice',overview:{symbol:rule.entity?.display_symbol??null,noticePresent:!!notice,noticeHash:hash,excerpt,factsAt:at},
  observation:{id:`cmc-metadata-notice:${cmcId}:${notice?hash||'unhashed':'none'}`,subject,provider:'coinmarketcap',
   sourceRef:'coinmarketcap:/v2/cryptocurrency/info',metric:'metadata_notice',value:notice?1:0,unit:'notice',periodSeconds:null,
   observedAt:at,recordedAt:at,expiresAt:new Date(observed+METADATA_NOTICE_MAX_AGE_MS).toISOString(),sampleAt:at,clockBasis:'provider_observation',
   metadata:{noticeHash:hash,excerpt},
   coverage:'Presence of a CoinMarketCap listing notice at the daily metadata clock. The notice text is not interpreted and its absence here is not a statement that no issue exists.'}}
}

/** Liquidations are captured for the covered derivatives universe every five
 * minutes. A cascade is the newest capture's window total measured against the
 * SAME window's own seven-day average, so the comparison is the asset against
 * its own recent normality — never another asset, another window, or a figure
 * carried over from a different provider list. */
export const LIQUIDATION_MAX_AGE_MS=15*60*1000
export const LIQUIDATION_BASELINE_MS=7*24*60*60*1000
export const LIQUIDATION_MIN_SAMPLES=24
export const LIQUIDATION_WINDOWS:Record<string,{column:string;periodSeconds:number}>={'1h':{column:'liq_1h',periodSeconds:3600},'4h':{column:'liq_4h',periodSeconds:14400}}
async function readLiquidationCascade(db:any,rule:any,subject:string,now:number){
 const cmcId=researchCmcId({canonicalKey:subject})
 if(!cmcId)throw Error('alert_canonical_identity_unavailable')
 const config=rule.config&&typeof rule.config==='object'?rule.config:{}
 const window=config.window==null?'1h':String(config.window),multiple=config.multiple==null?3:finite(config.multiple)
 const plan=Object.hasOwn(LIQUIDATION_WINDOWS,window)?LIQUIDATION_WINDOWS[window]:null
 if(!plan||multiple==null||!(multiple>=1.5)||!(multiple<=20))throw Error('alert_rule_config_invalid')
 const {data,error}=await db.from('intel_liquidation_snapshots').select('provider_id,captured_at,symbol,liq_1h,liq_4h')
  .eq('provider_id',cmcId).gte('captured_at',new Date(now-LIQUIDATION_BASELINE_MS).toISOString()).lte('captured_at',new Date(now).toISOString())
  .order('captured_at',{ascending:false}).limit(2500)
 if(error)throw Error('alert_source_read_failed')
 const rows=(Array.isArray(data)?data:[]).filter((r:any)=>r&&r.provider_id===cmcId&&instant(r.captured_at)!=null&&(instant(r.captured_at) as number)<=now)
  .sort((a:any,b:any)=>(instant(b.captured_at) as number)-(instant(a.captured_at) as number))
 if(!rows.length)throw Error('alert_source_coverage_unavailable')
 const newest=rows[0],captured=instant(newest.captured_at) as number
 if(captured<=now-LIQUIDATION_MAX_AGE_MS)throw Error('alert_fresh_source_unavailable')
 const current=finite(newest[plan.column])
 // A capture that recorded no total for this window is not a quiet hour; it is
 // an absent measurement, and a ratio may not be built out of one.
 if(current==null||current<0)throw Error('alert_metric_coverage_unavailable')
 const baseline:number[]=[]
 for(const row of rows.slice(1)){const v=finite(row[plan.column]);if(v!=null&&v>=0)baseline.push(v)}
 if(baseline.length<LIQUIDATION_MIN_SAMPLES)throw Error('alert_source_coverage_unavailable')
 const average=baseline.reduce((sum,v)=>sum+v,0)/baseline.length
 // A week in which nothing at all was liquidated gives no scale to compare
 // against. A ratio against zero would be an invented number, not a calm market.
 const value=average>0?current/average:null
 if(value==null||!Number.isFinite(value))throw Error('alert_metric_coverage_unavailable')
 const at=new Date(captured).toISOString()
 return {metric:'liquidation_cascade_ratio',unit:'x',
  overview:{symbol:newest.symbol??rule.entity?.display_symbol??null,window,current,average,samples:baseline.length,ratio:value},
  observation:{id:`cmc-liquidations:${cmcId}:${window}:${at}`,subject,provider:'coinmarketcap',
   sourceRef:`intel_liquidation_snapshots:coinmarketcap:${cmcId}:${window}`,metric:'liquidation_cascade_ratio',value,unit:'x',
   periodSeconds:plan.periodSeconds,observedAt:at,recordedAt:at,expiresAt:new Date(captured+LIQUIDATION_MAX_AGE_MS).toISOString(),
   sampleAt:at,clockBasis:'provider_observation',metadata:{current,average,samples:baseline.length,window},
   coverage:'Reported liquidation total for the stated window against the same window’s seven-day average of retained captures. It reports what the provider recorded as liquidated, not positions at risk, and it names nobody.'}}
}

/** Attention lists are captured hourly. The evidence is PERSISTENCE: how many
 * consecutive hourly captures, ending at the newest capture of that list, still
 * contained the asset. A gap wider than one capture window ends the run, whether
 * the asset left the list or the capture itself is missing; neither is evidence
 * of continued presence. Absence is a recorded zero, not a missing observation. */
export const ATTENTION_MAX_AGE_MS=90*60*1000
export const ATTENTION_LOOKBACK_MS=25*60*60*1000
export const ATTENTION_LISTS=['trending','most_visited','gainers','losers']
async function readAttentionEntry(db:any,rule:any,subject:string,now:number){
 const cmcId=researchCmcId({canonicalKey:subject})
 if(!cmcId)throw Error('alert_canonical_identity_unavailable')
 const config=rule.config&&typeof rule.config==='object'?rule.config:{}
 const list=String(config.list??''),hours=config.hours==null?1:finite(config.hours)
 if(!ATTENTION_LISTS.includes(list)||hours==null||!Number.isInteger(hours)||hours<1||hours>24)throw Error('alert_rule_config_invalid')
 const captures=await db.from('intel_attention_snapshots').select('list,captured_at').eq('list',list)
  .lte('captured_at',new Date(now).toISOString()).order('captured_at',{ascending:false}).limit(1)
 if(captures.error)throw Error('alert_source_read_failed')
 const latest=(Array.isArray(captures.data)?captures.data:captures.data?[captures.data]:[]).find((r:any)=>r&&r.list===list&&instant(r.captured_at)!=null)
 if(!latest)throw Error('alert_source_coverage_unavailable')
 const newest=instant(latest.captured_at) as number
 if(newest>now||newest<=now-ATTENTION_MAX_AGE_MS)throw Error('alert_fresh_source_unavailable')
 const mine=await db.from('intel_attention_snapshots').select('list,captured_at,provider_id,rank,symbol').eq('list',list).eq('provider_id',cmcId)
  .gte('captured_at',new Date(now-ATTENTION_LOOKBACK_MS).toISOString()).lte('captured_at',new Date(now).toISOString())
  .order('captured_at',{ascending:false}).limit(64)
 if(mine.error)throw Error('alert_source_read_failed')
 // One capture can carry several time periods of the same list; that is one
 // capture, not several hours of presence.
 const byCapture=new Map<number,any>()
 for(const row of (Array.isArray(mine.data)?mine.data:[])){
  const at=instant(row?.captured_at)
  if(row?.list!==list||row?.provider_id!==cmcId||at==null||at>now||byCapture.has(at))continue
  byCapture.set(at,row)
 }
 const present=[...byCapture.entries()].sort((a,b)=>b[0]-a[0])
 let streak=0,cursor=newest
 for(const [at] of present){
  if(streak===0?at!==newest:cursor-at>ATTENTION_MAX_AGE_MS)break
  streak++;cursor=at
 }
 const at=new Date(newest).toISOString(),rank=streak?finite(present[0][1].rank):null
 return {metric:'attention_persistence_hours',unit:'hours',
  overview:{symbol:(streak?present[0][1].symbol:null)??rule.entity?.display_symbol??null,list,hours,persistence:streak,rank},
  observation:{id:`cmc-attention:${list}:${cmcId}:${at}`,subject,provider:'coinmarketcap',
   sourceRef:`intel_attention_snapshots:coinmarketcap:${list}`,metric:'attention_persistence_hours',value:streak,unit:'hours',
   periodSeconds:null,observedAt:at,recordedAt:at,expiresAt:new Date(newest+ATTENTION_MAX_AGE_MS).toISOString(),
   sampleAt:at,clockBasis:'provider_observation',metadata:{list,requiredHours:hours,captures:streak,rank,capturedAt:at},
   coverage:'Consecutive hourly provider captures in which the asset was present in the named list. The provider does not publish how the list is ordered, and attention is not a valuation.'}}
}

/** New listings are captured ONCE A DAY with bounded per-row due diligence, so
 * the evidence is the pair of newest retained snapshots of that exact asset and
 * the question is only whether the recorded security flags CHANGED between them.
 * The provider publishes no effective time for a flag change: the newer
 * snapshot's capture is the clock, and the coverage note says so.
 *
 * Value 1 means the two snapshots recorded different flag sets; 0 means they
 * recorded the same one. A snapshot that was never inspected carries no hash,
 * and a comparison against a missing hash is refused rather than reported as a
 * change — losing coverage is not an event.
 *
 * The observation id carries BOTH hashes and the newer snapshot's date, so the
 * same pair read again is the SAME observation (the database answers
 * 'same_observation' and nothing fires) and a re-armed rule cannot double-fire
 * on one change. */
export const LISTING_FLAG_MAX_AGE_MS=48*60*60*1000
async function readListingFlagChange(db:any,rule:any,subject:string,now:number){
 const cmcId=researchCmcId({canonicalKey:subject})
 if(!cmcId)throw Error('alert_canonical_identity_unavailable')
 const {data,error}=await db.from('intel_new_listing_snapshots')
  .select('provider_id,snapshot_date,symbol,chain,contract_address,security_hash,security_state,captured_at')
  .eq('provider','coinmarketcap').eq('provider_id',cmcId)
  .lte('captured_at',new Date(now).toISOString()).order('snapshot_date',{ascending:false}).limit(2)
 if(error)throw Error('alert_source_read_failed')
 const rows=(Array.isArray(data)?data:data?[data]:[]).filter((r:any)=>r&&r.provider_id===cmcId&&instant(r.captured_at)!=null&&(instant(r.captured_at) as number)<=now)
  .sort((a:any,b:any)=>String(b.snapshot_date??'').localeCompare(String(a.snapshot_date??'')))
 if(!rows.length)throw Error('alert_source_coverage_unavailable')
 const current=rows[0],previous=rows[1]
 const captured=instant(current.captured_at) as number
 if(captured<=now-LISTING_FLAG_MAX_AGE_MS)throw Error('alert_fresh_source_unavailable')
 // A first snapshot is a baseline, never a change. Past flags are not reconstructed.
 if(!previous)throw Error('alert_source_coverage_unavailable')
 const hash=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)?value:null
 const after=hash(current.security_hash),before=hash(previous.security_hash)
 if(!after||!before)throw Error('alert_metric_coverage_unavailable')
 const value=after===before?0:1
 const at=new Date(captured).toISOString(),snapshotDate=String(current.snapshot_date??'').slice(0,10)
 return {metric:'listing_flag_change',unit:'flags',
  overview:{symbol:current.symbol??rule.entity?.display_symbol??null,chain:current.chain??null,contractAddress:current.contract_address??null,
   snapshotDate,previousSnapshotDate:String(previous.snapshot_date??'').slice(0,10),securityHash:after,previousSecurityHash:before,
   securityState:current.security_state??null,changed:value===1},
  observation:{id:`cmc-new-listing-flags:${cmcId}:${snapshotDate}:${before}:${after}`,subject,provider:'coinmarketcap',
   sourceRef:`intel_new_listing_snapshots:coinmarketcap:${cmcId}`,metric:'listing_flag_change',value,unit:'flags',periodSeconds:null,
   observedAt:at,recordedAt:at,expiresAt:new Date(captured+LISTING_FLAG_MAX_AGE_MS).toISOString(),sampleAt:at,clockBasis:'provider_observation',
   metadata:{snapshotDate,previousSnapshotDate:String(previous.snapshot_date??'').slice(0,10),securityHash:after,previousSecurityHash:before,chain:current.chain??null},
   coverage:'Whether the security flags CoinMarketCap reported for this contract differ between the two newest daily captures. The provider publishes no time at which a flag changed, so the newer capture dates it, and a changed flag set is not a safety verdict.'}}
}

export function marketAlertFailure(error:unknown){
 const reasons:Record<string,string>={alert_canonical_identity_unavailable:'A verified canonical asset identity is required; a ticker cannot identify this alert source.',alert_metric_unsupported:'This trigger has no compatible metric reader.',alert_metric_coverage_unavailable:'This source has no compatible value for the selected metric and period.',alert_provider_network_unavailable:'This source does not cover the asset network.',alert_fresh_source_unavailable:'No unexpired, bounded-age source value is available.',alert_source_coverage_unavailable:'No retained source record is available for this exact asset.'}
 // A rule recorded outside the range its trigger accepts is not an unavailable
 // source: nothing was read, so nothing may be reported as merely missing.
 const configuration:Record<string,string>={alert_rule_config_invalid:'The recorded rule configuration is outside the range this trigger accepts.'}
 const message=error instanceof Error?error.message:''
 if(configuration[message])return {status:'evaluation_failed',reason:configuration[message]}
 return {status:reasons[message]?'evidence_unavailable':'evaluation_failed',reason:reasons[message]||'The source or event write failed. This is not a successful no-match result.'}
}
