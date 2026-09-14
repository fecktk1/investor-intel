import {cmcParams,cmcRows,cmcObservedAt} from './cmc-capabilities.ts'
import type {MarketAssetsContext} from './types.ts'
import type {CmcResult} from './cmc-transport.ts'

// Reviewed provider IDs, not ticker matches. One hot batch serves all five assets.
export const CMC_FOCUS_IDS=['1','1027','1839','5426','5805']
export function quoteRefreshSeconds(params:Record<string,string>){return params.id===CMC_FOCUS_IDS.join(',')?60:300}
export function quoteGroupRows(ids:string[]){
 const sorted=[...new Set(ids)].filter(id=>/^[1-9][0-9]{0,9}$/.test(id)&&!CMC_FOCUS_IDS.includes(id)).sort((a,b)=>Number(a)-Number(b))
 return sorted.flatMap((id,index)=>({provider_id:id,quote_batch_ids:sorted.slice(Math.floor(index/250)*250,Math.floor(index/250)*250+250)}))
}
/** A durable public universe group, or one bounded cold group. Never user-specific cache keys. */
export function planQuoteGroups(ids:string[],rows:any[]=[]){
 const groups=new Map<string,string[]>(),cold:string[]=[]
 for(const id of ids){
  const stored=rows.find(row=>String(row.provider_id)===id)?.quote_batch_ids
  const valid=Array.isArray(stored)&&stored.length>0&&stored.length<=250&&stored.includes(id)&&stored.every(x=>typeof x==='string'&&/^[1-9][0-9]{0,9}$/.test(x))
  if(!CMC_FOCUS_IDS.includes(id)&&!valid){cold.push(id);continue}
  const group=CMC_FOCUS_IDS.includes(id)?CMC_FOCUS_IDS:[...new Set(stored as string[])].sort((a,b)=>Number(a)-Number(b))
  groups.set(group.join(','),group)
 }
 if(cold.length)groups.set(cold.join(','),cold)
 return [...groups.values()]
}
type Request=(name:string,input:Record<string,unknown>,ctx?:MarketAssetsContext)=>Promise<CmcResult>
export async function requestGroupedQuotes(input:Record<string,unknown>,ctx:MarketAssetsContext|undefined,request:Request):Promise<CmcResult>{
 const params=cmcParams('quotes',input),ids=params.id.split(',')
 let rows:any[]=[]
 const ordinary=ids.filter(id=>!CMC_FOCUS_IDS.includes(id))
 if(ordinary.length&&ctx?.supabase?.from)try{
  const result=await ctx.supabase.from('market_assets').select('provider_id,quote_batch_ids').eq('source_provider','coinmarketcap').in('provider_id',ordinary).limit(250)
  if(!result.error)rows=result.data||[]
 }catch{/* Older schemas and off-universe assets use a bounded exact-ID batch. */}
 const groups=planQuoteGroups(ids,rows)
 // A scattered basket must not expand into hundreds of universe batches.
 const selected=groups.length<=4?groups:[ids]
 const results:CmcResult[]=[]
 for(const group of selected)results.push(await request('quotes',{...params,id:group.join(',')},ctx))
 const found=results.flatMap(r=>cmcRows('quotes',r.payload).rows).filter(row=>ids.includes(String(row.id)))
 const unique=[...new Map(found.map(row=>[String(row.id),row])).values()]
 const payload=unique.length?{data:unique}:null
 const clock=(field:'fetchedAt'|'expiresAt')=>{const values=results.filter(r=>r.payload).map(r=>Date.parse(r.provenance[field]||''));return values.length&&values.every(Number.isFinite)?new Date(Math.min(...values)).toISOString():null}
 const first=results[0],missing=unique.length<ids.length
 return {payload,state:payload?(results.every(r=>r.state==='fresh')&&!missing?'fresh':'stale'):(first.state==='fresh'||first.state==='stale'?'unavailable':first.state),
  reason:results.find(r=>r.reason)?.reason||(missing?'missing_coverage':null),
  provenance:{...first.provenance,observedAt:payload?cmcObservedAt(payload):null,fetchedAt:clock('fetchedAt'),expiresAt:clock('expiresAt')}}
}
