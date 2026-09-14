import {NARRATIVE_METRIC_GUIDANCE} from './narrative-claim-quality.ts'
const sections = ['market','derivatives','cmc_contract','holders','rwa','security','benchmark','liquidity','representation','cex','dex','flow','narrative','news','historical']
const scores = ['momentum_score','chatter_score','price_confirmation_score','volume_confirmation_score','breadth_score','risk_score','crowding_score','confidence_score','freshness_score','global_priority_score','scored_at','stage_changed_at','lifecycle_stage','signal_class','onchain_status']
const sourceLists = ['narrative_signals','category_rotation','macro_rotation']
const object = (value:any) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const pick = (value:any, keys:string[]) => Object.fromEntries(keys.filter(key=>value?.[key] !== undefined).map(key=>[key,value[key]]))
function coverage(value:any) {
  return { confidence_impact:value?.confidence_impact || 'unknown',should_show_warning:value?.should_show_warning === true,
    material_gap_count:Array.isArray(value?.material_gaps)?value.material_gaps.length:0,unavailable_source_count:Array.isArray(value?.unavailable_sources)?value.unavailable_sources.length:0 }
}

/** Whole-record projection: every exact member precedes optional context.
 * Serialized JSON, values and their citations are never cut to fit. */
export function narrativePromptContext(context:any,maxChars=9000) {
  const original=object(context?.narrative_evidence_pack),members=Array.isArray(original.member_assets)?original.member_assets.slice(0,8):[]
  const projected:any={slug:original.slug??null,content_hash:original.content_hash??null,membership_evidence_version:original.membership_evidence_version??null,
    taxonomy:pick(original.taxonomy,['id','slug','name']),state:pick(original.state,scores),source_states:object(original.source_states),
    membership_context:pick(original.membership_context,['unresolved_count','duplicate_count','omitted_count','has_more']),
    bounded_source_record_counts:Object.fromEntries(sourceLists.map(key=>[key,original.bounded_source_record_counts?.[key]??(Array.isArray(original[key])?original[key].length:0)])),
    data_coverage:coverage(original.data_coverage),member_assets:members.map((member:any)=>({
      subject:pick(member.subject,['canonical_key','symbol','source_provider','provider_id','chain','token_address']),content_hash:member.content_hash,stale_after:member.stale_after,
      coverage:coverage(member.coverage),recorded_market_fields:['current_price','change_24h_pct','change_7d_pct','volume_24h','market_cap','fdv'].filter(key=>member.headlines?.market?.field_evidence?.[key] != null),available_headline_sections:sections.filter(key=>member.headlines?.[key]!=null),headlines:{market:{field_evidence:{}}},
    })),narrative_signals:[],category_rotation:[],macro_rotation:[]}
  const result:any={narrative_evidence_pack:projected,metric_guidance:NARRATIVE_METRIC_GUIDANCE,projection:{version:4,omittedRecords:0,included_source_records:{narrative_signals:0,category_rotation:0,macro_rotation:0},
    note:'Whole original records from the named versions. Use bounded_source_record_counts and source_states to assess coverage: an empty projected array is not an absent source. Omitted fields are not missing source data and cannot justify a bearish or data-coverage claim. Compare recorded_market_fields with included field_evidence. Omitted detail remains in the named versions. Category and macro rows are backdrop, not verified narrative members or causal drivers. Narrative scores are not mindshare. Source clocks remain separate.'}}
  const fits=()=>JSON.stringify(result).length<=maxChars-32
  if(!fits())throw new Error('narrative_prompt_identity_budget_exceeded')
  function add(target:any,key:string,value:any){
    if(value===undefined)return false
    const previous=target[key],existed=Object.hasOwn(target,key);target[key]=value
    if(fits())return true
    if(existed)target[key]=previous;else delete target[key]
    result.projection.omittedRecords++;return false
  }
  function marketField(i:number,key:string){
    const source=members[i].headlines?.market,field=source?.field_evidence?.[key],headlines=projected.member_assets[i].headlines
    if(field!=null)add(headlines,'market',{...headlines.market,[key]:source[key]??field.value??null,field_evidence:{...headlines.market?.field_evidence,[key]:field}})
    else if(key==='current_price'&&source&&Object.keys(source).length)add(headlines,'market',source)
  }
  for(const key of ['current_price','change_24h_pct','volume_24h'])for(let i=0;i<members.length;i++)marketField(i,key)
  const sourceRows = (key:string) => Array.isArray(original[key]) ? original[key].slice(0,10) : []
  // Narrative-specific sources precede optional asset depth. Keep each complete
  // source record, including its original text, URL and time.
  for(const key of sourceLists)for(const row of sourceRows(key).slice(0,key==='narrative_signals'?2:1))add(projected,key,[...projected[key],row])
  // Non-price evidence precedes secondary quote fields, after comparable member performance.
  for(const section of ['holders','derivatives','cmc_contract'])for(let i=0;i<members.length;i++){
    const source=members[i].headlines?.[section]
    if(source!=null)add(projected.member_assets[i].headlines,section,source)
  }
  add(projected,'data_coverage',original.data_coverage)
  for(let i=0;i<members.length;i++)add(projected.member_assets[i],'coverage',members[i].coverage)
  for(const key of ['change_7d_pct','market_cap','fdv'])for(let i=0;i<members.length;i++)marketField(i,key)
  for(const section of sections.filter(key=>!['market','holders','derivatives','cmc_contract'].includes(key)))for(let i=0;i<members.length;i++){
    if(members[i].headlines?.[section]!=null)add(projected.member_assets[i].headlines,section,members[i].headlines[section])
  }
  for(const key of sourceLists)for(const row of sourceRows(key))if(!projected[key].includes(row))add(projected,key,[...projected[key],row])
  add(projected,'leaders_laggards',original.leaders_laggards)
  add(projected.taxonomy,'description',original.taxonomy?.description)
  add(projected.state,'onchain_summary',original.state?.onchain_summary)
  if(!Object.keys(original).length)add(result,'legacy_narrative_context',context)
  for(const key of sourceLists)result.projection.included_source_records[key]=projected[key].length
  if(JSON.stringify(result).length>maxChars)throw new Error('narrative_prompt_budget_exceeded')
  return result
}
