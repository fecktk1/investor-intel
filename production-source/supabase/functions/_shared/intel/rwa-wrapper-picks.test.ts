import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { wrapperPicks, setsAnchor, PICK_RULES } from './rwa-wrapper-picks.ts'
import { wrapperSpread } from './rwa-wrapper-spread.ts'

// The live gold wrappers, 2026-09-20 14:00 UTC, as the read view serves them.
const ANCHOR = 4369.87655050591
const gold = {
  anchorKind: 'liquid_wrapper_median', anchorPrice: ANCHOR, anchorReason: 'no_nav_feed_mapped',
  cheapestCryptoId: '20245',
  tokens: [
    { cryptoId: '5176', symbol: 'XAUT', name: 'Tether Gold', normalisedPrice: ANCHOR, volume24h: 70850040.18, unitState: 'consistent', state: 'liquid', premiumBps: 0, inAnchor: true, reason: null },
    { cryptoId: '4705', symbol: 'PAXG', name: 'PAX Gold', normalisedPrice: 4372.1, volume24h: 60100000, unitState: 'consistent', state: 'liquid', premiumBps: 5.1, inAnchor: true, reason: null },
    { cryptoId: '20245', symbol: 'CGO', name: 'Comtech Gold', normalisedPrice: 4336.792, volume24h: 922206.18, unitState: 'normalised_troy_ounce', state: 'liquid', premiumBps: -75.7, inAnchor: true, reason: null },
    { cryptoId: '28030', symbol: 'VNXAU', name: 'VNX Gold', normalisedPrice: 4352.11, volume24h: 1840.22, unitState: 'consistent', state: 'too_thin_to_anchor', premiumBps: -40.7, inAnchor: false, reason: 'below_volume_floor' },
    { cryptoId: '29256', symbol: 'USDY', name: 'Ondo US Dollar Yield', normalisedPrice: 1.1465, volume24h: 423046.48, unitState: 'consistent', state: 'accrues_in_price', premiumBps: null, inAnchor: false, reason: 'accrues_in_price' },
    { cryptoId: '31411', symbol: 'XAUTT', name: 'Tether Gold Tokens', normalisedPrice: null, volume24h: null, unitState: 'not_assessed', state: 'no_price', premiumBps: null, inAnchor: false, reason: 'price_not_reported' },
    { cryptoId: '40001', symbol: 'GLDX', name: 'Gram Gold', normalisedPrice: null, volume24h: 900000, unitState: 'not_established', state: 'unit_not_established', premiumBps: null, inAnchor: false, reason: 'price_far_from_peers' },
  ],
}

Deno.test('names three different wrappers for three different questions', () => {
  const picks = wrapperPicks(gold)
  eq(picks.anchorKind, 'liquid_wrapper_median')
  assert(picks.cheapest.available)
  eq(picks.cheapest.available && picks.cheapest.cryptoId, '20245')
  // It agrees with the route the capture lane stored.
  eq(picks.cheapestMatchesCaptured, true)
  assert(picks.mostLiquid.available)
  eq(picks.mostLiquid.available && picks.mostLiquid.cryptoId, '5176')
})

Deno.test('the wrapper that set the median is flagged circular and the nearest other one is named', () => {
  const picks = wrapperPicks(gold)
  assert(picks.closest.available)
  if (!picks.closest.available) return
  eq(picks.closest.cryptoId, '5176')
  eq(picks.closest.circular, true)
  eq(picks.closest.closestOther?.cryptoId, '4705')
  eq(picks.closest.closestOther?.absPremiumBps, 5.1)
  // A published NAV is independent of every wrapper, so nothing is circular.
  const nav = wrapperPicks({ ...gold, anchorKind: 'published_nav' })
  assert(nav.closest.available && !nav.closest.circular && nav.closest.closestOther === null)
})

Deno.test('a thin wrapper is never the cheapest route but can be the most liquid when all are thin', () => {
  const picks = wrapperPicks(gold)
  // VNXAU at -40.7 is below the floor: not a route, and not excluded either.
  assert(picks.cheapest.available && picks.cheapest.cryptoId !== '28030')
  assert(!picks.excluded.some((row) => row.cryptoId === '28030'))
  const allThin = wrapperPicks({
    anchorKind: 'published_nav', anchorPrice: 100,
    tokens: [
      { cryptoId: '1', state: 'too_thin_to_anchor', premiumBps: 3, volume24h: 10, unitState: 'consistent' },
      { cryptoId: '2', state: 'too_thin_to_anchor', premiumBps: -3, volume24h: 90, unitState: 'consistent' },
    ],
  })
  eq(allThin.cheapest, { available: false, reason: 'no_liquid_wrapper' })
  eq(allThin.closest, { available: false, reason: 'no_liquid_wrapper' })
  assert(allThin.mostLiquid.available && allThin.mostLiquid.cryptoId === '2')
})

