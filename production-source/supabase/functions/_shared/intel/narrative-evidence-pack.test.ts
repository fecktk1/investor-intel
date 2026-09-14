import { assembleNarrativeEvidencePack } from './narrative-evidence-pack.ts'
import {assertEquals} from 'jsr:@std/assert'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

// deno-lint-ignore no-explicit-any
function makeDb(seed: Record<string, any[]> = {},failedTable?:string) {
  const db = {
    from(table: string) {
      table=({market_macro_available:'market_macro_snapshots',market_rankings_available:'market_ranking_snapshots'} as Record<string,string>)[table]??table
      const state: {
        eq: Array<[string, unknown]>
        is: Array<[string, unknown]>
        order: Array<[string, { ascending?: boolean; nullsFirst?: boolean }?]>
        limit: number | null
      } = { eq: [], is: [], order: [], limit: null }
      const result = () => {
        if(table===failedTable)return {data:null,error:{message:'synthetic read failure'}}
        let data = [...(seed[table] || [])]
        for (const [key, value] of state.eq) data = data.filter((row) => row?.[key] === value)
        for (const [key, value] of state.is) data = data.filter((row) => row?.[key] === value)
        for (const [key, opts] of [...state.order].reverse()) {
          data.sort((a, b) => {
            if(a?.[key]==null||b?.[key]==null){
              if(a?.[key]==null&&b?.[key]==null)return 0
              const nullFirst=opts?.nullsFirst??opts?.ascending===false
              return a?.[key]==null?(nullFirst?-1:1):(nullFirst?1:-1)
            }
            return opts?.ascending===false?String(b[key]).localeCompare(String(a[key])):String(a[key]).localeCompare(String(b[key]))
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
        order: (key: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => {
          state.order.push([key, opts])
          return q
        },
        limit: (n: number) => {
          state.limit = n
          return q
        },
        maybeSingle: () => {const r=result();return Promise.resolve({ data:r.data?.[0] || null, error:r.error })},
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
      narrative_assets: [{ narrative_id: narrativeId, asset_provider:'coingecko', asset_provider_id:'solana', normalized_symbol: 'SOL', weight: 1, is_leader: true }],
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
    assertEquals(pack.data_coverage.material_gaps.length,pack.member_assets.flatMap(member=>member.coverage.material_gaps).length,'member limitations remain visible even when narrative tables are populated')
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  }
})

Deno.test('narrative member evidence preserves exact provider identity instead of joining same tickers',async()=>{
 const calls:any[]=[],id='narrative',members=[{narrative_id:id,asset_provider:'coinmarketcap',asset_provider_id:'1',symbol:'SAME'},{narrative_id:id,asset_provider:'coinmarketcap',asset_provider_id:'2',symbol:'SAME'},{narrative_id:id,asset_provider:'coingecko',asset_provider_id:'separate',symbol:'SAME'},{narrative_id:id,asset_provider:'coinmarketcap',asset_provider_id:'1',symbol:'DUP'}]
 const db=makeDb({narrative_taxonomy:[{id,slug:'fixture'}],narrative_state:[{narrative_id:id,leaders:[{symbol:'UNLINKED'}]}],narrative_assets:members})
 const pack=await assembleNarrativeEvidencePack(db,'fixture',{assembleMiniPack:async(_db:any,subject:any,options:any)=>{calls.push({subject,options});return {subject:{canonical_key:(subject as any).canonicalKey},content_hash:'version'} as any}} as any)
 assertEquals(calls.map(c=>c.subject),[{canonicalKey:'market:coinmarketcap:1'},{canonicalKey:'market:coinmarketcap:2'},{canonicalKey:'market:coingecko:separate'}])
 assertEquals(calls.every(c=>c.options.allowLiveEnrichment===false),true)
 assertEquals((pack as any).membership_context.rows.length,4);assertEquals((pack as any).membership_context.duplicate_count,1)
 assertEquals(pack.leaders_laggards.leaders,[{symbol:'UNLINKED'}])
})
Deno.test('unresolved narrative labels stay in coverage without fetching a guessed asset',async()=>{
 let calls=0;const db=makeDb({narrative_taxonomy:[{id:'n',slug:'fixture'}],narrative_state:[{narrative_id:'n',leaders:[{symbol:'SAME'}]}],narrative_assets:[{narrative_id:'n',symbol:'SAME'},{narrative_id:'n',asset_provider:'coinmarketcap',asset_provider_id:'01'}]})
 const pack=await assembleNarrativeEvidencePack(db,'fixture',{assembleMiniPack:async()=>{calls++;throw Error('Should not guess identity')}} as any)
 assertEquals(calls,0);assertEquals((pack as any).membership_context.unresolved_count,2);assertEquals((pack as any).membership_context.rows.length,2)
 assertEquals(pack.data_coverage.should_show_warning,true)
})
Deno.test('narrative source failures remain explicit rather than successful empty evidence',async()=>{
 for(const source of ['narrative_assets','narrative_signals','narrative_category_snapshots']){
  const pack=await assembleNarrativeEvidencePack(makeDb({narrative_taxonomy:[{id:'n',slug:'fixture'}],narrative_state:[{narrative_id:'n'}]},source),'fixture')
  assertEquals((pack as any).source_states[source],'error');assertEquals(pack.data_coverage.unavailable_sources.includes(source),true);assertEquals(pack.data_coverage.should_show_warning,true)
 }
})

Deno.test('member gaps reach narrative coverage and ephemeral cache hits do not change the evidence version',async()=>{
 const db=makeDb({narrative_taxonomy:[{id:'n',slug:'fixture'}],narrative_state:[{narrative_id:'n'}],narrative_assets:[{narrative_id:'n',asset_provider:'coinmarketcap',asset_provider_id:'1'}]})
 const mini:any={subject:{canonical_key:'market:coinmarketcap:1'},content_hash:'original-member',coverage:{material_gaps:['Price source failed'],unavailable_sources:['price'],optional_gaps:[],should_show_warning:true,confidence_impact:'high'}}
 const first=await assembleNarrativeEvidencePack(db,'fixture',{assembleMiniPack:async()=>({...mini,cached:false})}),second=await assembleNarrativeEvidencePack(db,'fixture',{assembleMiniPack:async()=>({...mini,cached:true})})
 assertEquals(first.content_hash,second.content_hash)
 assert(first.data_coverage.material_gaps.some(s=>s.includes('market:coinmarketcap:1')&&s.includes('Price source failed')),'member gap retains exact subject')
 assert(first.data_coverage.unavailable_sources.some(s=>s.includes('price')),'member failure propagated')
})

Deno.test('newest dated narrative sources precede undated references under Postgres null ordering',async()=>{
 const latest={id:'dated',narrative_id:'n',provider:'curated',title:'Latest dated evidence',source_url:'https://example.com/primary',observed_at:'2026-09-12T07:00:00Z',fetched_at:'2026-09-12T07:05:00Z'}
 const db=makeDb({narrative_taxonomy:[{id:'n',slug:'fixture'}],narrative_state:[{narrative_id:'n'}],narrative_signals:[...Array.from({length:8},(_,i)=>({id:`undated-${i}`,narrative_id:'n',observed_at:null,fetched_at:'2026-09-12T07:06:00Z'})),latest]})
 const pack=await assembleNarrativeEvidencePack(db,'fixture')
 assertEquals(pack.narrative_signals[0],latest)
 assertEquals(pack.narrative_signals.length,8)
 assertEquals(pack.narrative_signals[1].observed_at,null)
})

Deno.test('provider-qualified Cosmos members retain cached quotes without metadata becoming an explicit contract request',async()=>{
 for(const [provider,id,platforms] of [['coingecko','akash-network',{akash:'uakt',osmosis:'ibc/ABC'}],['coinmarketcap','7431',{osmosis:'ibc/ABC'}]] as const){
  const db=makeDb({narrative_taxonomy:[{id:'n',slug:'fixture'}],narrative_state:[{narrative_id:'n'}],narrative_assets:[{id:'member',narrative_id:'n',asset_provider:provider,asset_provider_id:id}],market_assets:[{source_provider:provider,provider_id:id,symbol:'AKT',normalized_symbol:'AKT',current_price:0,change_24h_pct:0,as_of:'2026-09-12T07:00:00Z',platforms}]})
  const pack=await assembleNarrativeEvidencePack(db,'fixture',{now:new Date('2026-09-12T07:01:00Z')})
  assertEquals(pack.member_assets[0].subject.canonical_key,`market:${provider}:${id}`)
  const market=pack.member_assets[0].headlines.market as Record<string,any>
  assertEquals(market.current_price,0)
  assertEquals(market.field_evidence.current_price.source_table,'market_assets')
 }
})
