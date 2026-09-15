// Investor Intel — asset facts readers (CMC plan proposals 4, 11, 18, 19).
//
// Everything here reads what was already captured: `market_assets.facts` (the
// daily CoinMarketCap metadata pass) and `intel_rank_history` (the daily capture
// job). No provider call, no interpolation, no inferred fact. A valid zero stays
// a zero, a missing value stays null and carries a reason, and a gap in the
// capture history is reported as a gap rather than filled in.

import { finite, instant } from './investigation-evidence.ts'

// deno-lint-ignore no-explicit-any
type Db = any
// deno-lint-ignore no-explicit-any
type Row = any

const DAY_MS = 86_400_000

export type SupplyTrustState = 'verified' | 'self_reported' | 'mixed' | 'unknown'

export interface SupplyTrust {
  circulating: number | null
  total: number | null
  max: number | null
  selfReportedCirculating: number | null
  selfReportedMarketCap: number | null
  marketCap: number | null
  circulatingShareOfMax: number | null
  selfReportedDiffersPct: number | null
  infiniteSupply: boolean | null
  trust: SupplyTrustState
  reason: string | null
}

export interface ListingAge {
  dateAdded: string | null
  dateLaunched: string | null
  ageDays: number | null
  cohort: string | null
  reason: string | null
}

export interface FactDeployment {
  platformSlug: string | null
  platformName: string | null
  chain: string | null
  address: string
  primary: boolean
}

export interface NoticeState {
  present: boolean
  hash: string | null
  text: string | null
  factsAt: string | null
}

/** The facts document, defensively read. A row without one is not an error. */
export function assetFacts(row: Row): Record<string, unknown> {
  const facts = row?.facts
  return facts && typeof facts === 'object' && !Array.isArray(facts) ? facts as Record<string, unknown> : {}
}

