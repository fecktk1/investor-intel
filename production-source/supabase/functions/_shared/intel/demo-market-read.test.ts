import { assertEquals } from 'jsr:@std/assert@1'
import { demoQuoteRead, readQuoteTape } from './demo-market-read.ts'

// deno-lint-ignore no-explicit-any
type Any = any

const NOW = Date.parse('2026-09-23T18:46:00.000Z')
// The catalogue row the observation lane rewrote at 18:45, and the shared
// CoinMarketCap cache entry nobody has refreshed since 15:47.
const ROW = {
  source_provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', normalized_symbol: 'BTC', name: 'Bitcoin',
  current_price: 84210.97, change_24h_pct: -2.55, volume_24h: 47.4e9, market_cap: 1.69e12, as_of: '2026-09-23T18:45:00.000Z',
}
const CACHE = { ...ROW, current_price: 84285.71, change_24h_pct: -2.61, as_of: '2026-09-23T15:47:00.000Z' }
const CACHE_RECEIPT = { capability: 'quotes', endpoint: '/v3/cryptocurrency/quotes/latest', origin: 'cache', fetchedAt: '2026-09-23T15:47:53.761Z', ttlSeconds: 60, cacheAgeSeconds: 10730, httpStatus: 200 }

Deno.test('the newest stored answer wins: a catalogue row minutes old beats a cache entry hours old', () => {
  const read = demoQuoteRead(ROW, CACHE, [CACHE_RECEIPT], null, NOW)
  assertEquals([read.quote.price, read.quote.asOf, read.quote.change24h, read.priceSource], [84210.97, '2026-09-23T18:45:00.000Z', -2.55, 'catalogue'])
  assertEquals(read.quote.sourceFreshness, 'fresh')
  // The receipt describes the stored row that answered, not the old cache call.
  assertEquals(read.receipts.map((r: Any) => r.capability), ['market_assets'])
  assertEquals(read.figuresAsOf, null)
})

Deno.test('a newer cache entry still answers as it does for a member', () => {
  const read = demoQuoteRead({ ...ROW, as_of: '2026-09-23T14:00:00.000Z' }, CACHE, [CACHE_RECEIPT], null, NOW)
  assertEquals([read.quote.price, read.priceSource], [84285.71, 'cache'])
})

Deno.test('a later price on the quote tape answers the price; every other figure keeps its own time', () => {
  const tape = { price: 84190.12, observedAt: '2026-09-23T18:40:00.000Z' }
  const row = { ...ROW, as_of: '2026-09-23T17:45:00.000Z' }
  const read = demoQuoteRead(row, CACHE, [CACHE_RECEIPT], tape, NOW)
  assertEquals([read.quote.price, read.quote.asOf, read.priceSource, read.figuresAsOf], [84190.12, '2026-09-23T18:40:00.000Z', 'quote_tape', '2026-09-23T17:45:00.000Z'])
  // Six minutes old is fresh, never "stale".
  assertEquals(read.quote.sourceFreshness, 'fresh')
  assertEquals(read.receipts.map((r: Any) => [r.capability, r.origin, r.freshness]), [['intel_quote_tape', 'stored', 'cached']])
  assertEquals(read.figureProvenance.price.fetchedAt, '2026-09-23T18:40:00.000Z')
  // The 24h change, volume and market cap are the row's, dated by the row.
  assertEquals(read.quote.change24h, -2.55)
  assertEquals(read.figureProvenance.market_cap.fetchedAt, '2026-09-23T17:45:00.000Z')
})

Deno.test('an older tape point never replaces a newer quote', () => {
  const read = demoQuoteRead(ROW, CACHE, [CACHE_RECEIPT], { price: 1, observedAt: '2026-09-23T18:38:00.000Z' }, NOW)
  assertEquals([read.quote.price, read.priceSource], [84210.97, 'catalogue'])
})

Deno.test('an RWA wrapper token captured at 14:00 is priced from the tape when the tape is later', () => {
  const wrapper = {
    source_provider: 'coinmarketcap', provider_id: '39306', symbol: 'SGOVON', name: 'SGOV (Ondo)', current_price: 100.41,
    as_of: '2026-09-23T14:00:00.000Z', source_label: 'CoinMarketCap (RWA wrapper capture)',
  }
  const read = demoQuoteRead(wrapper, null, [], { price: 100.43, observedAt: '2026-09-23T18:41:00.000Z' }, NOW)
  assertEquals([read.quote.price, read.quote.asOf, read.priceSource, read.figuresAsOf], [100.43, '2026-09-23T18:41:00.000Z', 'quote_tape', '2026-09-23T14:00:00.000Z'])
})

Deno.test('the tape read is one keyed, newest-first row; a bad id or a failed read is null', async () => {
  const seen: unknown[][] = []
  const chain = (rows: Any[], error: Any = null) => {
    const q: Any = {
      select: (...a: unknown[]) => { seen.push(['select', ...a]); return q },
      eq: (...a: unknown[]) => { seen.push(['eq', ...a]); return q },
      order: (...a: unknown[]) => { seen.push(['order', ...a]); return q },
      limit: (...a: unknown[]) => { seen.push(['limit', ...a]); return Promise.resolve({ data: rows, error }) },
    }
    return { from: (table: string) => { seen.push(['from', table]); return q } }
  }
  const point = await readQuoteTape(chain([{ price: 84190.12, observed_at: '2026-09-23T18:40:00+00:00' }]), '1', NOW)
  assertEquals(point, { price: 84190.12, observedAt: '2026-09-23T18:40:00.000Z' })
  assertEquals(seen, [['from', 'intel_quote_tape'], ['select', 'price,observed_at'], ['eq', 'subject', 'market:coinmarketcap:1'], ['order', 'observed_at', { ascending: false }], ['limit', 1]])
  assertEquals(await readQuoteTape(chain([]), '1', NOW), null)
  assertEquals(await readQuoteTape(chain([], { message: 'permission denied' }), '1', NOW), null)
  assertEquals(await readQuoteTape(chain([{ price: 1, observed_at: '2026-09-24T00:00:00Z' }]), '1', NOW), null)
  assertEquals(await readQuoteTape(chain([]), 'bitcoin', NOW), null)
})

Deno.test('a stored quote minutes old is never called stale; each receipt names the store it came from', () => {
  // Nine minutes old: past the catalogue policy's five, well inside the lane's own refresh.
  const nine = demoQuoteRead({ ...ROW, as_of: '2026-09-23T18:37:00.000Z' }, null, [], null, NOW)
  assertEquals([nine.receipts[0].capability, nine.receipts[0].freshness, nine.figureProvenance.price.freshness, nine.quote.sourceFreshness], ['market_assets', 'cached', 'cached', 'fresh'])
  // A wrapper token priced from the six-hourly capture, five hours after it ran.
  const wrapper = { source_provider: 'coinmarketcap', provider_id: '40927', symbol: 'AAPLB', current_price: 231.4, as_of: '2026-09-23T14:00:00.000Z', source_label: 'CoinMarketCap (RWA wrapper capture)' }
  const read = demoQuoteRead(wrapper, null, [], null, NOW)
  assertEquals([read.receipts[0].capability, read.receipts[0].freshness, read.priceSource], ['intel_rwa_wrapper_tokens', 'cached', 'catalogue'])
})
