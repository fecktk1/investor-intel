import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { cmcRows } from '../market-assets/cmc-capabilities.ts'
import {
  wrapperAssetFromQuote, assetListFigures, wrapperSpread, reconcileTokenValue,
  unitVerdict, accrualVerdict, navAnchorUsable, volumeWeightedMedian, median, bps,
  TROY_OUNCE_GRAMS, LIQUIDITY_FLOOR_USD, RWA_NAV_ANCHORS, ACCRUAL_WRAPPERS, comparablePrice,
  type AccrualVerdict,
} from './rwa-wrapper-spread.ts'

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// Shaped like the real responses, not invented:
//   * the envelope is `{ data: { rwa_assets: [...] }, status: {...} }`, verbatim
//     from the cached `/v5/real-world-assets/info` payload read out of
//     `market_data_response_cache` on 2026-09-20;
//   * asset-level market figures sit on the USD entry of `quotes[]`, which is
//     where `cmcUsdQuote` finds them, and are named `average_tokenized_price`,
//     `tokenized_market_cap` and `tokenized_volume_24h`;
//   * token rows are `crypto_id`, `symbol`, `name`, `issuer_id`, `issuer_name`,
//     `price`, `market_cap`, `volume_24h`;
//   * the prices and volumes below are the live 2026-09-20 14:25 UTC catalogue
//     figures for the gold wrappers (XAUT 5176, PAXG 4705, XAUM 34212, CGO
//     20245), so the arithmetic under test is the arithmetic that will ship.

const usdQuote = (fields: Record<string, unknown>) => ({ quotes: [{ crypto_id: 2781, symbol: 'USD', last_updated: '2026-09-20T14:25:00.000Z', ...fields }] })

const GOLD_QUOTE = {
  status: { elapsed: 4, timestamp: '2026-09-20T14:25:03.000Z', error_code: '0', credit_count: 1, error_message: '' },
  data: {
    rwa_assets: [{
      rwa_id: 1, name: 'Gold', symbol: 'GOLD', slug: 'gold', asset_type: 'commodity', rwa_rank: 1, has_tokens: true,
      last_updated: '2026-09-20T14:25:00.000Z',
      ...usdQuote({ average_tokenized_price: 4363.25, tokenized_market_cap: 4706435873.737661, tokenized_volume_24h: 132271000 }),
      tokens: [
        { crypto_id: 5176, symbol: 'XAUT', name: 'Tether Gold', issuer_id: 'tether', issuer_name: 'Tether Holdings', price: 4369.87655050591, market_cap: 2721662504.88916, volume_24h: 70850040.1787824 },
        { crypto_id: 4705, symbol: 'PAXG', name: 'PAX Gold', issuer_id: 'paxos', issuer_name: 'Paxos', price: 4360.15119254379, market_cap: 1894482935.53469, volume_24h: 60073206.368403 },
        { crypto_id: 34212, symbol: 'XAUM', name: 'Matrixdock Gold', issuer_id: 'matrixdock', issuer_name: 'Matrixdock', price: 4366.34720490711, market_cap: 47922088.1839527, volume_24h: 426153.25010507 },
        // Comtech Gold is priced per GRAM. Without the unit guard this row alone
        // publishes a 97 percent discount on gold.
        { crypto_id: 20245, symbol: 'CGO', name: 'Comtech Gold', issuer_id: 'comtech', issuer_name: 'Comtech Gold', price: 139.431099492873, market_cap: 19659785.0284951, volume_24h: 922206.18079095 },
        // A real dead quote: reported, priced, and nobody trading it.
        { crypto_id: 28030, symbol: 'VNXAU', name: 'VNX Gold', issuer_id: 'vnx', issuer_name: 'VNX', price: 4352.11, market_cap: 8112000, volume_24h: 1840.22 },
        // A wrapper the provider lists with no price at all.
        { crypto_id: 31411, symbol: 'XAUTT', name: 'Tether Gold Tokens', issuer_id: 'tether', issuer_name: 'Tether Holdings', price: null, market_cap: null, volume_24h: null },
      ],
    }],
  },
}

/** `/assets/list` returns NO tokens array. That is why the reconciliation needs
 * two endpoints. Silver's zero is the live 2026-09-14 observation. */
const LIST_PAGE = {
  data: {
    rwa_assets: [
      { rwa_id: 1, name: 'Gold', symbol: 'GOLD', slug: 'gold', asset_type: 'commodity', rwa_rank: 1, has_tokens: true, last_updated: '2026-09-20T14:00:00.000Z', ...usdQuote({ average_tokenized_price: 4363.25, tokenized_market_cap: 4706435873.737661, tokenized_volume_24h: 132271000 }) },
      { rwa_id: 5, name: 'Silver', symbol: 'SILVER', slug: 'silver', asset_type: 'commodity', rwa_rank: 9, has_tokens: true, last_updated: '2026-09-20T14:00:00.000Z', ...usdQuote({ average_tokenized_price: 53.2, tokenized_market_cap: 0, tokenized_volume_24h: 265523 }) },
    ],
    total_size: 4, has_more: false,
  },
}

