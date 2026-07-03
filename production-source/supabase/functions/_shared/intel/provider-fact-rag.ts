// Provider-fact → RAG promotion helper (v3.1, Batch 2).
//
// Reuses the platform's existing promotion→embedding→retrieval pipeline (do NOT
// build a second RAG system): durable, reusable provider facts (token security,
// risk summaries, holder concentration, smart-money, metadata drift) are written
// to `decision_memory` (+ `intelligence_promotions`, + `intel_event_memory` for
// material events). The existing cron `intelligence_enqueue_memory_embedding_jobs`
// picks them up, embeds them into `intelligence_memory_embeddings`, and they
// surface via `assembleIntelligenceContext()`.
//
// Rules: promote SUMMARIES/facts, never raw high-volume rows. Every fact carries
// provenance (provider, endpoint, source_table/id, fetched_at, stale_after,
// confidence, canonical entity refs) so retrieval is trustworthy and auditable.

// deno-lint-ignore no-explicit-any
type DB = any

export interface ProviderFact {
  visibility?: 'global_derived' | 'org_private' | 'global_public'
  orgId?: string | null
  userId?: string | null
  decisionKind: string        // 'token_security_fact' | 'token_risk_summary' | 'holder_concentration_summary' | 'smart_money_summary' | 'metadata_migration'
  subjectType: string         // 'asset' | 'wallet' | 'token'
  subjectRef: string          // canonical_ref_key or 'chain:address'
  entityRefs: string[]        // [canonical_ref_key, ...]
  chains?: string[]
  narrativeRefs?: string[]
  title: string               // short conclusion (<= ~160 chars)
  summary: string             // durable human-readable reasoning summary
  confidenceScore?: number    // 0..1
  provider: string            // 'birdeye' | 'coingecko' | 'helius' | ...
  endpoint: string            // logical endpoint id (matches provider_integrations)
  sourceTable: string         // e.g. 'token_security_snapshots'
  sourceId: string            // row id / natural key
  fetchedAt: string           // ISO
  staleAfter?: string | null
  evidenceRefs?: unknown[]    // [{ table, id, as_of, metric }]
  materialEvent?: boolean     // also promote to event_memory (migrations, honeypot flips, ...)
  eventType?: string
  importanceScore?: number    // 0..100 (material events)
  payload?: Record<string, unknown>
}

const SURFACE = 'provider_fact_memory'
const DAY_MS = 86_400_000

// Stable 32-bit FNV-1a hash (hex) — matches the platform's dedup-hash intent
// without importing internals. Deterministic across runs.
export function stableHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return ('0000000' + h.toString(16)).slice(-8)
}

export function confidenceLabel(score?: number): 'high' | 'medium' | 'low' {
  if (score == null) return 'medium'
  if (score >= 0.75) return 'high'
  if (score >= 0.45) return 'medium'
  return 'low'
}

function factHash(f: ProviderFact): string {
  return stableHash(`${f.visibility || 'global_derived'}:${f.orgId || 'global'}:${f.sourceTable}:${f.sourceId}:${f.provider}:${f.endpoint}:${f.title}:${f.summary}`)
}

function provenance(f: ProviderFact): Record<string, unknown> {
  return {
    provider: f.provider,
    endpoint: f.endpoint,
    source_table: f.sourceTable,
    source_id: f.sourceId,
    fetched_at: f.fetchedAt,
    stale_after: f.staleAfter ?? null,
    canonical_ref_key: f.subjectRef,
    chains: f.chains ?? [],
  }
}

// ── Pure row builders (unit-testable, no DB) ─────────────────────────────────
export function buildDecisionRow(f: ProviderFact): Record<string, unknown> {
  const hash = factHash(f)
  return {
    visibility: f.visibility || 'global_derived',
    org_id: f.orgId ?? null,
    user_id: f.userId ?? null,
    surface: SURFACE,
    decision_kind: f.decisionKind,
    subject_type: f.subjectType,
    subject_ref: f.subjectRef,
    conclusion: f.title,
    reasoning_summary: f.summary,
    evidence_refs: f.evidenceRefs ?? [],
    source_refs: [provenance(f)],
    entity_refs: f.entityRefs,
    narrative_refs: f.narrativeRefs ?? [],
    confidence: confidenceLabel(f.confidenceScore),
    confidence_score: f.confidenceScore ?? null,
    decision_hash: hash,
    metadata: { ...(f.payload || {}), provenance: provenance(f) },
    updated_at: new Date(f.fetchedAt).toISOString(),
  }
}

