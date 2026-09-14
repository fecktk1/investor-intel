import {
  assembleAssetEvidencePack,
  criticalSlicesForAssetEvidencePack,
  getOrAssembleAssetEvidencePack,
  persistAssetEvidencePack,
  compactAssetEvidencePackForPrompt,
} from './asset-evidence-pack.ts'
import { evaluateThesis } from './thesis-monitor.ts'

Deno.test('fresh exact catalog evidence wins over an older pair quote for narrative and asset research',async()=>{
 const address='0x'+'a'.repeat(40),observed=NOW.toISOString(),old=new Date(NOW.getTime()-5*86400000).toISOString()
 const db=makeDb({market_assets:[{source_provider:'coingecko',provider_id:'render-token',normalized_symbol:'RENDER',primary_chain:'ethereum',platforms:{ethereum:address},current_price:1.4,volume_24h:0,market_cap:100,fdv:120,change_24h_pct:2.7,as_of:observed,last_refreshed_at:observed}],dex_pair_snapshots:[{chain:'ethereum',token_address:address,price_usd:1.55,volume_24h:200,market_cap:99,fdv:110,fetched_at:old,stale_after:old}]})
 const result=await assembleAssetEvidencePack(db,{canonicalKey:'market:coingecko:render-token'},{now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})}),m=result.pack.market_summary as any
 assert(m.current_price===1.4,'fresh catalog price must not be replaced by the five-day-old venue price')
 assert(m.volume_24h===0,'real zero aggregate volume must not fall through to pair volume')
 assert(m.market_cap===100&&m.fdv===120,'aggregate valuation stays with its source')
 assert(m.field_evidence.current_price.source_table==='market_assets'&&m.field_evidence.current_price.as_of===observed,'chosen source clock remains exact')
 assert((result.pack.dex_state as any).best_pair.price_usd===1.55,'original venue quote remains available in its own context')
})

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

Deno.test('chain protocol context retains zero and source clocks without implying token fundamentals',async()=>{
 const key='eip155:8453:0x'+'a'.repeat(40),clock=NOW.toISOString()
 const db=makeDb({protocol_tvl_snapshots:[{chain:'base',protocol_slug:'unrelated',protocol_name:'Different protocol',tvl_usd:0,ts:clock,provider:'defillama'},{chain:'ethereum',protocol_slug:'other-chain',tvl_usd:99,ts:clock}],defi_pool_snapshots:[{chain:'base',pool_id:'unrelated-pool',tvl_usd:5,snapshot_at:clock,provider:'defillama'}]})
 const result=await assembleAssetEvidencePack(db,{canonicalKey:key},{now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})}),protocol=result.pack.protocol_state as any
 assert(protocol.scope==='chain_context'&&protocol.asset_specific===false&&protocol.context_chain==='base','context cannot claim a selected token relationship')
 assert(protocol.protocol_tvl.length===1&&protocol.protocol_tvl[0].tvl_usd===0&&protocol.protocol_tvl[0].ts===clock,'zero and original clock survive while another chain is excluded')
 assert(protocol.protocol_tvl[0].scope==='chain_context'&&protocol.defi_pools[0].asset_specific===false,'each extracted row carries scope')
 const prompt=compactAssetEvidencePackForPrompt(result,1000000) as any
 assert(prompt.pack.protocol_state.asset_specific===false,'general research retains the qualification')
})
Deno.test('protocol read failure is an error with unknown coverage instead of an empty successful context',async()=>{
 const db=makeDb(),original=db.from.bind(db)
 db.from=(table:string)=>{if(table!=='protocol_tvl_snapshots')return original(table);const q:any={select:()=>q,eq:()=>q,order:()=>q,limit:()=>Promise.resolve({data:null,error:{message:'database offline'}})};return q}
 const result=await assembleAssetEvidencePack(db,{canonicalKey:'eip155:8453:0x'+'a'.repeat(40)},{now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})})
 const protocol=result.pack.protocol_state as any
 assert(protocol.status==='error'&&protocol.failed_sources.includes('protocol_tvl_snapshots'),'failed read is explicit')
 assert(result.dataCoverage.optional_gaps.some(g=>g.includes('could not be read')),'coverage identifies the failure')
 assert(!result.dataCoverage.optional_gaps.some(g=>g.startsWith('No cached protocol/DeFi')),'failure is not evidence of absence')
})