const goldAsset = () => {
  const asset = wrapperAssetFromQuote(cmcRows('rwaQuotes', GOLD_QUOTE).rows[0])!
  assert(asset)
  return asset
}

// ─── Reading the provider shapes ──────────────────────────────────────────────

Deno.test('the quotes payload is read with the field names the endpoint actually uses', () => {
  const asset = goldAsset()
  eq(asset.rwaId, '1')
  eq(asset.symbol, 'GOLD')
  eq(asset.assetType, 'commodity')
  eq(asset.rwaRank, 1)
  // The asset level says tokenized_volume_24h. A previous audit found this read
  // as volume_24h, which silently produced a null on every row.
  eq(asset.tokenizedVolume24h, 132271000)
  eq(asset.tokenizedMarketCap, 4706435873.737661)
  eq(asset.averageTokenizedPrice, 4363.25)
  eq(asset.observedAt, '2026-09-20T14:25:00.000Z')
  eq(asset.tokens.length, 6)
  const xaut = asset.tokens[0]
  eq(xaut.cryptoId, '5176')
  eq(xaut.issuerId, 'tether')
  eq(xaut.issuerName, 'Tether Holdings')
  // The TOKEN level says volume_24h, not tokenized_volume_24h.
  eq(xaut.volume24h, 70850040.1787824)
  eq(xaut.marketCap, 2721662504.88916)
})

Deno.test('the list payload is read separately and reports no tokens array', () => {
  const rows = cmcRows('rwaList', LIST_PAGE).rows.map(assetListFigures)
  eq(rows.length, 2)
  eq(rows[0]!.rwaId, '1')
  eq(rows[0]!.tokenizedMarketCap, 4706435873.737661)
  eq(rows[0]!.hasTokens, true)
  // A source zero is kept as zero. Turning it into null would erase the very
  // disagreement the reconciliation exists to surface.
  eq(rows[1]!.tokenizedMarketCap, 0)
  eq(rows[1]!.tokenizedVolume24h, 265523)
  eq(Object.hasOwn(rows[1]!, 'tokens'), false)
})

Deno.test('a row with no usable rwa id is not read as an asset', () => {
  eq(wrapperAssetFromQuote({ rwa_id: 0, tokens: [] }), null)
  eq(wrapperAssetFromQuote({ rwa_id: 'gold', tokens: [] }), null)
  eq(assetListFigures({ name: 'Gold' }), null)
  // A token with no stable id cannot be linked or checked, so it is not a wrapper.
  const asset = wrapperAssetFromQuote({ rwa_id: 7, tokens: [{ crypto_id: null, price: 1 }, { crypto_id: 4705, price: 1 }, { crypto_id: 4705, price: 2 }] })!
  eq(asset.tokens.length, 1)
  eq(asset.tokens[0].cryptoId, '4705')
  // The first occurrence of a repeated id wins; a repeat is not a second wrapper.
  eq(asset.tokens[0].price, 1)
})

// ─── Medians ──────────────────────────────────────────────────────────────────

Deno.test('the volume weighted median is the price half the turnover traded at or under', () => {
  eq(volumeWeightedMedian([{ price: 10, weight: 1 }, { price: 20, weight: 99 }]), 20)
  eq(volumeWeightedMedian([{ price: 10, weight: 99 }, { price: 20, weight: 1 }]), 10)
  // Exactly half crosses on the lower price: half the volume trades at or below it.
  eq(volumeWeightedMedian([{ price: 10, weight: 50 }, { price: 20, weight: 50 }]), 10)
  // A tie on price is pooled, so input order cannot change the answer.
  eq(volumeWeightedMedian([{ price: 10, weight: 20 }, { price: 10, weight: 40 }, { price: 30, weight: 40 }]), 10)
  eq(volumeWeightedMedian([{ price: 10, weight: 40 }, { price: 30, weight: 40 }, { price: 10, weight: 20 }]), 10)
  // No weight at all is not a weighted median, and never silently the plain one.
  eq(volumeWeightedMedian([{ price: 10, weight: 0 }, { price: 20, weight: 0 }]), null)
  eq(volumeWeightedMedian([]), null)
  eq(median([]), null)
  eq(median([3, 1, 2]), 2)
  eq(median([4, 1, 2, 3]), 2.5)
  eq(bps(102, 100), 200)
  eq(bps(100, 100), 0)
  eq(bps(1, 0), null)
})

// ─── The unit guard ───────────────────────────────────────────────────────────

