import {
  bandFor, dedupKeyFor, exceedsThreshold, holderShiftDelta, supplyShockPct,
  unlockQualifies, walletActivityQualifies, entityChain, DAY_MS, BRIDGE_TRIGGERS,
} from './alert-bridge.ts'

function assert(c: unknown, m: string) { if (!c) throw new Error(m) }
function eq(a: unknown, b: unknown, m: string) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

Deno.test('bridge owns exactly the data-fed triggers (not price/volume/liquidity/narrative)', () => {
  eq(BRIDGE_TRIGGERS.length, 5, 'five bridge triggers')
  for (const t of ['wallet_activity', 'holder_shift', 'unlock', 'supply_shock', 'metadata_migration']) {
    assert((BRIDGE_TRIGGERS as readonly string[]).includes(t), `${t} owned by bridge`)
  }
  for (const t of ['price_move', 'volume_spike', 'liquidity_drop', 'narrative_heat']) {
    assert(!(BRIDGE_TRIGGERS as readonly string[]).includes(t), `${t} stays with intel-alerts-eval`)
  }
})

Deno.test('dedup key: stable per (rule,metric,5%-band,day); different band => different key', () => {
  const day = '2026-07-03'
  // band(v)=round(v/5)*5: 10 and 12 both fall in band 10; 20 is band 20.
  eq(bandFor(10), '10', 'band of 10')
  eq(bandFor(12), '10', 'band of 12 is 10')
  eq(bandFor(20), '20', 'band of 20')
  eq(dedupKeyFor('r1', 'unlock_pct_supply', 10, day), dedupKeyFor('r1', 'unlock_pct_supply', 12, day), 'same 5% band => same key')
  assert(dedupKeyFor('r1', 'unlock_pct_supply', 10, day) !== dedupKeyFor('r1', 'unlock_pct_supply', 20, day), 'different band => different key')
  assert(dedupKeyFor('r1', 'm', 10, day) !== dedupKeyFor('r2', 'm', 10, day), 'different rule => different key')
  eq(bandFor(null), 'na', 'null value banded as na')
})

Deno.test('unlock window: fires only for upcoming unlocks inside the window', () => {
  const now = 1_000_000_000_000
  assert(unlockQualifies(now + 3 * DAY_MS, now, 7), 'unlock in 3d within 7d window fires')
  assert(!unlockQualifies(now + 30 * DAY_MS, now, 7), 'unlock in 30d outside 7d window does not fire')
  assert(!unlockQualifies(now - DAY_MS, now, 7), 'past unlock does not fire')
})

Deno.test('supply shock: signed pct change; threshold gate', () => {
  eq(Math.round(supplyShockPct(100, 108)), 8, '+8% supply change')
  eq(Math.round(supplyShockPct(100, 90)), -10, '-10% supply change')
  eq(supplyShockPct(0, 100), 0, 'no prior supply => 0 (no false shock)')
  assert(exceedsThreshold(-10, 5), '10% move exceeds 5% threshold (abs)')
  assert(!exceedsThreshold(3, 5), '3% move does not exceed 5% threshold')
})

Deno.test('holder shift delta + wallet-activity threshold', () => {
  eq(holderShiftDelta(40, 47), 7, 'top-10 concentration rose 7pts')
  assert(exceedsThreshold(holderShiftDelta(40, 47), 5), '7pt shift exceeds 5pt threshold')
  assert(walletActivityQualifies(250_000, 100_000), '250k transfer qualifies at 100k floor')
  assert(!walletActivityQualifies(50_000, 100_000), '50k transfer below 100k floor')
  assert(walletActivityQualifies(10, 0), 'zero floor => any finite transfer qualifies')
})

Deno.test('entity chain mapping (CAIP => birdeye slug)', () => {
  eq(entityChain('solana', null), 'solana', 'solana')
  eq(entityChain('eip155', '1'), 'ethereum', 'eth mainnet')
  eq(entityChain('eip155', '8453'), 'base', 'base')
  eq(entityChain('eip155', '999999'), null, 'unknown evm chain => null')
})