Deno.test('explicit token identity cannot borrow native market, CEX, news or private flows by ticker', async () => {
  const address = '0x' + 'a'.repeat(40), key = `eip155:8453:${address}`
  const db = makeDb({
    market_assets: [{source_provider:'coingecko',provider_id:'ethereum',normalized_symbol:'ETH',current_price:2500,market_cap:1e12}],
    exchange_latest_asset_profiles: [{normalized_symbol:'ETH',latest_price:2500}],
    exchange_latest_tickers: [{normalized_symbol:'ETH',price:2500}],
    intel_global_news: [{entity_symbol:'ETH',title:'Native Ethereum story'}],
    large_transfer_events: [{org_id:'org',user_id:'me',canonical_asset_key:'eip155:1:native',symbol:'ETH',usd_value:999}],
    dex_pair_snapshots: [{chain:'base',token_address:address,price_usd:0.25,liquidity_usd:5000}],
  })
  const result = await assembleAssetEvidencePack(db,{canonicalKey:key,symbol:'ETH',orgId:'org',userId:'me'},
    {now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})})
  const pack = result.pack as any
  assert(result.subject.token_address===address && result.subject.chain==='base','canonical contract is resolved')
  assert(pack.market_summary.current_price===0.25 && pack.market_summary.market_cap==null,'only contract-matched DEX values')
  assert(pack.cex_state.tickers.length===0 && pack.news_state.stories.length===0,'ticker context does not leak across assets')
  assert(pack.flow_state.large_transfers.length===0,'same-symbol flow on another network excluded')
})

Deno.test('an ambiguous symbol stays unresolved and legacy identity caches are rebuilt', async () => {
  const db = makeDb({market_assets:[
    {source_provider:'coingecko',provider_id:'first',normalized_symbol:'DUP',current_price:99},
    {source_provider:'coingecko',provider_id:'second',normalized_symbol:'DUP',current_price:1},
  ],intelligence_evidence_packs:[{org_id:null,user_id:null,subject_canonical_key:'symbol:DUP',window:'current',stale_after:FRESH,pack:{market_summary:{current_price:99}}}]})
  const result = await getOrAssembleAssetEvidencePack(db,{symbol:'DUP'},{now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})})
  assert(!result.cached && (result.pack.market_summary as any).current_price==null,'ambiguous legacy cache is never reused')
})
Deno.test('a previous slash-contract cache cannot retain a borrowed native quote after identity normalization',async()=>{
 const address='0x'+'a'.repeat(40),canonicalKey=`eip155:8453/erc20:${address}`
 const db=makeDb({intelligence_evidence_packs:[{org_id:null,user_id:null,subject_canonical_key:canonicalKey,window:'current',stale_after:FRESH,
  pack:{identity_version:2,coverage_version:1,retained_quote_version:1,market_summary:{current_price:2500}}}],
  dex_pair_snapshots:[{chain:'base',token_address:address,price_usd:0.25,liquidity_usd:5000}]})
 const result=await getOrAssembleAssetEvidencePack(db,{canonicalKey,symbol:'ETH',sourceProvider:'coingecko',providerId:'ethereum'},
  {now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})})
 assert(!result.cached,'older identity caches are rebuilt')
 assert(result.subject.token_address===address,'recorded contract identity is retained')
 assert((result.pack.market_summary as any).current_price===0.25,'only exact contract quote is used')
 assert(result.pack.identity_version===3,'replacement pack uses the corrected identity contract')
})
Deno.test('an unregistered explicit network cannot fall back to an unrelated provider hint',async()=>{
 const db=makeDb({market_assets:[{source_provider:'coingecko',provider_id:'ethereum',normalized_symbol:'ETH',current_price:2500,market_cap:1e12}]})
 const result=await assembleAssetEvidencePack(db,{canonicalKey:'eip155:999999/erc20:0x'+'a'.repeat(40),symbol:'ETH',sourceProvider:'coingecko',providerId:'ethereum'},
  {now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})})
 assert((result.pack.market_summary as any).current_price==null,'unknown network does not inherit native market price')
 assert(result.subject.provider_id==null,'unverified hint is not retained as the resolved provider identity')
})
Deno.test('an off-catalogue CMC comparison receives its retained price and expires with that evidence',async()=>{
 const subject='market:coinmarketcap:42019',record={id:'cmc:quote',subject,metric:'price',value:0.003,unit:'USD',provider:'coinmarketcap',sourceRef:'coinmarketcap:/v3/cryptocurrency/quotes/latest:{"id":"42019"}',observedAt:new Date(NOW.getTime()-2000).toISOString(),recordedAt:new Date(NOW.getTime()-1000).toISOString(),expiresAt:new Date(NOW.getTime()+30000).toISOString(),aiAllowed:true}
 const db=makeDb(),original=db.from.bind(db)
 db.from=(table:string)=>{if(table!=='intel_market_observations')return original(table);const q:any={};for(const method of ['select','eq','like','or','gte','lte','gt','order'])q[method]=()=>q;q.limit=()=>Promise.resolve({data:[{observation:record}]});return q}
 const result=await assembleAssetEvidencePack(db,{canonicalKey:subject,symbol:'HOODRAT'},{now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})})
 const summary=result.pack.market_summary as any
 assert(summary.current_price===0.003,'retained price is available without a catalogue row')
 assert(summary.freshness.as_of===record.observedAt&&summary.freshness.recorded_at===record.recordedAt,'original quote clocks retained')
 assert(result.staleAfter===record.expiresAt,'pack cannot outlive its quote')
 assert(result.dataCoverage.used_sources.includes('intel_market_observations'),'actual cache source attributed')
 assert(!result.dataCoverage.material_gaps.some(g=>g.includes('No cached price')),'available price is not called missing')
 assert(result.dataCoverage.material_gaps.some(g=>g.includes('liquidity/depth')),'quote does not invent execution depth')
})