Deno.test('every wrapper eligible for nothing is excluded with its state and reason', () => {
  const picks = wrapperPicks(gold)
  eq(picks.excluded.map((row) => [row.cryptoId, row.state, row.reason]), [
    ['29256', 'accrues_in_price', 'accrues_in_price'],
    ['31411', 'no_price', 'price_not_reported'],
    ['40001', 'unit_not_established', 'price_far_from_peers'],
  ])
})

Deno.test('no anchor means no cheapest and no closest, with the anchor reason', () => {
  const picks = wrapperPicks({
    anchorKind: 'none', anchorPrice: null, anchorReason: 'not_enough_liquid_wrappers',
    tokens: [
      { cryptoId: '7', state: 'liquid', premiumBps: null, volume24h: 900000, unitState: 'consistent' },
      { cryptoId: '8', state: 'too_thin_to_anchor', premiumBps: null, volume24h: 9, unitState: 'consistent', reason: 'below_volume_floor' },
    ],
  })
  eq(picks.cheapest, { available: false, reason: 'not_enough_liquid_wrappers' })
  eq(picks.closest, { available: false, reason: 'not_enough_liquid_wrappers' })
  eq(picks.mostLiquid, { available: false, reason: 'not_enough_liquid_wrappers' })
  eq(picks.cheapestMatchesCaptured, null)
  eq(picks.excluded.map((row) => row.reason), ['not_enough_liquid_wrappers', 'not_enough_liquid_wrappers'])
})

Deno.test('ties break on volume, then on the lower id, whatever the input order', () => {
  const tokens = [
    { cryptoId: '30', state: 'liquid', premiumBps: -10, volume24h: 500000, unitState: 'consistent' },
    { cryptoId: '20', state: 'liquid', premiumBps: -10, volume24h: 800000, unitState: 'consistent' },
    { cryptoId: '10', state: 'liquid', premiumBps: -10, volume24h: 800000, unitState: 'consistent' },
    { cryptoId: '9', state: 'liquid', premiumBps: 10, volume24h: 800000, unitState: 'consistent' },
  ]
  for (const order of [tokens, [...tokens].reverse()]) {
    const picks = wrapperPicks({ anchorKind: 'published_nav', anchorPrice: 1, cheapestCryptoId: '30', tokens: order })
    eq(picks.cheapest.available && picks.cheapest.cryptoId, '10')
    // The capture broke the same tie by input order; the disagreement is flagged.
    eq(picks.cheapestMatchesCaptured, false)
    // |10| ties four ways: the two 800k wrappers with the lowest id win.
    eq(picks.closest.available && picks.closest.cryptoId, '9')
    eq(picks.mostLiquid.available && picks.mostLiquid.cryptoId, '9')
  }
})

Deno.test('cheapest agrees with the capture lane on the spread it computed', () => {
  const spread = wrapperSpread({
    rwaId: '1', symbol: 'GOLD', name: 'Gold', assetType: 'commodity', rwaRank: 1,
    averageTokenizedPrice: null, tokenizedMarketCap: null, tokenizedVolume24h: null, observedAt: null,
    tokens: [
      { cryptoId: '5176', symbol: 'XAUT', name: 'Tether Gold', issuerId: null, issuerName: null, price: 4369.87, marketCap: 1, volume24h: 70_000_000 },
      { cryptoId: '4705', symbol: 'PAXG', name: 'PAX Gold', issuerId: null, issuerName: null, price: 4372.1, marketCap: 1, volume24h: 60_000_000 },
      { cryptoId: '20245', symbol: 'CGO', name: 'Comtech Gold', issuerId: null, issuerName: null, price: 4336.79, marketCap: 1, volume24h: 900_000 },
      { cryptoId: '28030', symbol: 'VNXAU', name: 'VNX Gold', issuerId: null, issuerName: null, price: 4300, marketCap: 1, volume24h: 100 },
    ],
  })
  const picks = wrapperPicks(spread)
  eq(picks.cheapest.available && picks.cheapest.cryptoId, spread.cheapestCryptoId)
  eq(picks.cheapestMatchesCaptured, true)
  // The median setter is the wrapper the spread marked as the anchor price.
  assert(picks.closest.available && picks.closest.circular)
  assert(setsAnchor(spread.tokens.find((t) => t.cryptoId === (picks.closest.available ? picks.closest.cryptoId : ''))!, spread.anchorKind, spread.anchorPrice))
})

Deno.test('the rules are stated in words', () => {
  for (const text of Object.values(PICK_RULES)) assert(text.length > 20)
})
