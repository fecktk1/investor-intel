import {nativeResearchProviderKeys} from './research-identity.ts'
import {issuerCmcIdentity,issuerProviderCmcId} from '../market-assets/issuer-identities.ts'
type Row = Record<string, any>
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const providerKey = (value: unknown): string | null => typeof value === 'string' && /^market:(coinmarketcap:[1-9][0-9]{0,11}|coingecko:[a-z0-9][a-z0-9._-]{0,199})$/.test(value) ? value : null
const clock = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
const METHOD = 'Exact recorded narrative membership joined to selected-portfolio values. Categories are Investor Intel taxonomy, not CMC sector equivalence. Memberships overlap: a position can appear in multiple groups, so group percentages must not be added. Membership recording time is not its effective market time. Scores and source membership weights are not portfolio allocation weights.'

export function portfolioNarrativeTargets(holdings: Row[], evidence: Row[]) {
  if (holdings.length > 25 || new Set(holdings.map(h => h.canonicalAssetKey)).size !== holdings.length) throw Error('portfolio_narrative_position_limit')
  return holdings.map(h => {
    const identity = evidence.find(e => e.canonicalAssetKey === h.canonicalAssetKey)?.connected_identity
    const direct=providerKey(h.canonicalAssetKey), linked=identity?.state === 'verified' && identity.requested === h.canonicalAssetKey ? providerKey(identity.marketSubject) : null
    const native=nativeResearchProviderKeys(h.canonicalAssetKey)
    const key=direct||linked,parts=key?.split(':')||[]
    const issuer=issuerCmcIdentity(h.canonicalAssetKey),circle=issuer?.id==='3408'||issuerProviderCmcId(parts[1],parts[2])==='3408'
    const subjects=[...new Set([direct,...native,...(circle?['market:coinmarketcap:3408','market:coingecko:usd-coin']:[]),...(native.length?[]:[linked])].filter((s):s is string=>Boolean(s)))]
    return { holding:h,subject:subjects[0]||null,subjects,identitySources:[...(native.length?['registered-native-chain-identities']:[]),...(circle?['https://developers.circle.com/stablecoins/usdc-contract-addresses; reviewed 2026-09-10']:[])] }
  })
}

