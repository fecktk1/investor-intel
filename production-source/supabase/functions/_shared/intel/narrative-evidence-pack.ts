import { h32 } from '../core-intel/hashing.ts'
import { assembleAssetMiniPack, type AssetMiniPack } from './asset-mini-pack.ts'
import type { DataCoverage } from './asset-evidence-pack.ts'

// deno-lint-ignore no-explicit-any
type DB = any
// deno-lint-ignore no-explicit-any
type Any = any

export interface NarrativeEvidencePack {
  content_hash: string
  slug: string
  taxonomy: Any | null
  state: Any | null
  membership_evidence_version: 1
  source_states: Record<string,string>
  membership_context: { rows: Any[]; unresolved_count:number; duplicate_count:number; omitted_count:number; has_more:boolean; note:string }
  member_assets: AssetMiniPack[]
  category_rotation: Any[]
  macro_rotation: Any[]
  narrative_signals: Any[]
  leaders_laggards: {
    leaders: Any[]
    laggards: Any[]
  }
  data_coverage: DataCoverage
}

export function narrativeMemberTargets(memberships: Any[], maxAssets=8) {
  const seen=new Set<string>(),targets:Array<{canonicalKey:string}>=[];let unresolved=0,duplicates=0
  for(const member of memberships){
    const provider=member.asset_provider,id=member.asset_provider_id
    const valid=typeof id==='string'&&(provider==='coinmarketcap'?/^[1-9][0-9]{0,11}$/.test(id):provider==='coingecko'&&/^[a-z0-9][a-z0-9._-]{0,199}$/.test(id))
    if(!valid){unresolved++;continue}
    const key=`market:${provider}:${id}`
    if(seen.has(key)){duplicates++;continue}
    seen.add(key);targets.push({canonicalKey:key})
  }
  const bound=Number.isFinite(maxAssets)?Math.max(1,Math.min(20,Math.floor(maxAssets))):8
  return {targets:targets.slice(0,bound),unresolved,duplicates,omitted:Math.max(0,targets.length-bound)}
}

function coverage(parts: Record<string, boolean>, memberAssets: AssetMiniPack[], sourceStates:Record<string,string>, unresolved:number): DataCoverage {
  const optional: string[] = []
  if (!parts.narrative_taxonomy) optional.push('Narrative taxonomy row was not available.')
  if (!parts.narrative_state) optional.push('Narrative state row was not available.')
  if (!parts.narrative_assets && !memberAssets.length) optional.push('No member asset mini-packs were available for this narrative.')
  if (!parts.narrative_category_snapshots) optional.push('No cached category rotation snapshot was available.')
  if (!parts.market_macro_snapshots) optional.push('No cached macro rotation snapshot was available.')
  if (!parts.narrative_signals) optional.push('No recent narrative source signals were available.')
  const unavailable=Object.entries(sourceStates).filter(([,state])=>state==='error').map(([source])=>source)
  const material = !parts.narrative_state ? ['No current narrative state was available.'] : []
  if(unresolved)material.push(`${unresolved} member records have no verified provider identity; their original labels remain available without guessed asset evidence.`)
  if(unavailable.length)material.push(`Source reads failed: ${unavailable.join(', ')}. These are not empty results.`)
  for(const member of memberAssets){
    const prefix=member.subject.canonical_key,child=member.coverage
    for(const gap of child?.material_gaps || [])material.push(`${prefix}: ${gap}`)
    for(const source of child?.unavailable_sources || [])unavailable.push(`${prefix}: ${source}`)
    for(const gap of child?.optional_gaps || [])optional.push(`${prefix}: ${gap}`)
  }
  return {
    used_sources: Object.entries(parts).filter(([, present]) => present).map(([key]) => key),
    checked_sources: ['narrative_taxonomy', 'narrative_state', 'narrative_assets', 'narrative_category_snapshots', 'market_macro_snapshots', 'narrative_signals', 'asset mini-packs'],
    unavailable_sources: unavailable,
    material_gaps: material,
    optional_gaps: optional,
    confidence_impact: material.length || memberAssets.some(member=>member.coverage?.confidence_impact==='high') ? 'high' : memberAssets.some(member=>member.coverage?.confidence_impact==='medium') ? 'medium' : optional.length ? 'low' : 'none',
    should_show_warning: material.length > 0 || unavailable.length > 0 || memberAssets.some(member=>member.coverage?.should_show_warning),
  }
}