Deno.test('a gram denominated gold wrapper is normalised and labelled, not called a discount', () => {
  const verdict = unitVerdict(139.431099492873, 4363.25, { weightDenominated: true })
  eq(verdict.state, 'normalised_troy_ounce')
  eq(verdict.factor, TROY_OUNCE_GRAMS)
  assert(verdict.normalisedPrice! > 4300 && verdict.normalisedPrice! < 4400)
  // The mirror case: an ounce wrapper among gram-priced peers.
  const mirror = unitVerdict(4363.25, 140.28, { weightDenominated: true })
  eq(mirror.state, 'normalised_gram')
  assert(mirror.normalisedPrice! > 140 && mirror.normalisedPrice! < 141)
})

Deno.test('a price off by anything other than a known weight unit is excluded and labelled', () => {
  // Half price is not a gram, not an ounce and not a premium.
  const odd = unitVerdict(2000, 4363.25, { weightDenominated: true })
  eq(odd.state, 'not_established')
  eq(odd.normalisedPrice, null)
  eq(odd.reason, 'price_matches_no_known_weight_unit')
  // A share is never rescaled by a metals constant: 31x apart is a different
  // instrument, and the reason says so in its own words.
  const share = unitVerdict(4.6, 143, { weightDenominated: false })
  eq(share.state, 'not_established')
  eq(share.reason, 'price_far_from_peers')
  // Inside the sane band the unit is accepted untouched, including a real premium.
  const real = unitVerdict(4500, 4363.25, { weightDenominated: true })
  eq(real.state, 'consistent')
  eq(real.normalisedPrice, 4500)
  // With no peer to compare against, nothing is asserted about the unit.
  eq(unitVerdict(4500, null).state, 'not_assessed')
  eq(unitVerdict(null, 4363.25).state, 'not_assessed')
})

// ─── The total-return guard ───────────────────────────────────────────────────

Deno.test('an accruing wrapper reports an accrual gap and never a premium', () => {
  // Ondo US Dollar Yield against par-priced peers: the live 2026-09-20 shape.
  const asset = wrapperAssetFromQuote({
    rwa_id: 8020, name: 'US Treasury Bills', symbol: 'USTB1', asset_type: 'government_security', rwa_rank: 40,
    ...usdQuote({ average_tokenized_price: 1.05, tokenized_market_cap: 3_000_000_000, tokenized_volume_24h: 1_400_000 }),
    tokens: [
      { crypto_id: 29256, symbol: 'USDY', name: 'Ondo US Dollar Yield', issuer_id: 'ondo', issuer_name: 'Ondo Finance', price: 1.14650108755115, market_cap: 2250793265.15894, volume_24h: 423046.48164333 },
      { crypto_id: 90001, symbol: 'PARA', name: 'Par Treasury A', issuer_id: 'a', issuer_name: 'Issuer A', price: 1.0002, market_cap: 400_000_000, volume_24h: 900_000 },
      { crypto_id: 90002, symbol: 'PARB', name: 'Par Treasury B', issuer_id: 'b', issuer_name: 'Issuer B', price: 0.9994, market_cap: 350_000_000, volume_24h: 700_000 },
    ],
  })!
  const spread = wrapperSpread(asset)
  const usdy = spread.tokens.find((row) => row.cryptoId === '29256')!
  eq(usdy.state, 'accrues_in_price')
  eq(usdy.premiumBps, null)
  assert(usdy.accrualGapBps! > 1400)
  eq(spread.accrualCount, 1)
  // It is excluded from the anchor, so it cannot drag the reference up either.
  eq(usdy.inAnchor, false)
  eq(spread.anchorMembers, 2)
  // And it is never the cheapest or the widest premium.
  assert(spread.widestPremiumCryptoId !== '29256')
  assert(spread.cheapestCryptoId !== '29256')

  // The name gate: a repurposed id is treated as NOT accruing and says why,
  // because exempting whatever the row has become would hide a real premium.
  const drifted = accrualVerdict('29256', 'Something Else Entirely')
  eq(drifted.accruing, false)
  eq(drifted.reason, 'accrual_name_mismatch')
  eq(accrualVerdict('29256', ACCRUAL_WRAPPERS['29256'].name).accruing, true)
  eq(accrualVerdict('4705', 'PAX Gold').accruing, false)
})

// ─── The anchor ───────────────────────────────────────────────────────────────

