import {CMC_CAPABILITIES,cmcAddsConvert,cmcRequestBody} from './cmc-capabilities.ts'
/** Proof of one CoinMarketCap call, built from what the receipt already carries.
 * Pure: no IO, no Deno, no DOM, so the app, the transport and the tests share it.
 *
 * TWO THINGS LIVE HERE.
 *
 * 1. "Reproduce this call": the exact provider request, as a curl command a
 *    reader can run with THEIR OWN key. The key is never material here: the
 *    command only ever carries the literal shell variable $CMC_API_KEY, in double
 *    quotes so the reader's shell expands it. Every other value is single-quoted
 *    ('\'' escaping). A keyless receipt gets the keyless form: no key header.
 *
 *    Which request a receipt reproduces depends on how it was served:
 *      live            the call that answered THIS read
 *      cache           the call that filled the shared cache row this read used.
 *                      The row is keyed by these exact parameters, so it is the
 *                      same request, made at the receipt's retrieval time.
 *      negative-cache  the call whose failure is remembered
 *      capture/stored  only when the receipt carries the capture's own recorded
 *                      request (proof.request, written at capture time). A
 *                      capture receipt names its lane, not a request, so without
 *                      that record there is nothing exact to reproduce.
 *    Anything that is not a registered capability at its registered path, or
 *    carries a parameter the registry never sends, reproduces as null.
 *
 *    The request is rebuilt exactly as cmc-transport.ts sends it: same base, same
 *    path, the canonical parameters in receipt order, convert=USD exactly when
 *    cmcAddsConvert(capability) says the transport adds it, and a POST body from
 *    the same cmcRequestBody().
 *
 * 2. The response excerpt: a bounded, trimmed copy of what CoinMarketCap
 *    returned, taken from the response body itself (the live body, or the shared
 *    cache row that stores that body verbatim). The status block is kept as
 *    returned; the data member is cut to its first rows, each cut list is named
 *    with its real total, and long text is shortened and counted. Nothing is ever
 *    reconstructed: a body we do not hold yields no excerpt, never a guess.
 *    It is DISPLAY, not export: no CSV builder reads it (see table-csv.js). */
export const CMC_REPRODUCE_BASE='https://pro-api.coinmarketcap.com'
export const CMC_REPRODUCE_KEY_VAR='$CMC_API_KEY'
export interface CmcRecordedRequest { capability?:unknown; endpoint?:unknown; parameters?:unknown }
export interface CmcReproduceReceipt {
  capability?:unknown; endpoint?:unknown; parameters?:unknown; origin?:unknown; keyMode?:unknown; provider?:unknown
  proof?:{request?:CmcRecordedRequest|null}|null
}
/** What the command reproduces, so a reader is never told a cached figure's
 * command "is this call". */
export type CmcReproduceMeaning='this_call'|'cache_fill'|'failed_call'|'capture_call'
export interface CmcReproduceRequest {
  capability:string; endpoint:string; parameters:Record<string,string>; keyMode:'keyed'|'keyless'; meaning:CmcReproduceMeaning
}
export const shellQuote=(value:string)=>`'${String(value).replaceAll("'","'\\''")}'`

const REPRODUCE_MEANING:Record<string,CmcReproduceMeaning>={live:'this_call',cache:'cache_fill','negative-cache':'failed_call'}

/** The request a receipt reproduces and what it means, or null. */
export function cmcReproduceRequest(receipt:CmcReproduceReceipt|null|undefined):CmcReproduceRequest|null {
  if(!receipt||typeof receipt!=='object')return null
  const keyMode=receipt.keyMode==='keyed'||receipt.keyMode==='keyless'?receipt.keyMode as 'keyed'|'keyless':null
  if(!keyMode)return null
  if(receipt.provider!=null&&receipt.provider!=='coinmarketcap')return null
  const origin=typeof receipt.origin==='string'?receipt.origin:''
  const recorded=receipt.proof&&typeof receipt.proof==='object'&&receipt.proof.request&&typeof receipt.proof.request==='object'?receipt.proof.request:null
  let request:CmcRecordedRequest,meaning:CmcReproduceMeaning
  if(Object.hasOwn(REPRODUCE_MEANING,origin)){request=receipt;meaning=REPRODUCE_MEANING[origin]}
  else if((origin==='capture'||origin==='stored')&&recorded){request=recorded;meaning='capture_call'}
  else return null
  const name=request.capability
  if(typeof name!=='string'||!Object.hasOwn(CMC_CAPABILITIES,name))return null
  const spec=CMC_CAPABILITIES[name]
  if(typeof request.endpoint!=='string'||!request.endpoint||spec.path!==request.endpoint)return null
  const raw=request.parameters??{}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null
  const entries=Object.entries(raw as Record<string,unknown>)
  // Only the registry's reviewed params can have been sent; anything else means
  // the receipt is not a transport receipt and the command would not be the call.
  if(entries.some(([k,v])=>typeof v!=='string'||!spec.params.includes(k)))return null
  return {capability:name,endpoint:spec.path,parameters:Object.fromEntries(entries) as Record<string,string>,keyMode,meaning}
}

