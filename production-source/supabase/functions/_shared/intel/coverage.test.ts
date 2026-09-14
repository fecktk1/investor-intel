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

Deno.test('reconcileCoverage warns for unsatisfied material gaps even with model high confidence', () => {
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
  assert(high.data_coverage.should_show_warning === true, 'model confidence cannot suppress a material gap')
})

Deno.test('server coverage gaps cannot be erased by related sources or downgraded by the model',()=>{
  const material='No current exchange depth snapshot.',optional='No current exchange spread snapshot.'
  const result=reconcileCoverage({confidence:'high',sources:['Exchange depth'],data_coverage:{confidence_impact:'none',optional_gaps:[material],used_sources:['Invented paid source'],checked_sources:['Invented probe']}},['Exchange ticker'],{
    used_sources:['exchange_latest_tickers'],checked_sources:['exchange_latest_orderbook'],unavailable_sources:['exchange_latest_orderbook'],material_gaps:[material],optional_gaps:[optional],confidence_impact:'high',
  })
  assert(result.data_coverage.material_gaps.includes(material),'measured missing depth is retained')
  assert(!result.data_coverage.optional_gaps.includes(material),'material gap cannot be downgraded')
  assert(result.data_coverage.optional_gaps.includes(optional),'partial source use cannot erase optional spread absence')
  assert(result.data_coverage.unavailable_sources.includes('exchange_latest_orderbook'),'unavailable snapshot remains explicit')
  assert(!result.data_coverage.used_sources.includes('Invented paid source'),'model source is not verified usage')
  assert(!result.data_coverage.checked_sources.includes('Invented probe'),'model probe is not verification')
  assert(result.data_coverage.confidence_impact==='high'&&result.data_coverage.should_show_warning,'strongest evidence gap wins')
})

Deno.test('model-only source labels cannot resolve a model-reported data gap',()=>{
  const result=reconcileCoverage({confidence:'high',sources:['Exchange market data'],missing_context:['Current price unavailable'],data_coverage:{used_sources:['Exchange market data']}},[],null)
  assert(result.missing_context.includes('Current price unavailable'),'unsupported source label cannot clear a gap')
  assert(result.data_coverage.used_sources.length===0,'no verified source was supplied')
})
