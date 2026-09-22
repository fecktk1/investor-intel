import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  RWA_YIELD_FEEDS, RWA_FEED_BY_KEY, RWA_FEED_BY_ADDRESS, BENCHMARK_CURRENCY,
  benchmarkForFeed, benchmarkMatchesCurrency, NAV_TOTAL_RETURN_LIMIT,
  RWA_MARKET_SOURCE_LIMIT, MARKET_DEVIATION_SOURCE_NOTE,
} from './rwa-yield-register.ts'

Deno.test('a euro asset is never benchmarked against a united states bill', () => {
  const eur = RWA_YIELD_FEEDS.filter((feed) => feed.currency === 'EUR')
  // The register has to actually carry euro feeds for this rule to mean anything.
  assert(eur.length >= 2)
  for (const feed of eur) {
    const choice = benchmarkForFeed(feed)
    eq(choice.key, 'estr')
    eq(BENCHMARK_CURRENCY[choice.key!], 'EUR')
    assert(benchmarkMatchesCurrency(feed, choice.key))
    // The thing that must never happen, stated directly.
    assert(choice.key !== 'us_treasury_bill_3m')
    assert(choice.key !== 'us_treasury_bill_avg')
    assert(!benchmarkMatchesCurrency(feed, 'us_treasury_bill_3m'))
    assert(!benchmarkMatchesCurrency(feed, 'sofr'))
  }
  // The currency rule wins over the instrument: a euro bill fund and a euro
  // money-market fund both land on the euro rate.
  eq(benchmarkForFeed({ currency: 'EUR', instrumentClass: 'treasury_bill' }).key, 'estr')
  eq(benchmarkForFeed({ currency: 'EUR', instrumentClass: 'money_market' }).key, 'estr')
  eq(benchmarkForFeed({ currency: 'EUR', instrumentClass: 'floating_credit' }).key, 'estr')
})

Deno.test('every registered feed only ever meets a benchmark quoted in its own currency', () => {
  for (const feed of RWA_YIELD_FEEDS) {
    const choice = benchmarkForFeed(feed)
    if (!choice.key) {
      // A feed with no benchmark always says why, and never silently borrows one.
      assert(choice.reason, `${feed.key} has no benchmark and no reason`)
      assert(!benchmarkMatchesCurrency(feed, choice.key))
      continue
    }
    eq(BENCHMARK_CURRENCY[choice.key], feed.currency, `${feed.key} crossed a currency`)
    assert(benchmarkMatchesCurrency(feed, choice.key))
  }
})

Deno.test('instruments with no free redistributable benchmark are given none with a stated reason', () => {
  // Private credit has no free series, and borrowing a treasury bill to stand in
  // for one would invent a comparison the data does not support.
  const crdyx = RWA_FEED_BY_KEY.crdyx
  eq(crdyx.instrumentClass, 'private_credit')
  eq(benchmarkForFeed(crdyx).key, null)
  eq(benchmarkForFeed(crdyx).reason, 'no_free_benchmark_for_private_credit')
  eq(benchmarkForFeed(RWA_FEED_BY_KEY.acred).key, null)

  // A feed whose underlying is not a cash rate instrument cannot acquire a rate
  // benchmark by accident.
  eq(RWA_FEED_BY_KEY.btcy.instrumentClass, 'unclassified')
  eq(benchmarkForFeed(RWA_FEED_BY_KEY.btcy).key, null)
  eq(benchmarkForFeed(RWA_FEED_BY_KEY.btcy).reason, 'instrument_not_classified')
})

Deno.test('the stated reference rate is used where it is the stated reference', () => {
  // AAA CLO paper is floating and references SOFR, so it is not compared to a bill.
  eq(RWA_FEED_BY_KEY.jaaa.instrumentClass, 'floating_credit')
  eq(benchmarkForFeed(RWA_FEED_BY_KEY.jaaa).key, 'sofr')
  // Dollar bill and money-market funds go to the bill curve.
  eq(benchmarkForFeed(RWA_FEED_BY_KEY.ustb).key, 'us_treasury_bill_3m')
  eq(benchmarkForFeed(RWA_FEED_BY_KEY.vbill).key, 'us_treasury_bill_3m')
  eq(benchmarkForFeed(RWA_FEED_BY_KEY.wtgxx).key, 'us_treasury_bill_3m')
})

