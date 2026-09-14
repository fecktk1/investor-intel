import assert from 'node:assert/strict'

Deno.test('Content Studio real price pipeline preserves fallbacks and timestamps',async t=>{
  const oldFetch=globalThis.fetch,oldServe=Object.getOwnPropertyDescriptor(Deno,'serve')!
  const env={CMC_ALLOW_CONTENT_CREATION:'false',ENABLE_MARKET_ASSETS:'true',MARKET_ASSETS_MAX_RETRIES:'0',MARKET_ASSETS_REQUEST_TIMEOUT_MS:'3000',MARKET_ASSETS_MAX_CALLS_PER_JOB:'4'}
  const previous=new Map(Object.keys(env).map(k=>[k,Deno.env.get(k)]))
  for(const [k,v]of Object.entries(env))Deno.env.set(k,v)
  const calls:string[]=[]
  globalThis.fetch=async(input)=>{
    const u=new URL(input instanceof Request?input.url:String(input));calls.push(u.hostname+u.pathname)
    if(u.hostname.endsWith('coingecko.com')&&u.pathname.endsWith('/simple/price'))return Response.json(u.searchParams.get('ids')==='bitcoin'?{bitcoin:{usd:100,usd_24h_change:2}}:{})
    if(u.hostname==='api.coinbase.com'&&u.pathname==='/v2/exchange-rates')return Response.json(u.searchParams.get('currency')==='ETH'?{data:{rates:{USD:'200'}}}:{})
    throw Error('Unexpected request '+u.hostname+u.pathname)
  }
  try{
    Object.defineProperty(Deno,'serve',{configurable:true,value:()=>({})})
    const {fetchPriceSnapshot,buildSnapshotBlock}=await import('../../content-studio/index.ts')
    await t.step('CoinGecko still supplies price context with CMC content access disabled',async()=>{
      calls.length=0;const s=await fetchPriceSnapshot(['BTC'])
      assert.equal(s.assets.length,1);assert.equal(s.assets[0].source,'coingecko');assert.equal(s.assets[0].price_usd,100);assert.deepEqual(s.missing,[])
      assert.deepEqual(calls,['api.coingecko.com/api/v3/simple/price'])
    })
    await t.step('Coinbase remains the fallback when the first provider has no coverage',async()=>{
      calls.length=0;const s=await fetchPriceSnapshot(['ETH'])
      assert.equal(s.assets.length,1);assert.equal(s.assets[0].source,'coinbase');assert.equal(s.assets[0].price_usd,200);assert.deepEqual(s.missing,[])
      assert.equal(calls.some(c=>c.includes('coinmarketcap')),false);assert.equal(calls.at(-1),'api.coinbase.com/v2/exchange-rates')
    })
    await t.step('Missing prices remain explicit without fabricated data',async()=>{
      const s=await fetchPriceSnapshot(['SOL']);assert.deepEqual(s.assets,[]);assert.deepEqual(s.missing,['SOL']);assert.ok(buildSnapshotBlock(s).includes('NO PRICE DATA for: SOL'))
      calls.length=0;assert.deepEqual((await fetchPriceSnapshot([])).assets,[]);assert.equal(calls.length,0)
    })
    await t.step('The model receives original per-asset observation time separately from request time',()=>{
      const original='2026-09-11T10:00:00.000Z',requested='2026-09-11T10:01:00.000Z'
      const text=buildSnapshotBlock({assets:[{ticker:'BTC',price_usd:100,change_24h_pct:null,high_24h_usd:null,low_24h_usd:null,as_of_utc:original,source:'coinmarketcap'}],missing:[],as_of_utc:requested,sources_used:{BTC:'coinmarketcap'}})
      assert.ok(text.includes('[coinmarketcap; as of '+original+']'));assert.ok(text.includes('snapshot_requested_at: '+requested))
    })
  }finally{globalThis.fetch=oldFetch;Object.defineProperty(Deno,'serve',oldServe);for(const [k,v]of previous)v===undefined?Deno.env.delete(k):Deno.env.set(k,v)}
})
