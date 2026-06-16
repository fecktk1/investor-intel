import { h32 } from '../core-intel/hashing.ts'
import { materialityVerdict } from '../core-intel/materiality.ts'

// deno-lint-ignore no-explicit-any
type DB = any

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_LOOKBACK_DAYS = 14
const PRIVATE_FLOW_FLOOR_USD = 100_000

export interface ProviderSnapshotPromotionCandidate {
  key: string
  visibility: 'global_derived' | 'org_private'
  orgId?: string | null
  userId?: string | null
  kind: string
  eventType: string
  subjectType: string
  subjectRef: string
  title: string
  summary: string
  occurredAt: string
  importanceScore: number
  promotionScore: number
  sourceTable: string
  sourceRecordId: string
  rawHash: string
  entityRefs: string[]
  narrativeRefs: string[]
  chains: string[]
  evidenceRefs: Array<Record<string, unknown>>
  payload: Record<string, unknown>
  promoteEventMemory: boolean
}

interface SnapshotInputs {
  priceRows?: Array<Record<string, unknown>>
  dexRows?: Array<Record<string, unknown>>
  protocolTvlRows?: Array<Record<string, unknown>>
  chainTvlRows?: Array<Record<string, unknown>>
  stablecoinRows?: Array<Record<string, unknown>>
  macroRows?: Array<Record<string, unknown>>
  categoryRows?: Array<Record<string, unknown>>
  largeTransferRows?: Array<Record<string, unknown>>
  now?: Date
}

