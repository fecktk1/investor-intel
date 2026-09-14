import { readAssetEvidenceVersion } from './asset-evidence-version.ts'
import { loadCmcOperatingSettings, cmcPolicyEnvironment } from '../market-assets/cmc-operating-settings.ts'

// Only this projection may cross an explicitly shared thesis boundary. Never
// return the original pack's private context, wallet, portfolio or authored text.
export function projectThesisRecordedEvidence(row:any,allowCmc:boolean) {
 const pack=row.pack||{},fields=Object.fromEntries(Object.entries(pack.market_summary?.field_evidence||{}).map(([key,value]:[string,any])=>
  [key,!allowCmc&&value?.provider==='coinmarketcap'?{value:null,unit:value.unit,status:'restricted',provider:'coinmarketcap'}:value]))
 const restricted={status:'restricted',reason:'Current source permission does not allow retained CMC evidence.',observations:[]}
 return {version:row.content_hash,asset:pack.asset,fields,specialist:{
  derivatives_state:allowCmc?pack.derivatives_state:restricted,
  cmc_contract_state:allowCmc?pack.cmc_contract_state:restricted,
  rwa_state:allowCmc?pack.rwa_state:restricted,
  security_state:allowCmc?pack.security_state:restricted,
  benchmark_state:allowCmc?pack.benchmark_state:restricted,
  representation_state:pack.representation_state,
  holder_state:pack.holder_state},status:allowCmc?'available':'partial'}
}

export async function readThesisRecordedEvidence(admin:any,user:any,actor:{orgId:string;userId:string},thesisId:string) {
 const {data:thesis,error}=await user.from('intel_theses').select('id,org_id,user_id,visibility,subject_canonical_key').eq('org_id',actor.orgId).eq('id',thesisId).maybeSingle()
 if(error)throw Error('thesis_read_failed')
 if(!thesis||thesis.org_id!==actor.orgId||thesis.user_id!==actor.userId&&thesis.visibility!=='org')throw Error('thesis_unavailable')
 const {data:context,error:snapshotError}=await user.rpc('intel_thesis_snapshot_context',{p_org_id:actor.orgId,p_thesis_id:thesisId})
 if(snapshotError)throw Error('thesis_snapshot_read_failed')
 const version=context?.baseline?.context_pack_hash
 if(!version)return {status:'missing',reason:'This legacy thesis has no retained evidence version.'}
 const row=await readAssetEvidenceVersion(admin,{orgId:actor.orgId,userId:thesis.user_id},thesis.subject_canonical_key,version)
 const policy=cmcPolicyEnvironment(await loadCmcOperatingSettings(admin),key=>{try{return Deno.env.get(key)}catch{return undefined}})
 return projectThesisRecordedEvidence(row,policy('CMC_ALLOW_HISTORICAL_RETENTION')==='true')
}