// deno-lint-ignore no-explicit-any
function makeDb(seed: Record<string, any[]> = {}) {
  const writes: Record<string, unknown[]> = {}
  const calls: Array<{ table: string; method: string }> = []
  const db = {
    writes,
    calls,
    from(table: string) {
      table=({market_macro_available:'market_macro_snapshots',market_rankings_available:'market_ranking_snapshots'} as Record<string,string>)[table]??table
      calls.push({ table, method: 'from' })
      const state: {
        eq: Array<[string, unknown]>
        gte: Array<[string, string]>
        lte: Array<[string, string]>
        in: Array<[string, unknown[]]>
        is: Array<[string, unknown]>
        contains: Array<[string, unknown[]]>
        or: string | null
        order: [string, { ascending?: boolean }?] | null
        limit: number | null
      } = { eq: [], gte: [], lte: [], in: [], is: [], contains: [], or: null, order: null, limit: null }

      const result = () => {
        let data = [...(seed[table] || [])]
        for (const [key, value] of state.eq) data = data.filter((row) => row?.[key] === value)
        for (const [key, value] of state.gte) data = data.filter((row) => row?.[key] != null && row[key] >= value)
        for (const [key, value] of state.lte) data = data.filter((row) => row?.[key] != null && row[key] <= value)
        for (const [key, values] of state.in) data = data.filter((row) => values.includes(row?.[key]))
        for (const [key, value] of state.is) data = data.filter((row) => row?.[key] === value)
        for (const [key, arr] of state.contains) data = data.filter((row) => Array.isArray(row?.[key]) && arr.every((v) => row[key].includes(v)))
        if (state.or) {
          const terms = String(state.or).split(',').map((s) => s.trim()).filter(Boolean)
          data = data.filter((row) => terms.some((term) => {
            const m = term.match(/^([\w]+)\.cs\.\{(.+)\}$/)
            if (!m) return false
            const [, field, val] = m
            return Array.isArray(row?.[field]) && row[field].includes(val)
          }))
        }
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
        gte: (key: string, value: string) => { state.gte.push([key, value]); return q },
        gt: () => q,
        like: () => q,
        lte: (key: string, value: string) => { state.lte.push([key, value]); return q },
        in: (key: string, values: unknown[]) => { state.in.push([key, values]); return q },
        is: (key: string, value: unknown) => { state.is.push([key, value]); return q },
        contains: (key: string, values: unknown[]) => { state.contains.push([key, values]); return q },
        or: (expr: string) => { state.or = expr; return q },
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

Deno.test('asset research distinguishes an unavailable retained history read from empty coverage',async()=>{
 const db=makeDb(),original=db.from.bind(db)
 db.from=(table:string)=>{
  if(table!=='market_macro_available')return original(table)
  const q:any={select:()=>q,order:()=>q,limit:()=>Promise.resolve({data:null,error:{message:'private upstream detail'}})};return q
 }
 const result=await assembleAssetEvidencePack(db,{canonicalKey:'market:coingecko:bitcoin'},{now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})})
 assert(result.dataCoverage.material_gaps.some(g=>g.includes('Market history could not be read')),'read failure remains explicit')
 assert(!JSON.stringify(result).includes('private upstream detail'),'upstream detail is not copied')
})

Deno.test('asset research ranks use the resolved provider ID, never a competing asset with the same ticker',async()=>{
 const db=makeDb({market_assets:[{source_provider:'coingecko',provider_id:'asset-one',symbol:'DUP',normalized_symbol:'DUP',current_price:1}],market_ranking_snapshots:[
  {provider:'coinmarketcap',provider_id:'999',normalized_symbol:'DUP',rank:1,as_of:NOW.toISOString()},
  {provider:'coingecko',provider_id:'asset-two',normalized_symbol:'DUP',rank:2,as_of:NOW.toISOString()},
  {provider:'coingecko',provider_id:'asset-one',normalized_symbol:'DUP',rank:7,as_of:NOW.toISOString()},
 ]})
 const result=await assembleAssetEvidencePack(db,{canonicalKey:'market:coingecko:asset-one'},{now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})})
 const body=JSON.stringify(result.pack)
 assert(body.includes('asset-one'),'exact identity retained')
 assert(!body.includes('asset-two')&&!body.includes('"provider_id":"999"'),'unrelated same-symbol ranks excluded')
})