Deno.test('the gold wrappers produce one anchor, a labelled unit fix and a real dispersion', () => {
  const spread = wrapperSpread(goldAsset())
  eq(spread.anchorKind, 'liquid_wrapper_median')
  eq(spread.weightDenominated, true)
  eq(spread.wrapperCount, 6)
  // XAUT, PAXG, XAUM and the normalised CGO clear the $250k floor. VNX Gold
  // ($1,840) and the unpriced Tether Gold Tokens row do not.
  eq(spread.liquidCount, 4)
  eq(spread.anchorMembers, 4)
  eq(spread.unitNormalisedCount, 1)
  eq(spread.unitRefusedCount, 0)
  // Tether Gold carries more than half the reported turnover on its own, so the
  // volume-weighted median is its price and every other wrapper is a discount.
  eq(spread.anchorPrice, 4369.87655050591)
  const cgo = spread.tokens.find((row) => row.cryptoId === '20245')!
  eq(cgo.unitState, 'normalised_troy_ounce')
  eq(cgo.state, 'liquid')
  // About 76 basis points cheap once the gram price is restated in ounces, and
  // nothing like the 9,681 basis points a naive engine would publish.
  assert(cgo.premiumBps! < -60 && cgo.premiumBps! > -90)
  eq(spread.cheapestCryptoId, '20245')
  // A thin quote is a ROW with its premium, kept out of the anchor and labelled.
  const vnx = spread.tokens.find((row) => row.cryptoId === '28030')!
  eq(vnx.state, 'too_thin_to_anchor')
  eq(vnx.reason, 'below_volume_floor')
  eq(vnx.inAnchor, false)
  assert(vnx.premiumBps != null)
  // An unpriced wrapper is still reported, and carries no invented figure.
  const unpriced = spread.tokens.find((row) => row.cryptoId === '31411')!
  eq(unpriced.state, 'no_price')
  eq(unpriced.premiumBps, null)
  eq(unpriced.reason, 'price_not_reported')
  // Dispersion is highest minus lowest among the anchor members.
  assert(spread.dispersionBps! > 60 && spread.dispersionBps! < 90)
  // The volume weighted spread ignores dead quotes, so it is much tighter than
  // the raw dispersion: the two deep wrappers are 22 basis points apart.
  assert(spread.weightedSpreadBps! < spread.dispersionBps!)
  eq(spread.widestPremiumCryptoId, '5176')
  eq(spread.widestPremiumBps, 0)
  eq(spread.widestDiscountCryptoId, '20245')
  // Both endpoint figures travel with the row.
  eq(spread.tokenMarketCapReported, 5)
  assert(spread.tokenMarketCapSum! > 4_600_000_000)
})

Deno.test('the volume floor decides anchor membership and nothing else', () => {
  const asset = goldAsset()
  // Raise the floor above every wrapper but the two deep ones.
  const tight = wrapperSpread(asset, { liquidityFloorUsd: 10_000_000 })
  eq(tight.liquidCount, 2)
  eq(tight.anchorMembers, 2)
  // Comtech Gold is now thin, and still carries its premium and its unit label.
  const cgo = tight.tokens.find((row) => row.cryptoId === '20245')!
  eq(cgo.state, 'too_thin_to_anchor')
  eq(cgo.unitState, 'normalised_troy_ounce')
  assert(cgo.premiumBps != null)
  // A thin wrapper is never offered as the cheapest ROUTE.
  eq(tight.cheapestCryptoId, '4705')
  eq(LIQUIDITY_FLOOR_USD, 250_000)
})

Deno.test('one liquid wrapper is not a median, so the anchor is refused with a reason', () => {
  const asset = wrapperAssetFromQuote({
    rwa_id: 9, name: 'SpaceX', symbol: 'SPCX', asset_type: 'stock', rwa_rank: 3,
    ...usdQuote({ average_tokenized_price: 212, tokenized_market_cap: 213245211.5150289, tokenized_volume_24h: 44000 }),
    tokens: [{ crypto_id: 70001, symbol: 'SPCXX', name: 'SpaceX xStock', issuer_id: 'backed', issuer_name: 'Backed', price: 212, market_cap: 213245211.5150289, volume_24h: 900_000 }],
  })!
  const spread = wrapperSpread(asset)
  eq(spread.anchorKind, 'none')
  eq(spread.anchorPrice, null)
  eq(spread.anchorReason, 'not_enough_liquid_wrappers')
  eq(spread.dispersionBps, null)
  eq(spread.weightedSpreadBps, null)
  eq(spread.tokens[0].premiumBps, null)
  eq(spread.cheapestCryptoId, null)
})

