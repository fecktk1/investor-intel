import {CMC_CAPABILITIES,cmcAddsConvert,cmcRequestBody} from './cmc-capabilities.ts'
/** "Reproduce this call": the exact provider request one LIVE transport read made,
 * as a curl command a reader can run with THEIR OWN key. Pure, so the app renders
 * it straight from the receipt it already has (no extra read, no provider call).
 *
 * Returns null unless the receipt describes a real keyed call to a registered
 * capability: a cache hit, a remembered failure, a capture run or a stored copy
 * made no call for this view, and a keyless or mismatched receipt is not one this
 * registry can vouch for. The key is never material here: the command only ever
 * carries the literal shell variable $CMC_API_KEY, in double quotes so the
 * reader's shell expands it. Every other value is single-quoted ('\'' escaping).
 *
 * The request is rebuilt exactly as cmc-transport.ts sends it: same base, same
 * path, the canonical parameters in receipt order, convert=USD exactly when
 * cmcAddsConvert(capability) says the transport adds it, and a POST body from the
 * same cmcRequestBody(). */
export const CMC_REPRODUCE_BASE='https://pro-api.coinmarketcap.com'
export const CMC_REPRODUCE_KEY_VAR='$CMC_API_KEY'
export interface CmcReproduceReceipt {
  capability?:unknown; endpoint?:unknown; parameters?:unknown; origin?:unknown; keyMode?:unknown; provider?:unknown
}
export const shellQuote=(value:string)=>`'${String(value).replaceAll("'","'\\''")}'`
export function cmcReproduceCommand(receipt:CmcReproduceReceipt|null|undefined):string|null {
  if(!receipt||typeof receipt!=='object')return null
  if(receipt.origin!=='live'||receipt.keyMode!=='keyed')return null
  if(receipt.provider!=null&&receipt.provider!=='coinmarketcap')return null
  const name=receipt.capability
  if(typeof name!=='string'||!Object.hasOwn(CMC_CAPABILITIES,name))return null
  const spec=CMC_CAPABILITIES[name]
  if(typeof receipt.endpoint!=='string'||!receipt.endpoint||spec.path!==receipt.endpoint)return null
  const raw=receipt.parameters??{}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null
  const entries=Object.entries(raw as Record<string,unknown>)
  // Only the registry's reviewed params can have been sent; anything else means
  // the receipt is not a transport receipt and the command would not be the call.
  if(entries.some(([k,v])=>typeof v!=='string'||!spec.params.includes(k)))return null
  const params=Object.fromEntries(entries) as Record<string,string>
  const url=`${CMC_REPRODUCE_BASE}${spec.path}`
  const auth=`-H "X-CMC_PRO_API_KEY: ${CMC_REPRODUCE_KEY_VAR}" -H 'Accept: application/json'`
  if(spec.method==='POST'){
    let body:string
    try{body=JSON.stringify(cmcRequestBody(name,params))}catch{return null}
    return `curl -sS -X POST ${shellQuote(url)} ${auth} -H 'Content-Type: application/json' --data ${shellQuote(body)}`
  }
  // Only priceConversion registers a convert param, and it is exempt, so the
  // transport's query.set('convert','USD') always appends: mirror that here.
  const pairs=entries.map(([k,v])=>[k,v as string])
  if(cmcAddsConvert(name))pairs.push(['convert','USD'])
  return [`curl -sS -G ${shellQuote(url)} ${auth}`,...pairs.map(([k,v])=>`--data-urlencode ${shellQuote(`${k}=${v}`)}`)].join(' ')
}
