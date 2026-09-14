type Issue={code:string;path:string;message:string}
export function narrativeClaimQuality(structured:any,pack:any){
 const applicable=Array.isArray(pack?.member_assets)&&pack.member_assets.some((member:any)=>Array.isArray(member?.headlines?.holders?.records)&&member.headlines.holders.records.some((record:any)=>typeof record.top10Percent==='number'&&Number.isFinite(record.top10Percent)))
 const issues:Issue[]=[],scope='Holder count versus percentile wording only; not comprehensive factual validation.'
 if(!applicable)return {version:1,status:'not_applicable',issues,scope}
 let characters=0,nodes=0
 const skip=new Set(['evidence_quality','sources','source_url','sourceUrl','sourceRef','source_ref','data_freshness','data_coverage'])
 function visit(value:any,path:string,depth:number){
  if(++nodes>5000||depth>15){if(!issues.some(i=>i.code==='claim_check_limit'))issues.push({code:'claim_check_limit',path,message:'The generated claim check exceeded its bounded review size.'});return}
  if(typeof value==='string'){
   characters+=value.length
   if(characters>250000){if(!issues.some(i=>i.code==='claim_check_limit'))issues.push({code:'claim_check_limit',path,message:'The generated claim check exceeded its bounded review size.'});return}
   for(const match of value.matchAll(/\b(?:top|largest)[-\s]*(?:10|ten)\s*(?:%|percent(?:ile)?\b)/gi)){
    const before=value.slice(Math.max(0,match.index!-40),match.index),near=value.slice(Math.max(0,match.index!-100),match.index!+match[0].length+100)
    if(/(?:not|never|rather than)\s+(?:the\s+)?$/i.test(before))continue
    if(!/holder|account|concentrat|suppl|ownership|population/i.test(near))continue
    issues.push({code:'holder_count_as_percentile',path,message:'The source reports the share held by ten accounts, not a percentile of the account population.'});break
   }
  }else if(Array.isArray(value)){for(let i=0;i<value.length&&i<5000;i++)visit(value[i],`${path}[${i}]`,depth+1)}
  else if(value&&typeof value==='object')for(const [key,child]of Object.entries(value))if(!skip.has(key))visit(child,path?`${path}.${key}`:key,depth+1)
 }
 visit(structured,'',0)
 return {version:1,status:issues.length?'needs_review':'checked',issues,scope}
}

export function annotateNarrativeClaims(structured:any,pack:any){
 return {...structured,evidence_quality:narrativeClaimQuality(structured,pack)}
}

export const NARRATIVE_METRIC_GUIDANCE='top10Percent is the reported supply share held by the ten largest accounts, never the top ten percent of accounts. sampledTop1Percent is relative to its recorded sample and is not a share of total supply. Unknown populations do not establish beneficial ownership. Preserve source clocks and explicit network identities. In prose use readable rounded figures (about four significant digits for prices, two decimals for percentages, compact millions/billions); exact original values remain in the evidence. Use readable score names instead of internal field names.'