Deno.test('a published nav anchors an asset only when it is mapped, proved, fresh and still the same fund', () => {
  // Nothing is mapped today: CoinMarketCap publishes no identifier for the funds
  // in the yield register, and the list endpoint returns no government
  // securities at all. So the default is a stated reason, not a wrong anchor.
  eq(Object.keys(RWA_NAV_ANCHORS).length, 0)
  const asset = { rwaId: '8100', symbol: 'JTRSY', name: 'Janus Henderson Anemoy Treasury Fund' }
  eq(navAnchorUsable(asset, null).reason, 'no_nav_feed_mapped')

  // With a mapping in place the gates run in order. The map is module state, so
  // it is restored at the end of the test.
  const nav = { feedKey: 'jtrsy', nav: 1.116272, navObservedAt: '2026-09-20T12:33:59Z', validationState: 'validated', staleness: 'fresh', currency: 'USD' }
  try {
    RWA_NAV_ANCHORS['8100'] = { feedKey: 'jtrsy', symbol: 'JTRSY', name: 'Janus Henderson Anemoy Treasury Fund' }
    eq(navAnchorUsable(asset, nav), { usable: true, reason: null })
    eq(navAnchorUsable({ ...asset, name: 'Renamed Fund' }, nav).reason, 'asset_name_mismatch')
    eq(navAnchorUsable({ ...asset, symbol: 'JTRSY2' }, nav).reason, 'asset_symbol_mismatch')
    eq(navAnchorUsable(asset, { ...nav, feedKey: 'vbill' }).reason, 'nav_feed_mismatch')
    eq(navAnchorUsable(asset, { ...nav, validationState: 'refused' }).reason, 'nav_not_validated')
    eq(navAnchorUsable(asset, { ...nav, staleness: 'stale' }).reason, 'nav_stale')
    eq(navAnchorUsable(asset, { ...nav, staleness: 'unknown' }).reason, 'nav_stale')
    eq(navAnchorUsable(asset, { ...nav, currency: 'EUR' }).reason, 'nav_currency_not_usd')
    eq(navAnchorUsable(asset, { ...nav, nav: null }).reason, 'no_nav')

    // A published NAV beats the wrapper median, and the premium is measured
    // against the fund's own figure.
    const fund = wrapperAssetFromQuote({
      rwa_id: 8100, name: 'Janus Henderson Anemoy Treasury Fund', symbol: 'JTRSY', asset_type: 'government_security', rwa_rank: 40,
      ...usdQuote({ average_tokenized_price: 1.12, tokenized_market_cap: 900_000_000, tokenized_volume_24h: 2_000_000 }),
      tokens: [
        { crypto_id: 90010, symbol: 'JTRSYA', name: 'Treasury Wrapper A', issuer_id: 'a', issuer_name: 'Issuer A', price: 1.128, market_cap: 500_000_000, volume_24h: 1_200_000 },
        { crypto_id: 90011, symbol: 'JTRSYB', name: 'Treasury Wrapper B', issuer_id: 'b', issuer_name: 'Issuer B', price: 1.110, market_cap: 400_000_000, volume_24h: 800_000 },
      ],
    })!
    const spread = wrapperSpread(fund, { nav })
    eq(spread.anchorKind, 'published_nav')
    eq(spread.anchorPrice, 1.116272)
    eq(spread.anchorFeedKey, 'jtrsy')
    eq(spread.anchorObservedAt, '2026-09-20T12:33:59Z')
    // The NAV anchor is independent of the wrappers, so no wrapper is a member.
    eq(spread.anchorMembers, 1)
    assert(spread.tokens[0].premiumBps! > 0)
    assert(spread.tokens[1].premiumBps! < 0)
    // A stale NAV falls back to the wrapper median and keeps the reason.
    const fallback = wrapperSpread(fund, { nav: { ...nav, staleness: 'stale' } })
    eq(fallback.anchorKind, 'liquid_wrapper_median')
    eq(fallback.anchorReason, 'nav_stale')
  } finally {
    delete RWA_NAV_ANCHORS['8100']
  }
})

Deno.test('an asset with no wrappers at all says so rather than drawing a blank row', () => {
  const spread = wrapperSpread(wrapperAssetFromQuote({ rwa_id: 16388, name: 'Palladium', symbol: 'XPD', asset_type: 'commodity', tokens: [] })!)
  eq(spread.wrapperCount, 0)
  eq(spread.anchorKind, 'none')
  eq(spread.anchorReason, 'no_wrappers_reported')
  eq(spread.tokenMarketCapSum, null)
  eq(spread.tokenMarketCapReported, 0)
})

// ─── Two-endpoint reconciliation ──────────────────────────────────────────────

Deno.test('the two endpoints are reconciled as a ratio inside or outside a stated band', () => {
  const agree = reconcileTokenValue({
    listMarketCap: 4706435873.737661, listCapturedAt: '2026-09-20T14:00:00Z', listObservedAt: '2026-09-20T14:00:00.000Z',
    tokenMarketCapSum: 4691839313.63, quotesCapturedAt: '2026-09-20T14:00:00Z', quotesObservedAt: '2026-09-20T14:25:00.000Z',
  })
  eq(agree.state, 'agree')
  eq(agree.reason, null)
  assert(agree.ratio! > 0.99 && agree.ratio! < 1.01)
  // Both clocks travel with the row: the comparison is between two reads.
  eq(agree.listCapturedAt, '2026-09-20T14:00:00Z')
  eq(agree.quotesObservedAt, '2026-09-20T14:25:00.000Z')

  eq(reconcileTokenValue({ listMarketCap: 100, tokenMarketCapSum: 84 }).state, 'outside_band')
  eq(reconcileTokenValue({ listMarketCap: 100, tokenMarketCapSum: 85 }).state, 'agree')
  eq(reconcileTokenValue({ listMarketCap: 100, tokenMarketCapSum: 115 }).state, 'agree')
  eq(reconcileTokenValue({ listMarketCap: 100, tokenMarketCapSum: 116 }).state, 'outside_band')
  eq(reconcileTokenValue({ listMarketCap: 100, tokenMarketCapSum: 150 }).gapUsd, 50)
})

