// Investor Intel RWA yield register: which NAV feeds we trust, what each one is
// denominated in, and which benchmark it may be compared against.
//
// WHY A CURATED REGISTER AND NOT THE WHOLE MIRROR.
// `chainlink-nav.ts` can prove that an address really is the feed the mirror
// named. It cannot tell us what CURRENCY that fund reports in, or what kind of
// instrument sits underneath it, and neither can the mirror: probed 2026-09-16,
// every NAVLink row carries an empty `docs.assetName` and `docs.quoteAsset`.
// Comparing a euro fund against a US Treasury bill would be a worse answer than
// no answer, so denomination is recorded here by hand, per feed, and a feed that
// is not in this register is reported as `not_registered` rather than captured.
// Ship fewer feeds we can defend over more we cannot.
//
// Every address below was validated on chain on 2026-09-16 against
// `description()` on https://ethereum-rpc.publicnode.com. The one mirror row
// that failed that check (mirror "USCC NAV per Share" against on-chain
// "USCC NAV") is deliberately absent: it is refused at validation time and is
// not silently listed here either.
//
// WHY THE MARKET SIDE IS JOINED ON AN ID AND NEVER ON A TICKER.
// Checked against our own `market_assets` on 2026-09-16: the ticker `M`
// resolves to MemeCore (CoinMarketCap id 35491) and to Mantis, neither of which
// is the M-zero protocol whose NAV feed we read, and `USTBL` collides with two
// rows. A ticker join would therefore have priced one fund's net asset value
// against a completely different asset's quote. Every market identity below is
// a catalogue provider id whose fund NAME is re-verified at read time.
//
// A HAND-CURATED REGISTRY GOES STALE, AND THIS ONE ALREADY HAS.
// The USTB row is the proof: its catalogue provider id still reads
// `superstate-short-duration-us-government-securities-fund-ustb` while the name
// on that same row is now "Invesco Short Duration US Government Securities
// Fund". The fund was renamed and the id kept the old sponsor. That is exactly
// why `marketName` is re-checked at read time rather than trusted from here:
// when a name drifts again the comparison is REFUSED with
// `market_name_mismatch` and surfaced, instead of silently pricing whatever the
// row has become. Treat a mismatch as a prompt to re-verify this register.

/** The only two denominations this register admits today. A fund reporting in
 * anything else is not registered, because we hold no benchmark for it. */
export type RwaCurrency = 'USD' | 'EUR'

/** What sits under the token. This drives the benchmark, so it is a recorded
 * judgement and never inferred from a feed name at runtime. */
export type RwaInstrumentClass =
  | 'treasury_bill'
  | 'money_market'
  | 'floating_credit'
  | 'private_credit'
  | 'unclassified'

export type BenchmarkKey = 'us_treasury_bill_3m' | 'us_treasury_bill_avg' | 'sofr' | 'estr'

export interface RwaYieldFeed {
  /** Stable slug, used as the storage key and the i18n suffix. */
  key: string
  /** MUST equal the feed's on-chain `description()` exactly. */
  feedName: string
  address: string
  currency: RwaCurrency
  instrumentClass: RwaInstrumentClass
  /** Which catalogue the market side of the price-against-NAV comparison comes
   * from. Always 'coingecko' where set: see RWA_MARKET_SOURCE_LIMIT. */
  marketProvider: 'coingecko' | null
  /** The catalogue's own stable provider id, NEVER a ticker. A ticker join is
   * the one thing this field exists to prevent: see the header. */
  marketProviderId: string | null
  /** The fund name the catalogue carried when this row was recorded, re-checked
   * at READ time. A catalogue row whose name has drifted is refused rather than
   * priced, because a renamed or repurposed row is no longer known to be this
   * fund. */
  marketName: string | null
  /** SEC series id when this fund files N-MFP3, which is where an ADVERTISED
   * yield can be read from a primary source. NULL means the advertised yield is
   * not published anywhere free and structured, and the surface says so. */
  secSeriesId: string | null
  /** What this feed's NAV does NOT mean. Carried onto every stored figure. */
  navScope: string
}

/** The observation clock. A NAV round is dated by the AGGREGATOR, not by us. */
export const NAV_TIME_MEANING =
  'Observation time is the aggregator\'s own updatedAt for that round. It dates the published NAV, not our capture, and not the moment the fund struck the valuation.'

