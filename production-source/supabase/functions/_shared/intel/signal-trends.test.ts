import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { computeTrends } from './signal-trends.ts'

const H = 3_600_000
const D = 86_400_000
const now = 1_700_000_000_000

Deno.test('window deltas use the snapshot nearest at-or-before each cutoff', () => {
  const hist = [
    { snapshot_at: new Date(now - 8 * D).toISOString(), value: 0.20, direction: 'bullish' },
    { snapshot_at: new Date(now - 25 * H).toISOString(), value: 0.30, direction: 'bullish' },
    { snapshot_at: new Date(now - 2 * H).toISOString(), value: 0.45, direction: 'bullish' },
  ]
  const t = computeTrends(hist, { value: 0.50, direction: 'bullish' }, now)
  assertEquals(t.d_1h, 0.05) // 0.50 - 0.45 (2h-ago is newest ≤ 1h cutoff)
  assertEquals(t.d_24h, 0.20) // 0.50 - 0.30 (25h-ago is newest ≤ 24h cutoff)
  assertEquals(t.d_7d, 0.30) // 0.50 - 0.20 (8d-ago is newest ≤ 7d cutoff)
})

Deno.test('empty history → null windows, no streak/slope', () => {
  const t = computeTrends([], { value: 0.5, direction: 'bullish' }, now)
  assertEquals(t.d_1h, null)
  assertEquals(t.d_24h, null)
  assertEquals(t.d_7d, null)
  assertEquals(t.streak, 0)
  assertEquals(t.slope, null)
  assertEquals(t.decay, null)
})

Deno.test('streak counts consecutive rising steps and a positive slope', () => {
  const hist = [0.1, 0.2, 0.3].map((v, i) => ({ snapshot_at: new Date(now - (3 - i) * H).toISOString(), value: v, direction: 'bullish' }))
  const t = computeTrends(hist, { value: 0.4, direction: 'bullish' }, now)
  assertEquals(t.streak, 3) // 0.1→0.2→0.3→0.4 = three up steps
  assert((t.slope ?? 0) > 0)
})

Deno.test('a direction flip resets the streak at the flip boundary', () => {
  const hist = [
    { snapshot_at: new Date(now - 3 * H).toISOString(), value: 0.30, direction: 'bearish' },
    { snapshot_at: new Date(now - 2 * H).toISOString(), value: 0.35, direction: 'bullish' },
    { snapshot_at: new Date(now - 1 * H).toISOString(), value: 0.40, direction: 'bullish' },
  ]
  const t = computeTrends(hist, { value: 0.45, direction: 'bullish' }, now)
  assertEquals(t.streak, 2) // counts the two post-flip rises, stops at the bearish→bullish flip
})

Deno.test('falling series yields negative deltas and slope', () => {
  const hist = [0.6, 0.5, 0.4].map((v, i) => ({ snapshot_at: new Date(now - (28 - i * 2) * H).toISOString(), value: v, direction: 'bearish' }))
  const t = computeTrends(hist, { value: 0.35, direction: 'bearish' }, now)
  assert((t.d_24h ?? 0) < 0)
  assert((t.slope ?? 0) < 0)
  assertEquals(t.streak, 3)
})