Deno.test('a verified exact contract receives its CMC catalog and retained quote without a ticker join',async()=>{
 const address='0x'+'a'.repeat(40),key='eip155:1/erc20:'+address
 const db:any=makeDb({market_assets:[{source_provider:'coinmarketcap',provider_id:'4705',symbol:'PAXG',normalized_symbol:'PAXG',name:'PAX Gold',platforms:{ethereum:address},current_price:12}]})
 db.rpc=(name:string)=>Promise.resolve({data:name==='intel_cmc_contract_chart_identity'?[{provider_id:'4705',name:'PAX Gold'}]:[],error:null})
 const original=db.from.bind(db),record={id:'cmc:exact-price',subject:'market:coinmarketcap:4705',metric:'price',value:0,unit:'USD',provider:'coinmarketcap',sourceRef:'coinmarketcap:/v3/cryptocurrency/quotes/latest:{"id":"4705"}',observedAt:NOW.toISOString(),recordedAt:NOW.toISOString(),expiresAt:FRESH,aiAllowed:true}
 db.from=(table:string)=>{if(table!=='intel_market_observations')return original(table);const q:any={};for(const method of ['select','eq','in','or','gte','lte','gt','order'])q[method]=()=>q;q.limit=()=>Promise.resolve({data:[{observation:record}]});return q}
 const result=await assembleAssetEvidencePack(db,{canonicalKey:key,symbol:'UNKNOWN'},{now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})})
 assert(result.subject.provider_id==='4705'&&result.subject.symbol==='PAXG','fresh exact contract registry supplies provider identity')
 assert((result.pack.market_summary as any).current_price===0,'actual retained zero quote supersedes the older catalog price')
 assert((result.pack.market_summary as any).retained_observations[0].id===record.id,'original market source record retained')
 assert(result.subject.canonical_key===key,'original canonical research scope is preserved')
})

Deno.test('P4 frozen research retains exact venue quantities including zero and surfaces failed depth reads',async()=>{
 const seed={market_assets:[{source_provider:'coingecko',provider_id:'bitcoin',normalized_symbol:'BTC'}],exchange_latest_tickers:[{normalized_symbol:'BTC',provider:'venue',provider_symbol:'BTC-USD',quote_asset:'USD',as_of:NOW.toISOString()}],exchange_latest_orderbook:[{normalized_symbol:'BTC',provider:'venue',provider_symbol:'BTC-USD',as_of:NOW.toISOString(),bid_price:10,ask_price:11,bid_qty:0,ask_qty:2}]}
 const opts={now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})}
 const ok=await assembleAssetEvidencePack(makeDb(seed),{canonicalKey:'native:bitcoin'},opts)
 const depth=(ok.pack.liquidity_state as any).venue_depth
 assert(depth.quotes.find((q:any)=>q.side==='sell').levels[0].quantity===0,'zero best-level quantity retained')
 assert((compactAssetEvidencePackForPrompt(ok) as any).pack.liquidity_state.venue_depth.quotes.length===2,'research receives the same two source records')
 const db=makeDb(seed),original=db.from.bind(db)
 db.from=(table:string)=>{const q=original(table);if(table==='exchange_latest_orderbook')q.then=(resolve:any)=>Promise.resolve({data:null,error:{message:'denied'}}).then(resolve);return q}
 const failed=await assembleAssetEvidencePack(db,{canonicalKey:'native:bitcoin'},opts)
 assert((failed.pack.liquidity_state as any).venue_depth.status==='error','failed read is explicit')
 assert((failed.pack.liquidity_state as any).venue_depth.quotes.length===0,'failure cannot produce a quote')
})

Deno.test('Phase 1 page context, research prompt and authorized alert evaluation consume the same saved evidence version', async () => {
  const key = 'market:coingecko:bitcoin', version = 'phase1-version-1'
  const db = makeDb({
    market_assets: [{ source_provider: 'coingecko', provider_id: 'bitcoin', normalized_symbol: 'BTC' }],
    org_members: [{ org_id: 'org', user_id: 'owner' }],
    intelligence_evidence_packs: [{ org_id: 'org', user_id: 'owner', subject_canonical_key: key, window: 'current', content_hash: version, stale_after: FRESH,
      pack: { identity_version: 3, market_lookup_version: 2, market_selection_version: 1, coverage_version: 1, retained_quote_version: 1, evidence_projection_version: 3, liquidity_projection_version: 1, protocol_context_version: 1, market_summary: { current_price: 0, field_evidence: { current_price: { value: 0, as_of: NOW.toISOString() } } }, data_coverage: {} }, data_coverage: {}, provider_coverage: {}, source_provenance: {} }],
  }) as any
  db.rpc = async () => ({ data: true })
  const page = await getOrAssembleAssetEvidencePack(db, { canonicalKey: key, orgId: 'org', userId: 'owner' }, { now: NOW })
  const research = compactAssetEvidencePackForPrompt(page) as any
  const alert = await evaluateThesis(db, { id: 'thesis', subject_canonical_key: key, org_id: 'org', user_id: 'owner' }, { dryRun: true })
  assert(page.cached && page.contentHash === version && research.content_hash === version && alert.evidence_version === version, 'all three consumers preserve the scoped evidence hash')
  assert(research.pack.market_summary.field_evidence.current_price.as_of === NOW.toISOString(), 'research retains the page observation time')
  assert(Object.keys(db.writes).length === 0, 'verification sends no notifications and rewrites no evidence')
})

