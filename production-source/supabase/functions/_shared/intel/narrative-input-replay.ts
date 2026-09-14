import {digest,stableJson} from './investigation-evidence.ts'
import {containsCmcOrigin} from './ai-source-policy.ts'
import {cmcPolicyEnvironment,loadCmcOperatingSettings} from '../market-assets/cmc-operating-settings.ts'

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const ROOT_KEYS=new Set(['content_hash','membership_evidence_version','source_states','membership_context','slug','taxonomy','state','member_assets','category_rotation','macro_rotation','narrative_signals','leaders_laggards','data_coverage'])
const privateKeys=new Set(['org_id','orgId','user_id','userId','private_owner_id','portfolio_id','portfolioId','wallet_address','walletAddress'])
export type NarrativeInputReceipt={version:1;id:string;content_hash:string;slug:string;recorded_at:string;retain_until:string;root_evidence_hash:string;normalization:string}
/** Failure diagnostics must never expose source bodies, private words or SQL. */
export function narrativeInputFailureCode(error:unknown){
 const code=error instanceof Error?error.message:''
 return new Set(['invalid_narrative_input','narrative_input_bounds','narrative_input_too_large','private_narrative_input','narrative_input_retention_restricted','narrative_input_source_clock_unavailable','narrative_input_retention_expired','narrative_input_storage_unavailable']).has(code)?code:'narrative_input_storage_unavailable'
}
export async function narrativeInputDocument(pack:any){
 if(!pack||typeof pack!=='object'||Array.isArray(pack)||Object.keys(pack).some(k=>!ROOT_KEYS.has(k))||!pack.taxonomy?.id||!/^[a-z0-9][a-z0-9_-]{0,119}$/.test(pack.slug)||typeof pack.content_hash!=='string')throw Error('invalid_narrative_input')
 for(const [rows,max]of [[pack.member_assets,8],[pack.membership_context?.rows,20],[pack.narrative_signals,8],[pack.category_rotation,10],[pack.macro_rotation,2]] as [unknown,number][])if(!Array.isArray(rows)||rows.length>max)throw Error('narrative_input_bounds')
 const original=JSON.stringify(pack)
 if(new TextEncoder().encode(original).length>500000)throw Error('narrative_input_too_large')
 const document=JSON.parse(original)
 // This operational flag is not evidence and must not create a new version on
 // a cache hit. Every actual source value, clock, word and failure is retained.
 for(const member of document.member_assets)delete member.cached
 let nodes=0
 function check(v:any,depth=0){
  if(++nodes>20000||depth>25)throw Error('narrative_input_bounds')
  if(v&&typeof v==='object')for(const [k,child]of Object.entries(v)){
   if(privateKeys.has(k)&&child!=null&&child!=='')throw Error('private_narrative_input')
   check(child,depth+1)
  }
 }
 check(document)
 return {document,hash:await digest(stableJson(document))}
}
export async function narrativeReplayPolicy(db:any,now=Date.now()){
 const read=cmcPolicyEnvironment(await loadCmcOperatingSettings(db,now),k=>{try{return Deno.env.get(k)}catch{return undefined}},now)
 const days=Number(read('CMC_HISTORY_RETENTION_DAYS')),expires=Date.parse(read('CMC_SOURCE_POLICY_EXPIRES_AT')||'')
 return {allowed:read('CMC_ALLOW_HISTORICAL_RETENTION')==='true'&&days>0&&Number.isFinite(expires)&&expires>now,
  days:Math.min(30,Number.isFinite(days)?Math.max(0,days):0),expires}
}
// Conservatively use the oldest recorded CMC source clock. Unknown source
// timestamps cannot acquire a fresh 30-day lifetime merely through this copy.
export function narrativeRetentionDeadline(pack:any,policy:{allowed:boolean;days:number;expires:number},now:number){
 if(!policy.allowed)throw Error('narrative_input_retention_restricted')
 const clocks:number[]=[]
 function visit(v:any,cmc=false){
  if(!v||typeof v!=='object')return
  // A subject's CMC ID selects an asset; it does not own every source in a
  // mixed pack. Only actual provider/source provenance scopes these clocks.
  const isCmc=(s:unknown)=>typeof s==='string'&&/^(?:coinmarketcap|cmc)(?:$|[:_ /-])|^https?:\/\/(?:pro-api\.|www\.)?coinmarketcap\.com(?:\/|$)/i.test(s)
  const providers=[v.provider,v.source_provider,v.sourceProvider,...(Array.isArray(v.providers)?v.providers:[])].filter(s=>typeof s==='string'&&s)
  const provider=providers.some(isCmc)||[v.source,v.source_ref,v.sourceRef,v.source_url,v.sourceUrl].some(isCmc)
  const current=provider||(providers.length===0&&cmc)
  if(current)for(const k of ['fetched_at','fetchedAt','recorded_at','recordedAt','observed_at','observedAt','as_of']){
   const n=typeof v[k]==='string'?Date.parse(v[k]):NaN;if(Number.isFinite(n))clocks.push(n)
  }
  for(const child of Object.values(v))visit(child,current)
 }
 visit(pack)
 if(containsCmcOrigin(pack)&&!clocks.length)throw Error('narrative_input_source_clock_unavailable')
 const deadline=Math.min(policy.expires,now+policy.days*86400000,...clocks.map(t=>t+policy.days*86400000))
 if(!Number.isFinite(deadline)||deadline<=now)throw Error('narrative_input_retention_expired')
 return new Date(deadline).toISOString()
}
export async function recordNarrativeInput(db:any,pack:any,now=Date.now(),policyLoader=narrativeReplayPolicy):Promise<NarrativeInputReceipt>{
 const {document,hash}=await narrativeInputDocument(pack),retainUntil=narrativeRetentionDeadline(document,await policyLoader(db,now),now)
 const {data,error}=await db.rpc('intel_record_narrative_snapshot',{p_hash:hash,p_slug:document.slug,p_pack:document,p_retain_until:retainUntil})
 if(error||!data||data.id!==`narrative-input:${hash}`||data.content_hash!==hash||data.slug!==document.slug||!Number.isFinite(Date.parse(data.recorded_at))||!Number.isFinite(Date.parse(data.retain_until))||Date.parse(data.retain_until)<=now)throw Error('narrative_input_storage_unavailable')
 return {...data,version:1,root_evidence_hash:pack.content_hash,normalization:'Only member cache-hit flags are excluded. This is the complete bounded root evidence input, not all underlying provider data.'}
}
export function attachNarrativeInput(structured:any,receipt:NarrativeInputReceipt){return {...structured,narrative_input_receipt:structuredClone(receipt)}}

