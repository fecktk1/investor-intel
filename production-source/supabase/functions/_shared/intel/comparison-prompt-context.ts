import {representationPromptState} from './representation-review.ts'
import {contractEvidencePreview} from './cmc-contract-projection.ts'
const text = (value: unknown, max = 160) => typeof value === 'string' ? value.slice(0, max) : null
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
const prices = ['current_price', 'market_cap', 'fdv', 'volume_24h', 'change_24h_pct', 'change_7d_pct']
const states = ['liquidity_state', 'cex_state', 'dex_state', 'onchain_state', 'holder_state', 'unlock_state', 'catalyst_state', 'news_state', 'flow_state']
const wholeStates = ['representation_state','derivatives_state','cmc_contract_state','rwa_state','security_state','benchmark_state']
export const COMPARISON_EVIDENCE_VERSION=9
/** One final comparison budget, not a lossy per-asset budget followed by a
 * second budget. Private context/notes are excluded before combining assets. */
export function comparisonEvidenceInput(result:any){
 const pack=result?.pack||{}
 return {content_hash:result.contentHash,subject:result.subject,pack:Object.fromEntries(['market_summary','data_coverage',...wholeStates,...states].filter(key=>pack[key]!=null).map(key=>[key,key==='representation_state'?representationPromptState(pack[key]):pack[key]]))}
}
function contractPreview(value:any,limit:number){
 const rows=Array.isArray(value.observations)?value.observations:[],priority=['holder_count','liquidity_event_usd','swap_event_usd','price']
 // Market fields already carry price. Preserve another evidence dimension before
 // spending the remaining budget on a duplicate quote from the contract reader.
 const rank=(metric:string)=>{const index=priority.indexOf(metric);return index<0?priority.length:index}
 const observations=contractEvidencePreview([...rows].sort((a,b)=>rank(a.metric)-rank(b.metric)),limit)
 return {subject:value.subject,status:value.status,evaluated_at:value.evaluated_at,reason:value.reason,coverage:value.coverage,observations,
  source_status:Object.fromEntries((value.sources||[]).map((s:any)=>[s.metric,{status:s.status,...(s.status==='error'?{reason:s.reason}:{})}])),
  projection_omitted_observations:rows.length-observations.length,
  ...(value.attention_comparison?{attention_comparison:{status:'prompt_omitted'}}:{}),
  projection_note:'Whole original records; omitted history remains in this version. Accounts are not people; pool activity is not depth. A single count does not establish growth.'}
}
function bounded(value: any, depth = 0): any {
  if (typeof value === 'string') return value.slice(0, 160)
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (depth >= 3) return undefined
  if (Array.isArray(value)) return value.slice(0, 3).map(v => bounded(v, depth + 1))
  return Object.fromEntries(Object.entries(value).slice(0, 12).map(([k, v]) => [k, bounded(v, depth + 1)]))
}
// Every basket member receives its core evidence before optional detail consumes
// the prompt budget. Never truncate serialized JSON or silently lose asset #2.
export function comparisonPromptContext(context: any) {
  const original = Array.isArray(context?.asset_evidence_packs) ? context.asset_evidence_packs.slice(0, 4) : []
  const packs = original.map((entry: any) => {
    const market = entry.pack?.market_summary || {}, fresh = market.freshness || {}, coverage = entry.pack?.data_coverage || {}
    return {
      subject: { canonical_key: text(entry.subject?.canonical_key, 240), symbol: text(entry.subject?.symbol, 40), source_provider: text(entry.subject?.source_provider, 40), provider_id: text(entry.subject?.provider_id, 80) },
      content_hash: text(entry.content_hash, 80),
      pack: {
        market_summary: { ...Object.fromEntries(prices.map(key => [key, market.field_evidence?.[key] ? null : numeric(market[key])])), field_evidence:{}, freshness: { status: text(fresh.status, 30), as_of: text(fresh.as_of, 40), recorded_at: text(fresh.recorded_at, 40), stale_after: text(fresh.stale_after, 40), provider: text(fresh.provider, 40), source_ref: text(fresh.source_ref, 300), mixed_observation_times:fresh.mixed_observation_times===true,oldest_observed_at:text(fresh.oldest_observed_at,40),newest_observed_at:text(fresh.newest_observed_at,40) } },
        data_coverage: { material_gaps: (coverage.material_gaps || []).slice(0, 3).map((v: any) => text(v, 120)), confidence_impact: text(coverage.confidence_impact, 30) },
        prompt_omitted_sections:[...prices.filter(key=>market.field_evidence?.[key]!=null).map(key=>`market_summary.field_evidence.${key}`),...[...wholeStates,...states].filter(key=>entry.pack?.[key]!=null)],
      } as Record<string, any>,
    }
  })
  const result = { asset_evidence_packs: packs, comparison_scope: 'Compare each exact asset using its own observations and clocks. Use available dated holder counts as counts, not proof of growth or people. Public pool events are not executable depth. Omitted detail remains in the full version; do not describe it as missing coverage. Unrelated market news is excluded.', prompt_compacted: true }
  // Preserve complete per-field source clocks before any optional context. A
  // value whose citation cannot fit is withheld only in this prompt projection.
  // Visit every basket member for one field before moving to the next field.
  const addMarketField=(key:string,i:number)=>{
    const originalMarket=original[i]?.pack?.market_summary,field=originalMarket?.field_evidence?.[key]
    if(field==null)return
    const market=packs[i].pack.market_summary,omitted=packs[i].pack.prompt_omitted_sections
    packs[i].pack.prompt_omitted_sections=omitted.filter((name:string)=>name!==`market_summary.field_evidence.${key}`)
    market.field_evidence[key]=field;market[key]=numeric(originalMarket[key])
    if(JSON.stringify(result).length>8500){delete market.field_evidence[key];market[key]=null;packs[i].pack.prompt_omitted_sections=omitted}
  }
  for(const key of ['current_price','market_cap'])for(let i=0;i<packs.length;i++)addMarketField(key,i)
  // Reserve a whole non-price observation (or its exact missing/error state)
  // before repeated quote provenance can consume every specialist evidence slot.
  // This is a prompt projection only; all original records remain in the pack.
  for(let i=0;i<packs.length;i++){
    const value=original[i]?.pack?.cmc_contract_state
    if(value==null)continue
    const omitted=packs[i].pack.prompt_omitted_sections
    packs[i].pack.prompt_omitted_sections=omitted.filter((name:string)=>name!=='cmc_contract_state')
    packs[i].pack.cmc_contract_state=contractPreview(value,1)
    if(JSON.stringify(result).length>8500){delete packs[i].pack.cmc_contract_state;packs[i].pack.prompt_omitted_sections=omitted}
  }
  for(const key of prices.filter(key=>!['current_price','market_cap'].includes(key)))for(let i=0;i<packs.length;i++)addMarketField(key,i)
  for (const key of [...wholeStates,...states]) for (let i = 0; i < packs.length; i++) {
    const value = original[i]?.pack?.[key]
    if (value == null) continue
    const omitted=packs[i].pack.prompt_omitted_sections,previous=packs[i].pack[key]
    packs[i].pack.prompt_omitted_sections=omitted.filter((name:string)=>name!==key)
    const variants=key==='cmc_contract_state'?[value,...[6,4,2,1].map(n=>contractPreview(value,n))]:[key==='representation_state'?representationPromptState(value):wholeStates.includes(key)?value:bounded(value)]
    let included=false
    for(const variant of variants){packs[i].pack[key]=variant;if(JSON.stringify(result).length<=8500){included=true;break}}
    if (!included) {if(previous!=null)packs[i].pack[key]=previous;else delete packs[i].pack[key];packs[i].pack.prompt_omitted_sections=omitted}
  }
  return result
}
