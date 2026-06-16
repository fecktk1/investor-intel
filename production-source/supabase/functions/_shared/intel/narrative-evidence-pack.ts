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

async function rows(run: () => Any): Promise<Any[]> {
  try {
    const res = await run()
    if (res?.error) return []
    return Array.isArray(res?.data) ? res.data : []
  } catch {
    return []
  }
}

async function maybeSingle(run: () => Any): Promise<Any | null> {
  try {
    const res = await run()
    if (res?.error) return null
    return res?.data || null
  } catch {
    return null
  }
}

function upper(value: unknown): string {
  return String(value || '').toUpperCase().replace(/^\$/, '').trim()
}

function uniq(values: unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const s = upper(value)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

function symbolsFromState(state: Any): string[] {
  const values: unknown[] = []
  for (const key of ['leaders', 'laggards', 'related_assets']) {
    const arr = Array.isArray(state?.[key]) ? state[key] : []
    for (const item of arr) values.push(item?.symbol || item?.normalized_symbol || item?.asset || item)
  }
  return uniq(values)
}

function coverage(parts: Record<string, boolean>, memberAssets: AssetMiniPack[]): DataCoverage {
  const optional: string[] = []
  if (!parts.narrative_taxonomy) optional.push('Narrative taxonomy row was not available.')
  if (!parts.narrative_state) optional.push('Narrative state row was not available.')
  if (!parts.narrative_assets && !memberAssets.length) optional.push('No member asset mini-packs were available for this narrative.')
  if (!parts.narrative_category_snapshots) optional.push('No cached category rotation snapshot was available.')
  if (!parts.market_macro_snapshots) optional.push('No cached macro rotation snapshot was available.')
  if (!parts.narrative_signals) optional.push('No recent narrative source signals were available.')
  const material = !parts.narrative_state ? ['No current narrative state was available.'] : []
  return {
    used_sources: Object.entries(parts).filter(([, present]) => present).map(([key]) => key),
    checked_sources: ['narrative_taxonomy', 'narrative_state', 'narrative_assets', 'narrative_category_snapshots', 'market_macro_snapshots', 'narrative_signals', 'asset mini-packs'],
    unavailable_sources: [],
    material_gaps: material,
    optional_gaps: optional,
    confidence_impact: material.length ? 'high' : optional.length ? 'low' : 'none',
    should_show_warning: material.length > 0,
  }
}

export async function assembleNarrativeEvidencePack(
  db: DB,
  slug: string,
  options: { maxAssets?: number; now?: Date } = {},
): Promise<NarrativeEvidencePack> {
  const cleanSlug = String(slug || '').trim()
  const taxonomy = cleanSlug
    ? await maybeSingle(() => db.from('narrative_taxonomy').select('*').eq('slug', cleanSlug).maybeSingle())
    : null
  const narrativeId = taxonomy?.id || null
  const [state, memberships, categories, macro, signals] = await Promise.all([
    narrativeId ? maybeSingle(() => db.from('narrative_state').select('*').eq('narrative_id', narrativeId).maybeSingle()) : Promise.resolve(null),
    narrativeId ? rows(() => db.from('narrative_assets').select('*').eq('narrative_id', narrativeId).order('is_leader', { ascending: false }).order('weight', { ascending: false }).limit(20)) : Promise.resolve([]),
    rows(() => db.from('narrative_category_snapshots').select('*').order('as_of', { ascending: false }).limit(10)),
    rows(() => db.from('market_macro_snapshots').select('*').order('as_of', { ascending: false }).limit(2)),
    narrativeId ? rows(() => db.from('narrative_signals').select('signal_kind,provider,title,snippet,source_url,bias,source_quality_score,observed_at').eq('narrative_id', narrativeId).order('observed_at', { ascending: false }).limit(8)) : Promise.resolve([]),
  ])
  const symbols = uniq([
    ...memberships.map((m) => m.normalized_symbol || m.symbol),
    ...symbolsFromState(state),
  ]).slice(0, Math.max(1, options.maxAssets ?? 8))
  const memberAssets: AssetMiniPack[] = []
  for (const symbol of symbols) {
    try {
      memberAssets.push(await assembleAssetMiniPack(db, { symbol }, { now: options.now, staleMinutes: 60, maxPromptChars: 2800 }))
    } catch {
      // Narrative packs degrade to coverage notes when member assets are thin.
    }
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
    data_coverage: coverage(parts, memberAssets),
  }
  return {
    content_hash: h32(JSON.stringify(packWithoutHash)),
    ...packWithoutHash,
  }
}
