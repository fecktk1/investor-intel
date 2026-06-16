import {
  assembleAssetEvidencePack,
  criticalSlicesForAssetEvidencePack,
  getOrAssembleAssetEvidencePack,
  persistAssetEvidencePack,
} from './asset-evidence-pack.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

// deno-lint-ignore no-explicit-any
function makeDb(seed: Record<string, any[]> = {}) {
  const writes: Record<string, unknown[]> = {}
  const calls: Array<{ table: string; method: string }> = []
  const db = {
    writes,
    calls,
    from(table: string) {
      calls.push({ table, method: 'from' })
      const state: {
        eq: Array<[string, unknown]>
        in: Array<[string, unknown[]]>
        is: Array<[string, unknown]>
        order: [string, { ascending?: boolean }?] | null
        limit: number | null
      } = { eq: [], in: [], is: [], order: null, limit: null }

      const result = () => {
        let data = [...(seed[table] || [])]
        for (const [key, value] of state.eq) data = data.filter((row) => row?.[key] === value)
        for (const [key, values] of state.in) data = data.filter((row) => values.includes(row?.[key]))
        for (const [key, value] of state.is) data = data.filter((row) => row?.[key] === value)
        if (state.order) {
          const [key, opts] = state.order
          data.sort((a, b) => {
            const av = a?.[key]
            const bv = b?.[key]
            if (av === bv) return 0
            if (av == null) return 1
            if (bv == null) return -1
            return opts?.ascending === false ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv))
          })
        }
        if (state.limit != null) data = data.slice(0, state.limit)
        return { data, error: null }
      }

      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        eq: (key: string, value: unknown) => { state.eq.push([key, value]); return q },
        in: (key: string, values: unknown[]) => { state.in.push([key, values]); return q },
        is: (key: string, value: unknown) => { state.is.push([key, value]); return q },
        order: (key: string, opts?: { ascending?: boolean }) => { state.order = [key, opts]; return q },
        limit: (n: number) => { state.limit = n; return q },
        maybeSingle: () => Promise.resolve({ data: result().data[0] || null, error: null }),
        upsert: (row: unknown) => {
          ;(writes[table] ||= []).push(...(Array.isArray(row) ? row : [row]))
          return Promise.resolve({ data: row, error: null })
        },
        insert: (row: unknown) => {
          ;(writes[table] ||= []).push(...(Array.isArray(row) ? row : [row]))
          return Promise.resolve({ data: row, error: null })
        },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      }
      return q
    },
  }
  return db
}

const NOW = new Date('2026-06-16T12:00:00.000Z')
const FRESH = '2030-01-01T00:00:00.000Z'

