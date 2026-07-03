import {
  buildDecisionRow, buildPromotionRow, buildEventRow,
  confidenceLabel, stableHash, type ProviderFact,
} from './provider-fact-rag.ts'

function assert(c: unknown, m: string) { if (!c) throw new Error(m) }
function eq(a: unknown, b: unknown, m: string) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const baseFact = (over: Partial<ProviderFact> = {}): ProviderFact => ({
  decisionKind: 'token_security_fact',
  subjectType: 'token',
  subjectRef: 'solana:So11111111111111111111111111111111111111112',
  entityRefs: ['solana:So11111111111111111111111111111111111111112'],
  chains: ['solana'],
  title: 'WSOL: mint authority renounced, LP 100% burned, not a honeypot',
  summary: 'Birdeye token_security + CoinGecko GT agree: mint/freeze authority null, LP burned 100%, is_honeypot=false, top10=41%.',
  confidenceScore: 0.82,
  provider: 'birdeye',
  endpoint: 'birdeye:/defi/token_security',
  sourceTable: 'token_security_snapshots',
  sourceId: 'solana:So1111...:2026-07-03',
  fetchedAt: '2026-07-03T12:00:00.000Z',
  staleAfter: '2026-07-04T12:00:00.000Z',
  evidenceRefs: [{ table: 'token_security_snapshots', id: 'abc', as_of: '2026-07-03T12:00:00.000Z', metric: 'lp_burned_pct' }],
  ...over,
})

Deno.test('stableHash is deterministic and 8-hex', () => {
  eq(stableHash('abc'), stableHash('abc'), 'same input => same hash')
  assert(stableHash('abc') !== stableHash('abd'), 'different input => different hash')
  assert(/^[0-9a-f]{8}$/.test(stableHash('anything')), 'hash is 8 hex chars')
})

Deno.test('confidenceLabel buckets', () => {
  eq(confidenceLabel(0.9), 'high', 'high')
  eq(confidenceLabel(0.5), 'medium', 'medium')
  eq(confidenceLabel(0.2), 'low', 'low')
  eq(confidenceLabel(undefined), 'medium', 'default medium')
})

Deno.test('decision row: correct surface/columns + provenance + entity refs', () => {
  const row = buildDecisionRow(baseFact())
  eq(row.surface, 'provider_fact_memory', 'surface key')
  eq(row.decision_kind, 'token_security_fact', 'decision_kind')
  eq(row.subject_type, 'token', 'subject_type')
  eq(row.confidence, 'high', 'confidence label from 0.82')
  eq((row.entity_refs as string[]).length, 1, 'entity_refs carried')
  const prov = (row.source_refs as Array<Record<string, unknown>>)[0]
  eq(prov.provider, 'birdeye', 'provenance provider')
  eq(prov.source_table, 'token_security_snapshots', 'provenance source_table')
  eq(prov.canonical_ref_key, baseFact().subjectRef, 'provenance canonical key')
  assert(typeof row.decision_hash === 'string' && (row.decision_hash as string).length === 8, 'decision_hash set')
})

Deno.test('dedup: identical fact => identical decision_hash; changed summary => new hash', () => {
  const a = buildDecisionRow(baseFact()).decision_hash
  const b = buildDecisionRow(baseFact()).decision_hash
  eq(a, b, 'stable across identical facts (idempotent upsert key)')
  const c = buildDecisionRow(baseFact({ summary: 'changed' })).decision_hash
  assert(a !== c, 'material summary change produces a new hash (re-embed)')
})

Deno.test('promotion row: full unique key + promoted status + links decision', () => {
  const row = buildPromotionRow(baseFact(), 'decision-123')
  eq(row.raw_table, 'token_security_snapshots', 'raw_table = source table')
  eq(row.raw_record_id, baseFact().sourceId, 'raw_record_id = source id')
  eq(row.promotion_status, 'promoted', 'promoted so the embed cron enqueues it')
  eq(row.promoted_memory_type, 'decision_memory', 'links decision_memory')
  eq(row.promoted_memory_ref, 'decision-123', 'ref set')
  eq(row.visibility, 'global_derived', 'default visibility is cross-org derived')
})

Deno.test('event row only for material events (migrations/honeypot flips), else null', () => {
  eq(buildEventRow(baseFact()), null, 'non-material fact does not spam event_memory')
  const ev = buildEventRow(baseFact({ materialEvent: true, eventType: 'metadata_migration', importanceScore: 90 }))
  assert(ev, 'material event produces an event_memory row')
  eq(ev!.event_type, 'metadata_migration', 'event_type')
  eq(ev!.importance_score, 90, 'importance carried')
  assert(String(ev!.event_key).startsWith('provider_fact:'), 'namespaced event_key')
})

Deno.test('org-private facts stay org-scoped (visibility + org_id)', () => {
  const row = buildDecisionRow(baseFact({ visibility: 'org_private', orgId: 'org-9' }))
  eq(row.visibility, 'org_private', 'visibility')
  eq(row.org_id, 'org-9', 'org scoped')
})