export function buildPromotionRow(f: ProviderFact, decisionRef: string | null): Record<string, unknown> {
  const nowIso = new Date(f.fetchedAt).toISOString()
  return {
    visibility: f.visibility || 'global_derived',
    org_id: f.orgId ?? null,
    raw_table: f.sourceTable,
    raw_record_id: f.sourceId,
    raw_hash: factHash(f),
    promotion_status: 'promoted',
    promotion_score: f.confidenceScore ?? 0.6,
    validation_status: 'deterministic_provider_fact',
    entity_refs: f.entityRefs,
    narrative_refs: f.narrativeRefs ?? [],
    event_refs: [],
    source_refs: [provenance(f)],
    promoted_memory_type: 'decision_memory',
    promoted_memory_ref: decisionRef,
    derived_payload: { ...(f.payload || {}), title: f.title, summary: f.summary },
    observed_at: f.fetchedAt,
    promoted_at: nowIso,
    created_at: nowIso,
    updated_at: nowIso,
  }
}

export function buildEventRow(f: ProviderFact): Record<string, unknown> | null {
  if (!f.materialEvent) return null
  return {
    event_key: `provider_fact:${f.sourceTable}:${f.sourceId}:${factHash(f)}`,
    event_type: f.eventType || f.decisionKind,
    title: f.title,
    summary: f.summary,
    occurred_at: f.fetchedAt,
    importance_score: f.importanceScore ?? 70,
    importance_source: 'deterministic_provider_fact',
    categories: [],
    assets: f.entityRefs,
    chains: f.chains ?? [],
    narratives: f.narrativeRefs ?? [],
    macro_topics: [],
    evidence_hash: factHash(f),
    evidence_refs: f.evidenceRefs ?? [],
    retain_until: new Date(Date.parse(f.fetchedAt) + 540 * DAY_MS).toISOString(),
    updated_at: new Date(f.fetchedAt).toISOString(),
  }
}

// ── DB write (idempotent, best-effort per table) ─────────────────────────────
// NOTE: decision_memory's unique index is PARTIAL (WHERE decision_hash IS NOT
// NULL), which PostgREST upsert cannot infer — so we SELECT-then-INSERT there,
// mirroring the proven pattern in provider-snapshot-promotion.ts. event_memory
// (event_key UNIQUE) uses a real upsert.
export async function promoteProviderFact(
  db: DB,
  f: ProviderFact,
): Promise<{ decisionId: string | null; promotionId: string | null; eventId: string | null }> {
  let decisionId: string | null = null
  let promotionId: string | null = null
  let eventId: string | null = null

  // event_memory first (so the promotion can reference it if needed)
  const eventRow = buildEventRow(f)
  if (eventRow) {
    try {
      const { data } = await db.from('intel_event_memory')
        .upsert(eventRow, { onConflict: 'event_key' }).select('id').maybeSingle()
      eventId = data?.id ? String(data.id) : null
    } catch { /* additive/best-effort */ }
  }

  // decision_memory: SELECT-then-INSERT (partial unique index).
  const decisionRow = buildDecisionRow(f)
  try {
    let q = db.from('decision_memory').select('id')
      .eq('surface', SURFACE).eq('decision_kind', f.decisionKind)
      .eq('decision_hash', decisionRow.decision_hash as string).limit(1)
    q = f.orgId ? q.eq('org_id', f.orgId) : q.is('org_id', null)
    const { data: prior } = await q.maybeSingle()
    if (prior?.id) {
      decisionId = String(prior.id)
    } else {
      const { data } = await db.from('decision_memory').insert(decisionRow).select('id').maybeSingle()
      decisionId = data?.id ? String(data.id) : null
    }
  } catch { /* best-effort */ }

  // intelligence_promotions: SELECT-then-INSERT/UPDATE on the full unique key.
  try {
    const promoRow = buildPromotionRow(f, decisionId)
    if (eventId) promoRow.event_refs = [eventId]
    let q = db.from('intelligence_promotions').select('id')
      .eq('visibility', promoRow.visibility as string)
      .eq('raw_table', f.sourceTable).eq('raw_record_id', f.sourceId).limit(1)
    q = f.orgId ? q.eq('org_id', f.orgId) : q.is('org_id', null)
    const { data: prior } = await q.maybeSingle()
    if (prior?.id) {
      await db.from('intelligence_promotions').update(promoRow).eq('id', prior.id)
      promotionId = String(prior.id)
    } else {
      const { data } = await db.from('intelligence_promotions').insert(promoRow).select('id').maybeSingle()
      promotionId = data?.id ? String(data.id) : null
    }
  } catch { /* best-effort */ }

  return { decisionId, promotionId, eventId }
}
