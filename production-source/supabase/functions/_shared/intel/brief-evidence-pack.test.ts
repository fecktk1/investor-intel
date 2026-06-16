import { assembleBriefEvidencePack } from './brief-evidence-pack.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

// deno-lint-ignore no-explicit-any
function makeDb(seed: Record<string, any[]> = {}, rpcSeed: Record<string, any> = {}) {
  const db = {
    rpc(name: string) {
      return Promise.resolve({ data: rpcSeed[name] ?? null, error: null })
    },
    from(table: string) {
      const state: {
        eq: Array<[string, unknown]>
        is: Array<[string, unknown]>
        order: [string, { ascending?: boolean }?] | null
        limit: number | null
      } = { eq: [], is: [], order: null, limit: null }
      const result = () => {
        let data = [...(seed[table] || [])]
        for (const [key, value] of state.eq) data = data.filter((row) => row?.[key] === value)
        for (const [key, value] of state.is) data = data.filter((row) => row?.[key] === value)
        if (state.order) {
          const [key, opts] = state.order
          data.sort((a, b) => opts?.ascending === false
            ? String(b?.[key] || '').localeCompare(String(a?.[key] || ''))
            : String(a?.[key] || '').localeCompare(String(b?.[key] || '')))
        }
        if (state.limit != null) data = data.slice(0, state.limit)
        return { data, error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          state.eq.push([key, value])
          return q
        },
        is: (key: string, value: unknown) => {
          state.is.push([key, value])
          return q
        },
        order: (key: string, opts?: { ascending?: boolean }) => {
          state.order = [key, opts]
          return q
        },
        limit: (n: number) => {
          state.limit = n
          return q
        },
        maybeSingle: () => Promise.resolve({ data: result().data[0] || null, error: null }),
        upsert: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      }
      return q
    },
  }
  return db
}

Deno.test('F2 brief evidence pack assembles cached macro protocol flow and watchlist mini-packs', async () => {
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((...args: Parameters<typeof fetch>) => {
    fetchCalls += 1
    return originalFetch(...args)
  }) as typeof fetch
  try {
    const db = makeDb({
      market_assets: [{ source_provider: 'coingecko', provider_id: 'solana', normalized_symbol: 'SOL', symbol: 'sol' }],
      intelligence_evidence_packs: [{
        org_id: null,
        user_id: null,
        subject_canonical_key: 'market:coingecko:solana',
        window: 'current',
        content_hash: 'sol-pack',
        pack: {
          market_summary: { current_price: 151, volume_24h: 4_000_000_000 },
          cex_state: { status: 'available', tickers: [{ provider: 'binance', price: 151 }] },
          dex_state: { status: 'available', best_pair: { dex_id: 'raydium', liquidity_usd: 35_000_000 } },
          liquidity_state: { dex_liquidity_usd: 35_000_000 },
          flow_state: { status: 'not_scoped' },
          holder_state: { status: 'derived_only' },
          narrative_state: { status: 'available' },
          news_state: { status: 'available' },
          risk_state: {},
          data_coverage: { used_sources: ['dex_pair_snapshots'], checked_sources: [], unavailable_sources: [], material_gaps: [], optional_gaps: [], confidence_impact: 'none', should_show_warning: false },
        },
        data_coverage: { used_sources: ['dex_pair_snapshots'], checked_sources: [], unavailable_sources: [], material_gaps: [], optional_gaps: [], confidence_impact: 'none', should_show_warning: false },
        provider_coverage: {},
        source_provenance: {},
        confidence: 0.9,
        stale_after: '2030-01-01T00:00:00.000Z',
      }],
      ai_context_packs: [{ org_id: null, user_id: null, surface: 'investor_intel', scope_key: 'market:coingecko:solana', content_hash: 'ctx', blocks: [], policy: {}, stale_after: '2030-01-01T00:00:00.000Z' }],
      market_macro_snapshots: [{ provider: 'coingecko', total_market_cap_usd: 3_000_000_000_000, btc_dominance_pct: 52, as_of: '2026-06-16T10:00:00Z' }],
      market_ranking_snapshots: [{ rank: 5, normalized_symbol: 'SOL', change_24h_pct: 4.1, as_of: '2026-06-16T10:00:00Z' }],
      narrative_category_snapshots: [{ category_id: 'solana-ecosystem', category_label: 'Solana Ecosystem', rank: 4, market_cap_change_24h_pct: 2.4, as_of: '2026-06-16T10:00:00Z' }],
      narrative_state: [{ slug: 'sol-defi', lifecycle_stage: 'heating_up', global_priority_score: 80 }],
      intel_curated_news: [{ should_surface: true, cleaned_title: 'SOL activity rises', final_score: 90 }],
      large_transfer_events: [{ org_id: 'org1', symbol: 'SOL', chain: 'solana', usd_value: 151_000, observed_at: '2026-06-16T09:00:00Z' }],
      protocol_tvl_snapshots: [{ protocol_slug: 'marinade', protocol_name: 'Marinade', chain: 'solana', tvl_usd: 1_000_000_000, ts: '2026-06-16T10:00:00Z' }],
      chain_tvl_snapshots: [{ chain: 'solana', tvl_usd: 9_000_000_000, ts: '2026-06-16T10:00:00Z' }],
    }, {
      intel_current_regime: { regime: 'risk_on', flavor: 'btc_led', confidence: 'medium' },
    })
    const pack = await assembleBriefEvidencePack(db, {
      orgId: 'org1',
      watchlistSymbols: ['SOL'],
      holdings: [{ symbol: 'SOL', value: 1000 }],
      now: new Date('2026-06-16T12:00:00.000Z'),
    })
    assert(fetchCalls === 0, 'brief evidence pack did not call fetch')
    assert(pack.market_regime?.regime === 'risk_on', 'regime included')
    assert(pack.watchlist_assets[0]?.subject.symbol === 'SOL', 'watchlist mini-pack included')
    assert(pack.protocol_chain_context.protocol_tvl[0].protocol_name === 'Marinade', 'protocol TVL included')
    assert(pack.flow_highlights[0].symbol === 'SOL', 'flow highlight included')
    assert(pack.data_coverage.material_gaps.length === 0, 'rich brief pack has no material gaps')
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  }
})
