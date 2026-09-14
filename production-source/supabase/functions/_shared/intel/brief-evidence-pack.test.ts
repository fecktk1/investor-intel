import { assembleBriefEvidencePack } from './brief-evidence-pack.ts'
import { loadPrivateBriefContext } from './private-brief-context.ts'

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
      table=({market_macro_available:'market_macro_snapshots',market_rankings_available:'market_ranking_snapshots'} as Record<string,string>)[table]??table
      const state: {
        eq: Array<[string, unknown]>
        is: Array<[string, unknown]>
        gt: Array<[string, any]>
        gte: Array<[string, any]>
        lte: Array<[string, any]>
        order: Array<[string, { ascending?: boolean }?]>
        limit: number | null
      } = { eq: [], is: [], gt: [], gte:[], lte:[], order: [], limit: null }
      const result = () => {
        let data = [...(seed[table] || [])]
        for (const [key, value] of state.eq) data = data.filter((row) => key.split('.').reduce((v, part) => v?.[part], row) === value)
        for (const [key, value] of state.is) data = data.filter((row) => row?.[key] === value)
        for(const [key,value] of state.gt) data=data.filter(row=>row[key]!=null && row[key]>value)
        for(const [key,value] of state.gte) data=data.filter(row=>row[key]!=null && row[key]>=value)
        for(const [key,value] of state.lte) data=data.filter(row=>row[key]!=null && row[key]<=value)
        data.sort((a,b)=>{for(const [key,opts] of state.order){const v=String(a[key]??'').localeCompare(String(b[key]??''));if(v)return opts?.ascending===false?-v:v}return 0})
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
        gte: (key:string,value:any)=>{state.gte.push([key,value]);return q},
        lte: (key:string,value:any)=>{state.lte.push([key,value]);return q},
        gt: (key: string, value: any) => {state.gt.push([key,value]);return q},
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

Deno.test('brief source read failures remain unavailable, distinct from successful empty results', async () => {
  const db = makeDb(), originalFrom = db.from
  db.from = (table: string) => {
    if (table !== 'market_macro_available') return originalFrom(table)
    const q: any = { select: () => q, order: () => q, limit: () => q,
      then: (resolve: any) => Promise.resolve({ data: null, error: { message: 'private upstream detail' } }).then(resolve) }
    return q
  }
  const failed = await assembleBriefEvidencePack(db, { orgId: 'org', userId: 'me' })
  const empty = await assembleBriefEvidencePack(makeDb(), { orgId: 'org', userId: 'me' })
  assert(failed.data_coverage.unavailable_sources.includes('market_macro_snapshots'), 'failed macro source must be named unavailable')
  assert(!empty.data_coverage.unavailable_sources.includes('market_macro_snapshots'), 'successful empty result is not a read failure')
  assert(!JSON.stringify(failed).includes('private upstream detail'), 'raw upstream error is not copied into the pack')
  assert(!failed.data_coverage.optional_gaps.some(s => s.includes('No cached market macro')), 'failure cannot be described as no cached snapshot')
})

Deno.test('brief independent shared reads start before the private portfolio selection resolves', async () => {
  const db = makeDb(), originalFrom = db.from, started: string[] = []
  let finish: any
  db.from = (table: string) => {
    started.push(table)
    if (table !== 'investor_portfolios') return originalFrom(table)
    const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => q,
      maybeSingle: () => new Promise(resolve => { finish = resolve }) }
    return q
  }
  const pending = assembleBriefEvidencePack(db, { orgId: 'org', userId: 'me' })
  await Promise.resolve()
  const sharedStarted = started.includes('market_macro_available')
  finish({data:null,error:null})
  await pending
  assert(sharedStarted, 'independent shared reads must not wait behind private portfolio selection')
})

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
        pack: { identity_version: 3,
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
      intel_curated_news: [{ should_surface: true, cleaned_title: 'SOL activity rises', final_score: 90,published_at:'2026-06-16T11:00:00Z',stale_after:'2026-06-17T11:00:00Z' }],
      large_transfer_events: [{ org_id: 'org1', user_id: 'user1', symbol: 'SOL', chain: 'solana', usd_value: 151_000, observed_at: '2026-06-16T09:00:00Z' }],
      protocol_tvl_snapshots: [{ protocol_slug: 'marinade', protocol_name: 'Marinade', chain: 'solana', tvl_usd: 1_000_000_000, ts: '2026-06-16T10:00:00Z' }],
      chain_tvl_snapshots: [{ chain: 'solana', tvl_usd: 9_000_000_000, ts: '2026-06-16T10:00:00Z' }],
    }, {
      intel_current_regime: { regime: 'risk_on', flavor: 'btc_led', confidence: 'medium' },
    })
    const pack = await assembleBriefEvidencePack(db, {
      orgId: 'org1', userId: 'user1',
      watchlistSymbols: ['SOL'],
      holdings: [{ symbol: 'SOL', value: 1000 }],
      now: new Date('2026-06-16T12:00:00.000Z'),
    })
    assert(fetchCalls === 0, 'brief evidence pack did not call fetch')
    assert(pack.market_regime?.regime === 'risk_on', 'regime included')
    assert(pack.watchlist_assets[0]?.subject.symbol === 'SOL', 'watchlist mini-pack included')
    assert(pack.protocol_chain_context.protocol_tvl[0].protocol_name === 'Marinade', 'protocol TVL included')
    assert(pack.flow_highlights[0].symbol === 'SOL', 'flow highlight included')
    assert(pack.news_that_matters[0]?.cleaned_title==='SOL activity rises','dated current news reaches the assembled pack')
    assert(pack.data_coverage.material_gaps.length === 0, 'rich brief pack has no material gaps')
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  }
})