Deno.test('D1 assembles a rich asset evidence pack from cached snapshot tables only', async () => {
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((...args: Parameters<typeof fetch>) => {
    fetchCalls += 1
    return originalFetch(...args)
  }) as typeof fetch
  try {
    const db = makeDb({
      market_assets: [{
        source_provider: 'coingecko',
        provider_id: 'solana',
        normalized_symbol: 'SOL',
        symbol: 'sol',
        name: 'Solana',
        primary_chain: 'solana',
        current_price: 150,
        market_cap: 80_000_000_000,
        volume_24h: 4_000_000_000,
        market_cap_rank: 5,
        platforms: { solana: 'So11111111111111111111111111111111111111112' },
        categories: ['smart-contract-platform'],
        as_of: '2026-06-16T11:45:00.000Z',
      }],
      exchange_latest_asset_profiles: [{
        normalized_symbol: 'SOL',
        display_name: 'Solana',
        chain: 'solana',
        best_global_provider: 'binance',
        best_global_pair: 'SOLUSDT',
        liquidity_score: 0.91,
        market_quality_score: 0.88,
        signal_direction: 'bullish',
        latest_price: 151,
        latest_volume_quote_24h: 4_100_000_000,
        caution_flags: [],
        as_of: '2026-06-16T11:55:00.000Z',
      }],
      exchange_latest_tickers: [{
        provider: 'binance',
        normalized_symbol: 'SOL',
        provider_symbol: 'SOLUSDT',
        price: 151,
        price_change_pct_24h: 3.1,
        price_change_pct_7d: 8.2,
        volume_quote_24h: 4_100_000_000,
        spread_pct: 0.02,
        as_of: '2026-06-16T11:55:00.000Z',
      }],
      exchange_latest_market_signals: [{
        normalized_symbol: 'SOL',
        direction: 'bullish',
        strength: 0.7,
        confidence: 0.82,
        provider_count: 4,
        summary: 'CEX momentum is improving.',
        why_it_matters: 'Volume confirms the move.',
        as_of: '2026-06-16T11:55:00.000Z',
      }],
      exchange_latest_market_caps: [{
        normalized_symbol: 'SOL',
        market_cap: 80_000_000_000,
        fdv: 92_000_000_000,
        circulating_supply: 530_000_000,
        market_cap_source: 'coingecko',
        as_of: '2026-06-16T11:55:00.000Z',
      }],
      exchange_latest_cross_market_spreads: [{
        normalized_symbol: 'SOL',
        gross_spread_pct: 0.04,
        estimated_net_spread_pct: 0.01,
        as_of: '2026-06-16T11:55:00.000Z',
      }],
      exchange_latest_orderbook: [{
        provider: 'binance',
        normalized_symbol: 'SOL',
        provider_symbol: 'SOLUSDT',
        bid_depth_usd: 2_000_000,
        ask_depth_usd: 1_900_000,
        spread_pct: 0.02,
        as_of: '2026-06-16T11:55:00.000Z',
      }],
      dex_pair_snapshots: [{
        chain: 'solana',
        token_address: 'So11111111111111111111111111111111111111112',
        pair_address: 'pair1',
        dex_id: 'raydium',
        symbol: 'SOL/USDC',
        price_usd: 150.9,
        liquidity_usd: 35_000_000,
        volume_24h: 400_000_000,
        socials: { x: 'solana' },
        links: { website: 'https://solana.com' },
        provider: 'dexscreener',
        fetched_at: '2026-06-16T11:50:00.000Z',
        stale_after: FRESH,
      }],
      pool_ohlcv_snapshots: [{
        chain: 'solana',
        token_address: 'So11111111111111111111111111111111111111112',
        pool_or_token_address: 'pool1',
        timeframe: '1h',
        candles: [{ t: 1, c: 150 }],
        provider: 'geckoterminal',
        fetched_at: '2026-06-16T11:50:00.000Z',
        stale_after: FRESH,
      }],
      token_metadata_snapshots: [{
        chain: 'solana',
        canonical_asset_key: 'solana:spl:So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        name: 'Solana',
        provider: 'alchemy',
        fetched_at: '2026-06-16T10:00:00.000Z',
        stale_after: FRESH,
      }],
      token_price_snapshots: [{
        chain: 'solana',
        canonical_asset_key: 'solana:spl:So11111111111111111111111111111111111111112',
        price_usd: 151,
        provider: 'alchemy',
        ts: '2026-06-16T11:45:00.000Z',
        stale_after: FRESH,
      }],
      asset_transfer_activity: [{
        org_id: 'org1',
        user_id: 'user1',
        canonical_asset_key: 'solana:spl:So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        chain: 'solana',
        amount: 100,
        usd_value: 15_000,
        direction: 'in',
        block_time: '2026-06-16T11:00:00.000Z',
        fetched_at: '2026-06-16T11:05:00.000Z',
        stale_after: FRESH,
      }],
      large_transfer_events: [{
        org_id: 'org1',
        user_id: 'user1',
        canonical_asset_key: 'solana:spl:So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        chain: 'solana',
        amount: 1000,
        usd_value: 151_000,
        threshold_usd: 100_000,
        direction: 'out',
        observed_at: '2026-06-16T10:40:00.000Z',
        fetched_at: '2026-06-16T10:45:00.000Z',
      }],
      protocol_tvl_snapshots: [{ chain: 'solana', protocol_slug: 'marinade', protocol_name: 'Marinade', tvl_usd: 1_000_000_000, provider: 'defillama', ts: '2026-06-16T10:00:00.000Z', stale_after: FRESH }],
      chain_tvl_snapshots: [{ chain: 'solana', tvl_usd: 9_000_000_000, provider: 'defillama', ts: '2026-06-16T10:00:00.000Z', stale_after: FRESH }],
      defi_pool_snapshots: [{ chain: 'solana', provider: 'defillama', pool_id: 'pool', project: 'orca', tvl_usd: 100_000_000, snapshot_at: '2026-06-16T10:00:00.000Z', stale_after: FRESH }],
      kamino_vault_snapshots: [{ org_id: null, vault_address: 'vault', tvl_usd: 10_000_000, apy: 0.05, snapshot_at: '2026-06-16T10:00:00.000Z', stale_after: FRESH }],
      kamino_market_snapshots: [{ org_id: null, market_address: 'market', reserve_address: 'reserve', supply_apy: 0.04, snapshot_at: '2026-06-16T10:00:00.000Z', stale_after: FRESH }],
      market_macro_snapshots: [{ provider: 'coingecko', total_market_cap_usd: 3_000_000_000_000, btc_dominance_pct: 52, as_of: '2026-06-16T10:00:00.000Z' }],
      market_ranking_snapshots: [{ provider: 'coingecko', normalized_symbol: 'SOL', rank: 5, price_usd: 151, market_cap_usd: 80_000_000_000, as_of: '2026-06-16T10:00:00.000Z' }],
      narrative_category_snapshots: [{ provider: 'coingecko', category_id: 'solana-ecosystem', category_label: 'Solana Ecosystem', rank: 4, top_3_coins: ['SOL'], as_of: '2026-06-16T10:00:00.000Z' }],
      intel_signal_state: [{ subject_type: 'asset', display_symbol: 'SOL', signal_key: 'asset:SOL', direction: 'bullish', confidence: 'high', source_count: 5, global_score: 0.8, generated_at: '2026-06-16T11:00:00.000Z', stale_after: FRESH }],
      intel_global_news: [{ entity_symbol: 'SOL', title: 'Solana network activity rises', source_name: 'Curated News', summary: 'Activity picked up.', published_at: '2026-06-16T09:00:00.000Z' }],
      intel_rollups: [{ id: 'roll1', subject_type: 'asset_price', subject_id: 'SOL', period_kind: 'month', period_start: '2026-06-01', period_end: '2026-07-01', source_count: 12, source_diversity: 3, important_events: [{ kind: 'provider_snapshot_rollup', metrics: { avg_metric: 150 } }], computed_at: '2026-06-16T11:00:00.000Z' }],
      intel_event_memory: [{ id: 'evt1', event_type: 'other', title: 'SOL liquidity regime changed', summary: 'SOL saw a material liquidity expansion.', occurred_at: '2026-06-15T10:00:00.000Z', importance_score: 88, assets: ['SOL'], chains: ['solana'], narratives: ['solana-ecosystem'], evidence_refs: [] }],
      historical_analog_links: [{ id: 'ana1', current_subject_ref: 'SOL', current_subject_type: 'asset', analog_subject_ref: 'SOL:prior-cycle', analog_subject_type: 'asset', analog_kind: 'asset_cycle', similarity_score: 0.72, basis: { shared: 'liquidity expansion' }, observed_at: '2026-06-15T11:00:00.000Z' }],
      intelligence_entity_timeline: [{ id: 'tl1', entity_type: 'asset', entity_ref: 'SOL', event_type: 'provider_snapshot_change', title: 'SOL snapshot trend persisted', summary: 'Month-to-date provider rollups kept improving.', impact_score: 0.8, confidence: 0.8, occurred_at: '2026-06-15T12:00:00.000Z' }],
      chain_capabilities: [{ chain: 'solana', capability: 'dex_market', status: 'live', verified_at: '2026-06-16T00:00:00.000Z' }],
    })

    const assembled = await assembleAssetEvidencePack(db, {
      symbol: 'SOL',
      providerId: 'solana',
      sourceProvider: 'coingecko',
      orgId: 'org1',
      userId: 'user1',
    }, {
      now: NOW,
      assembleContext: async () => ({
        policy: {
          surface_key: 'investor_intel',
          required_memory_classes: [],
          optional_memory_classes: [],
          forbidden_memory_classes: [],
          default_token_budget: 9000,
          ranking_weights: {},
          freshness_classes: [],
          allow_global_public: true,
          allow_global_derived: true,
          allow_scoped_private: false,
          allow_aggregated_learning: true,
          allow_execution_decision: false,
          derived_over_raw: true,
          restricted_license_policy: 'cite_only' as const,
        },
        blocks: [{
          memory_class: 'market_memory',
          visibility: 'global_derived',
          title: 'SOL narrative context',
          summary: 'Solana has improving market breadth.',
          payload: {},
          source_refs: [],
          entity_refs: ['market:coingecko:solana'],
          narrative_refs: [],
          freshness_class: 'hours',
          confidence: 0.8,
          rank_score: 5,
          created_at: '2026-06-16T11:00:00.000Z',
        }],
      }),
    })
    const persisted = await persistAssetEvidencePack(db, assembled, { orgId: 'org1', userId: 'user1' }, { now: NOW })
    const pack = persisted.pack as Record<string, any>
    assert(fetchCalls === 0, 'assembling evidence pack did not call fetch')
    assert(pack.asset?.symbol === 'SOL', 'asset symbol retained')
    assert(pack.flow_state?.status === 'available', 'scoped flow data included')
    assert(pack.dex_state?.status === 'available', 'DEX state included')
    assert(pack.news_state?.status === 'available', 'news state included')
    assert(pack.historical_context?.status === 'available', 'historical context included')
    assert(pack.historical_context?.trend_windows?.length === 1, 'rollup trend window included')
    assert(pack.data_coverage?.used_sources?.includes('intel_rollups'), 'historical rollups tracked as a source')
    assert((pack.data_coverage?.material_gaps || []).length === 0, 'rich pack has no material gaps')
    assert(pack.data_coverage?.used_sources?.includes('platform_intelligence_context'), 'selected AI context blocks are tracked as a source')
    assert(db.writes.intelligence_evidence_packs?.length === 1, 'evidence pack persisted')
    assert(db.writes.ai_context_packs?.length === 1, 'context pack persisted')
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  }
})

