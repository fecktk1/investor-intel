import { assembleNarrativeEvidencePack } from './narrative-evidence-pack.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

// deno-lint-ignore no-explicit-any
function makeDb(seed: Record<string, any[]> = {}) {
  const db = {
    from(table: string) {
      const state: {
        eq: Array<[string, unknown]>
        is: Array<[string, unknown]>
        order: Array<[string, { ascending?: boolean }?]>
        limit: number | null
      } = { eq: [], is: [], order: [], limit: null }
      const result = () => {
        let data = [...(seed[table] || [])]
        for (const [key, value] of state.eq) data = data.filter((row) => row?.[key] === value)
        for (const [key, value] of state.is) data = data.filter((row) => row?.[key] === value)
        for (const [key, opts] of [...state.order].reverse()) {
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
          state.order.push([key, opts])
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

Deno.test('F3 narrative evidence pack composes member mini-packs and narrative context cache-first', async () => {
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((...args: Parameters<typeof fetch>) => {
    fetchCalls += 1
    return originalFetch(...args)
  }) as typeof fetch
  try {
    const narrativeId = '11111111-1111-1111-1111-111111111111'
    const db = makeDb({
      narrative_taxonomy: [{ id: narrativeId, slug: 'sol-defi', name: 'Solana DeFi', status: 'active' }],
      narrative_state: [{
        narrative_id: narrativeId,
        lifecycle_stage: 'heating_up',
        signal_class: 'bullish',
        global_priority_score: 82,
        leaders: [{ symbol: 'SOL' }],
        laggards: [{ symbol: 'BONK' }],
        related_assets: [{ symbol: 'JUP' }],
      }],
      narrative_assets: [{ narrative_id: narrativeId, normalized_symbol: 'SOL', weight: 1, is_leader: true }],
      market_assets: [{ source_provider: 'coingecko', provider_id: 'solana', normalized_symbol: 'SOL', symbol: 'sol' }],
      intelligence_evidence_packs: [{
        org_id: null,
        user_id: null,
        subject_canonical_key: 'market:coingecko:solana',
        window: 'current',
        content_hash: 'sol-pack',
        pack: {
          market_summary: { current_price: 151 },
          cex_state: { status: 'available' },
          dex_state: { status: 'available' },
          liquidity_state: {},
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
      narrative_category_snapshots: [{ category_id: 'solana-ecosystem', category_label: 'Solana Ecosystem', rank: 4, as_of: '2026-06-16T10:00:00Z' }],
      market_macro_snapshots: [{ provider: 'coingecko', total_market_cap_usd: 3_000_000_000_000, as_of: '2026-06-16T10:00:00Z' }],
      narrative_signals: [{ narrative_id: narrativeId, signal_kind: 'news', provider: 'curated', title: 'Solana DeFi TVL rises', observed_at: '2026-06-16T09:00:00Z' }],
    })
    const pack = await assembleNarrativeEvidencePack(db, 'sol-defi', { now: new Date('2026-06-16T12:00:00.000Z') })
    assert(fetchCalls === 0, 'narrative pack did not call fetch')
    assert(pack.slug === 'sol-defi', 'slug retained')
    assert(pack.member_assets[0]?.subject.symbol === 'SOL', 'member asset mini-pack included')
    assert(pack.category_rotation[0].category_id === 'solana-ecosystem', 'category rotation included')
    assert(pack.narrative_signals[0].title === 'Solana DeFi TVL rises', 'narrative signals included')
    assert(pack.data_coverage.material_gaps.length === 0, 'rich narrative pack has no material gaps')
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  }
})