Deno.test('T09 general asset evidence includes retained derivatives with their original provenance', async () => {
  const observation = { id: 'oi:1', subject: 'market:coinmarketcap:1', metric: 'open_interest', value: 0, unit: 'USD', provider: 'coinmarketcap', sourceRef: 'coinmarketcap:derivativePairs', observedAt: NOW.toISOString(), recordedAt: NOW.toISOString(), expiresAt: FRESH, aiAllowed: true, state: 'known', metadata: { contractId: '1', venueId: 'venue', compatibleQuote: true, batchId: 'a'.repeat(64), batchContractCount: 1 } }
  const db = makeDb({ market_assets: [{ source_provider: 'coingecko', provider_id: 'bitcoin', normalized_symbol: 'BTC' }] })
  const original = db.from.bind(db)
  db.from = (table: string) => {
    if (table !== 'intel_market_observations') return original(table)
    const q: any = {}; for (const m of ['select','eq','in','gte','lte','gt','order','like']) q[m] = () => q
    q.limit = () => Promise.resolve({ data: [{ observation }], error: null }); return q
  }
  const result = await assembleAssetEvidencePack(db, { symbol: 'BTC' }, { now: NOW, allowLiveEnrichment: false, assembleContext: async () => ({ policy: {} as any, blocks: [] }) })
  const state = result.pack.derivatives_state as any
  assert(state?.observations?.[0]?.id === observation.id, 'same specialist observation is attached')
  assert(state.observations[0].value === 0 && state.observations[0].sourceRef === observation.sourceRef, 'zero and source retained')
  assert(!result.dataCoverage.optional_gaps.some(g => g.startsWith('Derivatives positioning is not attached')), 'obsolete omission statement removed')
})

Deno.test('T02 mixed evidence retains each selected field clock and cannot inherit the newest profile clock', async () => {
  const old = '2026-06-16T06:00:00.000Z', recent = '2026-06-16T11:59:00.000Z'
  const db = makeDb({
    market_assets: [{ source_provider: 'coingecko', provider_id: 'bitcoin', normalized_symbol: 'BTC' }],
    exchange_latest_asset_profiles: [{ normalized_symbol: 'BTC', as_of: recent }],
    exchange_latest_tickers: [{ normalized_symbol: 'BTC', provider: 'binance', price: 50, volume_quote_24h: 0, as_of: recent }],
    exchange_latest_market_caps: [{ normalized_symbol: 'BTC', market_cap: 100, as_of: old }],
    exchange_latest_orderbook: [{ normalized_symbol: 'BTC', bid_depth_usd: 0, ask_depth_usd: 3, as_of: old }],
  })
  const result = await assembleAssetEvidencePack(db, { symbol: 'BTC' }, { now: NOW, allowLiveEnrichment: false, assembleContext: async () => ({ policy: {} as any, blocks: [] }) })
  const pack = result.pack as any
  assert(pack.cex_state.freshness.status === 'stale', 'stale book/cap must not inherit the recent profile clock')
  assert(pack.cex_state.freshness.as_of === null && pack.cex_state.freshness.mixed_observation_times === true, 'mixed observations have no single observation time')
  assert(pack.market_summary.field_evidence.current_price.as_of === recent, 'price retains its selected ticker clock')
  assert(pack.market_summary.field_evidence.market_cap.as_of === old, 'market cap retains its selected cap clock')
  assert(pack.market_summary.field_evidence.volume_24h.value === 0, 'zero volume has its own evidence')
  assert(pack.market_summary.freshness.status === 'stale', 'mixed summary is conservatively dated')
  assert((result.sourceProvenance.cex as any).observations.length === 4, 'combined provenance retains all input clocks')
  assert((result.sourceProvenance.cex as any).freshness === 'stale', 'provenance uses the same source freshness policy')
})

