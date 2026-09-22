import {digest,instant,stableJson} from './investigation-evidence.ts'
import {marketSourceReference} from './market-source-reference.ts'
import {cmcRows} from '../market-assets/cmc-capabilities.ts'
import {cmcDexIdentity,cmcDexNetwork,validateCmcDexResponse} from '../market-assets/cmc-dex.ts'
import {cmcPolicyEnvironment,loadCmcOperatingSettings} from '../market-assets/cmc-operating-settings.ts'
type Policy={historical:boolean;retainUntil:string;aiAllowed:boolean;exportAllowed:boolean}
export type MarketSourceVersion={id:string;subject:string;family:'security'|'rwa_relationship';contentHash:string;document:any;sourceReference:any;fetchedAt:string;recordedAt:string;expiresAt:string;retainUntil:string;aiAllowed:boolean;exportAllowed:boolean}
const text=(v:unknown,n=300)=>typeof v==='string'?v.slice(0,n):null
const id=(v:unknown)=>/^[1-9][0-9]{0,11}$/.test(String(v))?String(v):null
const flag=(v:unknown)=>typeof v==='boolean'?v:null
/** Source dates are unreported. Never emit these as dated price/chart facts. */
export async function normalizeMarketSourceVersions(capability:string,body:any,params:Record<string,string>,provenance:any,policy:Policy){
 if(!policy.historical||!['dexSecurity','rwaQuotes'].includes(capability)||instant(provenance?.fetchedAt)==null||instant(provenance?.expiresAt)==null)return []
 const retainUntil=new Date(Math.min(Date.parse(policy.retainUntil),Date.parse(provenance.fetchedAt)+30*86400000)).toISOString()
 if(Date.parse(retainUntil)<=Date.parse(provenance.fetchedAt))return []
 const sourceReference=await marketSourceReference(capability,params,body,provenance),documents:{subject:string;family:MarketSourceVersion['family'];document:any}[]=[]
 if(capability==='dexSecurity'){
  const network=cmcDexNetwork(params.platformName),identity=network?cmcDexIdentity(`${network.chain}:${params.address}`):null
  if(!identity||!validateCmcDexResponse(capability,body,params))throw Error('invalid_security_identity')
  const record=body.data[0]
  if(record){
   const items=(Array.isArray(record.securityItems)?record.securityItems:[]).slice(0,50).map((r:any)=>({code:text(r.code,100)??(typeof r.code==='number'?String(r.code):null),description:text(r.des,500),hit:flag(r.isHit),level:typeof r.riskyLevel==='number'||typeof r.riskyLevel==='string'?r.riskyLevel:null}))
    .sort((a:any,b:any)=>stableJson(a).localeCompare(stableJson(b)))
   documents.push({subject:identity.subject,family:'security',document:{schemaVersion:1,exists:flag(record.exist),level:record.securityLevel??null,items,omitted:Math.max(0,(record.securityItems?.length||0)-items.length),timeMeaning:'Source observation time is unreported. First recorded means first retained by Investor Intel, not when a contract changed.'}})
  }
 }else{
  const sourceRows=cmcRows('rwaQuotes',body).rows
  if(sourceRows.length>20||sourceRows.some((r:any)=>Array.isArray(r.tokens)&&r.tokens.length>500))throw Error('source_relationship_input_limit')
  for(const row of sourceRows){
   const rwaId=id(row.rwa_id);if(!rwaId)continue
   const grouped=new Map<string,any[]>()
   for(const token of (Array.isArray(row.tokens)?row.tokens:[])){const cryptoId=id(token.crypto_id);if(cryptoId)grouped.set(cryptoId,[...(grouped.get(cryptoId)||[]),token])}
   for(const [cryptoId,tokens] of grouped){
    const issuerIds=new Set(tokens.map(t=>text(t.issuer_id,100)));if(issuerIds.size!==1||!tokens[0].issuer_id)continue
    const token=tokens[0]
    documents.push({subject:`market:coinmarketcap:${cryptoId}`,family:'rwa_relationship',document:{schemaVersion:1,rwaId,cryptoId,issuerId:text(token.issuer_id,100),underlyingName:text(row.name),tokenName:text(token.name),symbol:text(token.symbol,50),issuerName:text(token.issuer_name),timeMeaning:'Relationship reported in a CMC response; its effective date is unreported. Market values are not included.'}})
   }
  }
  // A token cannot be assigned two conflicting relationships from one response.
  // Deduplicate exact repeats; leave conflicting identities unclassified.
  const bySubject=new Map<string,typeof documents>()
  for(const row of documents)bySubject.set(row.subject,[...(bySubject.get(row.subject)||[]),row])
  documents.length=0
  for(const rows of bySubject.values())if(new Set(rows.map(r=>stableJson(r.document))).size===1)documents.push(rows[0])
 }
 // The store has an explicit batch limit. Never silently drop an entire token set.
 if(documents.length>100)throw Error('source_relationship_batch_limit')
 return Promise.all(documents.map(async row=>{const contentHash=await digest(stableJson(row));return {...row,contentHash,id:`cmc-source:${await digest(stableJson({subject:row.subject,family:row.family,contentHash,fetchedAt:provenance.fetchedAt}))}`,sourceReference,fetchedAt:provenance.fetchedAt,
  expiresAt:new Date(Math.min(Date.parse(provenance.expiresAt),Date.parse(retainUntil))).toISOString(),retainUntil,aiAllowed:policy.aiAllowed,exportAllowed:policy.exportAllowed}}))
}
export async function retainMarketSourceVersions(db:any,rows:any[],now=Date.now()){
 const current=rows.filter(r=>Date.parse(r.retainUntil)>now);if(!current.length)return
 const result=await db.rpc('intel_record_market_source_versions',{p_rows:current})
 if(result.error)throw Error('source_version_storage_unavailable')
}
export function sourceVersionRow(row:any):MarketSourceVersion{return {id:row.id,subject:row.subject,family:row.family,contentHash:row.content_hash,document:row.document,sourceReference:row.source_reference,fetchedAt:row.fetched_at,recordedAt:row.recorded_at,expiresAt:row.expires_at,retainUntil:row.retain_until,aiAllowed:row.ai_allowed,exportAllowed:row.export_allowed}}
export function sourceHistoryCursor(subject:string,family:MarketSourceVersion['family'],knownAt:number,last:Pick<MarketSourceVersion,'id'|'fetchedAt'>){
 return btoa(JSON.stringify([1,subject,family,knownAt,last.fetchedAt,last.id]))
}
export function parseSourceHistoryCursor(value:unknown,subject:string,family:MarketSourceVersion['family'],now:number){
 if(value==null)return null
 try{
  if(typeof value!=='string'||value.length>1000||!/^[A-Za-z0-9+/=]+$/.test(value))throw Error()
  const row=JSON.parse(atob(value))
  if(!Array.isArray(row)||row.length!==6||row[0]!==1||row[1]!==subject||row[2]!==family||!Number.isSafeInteger(row[3])||row[3]<0||row[3]>now||typeof row[4]!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(row[4])||instant(row[4])==null||Date.parse(row[4])>row[3]||typeof row[5]!=='string'||!/^cmc-source:[a-f0-9]{64}$/.test(row[5]))throw Error()
  return {knownAt:row[3] as number,fetchedAt:row[4] as string,id:row[5] as string}
 }catch{throw Error('invalid_source_history_cursor')}
}
/** Indexed retained reads, never provider calls. Callers establish asset identity
 * and authorize private joins before using the result. */