/** '2026Q3' for an instant, in UTC. */
export function quarterCohort(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`
}

/**
 * Whether the catalogue's supply numbers are the provider's verified figures,
 * the issuer's own self-reported ones, or both. A self-reported supply is never
 * substituted for a missing verified one.
 */
export function supplyTrust(row: Row): SupplyTrust {
  const facts = assetFacts(row)
  const circulating = finite(row?.circulating_supply)
  const total = finite(row?.total_supply)
  const max = finite(row?.max_supply)
  const selfReportedCirculating = finite(facts.selfReportedCirculatingSupply)
  const selfReportedMarketCap = finite(facts.selfReportedMarketCap)
  const marketCap = finite(row?.market_cap)
  const infiniteSupply = typeof facts.infiniteSupply === 'boolean' ? facts.infiniteSupply : null
  const hasVerified = circulating != null
  const hasSelfReported = selfReportedCirculating != null || selfReportedMarketCap != null
  const trust: SupplyTrustState = hasVerified && hasSelfReported ? 'mixed' : hasVerified ? 'verified' : hasSelfReported ? 'self_reported' : 'unknown'
  return {
    circulating, total, max, selfReportedCirculating, selfReportedMarketCap, marketCap,
    // An infinite or absent maximum has no share to report.
    circulatingShareOfMax: circulating != null && max != null && max > 0 ? circulating / max : null,
    selfReportedDiffersPct: circulating != null && circulating > 0 && selfReportedCirculating != null
      ? ((selfReportedCirculating - circulating) / circulating) * 100
      : null,
    infiniteSupply, trust,
    reason: trust === 'unknown' ? 'No circulating supply is recorded by the provider and none is self-reported.' : null,
  }
}

/** Listing and launch dates, the age in whole days and the listing quarter. */
export function listingAge(row: Row, now = Date.now()): ListingAge {
  const facts = assetFacts(row)
  const dateAdded = typeof facts.dateAdded === 'string' ? facts.dateAdded : null
  const dateLaunched = typeof facts.dateLaunched === 'string' ? facts.dateLaunched : null
  const added = instant(dateAdded)
  if (added == null) return { dateAdded, dateLaunched, ageDays: null, cohort: null, reason: 'No provider listing date is recorded for this asset.' }
  if (added > now) return { dateAdded, dateLaunched, ageDays: null, cohort: quarterCohort(added), reason: 'The recorded listing date is in the future; an age is not asserted.' }
  return { dateAdded, dateLaunched, ageDays: Math.floor((now - added) / DAY_MS), cohort: quarterCohort(added), reason: null }
}

/**
 * Every deployment the provider lists, with the one the catalogue treats as
 * primary flagged. The flag is only set when the catalogue actually names it:
 * a single deployment, a chain matching `primary_chain`, or an address matching
 * the single `platforms` entry. Ambiguity leaves every row unflagged.
 */
export function deployments(row: Row): FactDeployment[] {
  const raw = assetFacts(row).deployments
  const list = Array.isArray(raw) ? raw : []
  const primaryChain = typeof row?.primary_chain === 'string' && row.primary_chain ? row.primary_chain : null
  const platformValues = new Set(Object.values(row?.platforms || {}).filter((v): v is string => typeof v === 'string' && !!v).map((v) => v.toLowerCase()))
  const mapped = list.slice(0, 200).map((d: Row) => ({
    platformSlug: typeof d?.platformSlug === 'string' ? d.platformSlug : null,
    platformName: typeof d?.platformName === 'string' ? d.platformName : null,
    chain: typeof d?.chain === 'string' && d.chain ? d.chain : null,
    address: typeof d?.address === 'string' ? d.address : '',
  })).filter((d) => !!d.address)
  if (mapped.length === 1) return mapped.map((d) => ({ ...d, primary: true }))
  const byChain = primaryChain ? mapped.filter((d) => d.chain === primaryChain) : []
  const byPlatform = mapped.filter((d) => platformValues.has(d.address.toLowerCase()))
  const primary = byChain.length === 1 ? byChain[0] : byPlatform.length === 1 ? byPlatform[0] : null
  return mapped.map((d) => ({ ...d, primary: primary != null && d === primary }))
}

/** Whether a provider listing notice is recorded, and its stable hash. */
export function noticeState(row: Row): NoticeState {
  const facts = assetFacts(row)
  const text = typeof facts.notice === 'string' && facts.notice.trim() ? facts.notice.trim() : null
  const hash = typeof facts.noticeHash === 'string' && /^[0-9a-f]{64}$/.test(facts.noticeHash) ? facts.noticeHash : null
  const factsAt = typeof facts.factsAt === 'string' ? facts.factsAt : (typeof row?.facts_at === 'string' ? row.facts_at : null)
  return { present: text != null, hash, text, factsAt }
}

export interface FactDelta {
  date: string
  numMarketPairs: number | null
  pairsDelta: number | null
  circulatingSupply: number | null
  supplyDelta: number | null
  marketCap: number | null
  rank: number | null
}

/**
 * Daily market-pair and supply deltas from the capture history. An asset with no
 * captured history returns no rows — that is a truthful empty result, not a
 * failure. A read failure is reported as one.
 */
export async function deltas(db: Db, provider: string, providerId: string, days = 30): Promise<{ rows: FactDelta[]; days: number; unavailable: boolean; reason: string | null }> {
  const bounded = Math.min(Math.max(Math.trunc(Number(days) || 30), 1), 400)
  const { data, error } = await db.rpc('intel_market_asset_facts_deltas', { p_provider: provider, p_provider_id: providerId, p_days: bounded })
  if (error) return { rows: [], days: bounded, unavailable: true, reason: 'The captured daily history could not be read; no deltas are asserted.' }
  const rows: FactDelta[] = (Array.isArray(data) ? data : []).slice(0, 400).map((r: Row) => ({
    date: String(r?.snapshot_date ?? ''),
    numMarketPairs: finite(r?.num_market_pairs),
    pairsDelta: finite(r?.pairs_delta),
    circulatingSupply: finite(r?.circulating_supply),
    supplyDelta: finite(r?.supply_delta),
    marketCap: finite(r?.market_cap),
    rank: finite(r?.rank),
  })).filter((r: FactDelta) => !!r.date)
  return { rows, days: bounded, unavailable: false, reason: rows.length ? null : 'No daily capture rows are retained for this asset in the requested window.' }
}

/** Median of the finite values, or null when there are none. */
export function median(values: (number | null)[]): number | null {
  const sorted = values.filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export interface ListingCohort {
  cohort: string | null
  count: number
  medianChange30dPct: number | null
  medianMarketCap: number | null
  assetsWithChange: number
}

/**
 * The current top-1000 catalogue grouped by the quarter each asset was listed.
 * The 30-day change comes from the captured daily history (a price about 30 days
 * ago against the most recent captured price), never from the rolling 7-day
 * field, and is null for any asset without both captures.
 */
export async function listingCohorts(db: Db, provider: string, now = Date.now()): Promise<{ cohorts: ListingCohort[]; assets: number; unavailable: boolean; reason: string | null }> {
  const assets = await db.from('market_assets')
    .select('provider_id,market_cap,market_cap_rank,in_current_catalog,facts')
    .eq('source_provider', provider)
    .order('market_cap_rank', { ascending: true, nullsFirst: false })
    .limit(1000)
  if (assets.error) return { cohorts: [], assets: 0, unavailable: true, reason: 'The catalogue could not be read; no cohorts are asserted.' }
  const rows: Row[] = (assets.data || []).filter((r: Row) => r?.in_current_catalog !== false)
  if (!rows.length) return { cohorts: [], assets: 0, unavailable: false, reason: 'No catalogue rows are recorded for this provider.' }

  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const [recent, older] = await Promise.all([
    db.from('intel_rank_history').select('provider_id,snapshot_date,price').eq('provider', provider).gte('snapshot_date', iso(now - 3 * DAY_MS)).limit(4000),
    db.from('intel_rank_history').select('provider_id,snapshot_date,price').eq('provider', provider).gte('snapshot_date', iso(now - 33 * DAY_MS)).lte('snapshot_date', iso(now - 27 * DAY_MS)).limit(4000),
  ])
  // A history read failure removes the change column, never the cohort counts.
  const latest = new Map<string, { date: string; price: number }>()
  const pick = (target: Map<string, { date: string; price: number }>, result: Row) => {
    for (const r of (result?.error ? [] : result?.data || [])) {
      const price = finite(r?.price), id = r?.provider_id != null ? String(r.provider_id) : ''
      const date = typeof r?.snapshot_date === 'string' ? r.snapshot_date : ''
      if (!id || !date || price == null) continue
      const held = target.get(id)
      if (!held || held.date < date) target.set(id, { date, price })
    }
  }
  const past = new Map<string, { date: string; price: number }>()
  pick(latest, recent); pick(past, older)
  const historyUnavailable = !!recent.error || !!older.error

  const buckets = new Map<string | null, { marketCaps: (number | null)[]; changes: number[]; count: number }>()
  for (const row of rows) {
    const cohort = listingAge(row, now).cohort
    const bucket = buckets.get(cohort) || { marketCaps: [], changes: [], count: 0 }
    bucket.count++
    bucket.marketCaps.push(finite(row?.market_cap))
    const id = row?.provider_id != null ? String(row.provider_id) : ''
    const now30 = latest.get(id), then = past.get(id)
    if (now30 && then && then.price > 0) bucket.changes.push(((now30.price - then.price) / then.price) * 100)
    buckets.set(cohort, bucket)
  }
  const cohorts = [...buckets.entries()].map(([cohort, b]) => ({
    cohort, count: b.count,
    medianChange30dPct: b.changes.length ? median(b.changes) : null,
    medianMarketCap: median(b.marketCaps),
    assetsWithChange: b.changes.length,
  })).sort((a, b) => (b.cohort || '').localeCompare(a.cohort || '')).slice(0, 80)
  return {
    cohorts, assets: rows.length, unavailable: false,
    reason: historyUnavailable ? 'The captured daily history could not be read; cohort counts are reported without a 30-day change.' : null,
  }
}

export interface ListingActivityDay {
  date: string
  rose: number
  fell: number
  unchanged: number
  assets: number
}

/**
 * Per day, how many assets' market-pair counts rose and how many fell against
 * their previous CAPTURED day. Bounded: at most 30 days and a hard row cap, and
 * the result says when the cap truncated the window rather than reporting a
 * partial window as complete.
 */
export async function listingActivity(db: Db, provider: string, days = 30, now = Date.now()): Promise<{ days: ListingActivityDay[]; window: number; truncated: boolean; unavailable: boolean; reason: string | null }> {
  const ROW_CAP = 20_000
  const window = Math.min(Math.max(Math.trunc(Number(days) || 30), 1), 30)
  const from = new Date(now - (window + 1) * DAY_MS).toISOString().slice(0, 10)
  const { data, error } = await db.from('intel_rank_history')
    .select('provider_id,snapshot_date,num_market_pairs')
    .eq('provider', provider).gte('snapshot_date', from)
    .order('snapshot_date', { ascending: false }).limit(ROW_CAP)
  if (error) return { days: [], window, truncated: false, unavailable: true, reason: 'The captured daily history could not be read; no listing activity is asserted.' }
  const rows: Row[] = Array.isArray(data) ? data : []
  const truncated = rows.length >= ROW_CAP
  const byAsset = new Map<string, { date: string; pairs: number }[]>()
  for (const r of rows) {
    const id = r?.provider_id != null ? String(r.provider_id) : ''
    const date = typeof r?.snapshot_date === 'string' ? r.snapshot_date : ''
    const pairs = finite(r?.num_market_pairs)
    if (!id || !date || pairs == null) continue
    const list = byAsset.get(id) || []
    list.push({ date, pairs })
    byAsset.set(id, list)
  }
  const perDay = new Map<string, ListingActivityDay>()
  for (const list of byAsset.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date))
    for (let i = 1; i < list.length; i++) {
      const day = perDay.get(list[i].date) || { date: list[i].date, rose: 0, fell: 0, unchanged: 0, assets: 0 }
      const delta = list[i].pairs - list[i - 1].pairs
      if (delta > 0) day.rose++; else if (delta < 0) day.fell++; else day.unchanged++
      day.assets++
      perDay.set(list[i].date, day)
    }
  }
  const earliest = new Date(now - window * DAY_MS).toISOString().slice(0, 10)
  const out = [...perDay.values()].filter((d) => d.date >= earliest).sort((a, b) => a.date.localeCompare(b.date)).slice(-30)
  return {
    days: out, window, truncated, unavailable: false,
    reason: truncated
      ? 'The bounded history read hit its row cap; the oldest days in this window are incomplete.'
      : out.length ? null : 'No two consecutive captured days are retained for this provider in the requested window.',
  }
}