Deno.test('the register is internally consistent and states the limit that nav is not total return', () => {
  const keys = new Set<string>(), addresses = new Set<string>(), names = new Set<string>()
  for (const feed of RWA_YIELD_FEEDS) {
    assert(!keys.has(feed.key), `duplicate key ${feed.key}`)
    assert(!addresses.has(feed.address), `duplicate address ${feed.address}`)
    assert(!names.has(feed.feedName), `duplicate feed name ${feed.feedName}`)
    keys.add(feed.key); addresses.add(feed.address); names.add(feed.feedName)
    // Addresses join on one canonical form.
    eq(feed.address, feed.address.toLowerCase())
    assert(/^0x[0-9a-f]{40}$/.test(feed.address), `${feed.key} is not an address`)
    // Every feed carries a scope string saying what its NAV does not mean.
    assert(feed.navScope.length > 40, `${feed.key} has no usable scope string`)
    // A market identity is an id plus the name to re-verify it by, or nothing.
    // A half-recorded identity would be an unverifiable join.
    if (feed.marketProviderId) {
      eq(feed.marketProvider, 'coingecko', `${feed.key} has an id with no provider`)
      assert(feed.marketName && feed.marketName.length > 3, `${feed.key} has an id with no name to verify`)
      // A catalogue slug, not a display symbol. Note this is deliberately NOT a
      // check that the id differs from our key: SAFO's real CoinGecko id is
      // `safo`, and refusing that would discard a correct, name-verified
      // identity. What protects against a ticker join is the NAME gate at read
      // time plus the explicitly inert entries for the ambiguous tickers, both
      // asserted below, never the shape of the id.
      assert(/^[a-z0-9][a-z0-9-]*$/.test(feed.marketProviderId), `${feed.key} has a non-slug market id`)
    } else {
      eq(feed.marketProvider, null)
      eq(feed.marketName, null)
    }
    eq(RWA_FEED_BY_ADDRESS[feed.address].key, feed.key)
    eq(RWA_FEED_BY_KEY[feed.key].address, feed.address)
  }
  // The refused mirror row is not quietly present in the register either.
  assert(!names.has('USCC NAV per Share'))
  assert(!names.has('USCC NAV'))
  // The limitation the whole surface has to carry.
  assert(NAV_TOTAL_RETURN_LIMIT.includes('not total return'))
})

Deno.test('a fund whose ticker is ambiguous in our own catalogue is left with no market identity', () => {
  // THE LIVE TRAP, checked against market_assets on 2026-09-16: the ticker `M`
  // resolves to MemeCore and to Mantis, neither of which is this fund. Joining
  // on it would have priced M-zero's net asset value with MemeCore's quote.
  eq(RWA_FEED_BY_KEY.mzero.marketProviderId, null)
  eq(RWA_FEED_BY_KEY.mzero.marketProvider, null)
  // Absent from the catalogue entirely, re-checked 2026-09-20.
  eq(RWA_FEED_BY_KEY.wtgxx.marketProviderId, null)
  eq(RWA_FEED_BY_KEY.crdyx.marketProviderId, null)
  eq(RWA_FEED_BY_KEY.btcy.marketProviderId, null)

  // The funds that DO have an unambiguous, name-verified identity.
  eq(RWA_FEED_BY_KEY.vbill.marketProviderId, 'vaneck-treasury-fund')
  eq(RWA_FEED_BY_KEY.vbill.marketName, 'VanEck Treasury Fund')
  eq(RWA_FEED_BY_KEY.jaaa.marketProviderId, 'janus-henderson-anemoy-aaa-clo-fund')
  eq(RWA_FEED_BY_KEY.acred.marketProviderId, 'apollo-diversified-credit-securitize-fund')
})

Deno.test('a symbol collision resolved by issuer and contract IS mapped, to the right row', () => {
  // Re-checked against market_assets on 2026-09-20. The two `USTBL` rows are
  // distinguishable without using the symbol at all:
  // `spiko-us-t-bills-money-market-fund` is a multi-chain EVM Spiko fund, while
  // `ustbl-tokenized-u-s-treasury-bill` is a single Ordinals inscription with no
  // EVM contract, which a Chainlink NAVLink aggregator on Ethereum cannot be
  // publishing the net asset value of. Leaving a resolvable collision unmapped
  // would have withheld a correct comparison, which is its own defect.
  const ustbl = RWA_FEED_BY_KEY.ustbl
  eq(ustbl.marketProvider, 'coingecko')
  eq(ustbl.marketProviderId, 'spiko-us-t-bills-money-market-fund')
  eq(ustbl.marketName, 'Spiko US T-Bills Money Market Fund')
  // Mapped to the Spiko row, never to the bare-symbol Ordinals row.
  assert(!ustbl.marketProviderId!.includes('tokenized-u-s-treasury-bill'))
  // The registered Spiko siblings are why that discriminator is trustworthy.
  eq(RWA_FEED_BY_KEY.eutbl.marketName, 'Spiko EU T-Bills Money Market Fund')
  eq(RWA_FEED_BY_KEY.safo.marketName, 'Spiko Amundi Overnight Swap Fund')
})

Deno.test('the register records that a curated identity goes stale, using the rename it already carries', () => {
  // The USTB provider id still names Superstate while the catalogue name is now
  // Invesco. Recording the CURRENT name is what lets a further rename be caught
  // at read time instead of silently pricing whatever the row has become.
  const ustb = RWA_FEED_BY_KEY.ustb
  assert(ustb.marketProviderId!.includes('superstate'))
  eq(ustb.marketName, 'Invesco Short Duration US Government Securities Fund')
  assert(!ustb.marketName!.toLowerCase().includes('superstate'))

  // CoinMarketCap is recorded as a SOURCE LIMITATION, not as work outstanding.
  assert(RWA_MARKET_SOURCE_LIMIT.includes('no identifier'))
  // The surface has to say the two halves are two different sources.
  assert(MARKET_DEVIATION_SOURCE_NOTE.includes('never on a ticker'))
})
