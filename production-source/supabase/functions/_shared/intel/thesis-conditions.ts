import {thesisStress,type StressRule} from './investigation-calculations.ts'
import {researchIdentity,researchCmcId} from './research-identity.ts'
import {canonicalAssetKey} from '../investor-portfolio/canonical.ts'
import {observationState,type Observation} from './investigation-evidence.ts'
import {conditionPeriod,conditionSource,matchesConditionSource,conditionMaxAgeSeconds} from './condition-source.ts'
import {venueConditionObservations} from './venue-condition-sources.ts'
export function evaluateThesisConditions(rules:any[],pack:any,subject:string,now:number){
 const identity=researchIdentity({canonicalKey:subject}),cmc=researchCmcId({canonicalKey:subject})
 const aliases=new Set([subject,identity.chain?canonicalAssetKey(identity.chain,identity.tokenAddress):null,cmc?`market:coinmarketcap:${cmc}`:null,identity.sourceProvider&&identity.providerId?`market:${identity.sourceProvider}:${identity.providerId}`:null].filter(Boolean))
 // This relationship is stamped by the bounded server catalog resolver, not
 // accepted from authored rule text or a symbol supplied by the browser.
 const connected=pack.connected_identity
 if(connected?.requested===subject&&connected?.state==='verified'){
  if(connected.contractSubject)aliases.add(connected.contractSubject)
  if(connected.marketSubject)aliases.add(connected.marketSubject)
 }
 const observations:Observation[]=[...(pack.market_summary?.retained_observations||[]),...(pack.derivatives_state?.observations||[]),...(pack.cmc_contract_state?.observations||[])]
 observations.push(...venueConditionObservations(observations,pack.liquidity_state?.venue_depth,now))
 const admitted=observations.filter(o=>aliases.has(o.subject)&&o.expiresAt!=null&&observationState(o,now,conditionMaxAgeSeconds(o.metric))==='known')
 return rules.map(rule=>{
  const period=conditionPeriod(rule.time_window),explicit=typeof rule.threshold_unit==='string'&&rule.threshold_unit.length>0&&(rule.time_window==='current'||period!=null)
  const condition:StressRule={id:rule.id,metric:rule.metric,threshold:rule.threshold==null?null:Number(rule.threshold),comparator:rule.comparator,unit:rule.threshold_unit,periodSeconds:period,source_metric:rule.source_metric,rule_kind:rule.rule_kind,label:rule.description,interpretationRequired:!explicit}
  // Canonical aliases are verified before calculating. The receipt keeps the
  // original provider subject; ticker text can never join an observation.
  const contractMetric=['holder_count','liquidity_event_usd'].includes(rule.metric)
  const evaluationSubject=contractMetric?(connected?.requested===subject&&connected?.state==='verified'?connected.contractSubject:canonicalAssetKey(identity.chain,identity.tokenAddress))||subject:subject
  const candidates=admitted.filter(o=>matchesConditionSource(o,rule.source_metric,rule.metric)&&(rule.time_window!=='current'||o.periodSeconds==null))
  const result=thesisStress([condition],contractMetric?candidates:candidates.map(o=>({...o,subject})),evaluationSubject,{},now)[0]
  const original=admitted.find(o=>o.id===result.observation?.id)
  return {rule,met:result.currentlyMet,reason:result.reason,observation:original?{id:original.id,subject:original.subject,metric:original.metric,unit:original.unit,periodSeconds:original.periodSeconds??null,sourceRef:original.sourceRef,sourceUrl:original.sourceUrl??null,sourceMetric:conditionSource(original),provider:original.provider,observedAt:original.observedAt,recordedAt:original.recordedAt,expiresAt:original.expiresAt}:null}
 })
}