Deno.test('a list endpoint zero beside a reported token value is the disagreement, not a division', () => {
  // Silver: the list endpoint priced it at 0 beside $265,523 of 24-hour volume.
  const zero = reconcileTokenValue({ listMarketCap: 0, tokenMarketCapSum: 6_500_000 })
  eq(zero.state, 'outside_band')
  eq(zero.ratio, null)
  eq(zero.reason, 'list_endpoint_reports_zero')
  eq(zero.gapUsd, 6_500_000)
  // Both at zero is not a disagreement, and not a measurement either.
  const both = reconcileTokenValue({ listMarketCap: 0, tokenMarketCapSum: 0 })
  eq(both.state, 'not_comparable')
  eq(both.reason, 'both_endpoints_report_zero')
  // A missing side always names which side is missing.
  eq(reconcileTokenValue({ listMarketCap: null, tokenMarketCapSum: 10 }).reason, 'list_value_not_reported')
  eq(reconcileTokenValue({ listMarketCap: 10, tokenMarketCapSum: null }).reason, 'no_wrapper_reported_a_value')
})

Deno.test('a derivative price among the tokens is labelled, kept, and never a wrapper, an anchor member or the widest gap', async () => {
  const { isDerivativeReference, CMC_DERIVATIVES_ISSUER_ID } = await import('./rwa-wrapper-spread.ts')
  const tok = (cryptoId: string, price: number, volume24h: number, extra: Record<string, unknown> = {}) =>
    ({ cryptoId, symbol: 'NVDA' + cryptoId, name: `NVIDIA tokenized stock ${cryptoId}`, issuerId: 'i' + cryptoId, issuerName: 'Issuer ' + cryptoId, price, marketCap: 1_000_000, volume24h, ...extra })
  const asset = {
    rwaId: '2', symbol: 'NVDA', name: 'Nvidia Corp', assetType: 'stock', rwaRank: 1,
    averageTokenizedPrice: 228.4, tokenizedMarketCap: 1e8, tokenizedVolume24h: 1e8, observedAt: '2026-09-23T00:00:00Z',
    tokens: [
      tok('1', 228.0, 5_000_000), tok('2', 228.2, 5_000_000), tok('3', 228.4, 5_000_000),
      // The derivative: a high price and the largest volume, which would drag the median and win "widest premium".
      tok('9', 240.0, 50_000_000, { name: 'NVIDIA (Derivatives)', issuerName: 'NA (Derivatives)', issuerId: CMC_DERIVATIVES_ISSUER_ID, marketCap: 0 }),
    ],
  }
  // deno-lint-ignore no-explicit-any
  const spread = wrapperSpread(asset as any)
  const d = spread.tokens.find((r) => r.cryptoId === '9')!
  eq(d.state, 'derivative_reference')
  eq(d.reason, 'derivative_not_a_wrapper')
  eq(d.inAnchor, false)
  assert(d.premiumBps != null && d.premiumBps > 0, 'the gap is kept for information')
  eq(spread.wrapperCount, 3)
  eq(spread.anchorMembers, 3)
  assert(spread.anchorPrice! > 227.9 && spread.anchorPrice! < 228.5, `anchor ${spread.anchorPrice} must ignore the derivative`)
  assert(spread.widestPremiumCryptoId !== '9')
  assert(spread.cheapestCryptoId !== '9')
  // Recognised by issuer id, issuer name or token name.
  eq(isDerivativeReference({ issuerId: CMC_DERIVATIVES_ISSUER_ID }), true)
  eq(isDerivativeReference({ issuerName: 'NA (Derivatives)' }), true)
  eq(isDerivativeReference({ name: 'MicroStrategy Inc (Derivatives)' }), true)
  eq(isDerivativeReference({ name: 'NVIDIA tokenized stock (xStock)', issuerName: 'Backed Assets' }), false)
})

// ─── Dividend-reinvesting wrappers (accrual-multiplier.ts) ────────────────────
//
// The SPY wrappers exactly as the 2026-09-23 20:00 capture stored them (prices
// observed 20:45:01 UTC), with SPYon's own on-chain multiplier that day.

const SPYON_MULTIPLIER = 1.0094730727840426
const spyToken = (cryptoId: string, symbol: string, name: string, issuerName: string, price: number | null, volume: number | null) =>
  ({ cryptoId, symbol, name, issuerId: issuerName.toLowerCase(), issuerName, price, marketCap: null, volume24h: volume })