/** The single most important limitation on this whole surface. A fund that pays
 * its return out as a distribution holds NAV flat, so realized NAV growth is not
 * that fund's total return. Probed 2026-09-16: VBILL and WTGXX both sat at
 * exactly 1.0 across ten rounds, which is a real 0 percent NAV change and is
 * rendered as 0, not blank, and not as "no yield". */
export const NAV_TOTAL_RETURN_LIMIT =
  'NAV growth is not total return. A fund that distributes its income holds NAV flat, so a realized figure of zero can mean the return was paid out rather than accrued. Distributions are not observable from the NAV feed.'

/** THE MARKET SIDE IS A DIFFERENT SOURCE FROM THE NAV SIDE, AND SAYS SO.
 *
 * A deviation compares a NAV published by the fund's own Chainlink feed against
 * a market price from our CoinGecko-sourced catalogue. The two can never share a
 * source: a net asset value is struck by the fund, a price is observed on
 * venues. What matters is that the join is correct and that the mix is STATED,
 * so this string is rendered beside every deviation figure. */
export const MARKET_DEVIATION_SOURCE_NOTE =
  'The net asset value is the fund\'s own published figure read on chain. The market price comes from our CoinGecko-sourced catalogue, matched on that catalogue\'s provider id with the fund name re-verified, never on a ticker. These are two different sources with two different clocks.'

/** Why CoinMarketCap cannot supply the market side, recorded as a SOURCE
 * LIMITATION rather than as work still to do.
 *
 * Checked on 2026-09-16 against both stores: `market_assets` carries
 * CoinMarketCap rows for the gold tokens (PAXG 4705, XAUT 5176, XAUM 34212,
 * CGO 20245) and for an `M` that is a different asset entirely, and the
 * `entities` table returns no rows for any symbol in this register. There is no
 * CoinMarketCap identifier to find for these treasury and credit funds, so this
 * is not an id waiting to be filled in. */
export const RWA_MARKET_SOURCE_LIMIT =
  'CoinMarketCap publishes no identifier for these tokenised treasury and credit funds, so the market side of the comparison cannot come from it. Where a market price is shown it comes from our CoinGecko-sourced catalogue instead.'

/** Why an advertised yield may be missing. */
export const ADVERTISED_SCOPE =
  'Advertised yield is the issuer or filing figure for a stated past period. It is not a forecast, not a guarantee, and not the return of holding the token.'

const TREASURY_SCOPE =
  'Published net asset value per share for the named fund. Not a quote, not a redemption price, and not the market price of the token.'
const CREDIT_SCOPE =
  'Published net asset value per share for a credit fund. A change in this figure may be income, a distribution or a credit loss, and free data cannot tell them apart.'

/** The registered feeds. Address, name and decimals were each proved on chain on
 * 2026-09-16; the currency and instrument class are recorded judgements. */
