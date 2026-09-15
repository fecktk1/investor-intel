import {assert,assertEquals} from 'jsr:@std/assert@1'
import {buildContractMarketAsset,contractCandles,CONTRACT_MAX_PROVIDER_CALLS,parseContractProviderId,shortContractLabel} from './contract-market-asset.ts'

const ADDRESS='So11111111111111111111111111111111111111112'
const EVM='0xAbCdEf0123456789AbCdEf0123456789AbCdEf01'

function admin(row:Record<string,unknown>|null){
 const reads:Record<string,unknown>[]=[]
 const client={from(table:string){const q:Record<string,unknown>={};const state:Record<string,unknown>={table}
  for(const key of ['select','eq','in','order','limit'])q[key]=(a?:unknown,b?:unknown)=>{state[key]=[a,b];return q}
  q.maybeSingle=()=>{reads.push(state);return Promise.resolve({data:table==='memecoin_latest_tokens'?row:null,error:null})}
  return q}}
 return {client,reads}
}
const cachedRow={chain:'solana',token_address:ADDRESS,symbol:'wsol',name:'Wrapped SOL',image_url:'https://img.test/wsol.png',cached_image_url:null,
 price_usd:212.5,change_1h_pct:-0.4,change_24h_pct:3.1,volume_24h_usd:9_000_000,liquidity_usd:4_200_000,fdv:120_000_000,market_cap:110_000_000,
 pair_address:'POOL1111111111111111111111111111111111111111',dex_id:'raydium',source:'dexscreener',source_provider:'dexscreener',
 source_label:'DEX Screener',attribution_label:'Data via DEX Screener',confidence:'high',as_of:'2026-09-14T10:00:00.000Z',last_refreshed_at:'2026-09-14T10:00:30.000Z'}

Deno.test('Contract identity answers from the cached observation without spending a provider call',async()=>{
 const db=admin(cachedRow),calls:string[]=[]
 const row=await buildContractMarketAsset(db.client,'solana',ADDRESS,{},{
  tokenPairs:()=>{calls.push('dexscreener');return Promise.resolve(null)},
  tokenInfo:()=>{calls.push('geckoterminal');return Promise.resolve(null)},
  tokenMetadata:()=>{calls.push('birdeye');return Promise.resolve(null)},
 })
 assertEquals(calls,[])
 assertEquals(row.source_provider,'contract')
 assertEquals(row.provider_id,`solana:${ADDRESS}`)
 assertEquals(row.symbol,'wsol');assertEquals(row.normalized_symbol,'WSOL');assertEquals(row.name,'Wrapped SOL')
 assertEquals(row.primary_chain,'solana');assertEquals(row.platforms,{solana:ADDRESS})
 assertEquals(row.current_price,212.5);assertEquals(row.market_cap,110_000_000);assertEquals(row.fdv,120_000_000)
 assertEquals(row.volume_24h,9_000_000);assertEquals(row.change_1h_pct,-0.4);assertEquals(row.change_24h_pct,3.1)
 assertEquals(row.image_url,'https://img.test/wsol.png')
 assertEquals(row.as_of,'2026-09-14T10:00:00.000Z');assertEquals(row.last_refreshed_at,'2026-09-14T10:00:30.000Z')
 assertEquals(row.source_label,'DEX Screener');assertEquals(row.attribution_label,'Data via DEX Screener');assertEquals(row.confidence,'high')
 assertEquals(row.quote_reason,null)
 assertEquals(row.contract,{chain:'solana',address:ADDRESS,decimals:null,pairAddress:'POOL1111111111111111111111111111111111111111',dexId:'raydium',liquidityUsd:4_200_000,
  sources:[{provider:'dexscreener',state:'available',observedAt:'2026-09-14T10:00:00.000Z',reason:null}]})
})