Deno.test('D1 degrades CEX-only assets with specific optional gaps', async () => {
  const db = makeDb({
    market_assets: [{ source_provider: 'coingecko', provider_id: 'bitcoin', normalized_symbol: 'BTC', symbol: 'btc', name: 'Bitcoin', current_price: 66000, market_cap: 1_300_000_000_000, as_of: '2026-06-16T11:55:00.000Z' }],
    exchange_latest_asset_profiles: [{ normalized_symbol: 'BTC', display_name: 'Bitcoin', liquidity_score: 0.95, latest_price: 66000, as_of: '2026-06-16T11:55:00.000Z' }],
    exchange_latest_tickers: [{ provider: 'coinbase', normalized_symbol: 'BTC', price: 66000, volume_quote_24h: 20_000_000_000, spread_pct: 0.01, as_of: '2026-06-16T11:55:00.000Z' }],
    exchange_latest_orderbook: [{ provider: 'coinbase', normalized_symbol: 'BTC', bid_depth_usd: 5_000_000, ask_depth_usd: 4_800_000, spread_pct: 0.01, as_of: '2026-06-16T11:55:00.000Z' }],
  })
  const result = await assembleAssetEvidencePack(db, { symbol: 'BTC' }, {
    now: NOW,
    assembleContext: async () => ({ policy: {} as any, blocks: [] }),
  })
  const coverage = result.dataCoverage
  assert(coverage.material_gaps.length === 0, 'CEX-only asset with price/liquidity does not get a generic warning')
  assert(coverage.optional_gaps.some((gap) => gap.includes('No cached DEX pair snapshot')), 'DEX absence is a specific optional gap')
  assert(coverage.optional_gaps.some((gap) => gap.includes('Wallet/whale flow data was not scoped')), 'flow absence is a specific optional gap')
  assert(coverage.optional_gaps.some((gap) => gap.includes('No recent curated news rows')), 'news absence is a specific optional gap')
  assert(coverage.should_show_warning === false, 'optional gaps do not force the material warning')
})