export function projectPortfolioNarrativeExposure(targets: ReturnType<typeof portfolioNarrativeTargets>, memberships: Row[], taxonomy: Row[], totalValue: number | null, now: number) {
  const narratives = new Map<string, Row>(), sectors = new Map<string, Row>(), positions: Row[] = [], excluded: Row[] = []
  const seen = new Set<string>()
  for (const {holding: h, subject,subjects,identitySources} of targets) {
    const value = numeric(h.value)
    if (!subject || value != null && value < 0) { excluded.push({canonicalAssetKey: h.canonicalAssetKey, reason: !subject ? 'identity_unverified' : 'unsupported_negative_position'}); continue }
    const rows = memberships.filter(m => subjects.includes(`market:${m.asset_provider}:${m.asset_provider_id}`))
    const accepted: Row[] = []
    for (const m of rows) {
      const t = taxonomy.find(t => t.id === m.narrative_id)
      const at = clock(m.updated_at), taxAt = clock(t?.updated_at)
      if (!t || !['active', 'surfaced'].includes(t.status) || !/^[a-z0-9][a-z0-9_-]{0,119}$/.test(t.slug) || at == null || at > now || taxAt == null || taxAt > now) continue
      const dedupe = `${h.canonicalAssetKey}:${t.id}:${m.asset_provider}:${m.id}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      accepted.push({id: m.id, narrativeId: t.id, slug: t.slug, name: t.name, category: t.parent_category || null, provider: m.asset_provider, providerId: m.asset_provider_id, source: m.membership_source || null, membershipRecordedAt: m.updated_at, taxonomyRecordedAt: t.updated_at, effectiveAt: null, sourceRef: `narrative_assets:${m.id}`, taxonomyRef: `narrative_taxonomy:${t.id}`})
    }
    if (!accepted.length) { excluded.push({canonicalAssetKey: h.canonicalAssetKey, reason: 'no_eligible_recorded_membership'}); continue }
    const position = {canonicalAssetKey: h.canonicalAssetKey, subject,identitySources, name: h.name || h.symbol || h.canonicalAssetKey, valueUsd: value, quantity: numeric(h.quantity), priceStatus: h.priceStatus, positionObservedAt: h.observedAt || null, portfolioAllocationPct: value != null && totalValue != null && totalValue > 0 ? value / totalValue * 100 : null, memberships: accepted}
    positions.push(position)
    const add = (map: Map<string, Row>, key: string, name: string, slug: string | null) => {
      const group = map.get(key) || {id: key, name, slug, positions: [], pricedSubtotalUsd: 0, unpriced: 0, stalePositions: 0}
      if (group.positions.includes(position.canonicalAssetKey)) return
      group.positions.push(position.canonicalAssetKey)
      if (value == null) group.unpriced++; else group.pricedSubtotalUsd += value
      if (h.priceStatus !== 'priced') group.stalePositions++
      map.set(key, group)
    }
    for (const m of accepted) {
      add(narratives, m.narrativeId, m.name, m.slug)
      if (m.category) add(sectors, m.category, m.category, null)
    }
  }
  const groups = (map: Map<string, Row>) => [...map.values()].map((g): Row => ({...g, valueUsd: g.unpriced ? null : g.pricedSubtotalUsd, portfolioAllocationPct: !g.unpriced && totalValue != null && totalValue > 0 ? g.pricedSubtotalUsd / totalValue * 100 : null})).sort((a,b) => b.pricedSubtotalUsd - a.pricedSubtotalUsd || a.name.localeCompare(b.name))
  return {version: 1, status: excluded.length ? 'partial' : positions.length ? 'available' : 'empty', reason:null as string|null, method: METHOD, totalValue,
    positions, narratives: groups(narratives), sectors: groups(sectors), excluded, positionsRequested: targets.length, positionsClassified: positions.length,
    uniquePricedSubtotalUsd: positions.reduce((n,p) => n + (p.valueUsd ?? 0), 0), unpriced: positions.filter(p => p.valueUsd == null).length}
}

/** Bounded indexed reads, invoked after portfolio authorization. No provider,
 * user notes, wallet addresses, AI calls, or mutable shared private caches. */
export async function readPortfolioNarrativeExposure(db: any, holdings: Row[], evidence: Row[], totalValue: number | null, now: number) {
  const empty = {version: 1, method: METHOD, positions: [], narratives: [], sectors: [], excluded: [], totalValue, positionsRequested: holdings.length, positionsClassified: 0, uniquePricedSubtotalUsd: null, unpriced: null}
  try {
    const targets = portfolioNarrativeTargets(holdings, evidence)
    const queries = ['coinmarketcap', 'coingecko'].map(async provider => {
      const ids = [...new Set(targets.flatMap(t => t.subjects).filter(s => s.startsWith(`market:${provider}:`)).map(s => s.split(':')[2]))]
      if (!ids.length) return []
      const {data,error} = await db.from('narrative_assets').select('id,narrative_id,asset_provider,asset_provider_id,membership_source,updated_at')
        .eq('asset_provider',provider).in('asset_provider_id',ids).lte('updated_at',new Date(now).toISOString()).order('id').limit(501)
      if (error || !Array.isArray(data)) throw Error('portfolio_narrative_membership_read_failed')
      if (data.length > 500) throw Error('portfolio_narrative_membership_limit')
      if (data.some(m => m.asset_provider !== provider || !ids.includes(m.asset_provider_id))) throw Error('portfolio_narrative_identity_mismatch')
      return data
    })
    const memberships = (await Promise.all(queries)).flat()
    const ids = [...new Set(memberships.map(m => m.narrative_id))]
    if (ids.length > 100) throw Error('portfolio_narrative_taxonomy_limit')
    let taxonomy: Row[] = []
    if (ids.length) {
      const response = await db.from('narrative_taxonomy').select('id,slug,name,parent_category,status,updated_at').in('id',ids).order('id').limit(101)
      if (response.error || !Array.isArray(response.data)) throw Error('portfolio_narrative_taxonomy_read_failed')
      if (response.data.length > 100 || response.data.some((t: Row) => !ids.includes(t.id))) throw Error('portfolio_narrative_taxonomy_mismatch')
      taxonomy = response.data
    }
    return projectPortfolioNarrativeExposure(targets,memberships,taxonomy,totalValue,now)
  } catch (error) {
    return {...empty, status:'error', reason:error instanceof Error && /^portfolio_narrative_/.test(error.message) ? error.message : 'portfolio_narrative_read_failed'}
  }
}