const spyAsset = () => ({
  rwaId: '86', symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', assetType: 'etf', rwaRank: 5,
  averageTokenizedPrice: null, tokenizedMarketCap: null, tokenizedVolume24h: null,
  observedAt: '2026-09-23T20:45:01.000Z',
  tokens: [
    spyToken('40694', 'SPY', 'SPDR S&P 500 Trust Tokenized ETF (Robinhood)', 'Robinhood', 767.9687413290569, 27054054.94667706),
    spyToken('37006', 'SPYX', 'SP500 tokenized ETF (xStock)', 'Backed Assets', 770.6229441216093, 20183064.40722753),
    spyToken('40790', 'SPYB', 'State Street SPDR S&P 500 ETF Tokenized bStocks', 'bStocks', 767.0633303364281, 4853192.69359048),
    spyToken('38067', 'SPYon', 'SPDR S&P 500 Tokenized ETF (Ondo)', 'Ondo Assets', 775.6931836496483, 2573093.87005658),
    spyToken('41525', 'wSPYx', 'Wrapped SP500 Tokenized ETF (xStock)', 'Backed Assets', 772.072232628172, 98025.95433425),
  ],
})
const adjusted = (multiplier: number, asOf: string | null = '2026-09-18T17:54:15.000Z'): AccrualVerdict => ({
  treatment: 'adjusted', reinvestingClass: 'ondo_gm', reason: null, multiplier, source: 'ondo_solana_scaled_ui', asOf,
  network: 'solana', address: 'k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo', readAt: '2026-09-23T21:30:00.000Z',
})
const notAdjusted = (reason: string, cls = 'wrapped_xstock'): AccrualVerdict => ({
  treatment: 'not_adjusted', reinvestingClass: cls, reason, multiplier: null, source: null, asOf: null, network: null, address: null, readAt: null,
})

Deno.test('a reinvesting wrapper is divided by its own multiplier: SPYon +100.6 bp becomes +5.8 bp, raw kept beside it', () => {
  const accrual = new Map([['38067', adjusted(SPYON_MULTIPLIER)], ['41525', notAdjusted('no_multiplier_source')]])
  const spread = wrapperSpread(spyAsset(), { accrual })
  const on = spread.tokens.find((r) => r.cryptoId === '38067')!
  // The wrapper's own price is untouched; the per-share price is carried beside it.
  eq(on.price, 775.6931836496483)
  eq(on.normalisedPrice, 775.6931836496483)
  eq(Math.round(on.adjustedPrice! * 1e4) / 1e4, 768.4139)
  eq(on.accrualTreatment, 'adjusted')
  eq(on.accrualMultiplier, SPYON_MULTIPLIER)
  eq(on.accrualSource, 'ondo_solana_scaled_ui')
  eq(on.accrualAsOf, '2026-09-18T17:54:15.000Z')
  eq(on.accrualReason, null)
  eq(on.state, 'liquid')
  // The anchor is Robinhood's price on both runs (see the anchor test below).
  eq(spread.anchorPrice, 767.9687413290569)
  eq(Math.round(on.premiumBps! * 10) / 10, 5.8)
  eq(Math.round(on.rawPremiumBps! * 10) / 10, 100.6)
  eq(spread.accrualAdjustedCount, 1)
  // Every wrapper that pays its dividends out is exactly as it was.
  const plain = wrapperSpread(spyAsset())
  for (const id of ['40694', '37006', '40790']) {
    const a = spread.tokens.find((r) => r.cryptoId === id)!
    const b = plain.tokens.find((r) => r.cryptoId === id)!
    eq(a.premiumBps, b.premiumBps)
    eq(a.accrualTreatment, null)
    eq(a.adjustedPrice, null)
    eq(a.rawPremiumBps, null)
  }
  // Without a verdict nothing changes at all: the lane passes none for a wrapper outside the register.
  eq(plain.tokens.find((r) => r.cryptoId === '38067')!.premiumBps, on.rawPremiumBps)
  eq(plain.accrualAdjustedCount, 0)
})

Deno.test('a reinvesting wrapper with no sourced multiplier is labelled, never a premium and never an anchor', () => {
  const accrual = new Map([['38067', notAdjusted('multiplier_read_failed', 'ondo_gm')], ['41525', notAdjusted('no_multiplier_source')]])
  const spread = wrapperSpread(spyAsset(), { accrual })
  for (const [id, why] of [['38067', 'multiplier_read_failed'], ['41525', 'no_multiplier_source']]) {
    const row = spread.tokens.find((r) => r.cryptoId === id)!
    eq(row.state, 'accrues_in_price')
    eq(row.reason, 'reinvested_dividends_not_adjusted')
    eq(row.accrualTreatment, 'not_adjusted')
    eq(row.accrualReason, why)
    eq(row.premiumBps, null)
    eq(row.rawPremiumBps, null)
    eq(row.adjustedPrice, null)
    // A multiplier that did not apply is never carried.
    eq(row.accrualMultiplier, null)
    eq(row.inAnchor, false)
    assert(row.accrualGapBps != null)
  }
  eq(Math.round(spread.tokens.find((r) => r.cryptoId === '38067')!.accrualGapBps! * 10) / 10, 100.6)
  eq(spread.accrualCount, 2)
  eq(spread.accrualAdjustedCount, 0)
  assert(spread.cheapestCryptoId !== '38067' && spread.widestPremiumCryptoId !== '38067')
  eq(spread.anchorMembers, 3)
})