Deno.test('T02 a fetch timestamp cannot stand in for an unknown observation time', async () => {
  const db = makeDb({ market_assets: [{ source_provider: 'coingecko', provider_id: 'bitcoin', normalized_symbol: 'BTC', current_price: 1, fetched_at: NOW.toISOString(), stale_after: FRESH }] })
  const result = await assembleAssetEvidencePack(db, { symbol: 'BTC' }, { now: NOW, allowLiveEnrichment: false, assembleContext: async () => ({ policy: {} as any, blocks: [] }) })
  const evidence = (result.pack.market_summary as any).field_evidence?.current_price
  assert(evidence?.status === 'unknown' && evidence?.as_of === null, 'observation time remains unknown')
  assert(evidence.recorded_at === NOW.toISOString(), 'fetch time is retained separately')
})
for(const scenario of [
 {name:'null, blank, boolean and crossed spreads',values:[null,'',false,-1],ticker:.45,expected:.45,table:'exchange_latest_tickers'},
 {name:'measured zero',values:[null,'0',.2],ticker:.45,expected:0,table:'exchange_latest_orderbook'},
 {name:'missing observations',values:[null,' ',false],ticker:null,expected:null,table:null},
])Deno.test(`liquidity spread selection preserves ${scenario.name} with its own cited clock`,async()=>{
 const db=makeDb({market_assets:[{source_provider:'coingecko',provider_id:'bitcoin',normalized_symbol:'BTC'}],
  exchange_latest_orderbook:scenario.values.map((spread_pct,i)=>({normalized_symbol:'BTC',provider:`fixture${i}`,spread_pct,as_of:NOW.toISOString()})),
  exchange_latest_tickers:[{normalized_symbol:'BTC',provider:'fixture',spread_pct:scenario.ticker,as_of:NOW.toISOString()}]})
 const result=await assembleAssetEvidencePack(db,{canonicalKey:'market:coingecko:bitcoin',sourceProvider:'coingecko',providerId:'bitcoin'},{now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})})
 const state=result.pack.liquidity_state as any
 assert(state.cex_min_spread_pct===scenario.expected,`Expected ${scenario.expected}; got ${state.cex_min_spread_pct}`)
 assert(state.field_evidence.cex_min_spread_pct.value===scenario.expected,'spread and its evidence agree')
 if(scenario.table){assert(state.field_evidence.cex_min_spread_pct.source_table===scenario.table,'the selected source is cited');assert(state.field_evidence.cex_min_spread_pct.as_of===NOW.toISOString(),'its own observation time is retained')}
})
Deno.test('legacy spread projections are versioned without rewriting the original saved evidence',async()=>{
 const key='market:coingecko:bitcoin',old={identity_version:3,coverage_version:1,retained_quote_version:1,evidence_projection_version:3,liquidity_state:{cex_min_spread_pct:0}},before=JSON.stringify(old)
 const db=makeDb({market_assets:[{source_provider:'coingecko',provider_id:'bitcoin',normalized_symbol:'BTC'}],intelligence_evidence_packs:[{org_id:null,user_id:null,subject_canonical_key:key,window:'current',content_hash:'original',stale_after:FRESH,pack:old}]})
 const result=await getOrAssembleAssetEvidencePack(db,{canonicalKey:key,sourceProvider:'coingecko',providerId:'bitcoin'},{now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})})
 assert(!result.cached&&result.contentHash!=='original','new reads build a distinct evidence version')
 assert((result.pack.liquidity_state as any).cex_min_spread_pct===null,'an absent spread is missing')
 assert(JSON.stringify(old)===before,'the original saved source content is unchanged')
})

Deno.test('catalog clock correction creates a new evidence version without rewriting original evidence',async()=>{
 const key='market:coingecko:bitcoin',created='2026-06-09T02:20:03Z',refreshed=NOW.toISOString()
 const old={identity_version:3,market_lookup_version:1,coverage_version:1,retained_quote_version:1,evidence_projection_version:3,liquidity_projection_version:1,protocol_context_version:1,market_summary:{current_price:0,field_evidence:{current_price:{value:0,recorded_at:created}}}},before=JSON.stringify(old)
 const db=makeDb({market_assets:[{source_provider:'coingecko',provider_id:'bitcoin',normalized_symbol:'BTC',current_price:0,as_of:refreshed,last_refreshed_at:refreshed,created_at:created}],intelligence_evidence_packs:[{org_id:null,user_id:null,subject_canonical_key:key,window:'current',content_hash:'original-clock',stale_after:FRESH,pack:old}]})
 const result=await getOrAssembleAssetEvidencePack(db,{canonicalKey:key},{now:NOW,allowLiveEnrichment:false,assembleContext:async()=>({policy:{} as any,blocks:[]})})
 assert(!result.cached&&result.contentHash!=='original-clock','old cache is regenerated once on demand')
 assert(result.pack.market_lookup_version===2,'new assembly version is explicit')
 const quote=(result.pack.market_summary as any).field_evidence.current_price
 assert(quote.value===0&&quote.as_of===refreshed&&quote.recorded_at===refreshed,'price and both real clocks survive actual assembly')
 assert(JSON.stringify(old)===before,'original evidence remains byte-for-byte unchanged')
})