Deno.test('private brief context excludes another member and mismatched parents', async () => {
  const db = makeDb({
    watchlist_items: [
      { id: 'w1', org_id: 'org', watchlist: { org_id: 'org', user_id: 'me' }, entity: { display_symbol: 'OWN' } },
      { id: 'w2', org_id: 'org', watchlist: { org_id: 'org', user_id: 'other' }, entity: { display_symbol: 'OTHER' } },
    ],
    investor_portfolios: [{id:'p1',org_id:'org',user_id:'me',name:'Owned',is_default:true}],
    investor_portfolio_holdings: [
      { portfolio_id:'p1',quantity:1,is_closed:false, id: 'h1', org_id: 'org', user_id: 'me', portfolio: { org_id: 'org', user_id: 'me' }, asset_symbol: 'OWN', current_value: 10 },
      { portfolio_id:'p1',quantity:1,is_closed:false, id: 'h2', org_id: 'org', user_id: 'other', portfolio: { org_id: 'org', user_id: 'other' }, asset_symbol: 'OTHER', current_value: 20 },
      { portfolio_id:'p1',quantity:1,is_closed:false, id: 'h3', org_id: 'org', user_id: 'me', portfolio: { org_id: 'org', user_id: 'other' }, asset_symbol: 'BADPARENT', current_value: 30 },
    ],
    large_transfer_events: [{ org_id: 'org', user_id: 'me', symbol: 'OWN' }, { org_id: 'org', user_id: 'other', symbol: 'OTHER' }],
  })
  const result = await loadPrivateBriefContext(db, 'org', 'me')
  assert(result.holdings.length === 1 && result.holdings[0].symbol === 'OWN', 'only current user and parent-owned holdings included')
  assert(result.watchlistSymbols.join() === 'OWN', 'watchlists use parent owner identity')
  assert(result.flowHighlights.length === 1 && result.flowHighlights[0].symbol === 'OWN', 'flows stay own-user scoped')
})

Deno.test('private context requires identity and propagates cache errors', async () => {
  let missing = false, failed = false
  try { await loadPrivateBriefContext(makeDb(), 'org', '') } catch { missing = true }
  const q = { select: () => q, eq: () => q, order: () => q, limit: () => Promise.resolve({ error: new Error('missing cache') }) }
  try { await loadPrivateBriefContext({ from: () => q }, 'org', 'me') } catch { failed = true }
  assert(missing && failed, 'no false empty success for missing identity or errors')
})

Deno.test('brief evidence hash ignores assembly wall clock and honors user identity', async () => {
  const db = makeDb()
  const a = await assembleBriefEvidencePack(db, { orgId: 'org', userId: 'me', now: new Date('2026-09-09T12:00:00Z') })
  const b = await assembleBriefEvidencePack(db, { orgId: 'org', userId: 'me', now: new Date('2026-09-09T12:01:00Z') })
  const c = await assembleBriefEvidencePack(db, { orgId: 'org', userId: 'other', now: new Date('2026-09-09T12:00:00Z') })
  assert(a.content_hash === b.content_hash, 'unchanged evidence reuses despite later read time')
  assert(a.content_hash !== c.content_hash, 'users cannot share private fingerprints')
})

Deno.test('brief context selects one owned portfolio and excludes closed, zero and foreign positions', async () => {
  const parent = {org_id:'org',user_id:'me'}
  const seed = {
    investor_portfolios:[{id:'first',org_id:'org',user_id:'me',is_default:false,created_at:'2020'}, {id:'default',org_id:'org',user_id:'me',is_default:true,created_at:'2021'}, {id:'foreign',org_id:'org',user_id:'other',is_default:true}],
    investor_portfolio_holdings:[
      {id:'a',org_id:'org',user_id:'me',portfolio_id:'first',portfolio:parent,quantity:1,is_closed:false,canonical_asset_key:'eip155:1:native',asset_symbol:'ETH'},
      {id:'b',org_id:'org',user_id:'me',portfolio_id:'default',portfolio:parent,quantity:2,is_closed:false,canonical_asset_key:'solana:native:SOL',asset_symbol:'SOL'},
      {id:'c',org_id:'org',user_id:'me',portfolio_id:'default',portfolio:parent,quantity:4,is_closed:true,asset_symbol:'CLOSED'},
      {id:'d',org_id:'org',user_id:'me',portfolio_id:'default',portfolio:parent,quantity:0,is_closed:false,asset_symbol:'ZERO'},
    ],
  }
  const standard = await loadPrivateBriefContext(makeDb(seed),'org','me')
  assert(standard.portfolio?.id==='default' && standard.holdings.length===1 && standard.holdings[0].canonicalKey==='solana:native:SOL','default only, with canonical identity')
  const explicit = await loadPrivateBriefContext(makeDb(seed),'org','me','first')
  assert(explicit.portfolio?.id==='first' && explicit.holdings.length===1 && explicit.holdings[0].symbol==='ETH','explicit owned selection wins')
  let denied=false;try{await loadPrivateBriefContext(makeDb(seed),'org','me','foreign')}catch{denied=true}
  assert(denied,'foreign portfolio cannot silently fall back')
})

Deno.test('brief context bounds live holdings and reports truncation', async () => {
  const db=makeDb({investor_portfolios:[{id:'p',org_id:'org',user_id:'me'}],investor_portfolio_holdings:Array.from({length:205},(_,i)=>({id:String(i),org_id:'org',user_id:'me',portfolio_id:'p',portfolio:{org_id:'org',user_id:'me'},quantity:1,is_closed:false,asset_symbol:'T'+i}))})
  const result=await loadPrivateBriefContext(db,'org','me')
  assert(result.holdings.length===200 && result.coverage.holdings_truncated,'bounded context never silently claims full coverage')
})
