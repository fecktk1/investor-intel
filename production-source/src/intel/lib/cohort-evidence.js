import {cmcDexIdentity} from '../../../supabase/functions/_shared/market-assets/cmc-dex.ts'
export const cohortSubject=value=>typeof value==='string'&&(/^market:coinmarketcap:[1-9][0-9]*$/.test(value)||!!cmcDexIdentity(value))
export function cohortQuoteRows(cohort,quotes,at){
 if(cohort?.kind!=='dex_discovery'&&quotes?.state!=='retained'){
  const recordedAt=quotes?.provenance?.fetchedAt,expiresAt=quotes?.provenance?.expiresAt,expiry=Date.parse(expiresAt)
  return (quotes?.data?.rows||[]).map(r=>({subject:`market:coinmarketcap:${r.id}`,price:r.quote?.price,observedAt:r.quote?.last_updated||r.last_updated,recordedAt,expiresAt,
   available:r.is_active!==0&&Number.isFinite(Date.parse(recordedAt))&&Number.isFinite(expiry)&&expiry>at,
   reason:!Number.isFinite(expiry)?'Price freshness is unreported':expiry<=at?'Retained price is stale':null}))
 }
 return (quotes?.rows||[]).map(({subject,observation})=>{
  const o=observation?.subject===subject&&observation.metric==='price'&&observation.unit==='USD'?observation:null
  const expiry=o?Date.parse(o.expiresAt):NaN
  return {subject,price:o?.value??null,observedAt:o?.observedAt??null,recordedAt:o?.recordedAt??null,
   available:!!o&&Number.isFinite(Date.parse(o.recordedAt))&&Number.isFinite(expiry)&&expiry>at,sourceRef:o?.sourceRef??null,expiresAt:o?.expiresAt??null,
   reason:!o?'No retained price for the exact original asset':!Number.isFinite(expiry)?'Price freshness is unreported':expiry<=at?'Retained price is stale':null}
 })
}
export function cohortPriceCoverage(row,quote,at){
 if(!quote||quote.price==null)return {code:'missing',label:'No retained price for the exact original asset'}
 const observed=Date.parse(quote.observedAt),recorded=Date.parse(quote.recordedAt)
 if(!Number.isFinite(observed))return {code:'observation_unknown',label:'Price observation time is unreported'}
 if(observed>at)return {code:'observed_later',label:'Observed after the selected time'}
 if(!Number.isFinite(recorded)||recorded>at)return {code:Number.isFinite(recorded)?'recorded_later':'recording_unknown',label:Number.isFinite(recorded)?'Recorded after the selected time':'Price recording time is unreported'}
 if(typeof quote.price!=='number'||!Number.isFinite(quote.price)||quote.price<0)return {code:'invalid',label:'Price is invalid'}
 if(quote.reason==='Price freshness is unreported')return {code:'expiry_unknown',label:quote.reason}
 if(quote.reason==='Retained price is stale')return {code:'stale',label:quote.reason}
 if(!quote.available)return {code:'unavailable',label:'Price is unavailable; original member retained'}
 if(row.returnPercent!=null)return {code:'comparable',label:'Comparable'}
 if(row.initialPrice===0)return {code:'zero_baseline',label:'Initial price is zero; percentage return is undefined'}
 return {code:'baseline_missing',label:'Missing comparable initial price or observation time'}
}
export const cohortCompareAsset=row=>cmcDexIdentity(row.subject)?{canonicalAssetKey:row.subject,symbol:row.symbol||null,displayName:row.name}:{sourceProvider:'coinmarketcap',providerId:row.subject.split(':').at(-1),symbol:row.symbol||row.name,displayName:row.name}
export function cohortResearchPath(cohort){
 const subject=cmcDexIdentity(cohort?.members?.[0]?.subject)?.subject
 return subject&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cohort?.id)?`/intel/investigate?asset=${encodeURIComponent(subject)}&lens=cohort&cohort=${cohort.id}`:null
}
export function savedCohortPath(path){
 if(typeof path!=='string'||!path.startsWith('/intel/investigate?')||path.length>800)return null
 const url=new URL(path,'https://investor-intel.invalid')
 if(url.origin!=='https://investor-intel.invalid'||url.pathname!=='/intel/investigate'||url.searchParams.get('lens')!=='cohort')return null
 return cohortResearchPath({id:url.searchParams.get('cohort'),members:[{subject:url.searchParams.get('asset')}]})
}
export function cohortCaptureMarkers(cohort,subject,at){
 const identity=cmcDexIdentity(subject),created=Date.parse(cohort?.created_at)
 if(cohort?.kind!=='dex_discovery'||!identity||!Number.isFinite(created)||created>at||!cohort.members?.some(m=>m.subject===identity.subject))return []
 return [{id:`cohort:${cohort.id}`,t:created,recordedAt:cohort.created_at,canonicalAssetKey:identity.subject,group:'research',type:'research',actorKind:'system',source:'Investor Intel',
  action:'Discovery cohort captured',label:'Cohort captured',title:'Original discovery membership first recorded by Investor Intel.',
  sourceSnapshot:{title:cohort.name,source:'CoinMarketCap discovery response',url:cohort.source_reference?.sourceUrl,
   summary:`${cohort.members.length} exact contracts first captured at ${cohort.created_at}. Response retrieved ${cohort.source_reference?.retrievedAt||'at an unreported time'}. This records cohort membership, not token creation, a thesis decision or a trade.`}}]
}