for (const scenario of [
  { name: 'measured numeric zero', books: [{ bid_depth_usd: 0, ask_depth_usd: 0 }], bid: 0, ask: 0 },
  { name: 'measured string zero and positive depth', books: [{ bid_depth_usd: '0', ask_depth_usd: '12.5' }, { bid_depth_usd: 4, ask_depth_usd: 0 }], bid: 4, ask: 12.5 },
  { name: 'no observations', books: [], bid: null, ask: null },
  { name: 'missing side', books: [{ bid_depth_usd: 0, ask_depth_usd: null }], bid: 0, ask: null },
  { name: 'invalid observations', books: [{ bid_depth_usd: '', ask_depth_usd: ' ' }, { bid_depth_usd: false, ask_depth_usd: -1 }, { bid_depth_usd: Infinity, ask_depth_usd: 'bad' }, {}], bid: null, ask: null },
]) {
  Deno.test(`T05 depth aggregation preserves ${scenario.name}`, async () => {
    const db = makeDb({
      market_assets: [{ source_provider: 'coingecko', provider_id: 'bitcoin', normalized_symbol: 'BTC' }],
      exchange_latest_orderbook: scenario.books.map((book, i) => ({ ...book, provider: `venue${i}`, normalized_symbol: 'BTC', as_of: NOW.toISOString() })),
    })
    const result = await assembleAssetEvidencePack(db, { canonicalKey: 'market:coingecko:bitcoin', symbol: 'BTC', sourceProvider: 'coingecko', providerId: 'bitcoin' },
      { now: NOW, allowLiveEnrichment: false, assembleContext: async () => ({ policy: {} as any, blocks: [] }) })
    const liquidity = result.pack.liquidity_state as Record<string, unknown>
    assert(liquidity.cex_bid_depth_usd === scenario.bid, `bid: expected ${scenario.bid}, got ${liquidity.cex_bid_depth_usd}`)
    assert(liquidity.cex_ask_depth_usd === scenario.ask, `ask: expected ${scenario.ask}, got ${liquidity.cex_ask_depth_usd}`)
  })
}