function clean(value: unknown): string {
  return String(value || '').trim()
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function iso(value: unknown): string | null {
  const d = new Date(String(value || ''))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

function pctChange(previous: number | null, current: number | null): number | null {
  if (previous == null || current == null || previous === 0) return null
  return (current - previous) / Math.abs(previous)
}

function fmtMoney(value: number | null): string {
  if (value == null) return 'unknown'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(2)}T`
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`
  return `$${value.toFixed(2)}`
}

function fmtPct(value: number): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(1)}%`
}

function uniq(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((v) => clean(v)).filter(Boolean))]
}

function dayBucket(ts: string): string {
  return ts.slice(0, 10)
}

function scoreFromMagnitude(absPct: number): number {
  return Math.max(0.72, Math.min(0.98, 0.72 + absPct / 2))
}

function isMaterialPct(delta: number | null): boolean {
  if (delta == null) return false
  const verdict = materialityVerdict({
    prevEvidenceHash: 'previous',
    newEvidenceHash: 'current',
    prevSignal: { score: 0.5, source_count: 1 },
    newSignal: { score: Math.max(0, Math.min(1, 0.5 + Math.abs(delta))), source_count: 1 },
  })
  return verdict.magnitude === 'material'
}

function groupedShift(
  rows: Array<Record<string, unknown>> | undefined,
  opts: {
    key: (row: Record<string, unknown>) => string
    label: (row: Record<string, unknown>) => string
    value: (row: Record<string, unknown>) => number | null
    time: (row: Record<string, unknown>) => string | null
    table: string
    kind: string
    subjectType: string
    eventType: string
    metricLabel: string
    entityRefs?: (row: Record<string, unknown>) => string[]
    narrativeRefs?: (row: Record<string, unknown>) => string[]
    chains?: (row: Record<string, unknown>) => string[]
  },
): ProviderSnapshotPromotionCandidate[] {
  const groups = new Map<string, Array<Record<string, unknown>>>()
  for (const row of rows || []) {
    const key = opts.key(row)
    if (!key) continue
    groups.set(key, [...(groups.get(key) || []), row])
  }
  const out: ProviderSnapshotPromotionCandidate[] = []
  for (const [subjectRef, group] of groups.entries()) {
    const sorted = group
      .map((row) => ({ row, t: opts.time(row), v: opts.value(row) }))
      .filter((r) => r.t && r.v != null)
      .sort((a, b) => String(b.t).localeCompare(String(a.t)))
    if (sorted.length < 2) continue
    const latest = sorted[0]
    const previous = sorted[sorted.length - 1]
    const delta = pctChange(previous.v, latest.v)
    if (!isMaterialPct(delta)) continue
    const absPct = Math.abs(delta!)
    const occurredAt = latest.t!
    const label = opts.label(latest.row) || subjectRef
    const direction = delta! > 0 ? 'rose' : 'fell'
    const payload = {
      kind: opts.kind,
      metric: opts.metricLabel,
      current: latest.v,
      previous: previous.v,
      pct_change: delta,
      materiality_threshold: 0.18,
      source_table: opts.table,
    }
    const rawHash = h32(JSON.stringify(payload))
    const sourceRecordId = `${opts.kind}:${subjectRef}:${dayBucket(occurredAt)}`
    out.push({
      key: `provider_snapshot:${sourceRecordId}`,
      visibility: 'global_derived',
      kind: opts.kind,
      eventType: opts.eventType,
      subjectType: opts.subjectType,
      subjectRef,
      title: `${label} ${opts.metricLabel} ${direction} ${fmtPct(delta!)}`,
      summary: `${label} ${opts.metricLabel} ${direction} ${fmtPct(delta!)} from ${fmtMoney(previous.v)} to ${fmtMoney(latest.v)} in cached provider snapshots.`,
      occurredAt,
      importanceScore: Math.round(scoreFromMagnitude(absPct) * 100),
      promotionScore: scoreFromMagnitude(absPct),
      sourceTable: opts.table,
      sourceRecordId,
      rawHash,
      entityRefs: uniq([subjectRef, ...(opts.entityRefs?.(latest.row) || [])]),
      narrativeRefs: uniq(opts.narrativeRefs?.(latest.row) || []),
      chains: uniq(opts.chains?.(latest.row) || []),
      evidenceRefs: [{ table: opts.table, subject: subjectRef, as_of: occurredAt, metric: opts.metricLabel }],
      payload,
      promoteEventMemory: true,
    })
  }
  return out
}

export function detectMaterialSnapshotPromotions(inputs: SnapshotInputs): ProviderSnapshotPromotionCandidate[] {
  const candidates: ProviderSnapshotPromotionCandidate[] = [
    ...groupedShift(inputs.priceRows, {
      table: 'token_price_snapshots',
      kind: 'asset_price_shift',
      subjectType: 'asset',
      eventType: 'other',
      metricLabel: 'price',
      key: (r) => clean(r.canonical_asset_key),
      label: (r) => clean(r.canonical_asset_key),
      value: (r) => num(r.price_usd),
      time: (r) => iso(r.ts),
      entityRefs: (r) => [clean(r.canonical_asset_key)],
      chains: (r) => [clean(r.chain)],
    }),
    ...groupedShift(inputs.dexRows, {
      table: 'dex_pair_snapshots',
      kind: 'dex_liquidity_shift',
      subjectType: 'asset',
      eventType: 'other',
      metricLabel: 'DEX liquidity',
      key: (r) => clean(r.token_address) || clean(r.symbol),
      label: (r) => clean(r.symbol) || clean(r.token_address),
      value: (r) => num(r.liquidity_usd),
      time: (r) => iso(r.fetched_at),
      entityRefs: (r) => [clean(r.symbol), clean(r.token_address)],
      chains: (r) => [clean(r.chain)],
    }),
    ...groupedShift(inputs.protocolTvlRows, {
      table: 'protocol_tvl_snapshots',
      kind: 'protocol_tvl_shift',
      subjectType: 'protocol',
      eventType: 'other',
      metricLabel: 'TVL',
      key: (r) => `${clean(r.protocol_slug)}:${clean(r.chain)}`,
      label: (r) => clean(r.protocol_name) || clean(r.protocol_slug),
      value: (r) => num(r.tvl_usd),
      time: (r) => iso(r.ts),
      entityRefs: (r) => [clean(r.protocol_slug)],
      chains: (r) => [clean(r.chain)],
    }),
    ...groupedShift(inputs.chainTvlRows, {
      table: 'chain_tvl_snapshots',
      kind: 'chain_tvl_shift',
      subjectType: 'chain',
      eventType: 'other',
      metricLabel: 'TVL',
      key: (r) => clean(r.chain),
      label: (r) => clean(r.chain),
      value: (r) => num(r.tvl_usd),
      time: (r) => iso(r.ts),
      entityRefs: (r) => [clean(r.chain)],
      chains: (r) => [clean(r.chain)],
    }),
    ...groupedShift(inputs.stablecoinRows, {
      table: 'stablecoin_supply_snapshots',
      kind: 'stablecoin_supply_shift',
      subjectType: 'stablecoin',
      eventType: 'stablecoin_depeg',
      metricLabel: 'circulating supply',
      key: (r) => `${clean(r.stablecoin)}:${clean(r.chain)}`,
      label: (r) => clean(r.stablecoin),
      value: (r) => num(r.circulating_usd),
      time: (r) => iso(r.ts),
      entityRefs: (r) => [clean(r.stablecoin)],
      chains: (r) => [clean(r.chain)],
    }),
    ...groupedShift(inputs.macroRows, {
      table: 'market_macro_snapshots',
      kind: 'macro_market_cap_shift',
      subjectType: 'macro',
      eventType: 'macro_shock',
      metricLabel: 'total crypto market cap',
      key: (r) => clean(r.snapshot_kind) || 'global',
      label: (r) => clean(r.snapshot_kind) || 'Global market',
      value: (r) => num(r.total_market_cap_usd),
      time: (r) => iso(r.as_of),
      narrativeRefs: () => ['macro'],
    }),
    ...groupedShift(inputs.categoryRows, {
      table: 'narrative_category_snapshots',
      kind: 'narrative_market_cap_shift',
      subjectType: 'narrative',
      eventType: 'other',
      metricLabel: 'category market cap',
      key: (r) => clean(r.category_id),
      label: (r) => clean(r.category_label) || clean(r.category_id),
      value: (r) => num(r.market_cap_usd),
      time: (r) => iso(r.as_of),
      narrativeRefs: (r) => [clean(r.category_id)],
    }),
  ]

  for (const row of inputs.largeTransferRows || []) {
    const value = num(row.usd_value)
    const floor = Math.max(num(row.threshold_usd) || 0, PRIVATE_FLOW_FLOOR_USD)
    const occurredAt = iso(row.observed_at) || iso(row.fetched_at)
    const orgId = clean(row.org_id)
    const userId = clean(row.user_id)
    if (value == null || value < floor || !occurredAt || !orgId || !userId) continue
    const subjectRef = clean(row.canonical_asset_key) || clean(row.symbol) || clean(row.token_address) || 'asset_flow'
    const payload = {
      kind: 'large_private_transfer',
      value_usd: value,
      threshold_usd: num(row.threshold_usd),
      direction: clean(row.direction),
      source_table: 'large_transfer_events',
      private_user_scope: true,
    }
    const rawHash = h32(JSON.stringify(payload))
    const sourceRecordId = `large_private_transfer:${orgId}:${userId}:${subjectRef}:${dayBucket(occurredAt)}:${rawHash}`
    candidates.push({
      key: `provider_snapshot:${sourceRecordId}`,
      visibility: 'org_private',
      orgId,
      userId,
      kind: 'large_private_transfer',
      eventType: 'large_transfer',
      subjectType: 'asset_flow',
      subjectRef,
      title: `${subjectRef} large wallet transfer ${fmtMoney(value)}`,
      summary: `A private tracked-wallet flow for ${subjectRef} crossed ${fmtMoney(floor)} at ${fmtMoney(value)}. This is retained only in the tenant-scoped memory lane.`,
      occurredAt,
      importanceScore: Math.max(78, Math.min(98, Math.round(78 + Math.log10(Math.max(value, 1) / floor) * 10))),
      promotionScore: Math.max(0.78, Math.min(0.98, 0.78 + Math.log10(Math.max(value, 1) / floor) / 10)),
      sourceTable: 'large_transfer_events',
      sourceRecordId,
      rawHash,
      entityRefs: uniq([subjectRef, clean(row.symbol), clean(row.token_address)]),
      narrativeRefs: [],
      chains: uniq([clean(row.chain)]),
      evidenceRefs: [{ table: 'large_transfer_events', subject: subjectRef, as_of: occurredAt, metric: 'usd_value' }],
      payload,
      promoteEventMemory: false,
    })
  }

  return candidates.sort((a, b) => b.importanceScore - a.importanceScore).slice(0, 80)
}

async function getRows(db: DB, table: string, columns: string, timeColumn: string, sinceIso: string, limit = 600) {
  const { data, error } = await db.from(table)
    .select(columns)
    .gte(timeColumn, sinceIso)
    .order(timeColumn, { ascending: false })
    .limit(limit)
  if (error) return []
  return data || []
}

async function upsertEventMemory(db: DB, c: ProviderSnapshotPromotionCandidate): Promise<string | null> {
  if (!c.promoteEventMemory) return null
  const row = {
    event_key: c.key,
    event_type: c.eventType,
    title: c.title,
    summary: c.summary,
    occurred_at: c.occurredAt,
    importance_score: c.importanceScore,
    importance_source: 'deterministic_provider_snapshot',
    categories: [],
    assets: c.entityRefs,
    chains: c.chains,
    narratives: c.narrativeRefs,
    macro_topics: c.kind.includes('macro') ? ['macro'] : [],
    evidence_hash: c.rawHash,
    evidence_refs: c.evidenceRefs,
    retain_until: new Date(Date.parse(c.occurredAt) + 3 * 365 * DAY_MS).toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await db.from('intel_event_memory')
    .upsert(row, { onConflict: 'event_key' })
    .select('id')
    .maybeSingle()
  if (error) return null
  return data?.id ? String(data.id) : null
}

async function upsertDecisionMemory(db: DB, c: ProviderSnapshotPromotionCandidate, eventId: string | null): Promise<string | null> {
  const decisionHash = h32(`${c.visibility}:${c.orgId || 'global'}:${c.key}:${c.rawHash}`)
  let existing = db.from('decision_memory').select('id')
    .eq('surface', 'provider_snapshot_memory')
    .eq('decision_kind', c.kind)
    .eq('decision_hash', decisionHash)
    .limit(1)
  existing = c.orgId ? existing.eq('org_id', c.orgId) : existing.is('org_id', null)
  const { data: prior } = await existing.maybeSingle()
  if (prior?.id) return String(prior.id)

  const { data, error } = await db.from('decision_memory')
    .insert({
      visibility: c.visibility,
      org_id: c.orgId || null,
      user_id: c.userId || null,
      surface: 'provider_snapshot_memory',
      decision_kind: c.kind,
      subject_type: c.subjectType,
      subject_ref: c.subjectRef,
      recommendation: 'Preserve this provider snapshot change as material context.',
      conclusion: c.title,
      reasoning_summary: c.summary,
      evidence_refs: c.evidenceRefs,
      source_refs: c.evidenceRefs,
      entity_refs: c.entityRefs,
      narrative_refs: c.narrativeRefs,
      confidence: c.importanceScore >= 86 ? 'high' : 'medium',
      confidence_score: c.promotionScore,
      decision_hash: decisionHash,
      metadata: {
        ...c.payload,
        event_memory_id: eventId,
        private_user_scope: c.visibility === 'org_private',
      },
    })
    .select('id')
    .maybeSingle()
  if (error) return null
  return data?.id ? String(data.id) : null
}

async function upsertPromotion(db: DB, c: ProviderSnapshotPromotionCandidate, memoryType: string, memoryRef: string | null) {
  let q = db.from('intelligence_promotions').select('id')
    .eq('visibility', c.visibility)
    .eq('raw_table', c.sourceTable)
    .eq('raw_record_id', c.sourceRecordId)
    .limit(1)
  q = c.orgId ? q.eq('org_id', c.orgId) : q.is('org_id', null)
  const payload = {
    visibility: c.visibility,
    org_id: c.orgId || null,
    raw_table: c.sourceTable,
    raw_record_id: c.sourceRecordId,
    raw_hash: c.rawHash,
    promotion_status: 'promoted',
    promotion_score: c.promotionScore,
    validation_status: 'deterministic_materiality',
    entity_refs: c.entityRefs,
    narrative_refs: c.narrativeRefs,
    event_refs: memoryType === 'event_memory' && memoryRef ? [memoryRef] : [],
    source_refs: c.evidenceRefs,
    promoted_memory_type: memoryType,
    promoted_memory_ref: memoryRef,
    derived_payload: c.payload,
    promoted_at: new Date().toISOString(),
    observed_at: c.occurredAt,
    updated_at: new Date().toISOString(),
  }
  const { data: prior } = await q.maybeSingle()
  if (prior?.id) {
    await db.from('intelligence_promotions').update(payload).eq('id', prior.id)
    return prior.id
  }
  const { data } = await db.from('intelligence_promotions').insert(payload).select('id').maybeSingle()
  return data?.id || null
}

export async function promoteProviderSnapshotMemory(db: DB, options: { lookbackDays?: number; now?: Date } = {}) {
  const now = options.now || new Date()
  const lookbackDays = Math.max(2, Math.min(options.lookbackDays || DEFAULT_LOOKBACK_DAYS, 90))
  const sinceIso = new Date(now.getTime() - lookbackDays * DAY_MS).toISOString()
  const [
    priceRows,
    dexRows,
    protocolTvlRows,
    chainTvlRows,
    stablecoinRows,
    macroRows,
    categoryRows,
    largeTransferRows,
  ] = await Promise.all([
    getRows(db, 'token_price_snapshots', 'canonical_asset_key,chain,price_usd,ts', 'ts', sinceIso),
    getRows(db, 'dex_pair_snapshots', 'chain,token_address,symbol,liquidity_usd,fetched_at', 'fetched_at', sinceIso),
    getRows(db, 'protocol_tvl_snapshots', 'protocol_slug,protocol_name,chain,tvl_usd,ts', 'ts', sinceIso),
    getRows(db, 'chain_tvl_snapshots', 'chain,tvl_usd,ts', 'ts', sinceIso),
    getRows(db, 'stablecoin_supply_snapshots', 'stablecoin,chain,circulating_usd,peg,ts', 'ts', sinceIso),
    getRows(db, 'market_macro_snapshots', 'provider,snapshot_kind,total_market_cap_usd,btc_dominance_pct,eth_dominance_pct,as_of', 'as_of', sinceIso),
    getRows(db, 'narrative_category_snapshots', 'category_id,category_label,rank,market_cap_usd,market_cap_change_24h_pct,as_of', 'as_of', sinceIso),
    getRows(db, 'large_transfer_events', 'org_id,user_id,chain,canonical_asset_key,symbol,token_address,usd_value,threshold_usd,direction,observed_at,fetched_at', 'fetched_at', sinceIso),
  ])

  const candidates = detectMaterialSnapshotPromotions({
    priceRows,
    dexRows,
    protocolTvlRows,
    chainTvlRows,
    stablecoinRows,
    macroRows,
    categoryRows,
    largeTransferRows,
    now,
  })

  let eventRows = 0
  let decisionRows = 0
  let promotionRows = 0
  for (const c of candidates) {
    const eventId = await upsertEventMemory(db, c)
    if (eventId) eventRows += 1
    const decisionId = await upsertDecisionMemory(db, c, eventId)
    if (decisionId) decisionRows += 1
    const promotionId = await upsertPromotion(db, c, eventId ? 'event_memory' : 'decision_memory', eventId || decisionId)
    if (promotionId) promotionRows += 1
  }

  let embeddingJobs: unknown = null
  let regimeMemory: unknown = null
  let regimeAnalogs: unknown = null
  try {
    const { data } = await db.rpc('intelligence_promote_market_regime_memory', { p_lookback_days: 365 })
    regimeMemory = data
  } catch {
    regimeMemory = { skipped: true }
  }
  try {
    const { data } = await db.rpc('intelligence_generate_market_regime_analogs', { p_lookback_days: 365, p_min_similarity: 0.55 })
    regimeAnalogs = data
  } catch {
    regimeAnalogs = { skipped: true }
  }
  try {
    const { data } = await db.rpc('intelligence_enqueue_memory_embedding_jobs', { p_limit: 500 })
    embeddingJobs = data
  } catch {
    embeddingJobs = { skipped: true }
  }

  return {
    lookback_days: lookbackDays,
    candidates: candidates.length,
    event_memory_rows: eventRows,
    decision_memory_rows: decisionRows,
    promotion_rows: promotionRows,
    regime_memory: regimeMemory,
    regime_analogs: regimeAnalogs,
    embedding_jobs: embeddingJobs,
  }
}