export async function readMarketSourceVersions(db:any,subject:string,family:MarketSourceVersion['family'],now:number,purpose:'display'|'research'='research',limit=10,cursor?:string|null){
 const before=parseSourceHistoryCursor(cursor,subject,family,now),knownAt=before?.knownAt??now
 const base={subject,family,knownAt,versions:[] as MarketSourceVersion[],has_more:false,nextCursor:null as string|null,reason:null as string|null}
 if(!subject||!['security','rwa_relationship'].includes(family)||!Number.isInteger(limit)||limit<1||limit>25)return {...base,status:'unsupported',reason:'A supported exact source identity is required.'}
 try{
  const policy=cmcPolicyEnvironment(await loadCmcOperatingSettings(db,now),key=>{try{return Deno.env.get(key)}catch{return undefined}},now)
  if(policy('CMC_ALLOW_HISTORICAL_RETENTION')!=='true'||purpose==='research'&&policy('CMC_ALLOW_AI_PROCESSING')!=='true')return {...base,status:'restricted',reason:'Current source rights do not permit this retained use.'}
  let q=db.from('intel_market_source_versions').select('*').eq('subject',subject).eq('family',family).gt('retain_until',new Date(now).toISOString()).lte('recorded_at',new Date(knownAt).toISOString()).lte('fetched_at',new Date(knownAt).toISOString()).order('fetched_at',{ascending:false}).order('id',{ascending:false}).limit(limit+1)
  // Both strings are strictly parsed above before entering a PostgREST filter.
  if(before)q=q.or(`fetched_at.lt.${before.fetchedAt},and(fetched_at.eq.${before.fetchedAt},id.lt.${before.id})`)
  if(purpose==='research')q=q.eq('ai_allowed',true)
  const {data,error}=await q;if(error||!Array.isArray(data))throw Error('source_history_read_failed')
  const versions=data.slice(0,limit).map(sourceVersionRow)
  return {...base,versions,has_more:data.length>limit,nextCursor:data.length>limit&&versions.length?sourceHistoryCursor(subject,family,knownAt,versions.at(-1)!):null,status:versions.length?'available':'missing',reason:versions.length?null:before?'No older source responses remain within current retention and the original knowledge cutoff.':'No retained source version. First observed coverage starts with an explicit shared refresh.'}
 }catch{return {...base,status:'error',reason:'Retained source versions could not be read.'}}
}
/** Only matching, unique source codes can be compared. Removed coverage is not
 * a cleared flag; false and level zero remain explicit source values. */