Deno.test('the anchor: an adjusted wrapper anchors at its per-share price, an unadjusted one never anchors', () => {
  // A reinvesting wrapper carrying most of the volume sits AT the weighted median.
  const asset = {
    rwaId: '77', symbol: 'TEST', name: 'Test Corp', assetType: 'stock', rwaRank: 1,
    averageTokenizedPrice: null, tokenizedMarketCap: null, tokenizedVolume24h: null, observedAt: '2026-09-23T20:45:01.000Z',
    tokens: [
      spyToken('1', 'TESTa', 'Test A', 'Alpha', 100.00, 3_000_000),
      spyToken('2', 'TESTb', 'Test B', 'Beta', 100.10, 3_000_000),
      spyToken('3', 'TESTon', 'Test Tokenized Stock (Ondo)', 'Ondo Assets', 101.00, 10_000_000),
    ],
  }
  // Unadjusted and unlabelled, as before this change: the dividends set the median.
  const raw = wrapperSpread(asset)
  eq(raw.anchorPrice, 101.00)
  eq(Math.round(raw.tokens[0].premiumBps! * 10) / 10, -99)
  eq(Math.round(raw.dispersionBps! * 10) / 10, 99)
  // Adjusted: the per-share price is a member and here it IS the median.
  const m = 1.0095
  const adj = wrapperSpread(asset, { accrual: new Map([['3', adjusted(m)]]) })
  eq(adj.anchorPrice, 101.00 / m)
  eq(adj.anchorMembers, 3)
  const on = adj.tokens.find((r) => r.cryptoId === '3')!
  eq(on.inAnchor, true)
  eq(on.premiumBps, 0)
  eq(Math.round(on.rawPremiumBps! * 10) / 10, 95)
  eq(Math.round(adj.tokens[0].premiumBps! * 10) / 10, -5)
  eq(Math.round(adj.tokens[1].premiumBps! * 10) / 10, 5)
  // Dispersion is taken over per-share prices.
  eq(Math.round(adj.dispersionBps! * 10) / 10, 10)
  // Not adjusted: kept out of the anchor, so the median is set by the others.
  const out = wrapperSpread(asset, { accrual: new Map([['3', notAdjusted('multiplier_changed_after_observation', 'ondo_gm')]]) })
  eq(out.anchorPrice, 100.00)
  eq(out.anchorMembers, 2)
  eq(out.tokens.find((r) => r.cryptoId === '3')!.inAnchor, false)
  eq(Math.round(out.tokens.find((r) => r.cryptoId === '3')!.accrualGapBps! * 10) / 10, 100)
  // On the real SPY capture the anchor does not move: SPYon adjusted (768.41) sits
  // above Robinhood (767.97), which still holds the volume-weighted median.
  eq(wrapperSpread(spyAsset(), { accrual: new Map([['38067', adjusted(SPYON_MULTIPLIER)]]) }).anchorPrice, wrapperSpread(spyAsset()).anchorPrice)
})

Deno.test('the unit guard reads the per-share price, so a split applied through the multiplier is not a unit failure', () => {
  const asset = {
    rwaId: '78', symbol: 'SPLT', name: 'Split Corp', assetType: 'stock', rwaRank: 1,
    averageTokenizedPrice: null, tokenizedMarketCap: null, tokenizedVolume24h: null, observedAt: '2026-09-23T20:45:01.000Z',
    tokens: [
      spyToken('1', 'SPLTa', 'Split A', 'Alpha', 100.00, 3_000_000),
      spyToken('2', 'SPLTb', 'Split B', 'Beta', 100.20, 3_000_000),
      // Ten shares per token after a 10:1 split applied through sValue.
      spyToken('3', 'SPLTon', 'Split Tokenized Stock (Ondo)', 'Ondo Assets', 1001.00, 1_000_000),
    ],
  }
  eq(wrapperSpread(asset).tokens[2].state, 'unit_not_established')
  const adj = wrapperSpread(asset, { accrual: new Map([['3', adjusted(10)]]) })
  const on = adj.tokens[2]
  eq(on.unitState, 'consistent')
  eq(on.state, 'liquid')
  eq(on.normalisedPrice, 1001.00)
  eq(on.adjustedPrice, 100.1)
  eq(comparablePrice(on), 100.1)
})