Deno.test('Contract identity falls back to the governed DEX and metadata clients',async()=>{
 const db=admin(null),calls:string[]=[]
 const row=await buildContractMarketAsset(db.client,'solana',ADDRESS,{},{
  now:()=>1_700_000_000_000,
  tokenPairs:(chain,address)=>{calls.push(`dexscreener:${chain}:${address}`);return Promise.resolve({chain,tokenAddress:address,symbol:'PEPE',name:'Pepe',imageUrl:'https://img.test/p.png',imageSource:'dexscreener',
   priceUsd:0.0042,change1hPct:1.5,change24hPct:-7,volume24hUsd:500_000,liquidityUsd:90_000,fdv:4_200_000,marketCap:4_000_000,buys24h:10,sells24h:8,txns24h:18,
   pairAddress:'POOLAAA',dexId:'orca',socials:null,links:null,pairCreatedAt:null,source:'dexscreener' as const})},
  tokenInfo:(chain,address)=>{calls.push(`geckoterminal:${chain}:${address}`);return Promise.resolve({description:'A frog',imageUrl:'https://img.test/gt.png',websites:[],socials:{},categories:[]})},
  tokenMetadata:(chain,address)=>{calls.push(`birdeye:${chain}:${address}`);return Promise.resolve({symbol:'PEPE',name:'Pepe',logo_url:'https://img.test/be.png',decimals:6})},
 })
 assertEquals(calls,[`dexscreener:solana:${ADDRESS}`,`geckoterminal:solana:${ADDRESS}`,`birdeye:solana:${ADDRESS}`])
 assertEquals(calls.length<=CONTRACT_MAX_PROVIDER_CALLS,true)
 assertEquals(row.symbol,'PEPE');assertEquals(row.normalized_symbol,'PEPE');assertEquals(row.current_price,0.0042)
 assertEquals(row.image_url,'https://img.test/p.png')
 assertEquals(row.contract.decimals,6);assertEquals(row.contract.pairAddress,'POOLAAA');assertEquals(row.contract.dexId,'orca');assertEquals(row.contract.liquidityUsd,90_000)
 assertEquals(row.source_label,'DEX Screener');assertEquals(row.attribution_label,'Data via DEX Screener');assertEquals(row.confidence,'medium')
 assertEquals(row.quote_reason,null)
 assertEquals(row.contract.sources.map((s)=>[s.provider,s.state,s.observedAt]),[['dexscreener','available','2023-11-14T22:13:20.000Z'],['geckoterminal','available','2023-11-14T22:13:20.000Z'],['birdeye','available','2023-11-14T22:13:20.000Z']])
})

Deno.test('Contract identity stops at the total time budget instead of spending more calls',async()=>{
 const db=admin(null),calls:string[]=[];let clock=0
 const row=await buildContractMarketAsset(db.client,'solana',ADDRESS,{},{
  now:()=>clock,
  tokenPairs:()=>{calls.push('dexscreener');clock+=7000;return Promise.resolve(null)},
  tokenInfo:()=>{calls.push('geckoterminal');return Promise.resolve(null)},
  tokenMetadata:()=>{calls.push('birdeye');return Promise.resolve(null)},
 })
 assertEquals(calls,['dexscreener'])
 assertEquals(row.contract.sources.map((s)=>[s.provider,s.state,s.reason]),[['dexscreener','empty','no_observation'],['geckoterminal','unavailable','budget_exhausted'],['birdeye','unavailable','budget_exhausted']])
})