export function securityVersionChanges(versions:MarketSourceVersion[]){
 const sorted=[...versions].filter(v=>v.family==='security').sort((a,b)=>Date.parse(b.fetchedAt)-Date.parse(a.fetchedAt)),current=sorted[0],previous=sorted[1]
 if(!current||!previous)return {status:'baseline_needed',current:current??null,previous:null,changes:[],ambiguousCodes:[] as string[],note:'Two retained source versions are required; past flags are not reconstructed.'}
 if(current.subject!==previous.subject)return {status:'incompatible',current,previous,changes:[],ambiguousCodes:[] as string[],note:'Source identities do not match.'}
 const unique=(items:any[])=>{const map=new Map<string,any>();for(const item of items){if(!item.code)continue;map.set(item.code,map.has(item.code)?null:item)}return map}
 const a=unique(previous.document.items||[]),b=unique(current.document.items||[]),changes:any[]=[],ambiguousCodes:string[]=[]
 for(const [field,code] of [['exists','Source coverage'],['level','Source classification']]){
  const before=previous.document[field]??null,after=current.document[field]??null
  if(before!==after)changes.push({code,field,before:{value:before},after:{value:after},kind:before==null?'coverage_added':after==null?'coverage_removed':'reported_change'})
 }
 for(const code of new Set([...a.keys(),...b.keys()])){
  const before=a.get(code),after=b.get(code);if(before===null||after===null){ambiguousCodes.push(code);continue}
  if(!before||!after){changes.push({code,before:before??null,after:after??null,kind:before?'coverage_removed':'coverage_added'});continue}
  if(before.hit!==after.hit||before.level!==after.level)changes.push({code,before,after,kind:'reported_change'})
 }
 return {status:'compared',current,previous,changes,ambiguousCodes,note:'Changes were first recorded here at the newer version time. CMC supplies no effective change time. This is not a safety verdict.'}
}