Deno.test('D1 reads a fresh evidence/context pack cache before assembling', async () => {
  const db = makeDb({
    market_assets: [{ source_provider: 'coingecko', provider_id: 'bitcoin', normalized_symbol: 'BTC', symbol: 'btc' }],
    intelligence_evidence_packs: [{
      org_id: null,
      user_id: null,
      subject_canonical_key: 'market:coingecko:bitcoin',
      window: 'current',
      content_hash: 'abc123',
      pack: { asset: { symbol: 'BTC' }, data_coverage: { material_gaps: [] } },
      data_coverage: { material_gaps: [], optional_gaps: [] },
      provider_coverage: {},
      source_provenance: {},
      confidence: 0.9,
      stale_after: FRESH,
      materiality: 'none',
    }],
    ai_context_packs: [{
      org_id: null,
      user_id: null,
      surface: 'investor_intel',
      scope_key: 'market:coingecko:bitcoin',
      content_hash: 'ctx123',
      blocks: [{ title: 'cached' }],
      policy: {},
      stale_after: FRESH,
    }],
  })
  const result = await getOrAssembleAssetEvidencePack(db, { symbol: 'BTC' }, { now: NOW })
  assert(result.cached === true, 'fresh pack cache hit returned')
  assert(result.contentHash === 'abc123', 'cached evidence hash preserved')
  assert(result.contextPack.content_hash === 'ctx123', 'cached context pack returned')
  assert(!db.writes.intelligence_evidence_packs, 'cache hit did not persist a new pack')
})

