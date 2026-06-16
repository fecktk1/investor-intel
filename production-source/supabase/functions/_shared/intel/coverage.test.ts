import { reconcileCoverage } from './coverage.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

Deno.test('D3 reconcileCoverage drops gaps covered by used sources', () => {
  const structured = reconcileCoverage({
    confidence: 'medium',
    sources: ['Exchange market data (Binance/Coinbase/Kraken/KuCoin)'],
    missing_context: ['Current price unavailable', 'No scoped flow data'],
  }, [], {
    used_sources: ['exchange_latest_tickers'],
    checked_sources: ['exchange_latest_tickers', 'asset_transfer_activity'],
    material_gaps: [],
    optional_gaps: ['No scoped flow data'],
  })
  assert(!structured.missing_context.includes('Current price unavailable'), 'price gap covered by exchange source')
  assert(!structured.missing_context.includes('No scoped flow data'), 'flow optional gap is not material')
  assert(structured.data_coverage.optional_gaps.includes('No scoped flow data'), 'optional gap retained neutrally')
  assert(structured.data_coverage.should_show_warning === false, 'optional-only gaps do not warn')
})

Deno.test('D3 reconcileCoverage warns only for unsatisfied material gaps below high confidence', () => {
  const structured = reconcileCoverage({
    confidence: 'low',
    sources: ['Curated News'],
    data_coverage: {
      material_gaps: ['No cached liquidity/depth snapshot matched MISS.'],
      optional_gaps: ['No recent curated news rows matched MISS.'],
    },
  }, ['Curated News'], null)
  assert(structured.missing_context.length === 1, 'unsatisfied material liquidity gap remains')
  assert(structured.data_coverage.should_show_warning === true, 'low-confidence material gap warns')

  const high = reconcileCoverage({
    confidence: 'high',
    missing_context: ['No cached liquidity/depth snapshot matched MISS.'],
    sources: [],
  }, [], null)
  assert(high.data_coverage.should_show_warning === false, 'high confidence suppresses warning per c7 policy')
})
