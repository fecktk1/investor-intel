import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { produceSignalState } from './intel-signal-producer.ts'

// Awaitable Supabase mock with upsert/insert capture.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeAdmin(tables: Record<string, any>) {
  const sink = { upserts: [] as any[], inserts: [] as any[] }
  const make = (table: string) => {
    const result = tables[table] ?? { data: [], error: null }
    const b: any = {}
    for (const m of ['select', 'order', 'limit', 'gte', 'gt', 'eq', 'in']) b[m] = () => b
    b.upsert = (rows: any[]) => { sink.upserts.push({ table, rows }); return Promise.resolve({ error: null }) }
    b.insert = (rows: any[]) => { sink.inserts.push({ table, rows }); return Promise.resolve({ error: null }) }
    b.then = (res: any) => res(result)
    return b
  }
  return { admin: { from: (t: string) => make(t), rpc: () => Promise.resolve({ data: null, error: null }) }, sink }
}

const now = 1_700_000_000_000
const isoNow = new Date(now).toISOString()

function fixtures() {
  return {
    market_assets: { data: [
      { source_provider: 'coingecko', provider_id: 'solana', symbol: 'SOL', normalized_symbol: 'SOL', market_cap: 9e10 },
      { source_provider: 'coingecko', provider_id: 'bitcoin', symbol: 'BTC', normalized_symbol: 'BTC', market_cap: 1e12 },
    ], error: null },
    intel_global_news: { data: [
      { title: 'Solana ETF filing advances at the SEC', source_name: 'CoinDesk', sentiment: 'bullish', published_at: isoNow, created_at: isoNow, chains: ['solana'], entity_symbol: 'SOL' },
      { title: 'Solana network upgrade ships to mainnet', source_name: 'The Block', sentiment: 'bullish', published_at: isoNow, created_at: isoNow, chains: ['solana'], entity_symbol: 'SOL' },
    ], error: null },
    intel_curated_news: { data: [
      { cluster_hash: 'abc123', cleaned_title: 'BTC ETF inflows hit record', title: 'BTC ETF inflows hit record', why_it_matters: 'Demand signal', watch_next: 'Flows next session', chains: ['bitcoin'], tokens: ['BTC'], narratives: ['etf'], signal: 'bullish', confidence: 'high', final_score: 82, source_count: 4, should_surface: true },
    ], error: null },
    exchange_latest_tickers: { data: [
      { normalized_symbol: 'SOL', price_change_pct_24h: 6.0, volume_quote_24h: 1e8, spread_pct: 0.1 },
    ], error: null },
    exchange_latest_market_signals: { data: [
      { normalized_symbol: 'SOL', direction: 'bullish', strength: 'strong', confidence: 'high', title: 'SOL multi-venue strength', summary: 's', why_it_matters: 'Confirmed across venues', provider_count: 3, confirming_providers: ['binance', 'coinbase', 'kraken'] },
    ], error: null },
    narrative_state: { data: [
      { narrative_id: 'n1', signal_class: 'bullish', lifecycle_stage: 'heating_up', prev_stage: 'early', global_priority_score: 72, confidence_score: 65, freshness_score: 80, price_confirmation_score: 60, volume_confirmation_score: 55, breadth_score: 40, risk_score: 30, related_chains: ['solana'], related_assets: [{ symbol: 'SOL' }], leaders: [{ symbol: 'SOL' }], score_delta: {}, narrative_taxonomy: { slug: 'sol-defi', name: 'Solana DeFi', status: 'active' } },
    ], error: null },
    // prior state: SOL was bearish last cycle → flip + delta this run
    intel_signal_state: { data: [
      { signal_key: 'asset:cg:solana', direction: 'bearish', global_score: 0.2, cache_key: 'old' },
    ], error: null },
  }
}