Deno.test('D2 critical-slice detector only flags market price liquidity gaps', () => {
  const slices = criticalSlicesForAssetEvidencePack({
    subject: { canonical_key: 'symbol:MISS', symbol: 'MISS', chain: null, token_address: null, provider_id: null, source_provider: null },
    pack: {
      market_summary: {},
      cex_state: { freshness: { status: 'missing' } },
      dex_state: { freshness: { status: 'missing' } },
      liquidity_state: {},
      data_coverage: {
        material_gaps: [
          'No cached market/profile snapshot matched MISS.',
          'No cached price snapshot matched MISS.',
          'No cached liquidity/depth snapshot matched MISS.',
        ],
      },
    },
    contentHash: 'hash',
    contextPack: { surface: 'investor_intel', scope_key: 'symbol:MISS', content_hash: 'ctx', blocks: [], policy: {}, stale_after: FRESH },
    dataCoverage: {
      used_sources: [],
      checked_sources: [],
      unavailable_sources: [],
      material_gaps: [],
      optional_gaps: ['No cached DEX pair snapshot matched MISS.'],
      confidence_impact: 'high',
      should_show_warning: true,
    },
    providerCoverage: {},
    sourceProvenance: {},
    confidence: 0.2,
    staleAfter: FRESH,
  })
  assert(slices.includes('market'), 'market gap flagged')
  assert(slices.includes('price'), 'price gap flagged')
  assert(slices.includes('liquidity'), 'liquidity gap flagged')
  assert(slices.length === 3, 'optional gaps do not add extra critical slices')
})