export const RWA_YIELD_FEEDS: RwaYieldFeed[] = [
  // USD short-duration government funds. NAV accrues, so realized yield is
  // directly computable and did compute cleanly on 2026-09-16.
  // USTB carries the rename described in the header: the id still names
  // Superstate, the catalogue name is now Invesco. The name below is the one the
  // catalogue actually holds, so a further rename trips `market_name_mismatch`.
  { key: 'ustb', feedName: 'USTB NAV per Share', address: '0x289b5036cd942e619e1ee48670f98d214e745aac',
    currency: 'USD', instrumentClass: 'treasury_bill',
    marketProvider: 'coingecko', marketProviderId: 'superstate-short-duration-us-government-securities-fund-ustb',
    marketName: 'Invesco Short Duration US Government Securities Fund', secSeriesId: null, navScope: TREASURY_SCOPE },
  // AMBIGUOUS in the catalogue: two rows, a Spiko money market fund and a
  // separate tokenised treasury bill. An ambiguous match is not a match, so the
  // market side stays inert rather than guessing which row is this feed.
  { key: 'ustbl', feedName: 'USTBL NAV', address: '0x477e363c51ab0c4d13b22cd6b57d56d4a3cb7abe',
    currency: 'USD', instrumentClass: 'treasury_bill',
    marketProvider: null, marketProviderId: null, marketName: null, secSeriesId: null, navScope: TREASURY_SCOPE },
  { key: 'jtrsy', feedName: 'JTRSY NAV', address: '0x0c2e4df738e99e8db80012f5bb2a303f3f48ca74',
    currency: 'USD', instrumentClass: 'treasury_bill',
    marketProvider: 'coingecko', marketProviderId: 'janus-henderson-anemoy-treasury-fund',
    marketName: 'Janus Henderson Anemoy Treasury Fund', secSeriesId: null, navScope: TREASURY_SCOPE },
  { key: 'vbill', feedName: 'VBILL NAV', address: '0xd92095baf79a6ca6533019e952ade0d3c5834f4b',
    currency: 'USD', instrumentClass: 'treasury_bill',
    marketProvider: 'coingecko', marketProviderId: 'vaneck-treasury-fund',
    marketName: 'VanEck Treasury Fund', secSeriesId: null, navScope: TREASURY_SCOPE },
  { key: 'safo', feedName: 'SAFO NAV', address: '0xc1e5fa6d48ba11ca163b03f2abf843471eb7b2fb',
    currency: 'USD', instrumentClass: 'money_market',
    marketProvider: 'coingecko', marketProviderId: 'safo',
    marketName: 'Spiko Amundi Overnight Swap Fund', secSeriesId: null, navScope: TREASURY_SCOPE },
  // Absent from the catalogue entirely, so there is nothing to join to.
  { key: 'wtgxx', feedName: 'WTGXX NAV', address: '0xd13cb763c43b5c058e7ec40176962c5030f4eb49',
    currency: 'USD', instrumentClass: 'money_market',
    marketProvider: null, marketProviderId: null, marketName: null, secSeriesId: null, navScope: TREASURY_SCOPE },
  // THE LIVE TRAP. The ticker `M` resolves to MemeCore and to Mantis in our own
  // catalogue, and neither is this fund. There is no safe match, so no id.
  { key: 'mzero', feedName: 'M NAV', address: '0xc28198df9aee1c4990994b35ff51efa4c769e534',
    currency: 'USD', instrumentClass: 'money_market',
    marketProvider: null, marketProviderId: null, marketName: null, secSeriesId: null, navScope: TREASURY_SCOPE },

  // EUR funds. These exist in the register mainly to make the currency rule
  // impossible to get wrong by accident: they must never meet a US bill. Their
  // market identities are recorded, but the catalogue prices in USD, so the
  // deviation still refuses on currency rather than folding in an exchange rate.
  { key: 'eutbl', feedName: 'EUTBL NAV', address: '0xfd628af590c4150a9651c1f4ddd0b4f532b703ae',
    currency: 'EUR', instrumentClass: 'treasury_bill',
    marketProvider: 'coingecko', marketProviderId: 'eutbl',
    marketName: 'Spiko EU T-Bills Money Market Fund', secSeriesId: null, navScope: TREASURY_SCOPE },
  { key: 'eursafo', feedName: 'EURSAFO NAV', address: '0x799fdc55150583b5baa0b47065e1c901862c95d5',
    currency: 'EUR', instrumentClass: 'money_market',
    marketProvider: 'coingecko', marketProviderId: 'spiko-amundi-overnight-swap-fund-eur',
    marketName: 'Spiko Amundi Overnight Swap Fund (EUR)', secSeriesId: null, navScope: TREASURY_SCOPE },

  // Floating-rate credit. SOFR is the stated reference for AAA CLO paper, so
  // this is the one feed benchmarked against SOFR rather than a bill.
  { key: 'jaaa', feedName: 'JAAA NAV', address: '0x3bbccb2301759d2e4a5692ba72dab4b75dc43b1a',
    currency: 'USD', instrumentClass: 'floating_credit',
    marketProvider: 'coingecko', marketProviderId: 'janus-henderson-anemoy-aaa-clo-fund',
    marketName: 'Janus Henderson Anemoy AAA CLO Fund', secSeriesId: null, navScope: CREDIT_SCOPE },

  // Private credit. Registered so the monitor can SEE them, and deliberately
  // given no benchmark: see `benchmarkForFeed`. Probed 2026-09-16, CRDYX fell
  // over multiple steps and ACRED drifted down; neither is publishable as a
  // yield, and both route to review.
  // Absent from the catalogue, so no market side.
  { key: 'crdyx', feedName: 'CRDYX NAV', address: '0x0b9bd3eaac381a1a6731ff6598a50638e5cffd25',
    currency: 'USD', instrumentClass: 'private_credit',
    marketProvider: null, marketProviderId: null, marketName: null, secSeriesId: null, navScope: CREDIT_SCOPE },
  { key: 'acred', feedName: 'ACRED NAV', address: '0x35ddfb90011e686ccf837a6819562705076207eb',
    currency: 'USD', instrumentClass: 'private_credit',
    marketProvider: 'coingecko', marketProviderId: 'apollo-diversified-credit-securitize-fund',
    marketName: 'Apollo Diversified Credit Securitize Fund', secSeriesId: null, navScope: CREDIT_SCOPE },

  // Not a rate instrument at all. Registered because it is the clearest live
  // staleness case we have: probed 2026-09-16 its newest round was 156 hours old
  // against a 24 hour heartbeat. It is classed `unclassified` so that it can
  // never acquire a benchmark by accident.
  { key: 'btcy', feedName: 'BTCY NAV', address: '0x5a33e6cb085e2ddd0df558c0d7d71a27be6b9131',
    currency: 'USD', instrumentClass: 'unclassified',
    marketProvider: null, marketProviderId: null, marketName: null, secSeriesId: null,
    navScope: 'Published net asset value for a fund whose underlying is not a cash rate instrument. No interest-rate benchmark applies.' },
]