Deno.test('D1 assembles a rich asset evidence pack from cached snapshot tables only', async () => {
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
      market_ranking_snapshots: [{ provider: 'coingecko', provider_id: 'solana', normalized_symbol: 'SOL', rank: 5, price_usd: 151, market_cap_usd: 80_000_000_000, as_of: '2026-06-16T10:00:00.000Z' }],
      narrative_category_snapshots: [{ provider: 'coingecko', category_id: 'solana-ecosystem', category_label: 'Solana Ecosystem', rank: 4, top_3_coins: ['SOL'], as_of: '2026-06-16T10:00:00.000Z' }],
      intel_signal_state: [{ subject_type: 'asset', display_symbol: 'SOL', signal_key: 'asset:SOL', direction: 'bullish', confidence: 'high', source_count: 5, global_score: 0.8, generated_at: '2026-06-16T11:00:00.000Z', stale_after: FRESH }],
      intel_global_news: [{ entity_symbol: 'SOL', title: 'Solana network activity rises', source_name: 'Curated News', summary: 'Activity picked up.', published_at: '2026-06-16T09:00:00.000Z' }],
      intel_rollups: [{ id: 'roll1', subject_type: 'asset_price', subject_id: 'SOL', period_kind: 'month', period_start: '2026-06-01', period_end: '2026-07-01', source_count: 12, source_diversity: 3, important_events: [{ kind: 'provider_snapshot_rollup', metrics: { avg_metric: 150 } }], computed_at: '2026-06-16T11:00:00.000Z' }],
      intel_event_memory: [{ id: 'evt1', event_type: 'other', title: 'SOL liquidity regime changed', summary: 'SOL saw a material liquidity expansion.', occurred_at: '2026-06-15T10:00:00.000Z', importance_score: 88, assets: ['SOL'], chains: ['solana'], narratives: ['solana-ecosystem'], evidence_refs: [] }],
      historical_analog_links: [{ id: 'ana1', current_subject_ref: 'SOL', current_subject_type: 'asset', analog_subject_ref: 'SOL:prior-cycle', analog_subject_type: 'asset', analog_kind: 'asset_cycle', similarity_score: 0.72, basis: { shared: 'liquidity expansion' }, observed_at: '2026-06-15T11:00:00.000Z' }],
      intelligence_entity_timeline: [{ id: 'tl1', entity_type: 'asset', entity_ref: 'SOL', event_type: 'provider_snapshot_change', title: 'SOL snapshot trend persisted', summary: 'Month-to-date provider rollups kept improving.', impact_score: 0.8, confidence: 0.8, occurred_at: '2026-06-15T12:00:00.000Z' }],
      chain_capabilities: [{ chain: 'solana', capability: 'dex_market', status: 'live', verified_at: '2026-06-16T00:00:00.000Z' }],
      narrative_taxonomy: [{ id: 'n1', slug: 'solana-memes', name: 'Solana Memes', parent_category: 'Meme', status: 'active', chains: ['solana'] }],
      narrative_state: [{ narrative_id: 'n1', global_priority_score: 72, signal_class: 'bullish', lifecycle_stage: 'heating_up', momentum_score: 64, chatter_score: 58, risk_score: 30, scored_at: '2026-06-16T11:00:00.000Z' }],
      narrative_signals: [{ narrative_id: 'n1', signal_kind: 'social_chatter', bias: 'bullish', source_quality_score: 70, title: 'Solana meme rotation heating up', snippet: 'Chatter rising.', observed_at: '2026-06-16T11:10:00.000Z' }],
      intel_curated_news: [{ title: 'Solana ecosystem inflows accelerate', cleaned_title: 'Solana inflows accelerate', summary: 'Net inflows rose.', why_it_matters: 'Confirms demand.', signal: 'bullish', confidence: 'medium', final_score: 81, source_count: 3, primary_url: 'https://example.com/sol', published_at: '2026-06-16T09:30:00.000Z', should_surface: true, tokens: ['SOL'], chains: ['solana'], narratives: ['solana-ecosystem'], sectors: [] }],
    })

    const assembled = await assembleAssetEvidencePack(db, {
      symbol: 'SOL',
      providerId: 'solana',
      sourceProvider: 'coingecko',
      orgId: 'org1',
      userId: 'user1',
    }, {
      now: NOW,
      allowLiveEnrichment: false,
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
    assert(pack.asset?.symbol === 'SOL', 'asset symbol retained')
    assert(pack.flow_state?.status === 'available', 'scoped flow data included')
    assert(pack.dex_state?.status === 'available', 'DEX state included')
    assert(pack.news_state?.status === 'available', 'news state included')
    assert(pack.ecosystem_narrative_state?.status === 'available', 'ecosystem narratives included')
    assert((pack.ecosystem_narrative_state?.ecosystem_narratives || []).some((n: any) => n.slug === 'solana-memes'), 'chain ecosystem narrative surfaced')
    assert(pack.catalyst_state?.status === 'available', 'curated news + catalysts included')
    assert((pack.catalyst_state?.curated_news || []).length >= 1, 'curated news surfaced by token/chain')
    assert((pack.catalyst_state?.catalysts || []).some((e: any) => e.event_type === 'other'), 'historic catalyst surfaced')
    assert(pack.onchain_state != null && typeof pack.onchain_state.status === 'string', 'on-chain state slice present')
    assert(pack.data_coverage?.used_sources?.includes('narrative_taxonomy'), 'ecosystem narrative tracked as a source')
    assert(pack.data_coverage?.used_sources?.includes('intel_curated_news'), 'curated news tracked as a source')
    assert(pack.historical_context?.status === 'available', 'historical context included')
    assert(pack.historical_context?.trend_windows?.length === 1, 'rollup trend window included')
    assert(pack.data_coverage?.used_sources?.includes('intel_rollups'), 'historical rollups tracked as a source')
    assert((pack.data_coverage?.material_gaps || []).length === 0, 'rich pack has no material gaps')
    assert(pack.data_coverage?.used_sources?.includes('platform_intelligence_context'), 'selected AI context blocks are tracked as a source')
    assert(db.writes.intelligence_evidence_packs?.length === 1, 'evidence pack persisted')
    assert(db.writes.ai_context_packs?.length === 1, 'context pack persisted')
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
  assert(coverage.optional_gaps.some((gap) => gap.includes('No curated news or historic catalysts')), 'news/catalyst absence is a specific optional gap')
  assert(coverage.optional_gaps.some((gap) => gap.includes('derivatives observations')), 'derivatives absence is an optional (not material) gap')
  assert(coverage.should_show_warning === false, 'optional gaps do not force the material warning')
  assert((result.pack.derivatives_state as any).status === 'missing', 'absence is scoped to this bounded read')
  assert(!JSON.stringify(result.pack).includes('not collected platform-wide'), 'existing derivatives consumers are not denied')
  assert(!JSON.stringify(result.pack).includes('No standalone holder-distribution snapshot table'), 'existing holder tables are not denied')
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
      pack: { identity_version: 3, market_lookup_version: 2, market_selection_version: 1, coverage_version: 1, retained_quote_version: 1, evidence_projection_version: 3, liquidity_projection_version: 1, protocol_context_version: 1, asset: { symbol: 'BTC' }, data_coverage: { material_gaps: [] } },
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