export async function assembleNarrativeEvidencePack(
  db: DB,
  slug: string,
  options: { maxAssets?: number; now?: Date; assembleMiniPack?:typeof assembleAssetMiniPack } = {},
): Promise<NarrativeEvidencePack> {
  const sourceStates:Record<string,string>={}
  async function read(source:string,run:()=>Any,single=false):Promise<Any>{
    try{
      const result=await run()
      if(result?.error||result?.data===undefined||!single&&!Array.isArray(result.data))throw Error('source_unavailable')
      sourceStates[source]=single?(result.data?'available':'empty'):(result.data.length?'available':'empty')
      return result.data
    }catch{sourceStates[source]='error';return single?null:[]}
  }
  const cleanSlug = String(slug || '').trim()
  const taxonomy = cleanSlug?await read('narrative_taxonomy',()=>db.from('narrative_taxonomy').select('*').eq('slug',cleanSlug).maybeSingle(),true):null
  const narrativeId = taxonomy?.id || null
  const [state,readMemberships,categories,macro,signals]=await Promise.all([
    narrativeId?read('narrative_state',()=>db.from('narrative_state').select('*').eq('narrative_id',narrativeId).maybeSingle(),true):Promise.resolve(null),
    narrativeId?read('narrative_assets',()=>db.from('narrative_assets').select('*').eq('narrative_id',narrativeId).order('is_leader',{ascending:false}).order('weight',{ascending:false}).order('id',{ascending:true}).limit(21)):Promise.resolve([]),
    read('narrative_category_snapshots',()=>db.from('narrative_category_snapshots').select('*').order('as_of',{ascending:false}).limit(10)),
    read('market_macro_snapshots',()=>db.from('market_macro_available').select('*').order('as_of',{ascending:false}).limit(2)),
    narrativeId?read('narrative_signals',()=>db.from('narrative_signals').select('id,signal_kind,provider,title,snippet,source_url,bias,source_quality_score,observed_at,fetched_at').eq('narrative_id',narrativeId).order('observed_at',{ascending:false,nullsFirst:false}).order('fetched_at',{ascending:false,nullsFirst:false}).order('id',{ascending:true}).limit(8)):Promise.resolve([]),
  ])
  if(!narrativeId)for(const source of ['narrative_state','narrative_assets','narrative_signals'])sourceStates[source]='skipped'
  const memberships=readMemberships.slice(0,20),selection=narrativeMemberTargets(memberships,options.maxAssets)
  const memberAssets: AssetMiniPack[] = [],assemble=options.assembleMiniPack??assembleAssetMiniPack
  // Two cache-only assemblies at a time. Original rankings/labels remain in the
  // pack, but a ticker label cannot become an inferred provider relationship.
  for(let i=0;i<selection.targets.length;i+=2){
    const reads=await Promise.allSettled(selection.targets.slice(i,i+2).map(target=>assemble(db,target,{now:options.now,staleMinutes:60,maxPromptChars:2800,allowLiveEnrichment:false})))
    reads.forEach((result,index)=>{const target=selection.targets[i+index];if(result.status==='fulfilled')memberAssets.push(result.value);else sourceStates[`asset mini-pack:${target.canonicalKey}`]='error'})
  }
  const parts = {
    narrative_taxonomy: !!taxonomy,
    narrative_state: !!state,
    narrative_assets: memberships.length > 0,
    narrative_category_snapshots: categories.length > 0,
    market_macro_snapshots: macro.length > 0,
    narrative_signals: signals.length > 0,
    asset_mini_packs: memberAssets.length > 0,
  }
  const packWithoutHash = {
    membership_evidence_version:1 as const,
    source_states:sourceStates,
    membership_context:{rows:memberships,unresolved_count:selection.unresolved,duplicate_count:selection.duplicates,omitted_count:selection.omitted,has_more:readMemberships.length>20,note:'Exact provider IDs select member evidence. Ticker-only rankings remain source labels; no CMC category equivalence or new membership is inferred.'},
    slug: cleanSlug,
    taxonomy,
    state,
    member_assets: memberAssets,
    category_rotation: categories,
    macro_rotation: macro,
    narrative_signals: signals,
    leaders_laggards: {
      leaders: Array.isArray(state?.leaders) ? state.leaders : [],
      laggards: Array.isArray(state?.laggards) ? state.laggards : [],
    },
    data_coverage: coverage(parts, memberAssets, sourceStates, selection.unresolved),
  }
  return {
    content_hash: h32(JSON.stringify({...packWithoutHash,member_assets:memberAssets.map(({cached:_cached,...member})=>member)})),
    ...packWithoutHash,
  }
}