/** A fund that files N-MFP3 and therefore publishes an advertised yield to a
 * primary source. Kept separate from the NAV feeds because the Franklin OnChain
 * US Government Money Fund has no NAVLink feed in the mirror: it is an asset for
 * which we can read the ADVERTISED side and honestly report that the realized
 * side is unavailable. Series id verified against EDGAR on 2026-09-16. */
export const RWA_ADVERTISED_ONLY: { key: string; name: string; secSeriesId: string; currency: RwaCurrency; instrumentClass: RwaInstrumentClass }[] = [
  { key: 'benji', name: 'Franklin OnChain U.S. Government Money Fund', secSeriesId: 'S000067043', currency: 'USD', instrumentClass: 'money_market' },
]

export const RWA_FEED_BY_KEY: Record<string, RwaYieldFeed> =
  Object.fromEntries(RWA_YIELD_FEEDS.map((feed) => [feed.key, feed]))
/** Lower-case address to feed, so a validated on-chain row finds its register
 * entry without trusting the mirror's name a second time. */
export const RWA_FEED_BY_ADDRESS: Record<string, RwaYieldFeed> =
  Object.fromEntries(RWA_YIELD_FEEDS.map((feed) => [feed.address.toLowerCase(), feed]))

/** The currency each benchmark is quoted in. This is the table the currency
 * guard reads; it is not derived from a string at the call site. */
export const BENCHMARK_CURRENCY: Record<BenchmarkKey, RwaCurrency> = {
  us_treasury_bill_3m: 'USD',
  us_treasury_bill_avg: 'USD',
  sofr: 'USD',
  estr: 'EUR',
}

export interface BenchmarkChoice {
  key: BenchmarkKey | null
  /** Present whenever `key` is null. A feed with no benchmark states why. */
  reason: string | null
}

/** Which benchmark, if any, this feed may be compared against.
 *
 * THE CURRENCY RULE COMES FIRST AND HAS NO EXCEPTION. A euro fund is compared
 * against the euro short-term rate whatever sits underneath it. Putting a EUR
 * NAV next to a US Treasury bill would silently fold a currency difference into
 * something presented as a yield gap, and getting that wrong is worse than not
 * shipping the comparison at all.
 *
 * Private credit gets NO benchmark on purpose. There is no free, redistributable
 * series for it, and borrowing a Treasury bill to stand in for one would invent
 * a comparison the data does not support. */
export function benchmarkForFeed(feed: Pick<RwaYieldFeed, 'currency' | 'instrumentClass'>): BenchmarkChoice {
  if (feed.instrumentClass === 'unclassified') return { key: null, reason: 'instrument_not_classified' }
  if (feed.instrumentClass === 'private_credit') return { key: null, reason: 'no_free_benchmark_for_private_credit' }
  if (feed.currency === 'EUR') return { key: 'estr', reason: null }
  if (feed.currency === 'USD') {
    if (feed.instrumentClass === 'floating_credit') return { key: 'sofr', reason: null }
    return { key: 'us_treasury_bill_3m', reason: null }
  }
  return { key: null, reason: 'currency_not_registered' }
}

/** The last gate before a comparison is stored or drawn. A benchmark whose
 * currency differs from the fund's is refused here even if a caller asked for
 * it, so no future edit to the mapping above can leak a EUR fund onto a USD
 * bill without this failing first. */
export function benchmarkMatchesCurrency(feed: Pick<RwaYieldFeed, 'currency'>, key: BenchmarkKey | null): boolean {
  if (!key) return false
  return BENCHMARK_CURRENCY[key] === feed.currency
}
