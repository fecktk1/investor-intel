// Tests for the Degen query core. Run:
//   deno test supabase/functions/intel-degen/index.test.ts
//
// index.ts itself is a Deno.serve listener plus two table reads; everything a
// reader can actually observe lives in applyDegenQuery, so that is what is
// proved here.

import { applyDegenQuery, DegenQueryError } from '../_shared/memecoin/degen-query.ts'

function assert(c: unknown, m: string) { if (!c) throw new Error(m) }

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0)
const DAY = 86_400_000

const token = (p: Record<string, unknown>) => ({
  chain: 'solana', token_address: `Mint${Math.random().toString(36).slice(2, 8)}`,
  symbol: 'MEME', name: 'Meme Token', listing_state: 'verified', liquidity_verified: true,
  discovery_reasons: ['trending'], source: 'dexscreener',
  price_usd: 0.0001, change_1h_pct: 1, change_24h_pct: 5, volume_24h_usd: 250_000,
  liquidity_usd: 120_000, market_cap: 8_000_000, fdv: 9_000_000,
  buys_24h: 300, sells_24h: 200, txns_24h: 500, risk_score: 20,
  pair_created_at: new Date(NOW - 2 * DAY).toISOString(), as_of: '2026-09-14T11:00:00Z', ...p,
})

const ROWS = [
  token({ symbol: 'BONKY', token_address: 'Bonky1', fdv: 9_000_000 }),
  token({ symbol: 'WIFFY', token_address: 'Wiffy1', fdv: null }),
  token({ symbol: 'PEPO', token_address: 'Pepo1', fdv: 3_000_000 }),
  // gated: symbol deny list
  token({ symbol: 'USDT', token_address: 'FakeUsdt1', name: 'Not Tether' }),
  // gated: canonical contract, whatever it calls itself
  token({ symbol: 'USDCX', chain: 'base', token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }),
  // gated: homoglyph
  token({ symbol: 'ՍՏⅮТ', token_address: 'Impostor1' }),
  // gated: arithmetic
  token({ symbol: 'BLOTIX', token_address: 'Blotix1', market_cap: 57_860_000_000_000, liquidity_usd: 50_000 }),
  // gated: wrapped receipt
  token({ symbol: 'wstETH', chain: 'ethereum', token_address: '0xdeadbeef00000000000000000000000000000001' }),
]

Deno.test('the default view drops gated rows and says how many of each it dropped', () => {
  const out = applyDegenQuery(ROWS, {}, { now: NOW })
  assert(out.total === 3, `expected 3 rows, got ${out.total}`)
  assert(out.rows.every((r) => !('excludedReason' in r)), 'no excluded row leaked into the default view')
  assert(out.excluded.total === 5, `expected 5 exclusions, got ${out.excluded.total}`)
  assert(out.excluded.stablecoin === 2, `stablecoin ${out.excluded.stablecoin}`)
  assert(out.excluded.impersonation === 1, `impersonation ${out.excluded.impersonation}`)
  assert(out.excluded.implausible_cap === 1, `implausible ${out.excluded.implausible_cap}`)
  assert(out.excluded.wrapped_or_staked === 1, `wrapped ${out.excluded.wrapped_or_staked}`)
  assert(out.excluded.major === 0, `major ${out.excluded.major}`)
  assert(out.snapshot.verifiedCount === 3, 'the snapshot counts the gated population')
})

Deno.test('showExcluded returns ONLY the gated rows, each carrying its reason', () => {
  const out = applyDegenQuery(ROWS, { showExcluded: true }, { now: NOW })
  assert(out.showExcluded === true, 'showExcluded echoed')
  assert(out.total === 5, `expected 5 excluded rows, got ${out.total}`)
  assert(out.rows.every((r) => typeof r.excludedReason === 'string' && typeof r.excludedDetail === 'string'), 'every row names its reason')
  const reasons = new Set(out.rows.map((r) => r.excludedReason))
  assert(reasons.has('impersonation') && reasons.has('implausible_cap'), 'the interesting reasons are present')
  // The counts still describe the same population the list is showing.
  assert(out.excluded.total === out.total, 'counts and rows agree')
})

Deno.test('sorting is explicit: nulls last in both directions, unknown keys rejected', () => {
  const asc = applyDegenQuery(ROWS, { sort: 'fdv', dir: 'asc' }, { now: NOW })
  assert(asc.sort === 'fdv' && asc.dir === 'asc', 'sort and dir echoed')
  assert(asc.rows.map((r) => r.symbol).join(',') === 'PEPO,BONKY,WIFFY', `asc order ${asc.rows.map((r) => r.symbol).join(',')}`)
  const desc = applyDegenQuery(ROWS, { sort: 'fdv', dir: 'desc' }, { now: NOW })
  assert(desc.rows.map((r) => r.symbol).join(',') === 'BONKY,PEPO,WIFFY', `desc order ${desc.rows.map((r) => r.symbol).join(',')}`)
  // Named directions keep their name.
  assert(applyDegenQuery(ROWS, { sort: 'losers', dir: 'desc' }, { now: NOW }).dir === 'asc', 'losers stay ascending')

  let threw = ''
  try { applyDegenQuery(ROWS, { sort: 'sideways' }, { now: NOW }) } catch (e) { threw = (e as DegenQueryError).code }
  assert(threw === 'invalid_sort', `expected invalid_sort, got ${threw || 'no error'}`)
})

Deno.test('the launch-age buckets are always seven days and a zero stays a zero', () => {
  const out = applyDegenQuery(ROWS, {}, { now: NOW })
  assert(out.snapshot.ageBuckets.length === 7, `expected 7 buckets, got ${out.snapshot.ageBuckets.length}`)
  assert(out.snapshot.ageBuckets[6].label === 'Mon', `last bucket is today (Mon), got ${out.snapshot.ageBuckets[6].label}`)
  assert(out.snapshot.ageBuckets.reduce((s, b) => s + b.value, 0) === 3, 'every passing row landed in a bucket')
  assert(out.snapshot.ageBuckets.filter((b) => b.value === 0).length === 6, 'the empty days are zeros, not gaps')

  const older = applyDegenQuery(
    ROWS.map((r) => ({ ...r, pair_created_at: new Date(NOW - 40 * DAY).toISOString() })),
    {}, { now: NOW },
  )
  assert(older.snapshot.ageBuckets.every((b) => b.value === 0), 'nothing in the window')
  assert(older.snapshot.olderThan7d === 3, `olderThan7d ${older.snapshot.olderThan7d}`)
})

Deno.test('the snapshot describes the gated population the charts will draw', () => {
  const out = applyDegenQuery(ROWS, {}, { now: NOW })
  assert(out.snapshot.chainCounts.length === 1 && out.snapshot.chainCounts[0].chain === 'solana', 'gated chains only')
  assert(out.snapshot.chainCounts[0].count === 3, `chain count ${out.snapshot.chainCounts[0].count}`)
  assert(out.snapshot.scatter.length === 3, `scatter ${out.snapshot.scatter.length}`)
  assert(out.snapshot.scatter[0].detailHref.startsWith('/intel/asset/'), 'scatter points can be opened')
  assert(out.snapshot.scatter.every((p) => p.marketCap != null && p.liquidityUsd != null), 'scatter carries both axes')
})