Deno.test('producer maps families to normalized signals with canonical keys', async () => {
  const { admin, sink } = makeAdmin(fixtures())
  const res = await produceSignalState(admin as any, { now })
  assert(res.signals > 0)

  const stateRows = sink.upserts.filter((u) => u.table === 'intel_signal_state').flatMap((u) => u.rows)
  const byKey = new Map(stateRows.map((r: any) => [r.signal_key, r]))

  // SOL asset signal — canonical coingecko key, not the symbol
  const sol = byKey.get('asset:cg:solana')
  assert(sol, 'SOL asset signal present')
  assertEquals(sol.subject_type, 'asset')
  assertEquals(sol.subject_id, 'cg:solana')
  assertEquals(sol.display_symbol, 'SOL')
  assertEquals(sol.direction, 'bullish')
  assert(sol.market_impact > 0, 'market impact from exchange ticker')

  // narrative signal — slug subject; related_assets are CANONICAL (cg:solana), not "SOL"
  const narr = byKey.get('narrative:sol-defi')
  assert(narr, 'narrative signal present')
  assertEquals(narr.subject_type, 'narrative')
  assertEquals(narr.direction, 'bullish')
  assert((narr.related_assets || []).includes('cg:solana'), `related_assets canonical: ${JSON.stringify(narr.related_assets)}`)
  assert(!(narr.related_assets || []).includes('SOL'), 'no raw symbols in related_assets')

  // curated news signal
  const news = byKey.get('news:abc123')
  assert(news, 'news signal present')
  assertEquals(news.subject_type, 'news')
})

Deno.test('score_delta carries prev_direction + d_global_score from prior row', async () => {
  const { admin, sink } = makeAdmin(fixtures())
  await produceSignalState(admin as any, { now })
  const sol = sink.upserts.flatMap((u) => u.rows).find((r: any) => r.signal_key === 'asset:cg:solana')
  assertEquals(sol.score_delta.prev_direction, 'bearish')
  assert(sol.score_delta.d_global_score !== 0, 'delta computed vs prior')
  // changed (cache_key differs from prior 'old') → a snapshot was written
  const snaps = sink.inserts.filter((i) => i.table === 'intel_signal_snapshots').flatMap((i) => i.rows)
  assert(snaps.some((s: any) => s.signal_key === 'asset:cg:solana'), 'snapshot emitted on change')
})

Deno.test('corroboration: agreeing layers counted, divergence flagged', async () => {
  const { admin, sink } = makeAdmin(fixtures())
  await produceSignalState(admin as any, { now })
  const sol = sink.upserts.flatMap((u) => u.rows).find((r: any) => r.signal_key === 'asset:cg:solana')
  const corr = sol.metrics.corroboration
  assert(corr, 'corroboration present on asset signal')
  assertEquals(corr.divergence, false) // radar + exchange + narrative all bullish on SOL
  assert(corr.count >= 2, `expected >=2 agreeing layers, got ${corr.count}`)
  assertEquals(corr.layers.radar, 'bullish')
  assertEquals(corr.layers.exchange, 'bullish')
})

Deno.test('NO private wallet/portfolio rows are written to the global store', async () => {
  const { admin, sink } = makeAdmin(fixtures())
  await produceSignalState(admin as any, { now })
  const stateRows = sink.upserts.flatMap((u) => u.rows)
  assert(stateRows.length > 0)
  for (const r of stateRows) {
    assert(r.subject_type !== 'wallet' && r.subject_type !== 'portfolio', `unexpected private subject_type ${r.subject_type}`)
    // bullish/bearish/mixed only — never neutralized away
    assert(['bullish', 'bearish', 'mixed'].includes(r.direction), `direction ${r.direction}`)
    // expiry + staleness set
    assert(r.stale_after && r.expires_at && r.generated_at)
  }
})

Deno.test('records a precise cost-ledger event with zero provider calls', async () => {
  const { admin, sink } = makeAdmin(fixtures())
  await produceSignalState(admin as any, { now })
  const ledger = sink.inserts.filter((i) => i.table === 'intel_cost_ledger').flatMap((i) => i.rows)
  assertEquals(ledger.length, 1)
  assertEquals(ledger[0].feature, 'signal_producer')
  assertEquals(ledger[0].provider_calls_made, 0)
  assert(ledger[0].provider_calls_avoided > 0)
  assertEquals(ledger[0].bucket_start, null) // precise, not bucketed
})