/** Caller JWT/RLS plus explicit owner/org checks before any service-store read.
 * Page slices are from the original root, never reassembled or provider-fetched. */
export async function readNarrativeInput(userDb:any,serviceDb:any,actor:{userId:string;orgId:string},params:any,now=Date.now(),policyLoader=narrativeReplayPolicy){
 if(!params||Object.keys(params).some(k=>!['artifactId','section','page'].includes(k))||!UUID.test(params.artifactId||'')||!['context','members','signals'].includes(params.section)||!Number.isInteger(params.page)||params.page<1||params.page>8)throw Error('invalid_narrative_input_request')
 const empty={state:'unavailable',receipt:null as any,records:[] as any[],page:params.page,total:0,hasMore:false,reason:'Original inputs are unavailable for this research.'}
 const {data:a,error}=await userDb.from('research_artifacts').select('id,org_id,private_owner_id,artifact_type,structured').eq('id',params.artifactId).eq('org_id',actor.orgId).maybeSingle()
 if(error)throw Error('narrative_input_read_failed')
 if(!a||a.id!==params.artifactId||a.org_id!==actor.orgId||a.private_owner_id&&a.private_owner_id!==actor.userId)return empty
 const ref=a.structured?.narrative_input_receipt
 if(a.artifact_type!=='narrative_report'||!ref)return {...empty,state:'not_recorded',reason:'This report predates original input replay. Its inputs will not be reconstructed from current data.'}
 if(ref.version!==1||!/^narrative-input:[a-f0-9]{64}$/.test(ref.id)||ref.id!==`narrative-input:${ref.content_hash}`)throw Error('narrative_input_receipt_invalid')
 const base={...empty,receipt:ref}
 const currentPolicy=await policyLoader(serviceDb,now)
 if(!currentPolicy.allowed)return {...base,state:'restricted',reason:'Current source rights do not permit retained input viewing.'}
 const {data:r,error:sourceError}=await serviceDb.from('intel_narrative_evidence_snapshots').select('*').eq('id',ref.id).maybeSingle()
 if(sourceError)throw Error('narrative_input_read_failed')
 if(!r)return {...base,reason:'The named original input snapshot is unavailable.'}
 if(r.content_hash!==ref.content_hash||r.slug!==ref.slug)throw Error('narrative_input_receipt_invalid')
 if(!r.pack||Date.parse(r.retain_until)<=now)return {...base,state:'expired',reason:'Original source values have reached their retention limit. Your report and its evidence reference remain recorded.'}
 const checked=await narrativeInputDocument(r.pack)
 if(checked.hash!==ref.content_hash)throw Error('narrative_input_receipt_invalid')
 try{narrativeRetentionDeadline(r.pack,currentPolicy,now)}catch{return {...base,state:'expired',reason:'Original source values are outside the currently permitted retention window.'}}
 const p=r.pack,records=params.section==='members'?p.member_assets:params.section==='signals'?p.narrative_signals:[Object.fromEntries(Object.entries(p).filter(([k])=>!['member_assets','narrative_signals'].includes(k)))]
 const size=params.section==='signals'?4:1,offset=(params.page-1)*size
 return {...base,state:'available',records:records.slice(offset,offset+size),page:params.page,total:records.length,hasMore:offset+size<records.length,reason:null}
}
