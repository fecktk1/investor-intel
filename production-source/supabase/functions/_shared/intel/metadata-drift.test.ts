import {
  detectMetadataDrift, platformsChanged, metaFromCoinDoc, driftDedupKey, type MetaBaseline,
} from './metadata-drift.ts'

function assert(c: unknown, m: string) { if (!c) throw new Error(m) }
function eq(a: unknown, b: unknown, m: string) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

Deno.test('platformsChanged: contract migration when a chain address changes', () => {
  const a = { solana: 'ABC' }, b = { solana: 'XYZ' }
  const r = platformsChanged(a, b)
  assert(r.changed, 'address change detected')
  assert(r.detail.solana, 'solana chain flagged')
})

Deno.test('platformsChanged: added/removed chain is drift; identical is not', () => {
  assert(platformsChanged({ solana: 'A' }, { solana: 'A', base: 'B' }).changed, 'new chain listing is drift')
  assert(platformsChanged({ solana: 'A', base: 'B' }, { solana: 'A' }).changed, 'removed chain is drift')
  assert(!platformsChanged({ solana: 'A' }, { solana: 'a' }).changed, 'case-insensitive => no false drift')
  assert(!platformsChanged({}, {}).changed, 'empty == empty')
})

Deno.test('metaFromCoinDoc extracts symbol/name/image/platforms (lowercased)', () => {
  const doc = { symbol: 'WSOL', name: 'Wrapped SOL', image: { large: 'http://x/large.png' }, platforms: { Solana: 'So111' } }
  const m = metaFromCoinDoc(doc)
  eq(m.symbol, 'wsol', 'symbol lowercased')
  eq(m.name, 'Wrapped SOL', 'name preserved')
  eq(m.image, 'http://x/large.png', 'large image chosen')
  eq(m.platforms?.solana, 'so111', 'platform chain+addr lowercased')
})

Deno.test('detectMetadataDrift: contract migration is highest severity', () => {
  const base: MetaBaseline = { symbol: 'aaa', name: 'Aaa', image: 'i1', platforms: { solana: 'old' } }
  const next: MetaBaseline = { symbol: 'aaa', name: 'Aaa', image: 'i1', platforms: { solana: 'new' } }
  const drift = detectMetadataDrift(base, next)
  eq(drift.length, 1, 'one drift')
  eq(drift[0].drift_type, 'contract_migration', 'migration')
  eq(drift[0].severity, 90, 'severity 90')
})

Deno.test('detectMetadataDrift: symbol/name/logo changes each detected with severity ordering', () => {
  const base: MetaBaseline = { symbol: 'aaa', name: 'Aaa', image: 'i1', platforms: { solana: 'x' } }
  const next: MetaBaseline = { symbol: 'bbb', name: 'Bbb', image: 'i2', platforms: { solana: 'x' } }
  const drift = detectMetadataDrift(base, next)
  eq(drift.length, 3, 'symbol + name + logo')
  const types = drift.map((d) => d.drift_type)
  assert(types.includes('symbol_change') && types.includes('name_change') && types.includes('logo_change'), 'all three types')
  eq(drift.find((d) => d.drift_type === 'symbol_change')!.severity, 60, 'symbol=60')
})

Deno.test('detectMetadataDrift: no drift when unchanged; null fields ignored', () => {
  const base: MetaBaseline = { symbol: 'aaa', name: 'Aaa', image: 'i1', platforms: { solana: 'x' } }
  eq(detectMetadataDrift(base, base).length, 0, 'identical => no drift')
  const partial: MetaBaseline = { symbol: null, name: null, image: null, platforms: { solana: 'x' } }
  eq(detectMetadataDrift(base, partial).length, 0, 'null next fields do not false-trigger')
})

Deno.test('driftDedupKey stable per (ref, type, new value)', () => {
  const d = { drift_type: 'contract_migration' as const, severity: 90, old_value: {}, new_value: { solana: 'new' } }
  eq(driftDedupKey('solana:mint', d), driftDedupKey('solana:mint', d), 'deterministic')
  assert(driftDedupKey('solana:mint', d) !== driftDedupKey('solana:other', d), 'ref-scoped')
})
