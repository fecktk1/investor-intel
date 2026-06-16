import { assembleAssetMiniPack } from './asset-mini-pack.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

// deno-lint-ignore no-explicit-any
function makeDb(seed: Record<string, any[]> = {}) {
  const writes: Record<string, unknown[]> = {}
  const db = {
    writes,
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
        upsert: (row: unknown) => {
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

Deno.test('F1 asset mini pack compacts a cached evidence pack without provider fetches', async () => {
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
        provider_id: 'bitcoin',
        normalized_symbol: 'BTC',
        symbol: 'btc',
      }],
      intelligence_evidence_packs: [{
        org_id: null,
        user_id: null,
        subject_canonical_key: 'market:coingecko:bitcoin',
        window: 'current',
        content_hash: 'pack-hash',
        pack: {
          market_summary: { current_price: 66000, volume_24h: 20_000_000_000, market_cap: 1_300_000_000_000 },
          dex_state: { status: 'missing' },
          cex_state: {
            status: 'available',
            tickers: [{ provider: 'coinbase', price: 66000, spread_pct: 0.01, as_of: '2026-06-16T11:00:00.000Z' }],
          },
          liquidity_state: { cex_bid_depth_usd: 5_000_000, cex_ask_depth_usd: 4_800_000 },
          flow_state: { status: 'not_scoped', poll_cadence_note: 'Flow data is polling-cadence only.' },
          holder_state: { status: 'derived_only' },
          narrative_state: { status: 'missing' },
          news_state: { status: 'missing' },
          risk_state: { caution_flags: [] },
          data_coverage: {
            used_sources: ['exchange_latest_tickers'],
            checked_sources: ['exchange_latest_tickers', 'dex_pair_snapshots'],
            unavailable_sources: [],
            material_gaps: [],
            optional_gaps: ['No cached DEX pair snapshot matched BTC.'],
            confidence_impact: 'low',
            should_show_warning: false,
          },
        },
        data_coverage: {
          used_sources: ['exchange_latest_tickers'],
          checked_sources: ['exchange_latest_tickers', 'dex_pair_snapshots'],
          unavailable_sources: [],
          material_gaps: [],
          optional_gaps: ['No cached DEX pair snapshot matched BTC.'],
          confidence_impact: 'low',
          should_show_warning: false,
        },
        provider_coverage: {},
        source_provenance: { cex: { table: 'exchange_latest_tickers' } },
        confidence: 0.85,
        stale_after: '2030-01-01T00:00:00.000Z',
        materiality: 'none',
      }],
      ai_context_packs: [{
        org_id: null,
        user_id: null,
        surface: 'investor_intel',
        scope_key: 'market:coingecko:bitcoin',
        content_hash: 'ctx',
        blocks: [],
        policy: {},
        stale_after: '2030-01-01T00:00:00.000Z',
      }],
    })
    const mini = await assembleAssetMiniPack(db, { symbol: 'BTC' }, { now: new Date('2026-06-16T12:00:00.000Z') })
    assert(fetchCalls === 0, 'mini pack did not call fetch')
    assert(mini.content_hash === 'pack-hash', 'cached content hash is preserved')
    assert((mini.headlines.market as Record<string, unknown>).current_price === 66000, 'market headline included')
    assert((mini.headlines.cex as Record<string, unknown>).status === 'available', 'CEX headline included')
    assert(mini.coverage.optional_gaps.length === 1, 'coverage carried through')
    assert(!db.writes.intelligence_evidence_packs, 'fresh cache hit did not write a new full pack')
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  }
})