export function cmcReproduceCommand(receipt:CmcReproduceReceipt|null|undefined):string|null {
  const request=cmcReproduceRequest(receipt)
  if(!request)return null
  const {capability:name,parameters:params}=request,spec=CMC_CAPABILITIES[name]
  const url=`${CMC_REPRODUCE_BASE}${spec.path}`
  const auth=[request.keyMode==='keyed'?`-H "X-CMC_PRO_API_KEY: ${CMC_REPRODUCE_KEY_VAR}"`:null,`-H 'Accept: application/json'`].filter(Boolean).join(' ')
  if(spec.method==='POST'){
    let body:string
    try{body=JSON.stringify(cmcRequestBody(name,params))}catch{return null}
    return `curl -sS -X POST ${shellQuote(url)} ${auth} -H 'Content-Type: application/json' --data ${shellQuote(body)}`
  }
  // Only priceConversion registers a convert param, and it is exempt, so the
  // transport's query.set('convert','USD') always appends: mirror that here.
  const pairs=Object.entries(params)
  if(cmcAddsConvert(name))pairs.push(['convert','USD'])
  return [`curl -sS -G ${shellQuote(url)} ${auth}`,...pairs.map(([k,v])=>`--data-urlencode ${shellQuote(`${k}=${v}`)}`)].join(' ')
}

// ─── Response excerpt ────────────────────────────────────────────────────────

/** One list the excerpt cut: where it is, how many rows it shows, and how many
 * the response really carried. */
export interface CmcExcerptList { path:string; shown:number; total:number }
export interface CmcResponseExcerpt {
  /** The provider's status block, scalar fields as returned (timestamp,
   *  error_code, error_message, elapsed, credit_count, notice, ...). */
  status:Record<string,unknown>|null
  /** The response's data member, cut to its first rows. */
  data:unknown
  /** True when the data member did not fit at all and is left out. */
  dataOmitted:boolean
  lists:CmcExcerptList[]
  /** How many text values were shortened (each ends in an ellipsis). */
  shortened:number
  /** Anything at all left out: a cut list, shortened text, a depth cut. */
  trimmed:boolean
}
/** Where a proof's facts come from. */
export type CmcProofSource='live-response'|'shared-cache-row'|'capture-record'
/** Why a proof carries no excerpt. */
export type CmcExcerptMissing='failure_body_not_kept'|'body_not_json'|'not_recorded'|'withheld'
export interface CmcCallProof {
  source:CmcProofSource
  /** status.timestamp: CoinMarketCap's own clock for the response. */
  respondedAt:string|null
  /** When our transport received that response. */
  retrievedAt:string|null
  /** status.credit_count of THAT response: what the call that produced this
   *  figure was charged. Null only when the response did not report one. */
  creditCount:number|null
  errorCode:string|number|null
  httpStatus:number|null
  excerpt:CmcResponseExcerpt|null
  excerptMissing:CmcExcerptMissing|null
  /** A capture record's own request (the capture receipt itself names a lane). */
  request?:{capability:string;endpoint:string;parameters:Record<string,string>}|null
}

export const CMC_EXCERPT_MAX_CHARS=3000
const MAX_LIST_NOTES=20
interface Limits { rows:number; innerRows:number; text:number; depth:number }
/** Tried in order until the excerpt fits CMC_EXCERPT_MAX_CHARS. */
const ATTEMPTS:Limits[]=[{rows:3,innerRows:2,text:200,depth:6},{rows:2,innerRows:1,text:120,depth:5},{rows:1,innerRows:1,text:80,depth:4}]
const ID_KEY=/^[0-9]{1,12}$/
const isRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
interface CutState { lists:CmcExcerptList[]; shortened:number; cutDeep:boolean }