Deno.test('Contract identity invents nothing when no source answers',async()=>{
 const db=admin(null)
 const row=await buildContractMarketAsset(db.client,'ethereum',EVM,{},{
  now:()=>1_700_000_000_000,
  tokenPairs:()=>Promise.resolve(null),tokenInfo:()=>Promise.resolve(null),tokenMetadata:()=>Promise.resolve(null),
 })
 // EVM addresses are canonicalised to lower case; the label is derived, never a claimed ticker.
 assertEquals(row.provider_id,`ethereum:${EVM.toLowerCase()}`)
 assertEquals(row.symbol,shortContractLabel(EVM.toLowerCase()));assertEquals(row.name,null)
 assertEquals(row.current_price,null);assertEquals(row.market_cap,null);assertEquals(row.fdv,null);assertEquals(row.volume_24h,null)
 assertEquals(row.change_1h_pct,null);assertEquals(row.change_24h_pct,null);assertEquals(row.image_url,null);assertEquals(row.as_of,null)
 assertEquals(row.quote_reason,'no_dex_pair_found')
 assertEquals(row.confidence,'unknown');assertEquals(row.source_label,null);assertEquals(row.attribution_label,null)
 // Each source is reported as asked-and-empty, never silently dropped.
 assertEquals(row.contract.sources.map((s)=>[s.provider,s.state,s.reason]),[['dexscreener','empty','no_observation'],['geckoterminal','empty','no_observation'],['birdeye','empty','no_observation']])
 // A chain the registry has no provider for is reported, not guessed.
 const unsupported=await buildContractMarketAsset(admin(null).client,'zcash','t1abc',{},{now:()=>1,tokenPairs:()=>Promise.resolve(null),tokenInfo:()=>Promise.resolve(null),tokenMetadata:()=>Promise.resolve(null)})
 assertEquals(unsupported.contract.sources.map((s)=>[s.provider,s.state,s.reason]),[['dexscreener','unavailable','chain_not_supported'],['geckoterminal','unavailable','chain_not_supported'],['birdeye','unavailable','chain_not_supported']])
 assertEquals(unsupported.quote_reason,'chain_not_supported')
})

Deno.test('Contract provider ids parse to exactly one registered chain and address',()=>{
 assertEquals(parseContractProviderId(`solana:${ADDRESS}`),{chain:'solana',address:ADDRESS})
 assertEquals(parseContractProviderId(`ethereum:${EVM}`),{chain:'ethereum',address:EVM})
 for(const bad of ['',ADDRESS,'solana:','notachain:0x1','SOLANA:0x1','solana:0x1 2',':0x1','solana'])assertEquals(parseContractProviderId(bad),null,bad)
})

Deno.test('Contract candles use the token pool and stay inside the requested window',async()=>{
 const now=1_700_000_000_000,hour=3600000,pools:string[]=[]
 const rows=[{t:now-2*hour,o:1,h:2,l:1,c:2,v:5},{t:now-40*24*hour,o:1,h:1,l:1,c:1,v:1},{t:now+hour,o:9,h:9,l:9,c:9,v:0}]
 const asset={source_provider:'contract',primary_chain:'solana',contract:{chain:'solana',address:ADDRESS,pairAddress:'POOLAAA'}}
 const chart=await contractCandles(asset,'7D','auto',{},{now:()=>now,tokenPools:()=>{pools.push('called');return Promise.resolve([])},ohlcv:(_c,pool,tf)=>{pools.push(`${pool}:${tf}`);return Promise.resolve(rows)}})
 assertEquals(pools,['POOLAAA:1H'])
 assertEquals(chart.candles.map((c)=>c.c),[2])
 assertEquals(chart.bestProvider,'geckoterminal');assertEquals(chart.bestPair,'POOLAAA');assertEquals(chart.sourceState,'available')
})

Deno.test('Contract candles resolve a pool when the identity has none, and report an empty history',async()=>{
 const now=1_700_000_000_000
 const asset={source_provider:'contract',primary_chain:'solana',contract:{chain:'solana',address:ADDRESS,pairAddress:null}}
 const resolved=await contractCandles(asset,'1M','auto',{},{now:()=>now,tokenPools:()=>Promise.resolve([{address:'POOLBBB',dexId:'orca',liquidityUsd:5,volume24hUsd:1}]),ohlcv:(_c,_p,tf)=>{assertEquals(tf,'1D');return Promise.resolve([])}})
 assertEquals(resolved.bestPair,'POOLBBB');assertEquals(resolved.candles,[]);assertEquals(resolved.sourceReason,'no_completed_candles')
 const missing=await contractCandles(asset,'1M','auto',{},{now:()=>now,tokenPools:()=>Promise.resolve([]),ohlcv:()=>Promise.resolve([])})
 assertEquals(missing.sourceReason,'no_pool_found');assertEquals(missing.bestProvider,null)
 const unsupported=await contractCandles({source_provider:'contract',contract:{chain:'bitcoin',address:'bc1'}},'7D')
 assertEquals(unsupported.sourceReason,'chain_not_supported')
 assert(!unsupported.candles.length)
})
