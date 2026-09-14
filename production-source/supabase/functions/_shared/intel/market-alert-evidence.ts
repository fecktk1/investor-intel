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
 const metric=rule.trigger_type==='price_move'?'price_change_24h_pct':rule.trigger_type==='volume_spike'?'volume_change_24h_pct':rule.trigger_type==='liquidity_drop'?'liquidity_usd':null
 if(!metric)throw Error('alert_metric_unsupported')
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

export function marketAlertFailure(error:unknown){
 const reasons:Record<string,string>={alert_canonical_identity_unavailable:'A verified canonical asset identity is required; a ticker cannot identify this alert source.',alert_metric_unsupported:'This trigger has no compatible metric reader.',alert_metric_coverage_unavailable:'This source has no compatible value for the selected metric and period.',alert_provider_network_unavailable:'This source does not cover the asset network.',alert_fresh_source_unavailable:'No unexpired, bounded-age source value is available.',alert_source_coverage_unavailable:'No retained source record is available for this exact asset.'}
 const message=error instanceof Error?error.message:''
 return {status:reasons[message]?'evidence_unavailable':'evaluation_failed',reason:reasons[message]||'The source or event write failed. This is not a successful no-match result.'}
}