function cut(value:unknown,path:string,depth:number,limits:Limits,state:CutState):unknown {
  if(typeof value==='string'){
    if(value.length<=limits.text)return value
    state.shortened++
    return `${value.slice(0,limits.text)}…`
  }
  if(value===null||typeof value==='number'||typeof value==='boolean')return value
  if(typeof value!=='object')return null
  // The primary list sits at data or one level below it (data.rwa_assets,
  // data.quotes); anything deeper is a member's own list and is cut harder.
  const rows=depth<=1?limits.rows:limits.innerRows
  if(Array.isArray(value)){
    if(depth>=limits.depth){if(value.length){state.cutDeep=true;state.lists.push({path,shown:0,total:value.length})}return []}
    if(value.length>rows)state.lists.push({path,shown:rows,total:value.length})
    return value.slice(0,rows).map((v,i)=>cut(v,`${path}[${i}]`,depth+1,limits,state))
  }
  const entries=Object.entries(value as Record<string,unknown>)
  if(depth>=limits.depth){if(entries.length)state.cutDeep=true;return {}}
  // quotes/latest and info are keyed by CoinMarketCap id: a list in all but syntax.
  if(entries.length>rows&&entries.every(([k,v])=>ID_KEY.test(k)&&v&&typeof v==='object')){
    state.lists.push({path,shown:rows,total:entries.length})
    return Object.fromEntries(entries.slice(0,rows).map(([k,v])=>[k,cut(v,`${path}.${k}`,depth+1,limits,state)]))
  }
  return Object.fromEntries(entries.map(([k,v])=>[k,cut(v,`${path}.${k}`,depth+1,limits,state)]))
}

function statusBlock(body:unknown,text:number):Record<string,unknown>|null {
  const status=isRecord(body)&&isRecord(body.status)?body.status:null
  if(!status)return null
  const out:Record<string,unknown>={}
  for(const [k,v] of Object.entries(status)){
    if(typeof v==='string')out[k]=v.length>text?`${v.slice(0,text)}…`:v
    else if(v===null||typeof v==='number'||typeof v==='boolean')out[k]=v
  }
  return out
}

/** A bounded excerpt of one response body, or null for anything that is not a
 * parsed body. At most maxChars of JSON for the status block and data together. */
export function cmcResponseExcerpt(body:unknown,maxChars=CMC_EXCERPT_MAX_CHARS):CmcResponseExcerpt|null {
  if(body==null||typeof body!=='object')return null
  const status=statusBlock(body,200)
  // A few DEX paths answer a bare array; everything else carries `data`.
  const data=Array.isArray(body)?body:(body as Record<string,unknown>).data
  for(const limits of ATTEMPTS){
    const state:CutState={lists:[],shortened:0,cutDeep:false}
    const trimmedData=data===undefined?null:cut(data,'data',0,limits,state)
    if(JSON.stringify({status,data:trimmedData}).length>maxChars)continue
    // The cut-list notes are bounded too: the first MAX_LIST_NOTES paths, which
    // always include the primary list because it is cut first.
    return {status,data:trimmedData,dataOmitted:false,lists:state.lists.slice(0,MAX_LIST_NOTES),shortened:state.shortened,trimmed:state.lists.length>0||state.shortened>0||state.cutDeep}
  }
  // Even one row does not fit: keep the status block and say what was left out.
  const total=Array.isArray(data)?data.length:isRecord(data)?Object.keys(data).length:0
  return {status,data:null,dataOmitted:true,lists:total?[{path:'data',shown:0,total}]:[],shortened:0,trimmed:true}
}

const finiteOrNull=(v:unknown):number|null=>{if(v==null||v===''||typeof v==='boolean')return null;const n=Number(v);return Number.isFinite(n)?n:null}
const isoOrNull=(v:unknown):string|null=>{if(v==null||v==='')return null;const t=Date.parse(String(v));return Number.isFinite(t)?new Date(t).toISOString():null}

/** The proof of one call from the response body we hold for it. `body` is the
 * parsed provider body (null when none is held) and `missing` says why it is
 * null. `secret`, when given, is the live key: an excerpt that contains it is
 * withheld outright. A provider body never should, so this only ever guards. */
export function cmcCallProof(body:unknown,input:{source:CmcProofSource;httpStatus?:unknown;retrievedAt?:unknown;missing?:CmcExcerptMissing|null;secret?:string|null;request?:CmcCallProof['request']}):CmcCallProof {
  const status=isRecord(body)&&isRecord(body.status)?body.status:null
  const credit=finiteOrNull(status?.credit_count)
  let excerpt=body==null?null:cmcResponseExcerpt(body)
  let missing:CmcExcerptMissing|null=excerpt?null:(input.missing??'not_recorded')
  if(excerpt&&typeof input.secret==='string'&&input.secret.length>=8&&JSON.stringify(excerpt).includes(input.secret)){excerpt=null;missing='withheld'}
  const code=status?.error_code
  return {source:input.source,respondedAt:isoOrNull(status?.timestamp),retrievedAt:isoOrNull(input.retrievedAt),
    creditCount:credit==null?null:Math.max(0,credit),errorCode:typeof code==='string'||typeof code==='number'?code:null,
    httpStatus:finiteOrNull(input.httpStatus),excerpt,excerptMissing:missing,...(input.request?{request:input.request}:{})}
}
