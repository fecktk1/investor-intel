import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { isPruneEligible, prunePreview, TIER_DAYS } from './retention.ts'

const NOW = Date.UTC(2026, 5, 10)
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

Deno.test('standard tier = 15 months (456 days), not 180', () => {
  assertEquals(TIER_DAYS.standard, 456)
  assert(isPruneEligible({ age_ts: daysAgo(460) }, 'standard', NOW))
  assert(!isPruneEligible({ age_ts: daysAgo(200) }, 'standard', NOW), '200d-old standard row must NOT prune (15mo baseline)')
})

Deno.test('retain_forever is ALWAYS protected', () => {
  assert(!isPruneEligible({ age_ts: daysAgo(9999), retain_forever: true }, 'standard', NOW))
  assert(!isPruneEligible({ age_ts: daysAgo(9999), retain_forever: true }, 'low_value', NOW))
})

Deno.test('evergreen / important / historic tiers never prune', () => {
  for (const tier of ['evergreen', 'important', 'historic'] as const) {
    assert(!isPruneEligible({ age_ts: daysAgo(9999) }, tier, NOW), `${tier} must not prune`)
  }
  // even a row whose row-level tier is protected, under a standard config:
  assert(!isPruneEligible({ age_ts: daysAgo(9999), retention_tier: 'evergreen' }, 'standard', NOW))
  assert(!isPruneEligible({ age_ts: daysAgo(9999), retention_tier: 'important' }, 'standard', NOW))
})

Deno.test('future retain_until protects; past retain_until allows', () => {
  assert(!isPruneEligible({ age_ts: daysAgo(999), retain_until: new Date(NOW + 86_400_000).toISOString() }, 'standard', NOW))
  assert(isPruneEligible({ age_ts: daysAgo(999), retain_until: daysAgo(1) }, 'standard', NOW))
})

Deno.test('unknown age never prunes (conservative)', () => {
  assert(!isPruneEligible({ age_ts: null }, 'standard', NOW))
  assert(!isPruneEligible({}, 'low_value', NOW))
})

Deno.test('media 7d / low_value 45d bands', () => {
  assert(isPruneEligible({ age_ts: daysAgo(8) }, 'media', NOW))
  assert(!isPruneEligible({ age_ts: daysAgo(6) }, 'media', NOW))
  assert(isPruneEligible({ age_ts: daysAgo(46) }, 'low_value', NOW))
  assert(!isPruneEligible({ age_ts: daysAgo(44) }, 'low_value', NOW))
})

Deno.test('prunePreview partitions and never includes a protected row', () => {
  const rows = [
    { age_ts: daysAgo(500) },                              // eligible
    { age_ts: daysAgo(500), retain_forever: true },        // protected
    { age_ts: daysAgo(500), retention_tier: 'historic' },  // protected
    { age_ts: daysAgo(10) },                               // too new
  ]
  const { eligible, protected_ } = prunePreview(rows, 'standard', NOW)
  assertEquals(eligible.length, 1)
  assertEquals(protected_.length, 3)
  assert(!eligible.some((r) => r.retain_forever || r.retention_tier === 'historic'))
})
