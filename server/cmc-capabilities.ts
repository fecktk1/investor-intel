import {isCmcDexCursor,isDexDiscovery,cmcDexNetwork,cmcDexAddress,cmcDexNumber,cmcDexHolderPage,cmcDexHolderAddress,cmcDexHolderTagList,CMC_DEX_NETWORKS,CMC_DEX_DISCOVERY,CMC_HOLDER_TAGS} from './cmc-dex.ts'
/** Re-exported from cmc-dex.ts, where the response validators also need it. */
export {CMC_HOLDER_TAGS}
// Reviewed against official CMC endpoint references 2026-09-09. Access is a
// separate fact from a successful live response. DEX additions were probed with
// the owner's Startup key on September 12; unverified DEX endpoints stay closed.
export type CmcPlan = 'basic' | 'builder' | 'startup' | 'growth' | 'professional' | 'enterprise'
export type CmcFeature = 'market' | 'metadata' | 'history' | 'regime' | 'rwa' | 'structure' | 'attention'
export interface CmcCapability {
  path: string; tier: CmcPlan; feature: CmcFeature; ttl: number; stale: number
  demand?: boolean; method?:'POST'; params: string[]; required?: string[]; rows?: string; cost: '250' | '100' | 'categories' | 'one' | 'zero'
}
const market = ['start','limit','sort','sort_dir','price_min','price_max','market_cap_min','market_cap_max','volume_24h_min','volume_24h_max','circulating_supply_min','circulating_supply_max','percent_change_24h_min','percent_change_24h_max','cryptocurrency_type','tag']
const ids = ['id','slug','symbol','skip_invalid']
const rwa = ['rwa_id','rwa_slug','symbol','asset_type','start','limit','sort','sort_dir','skip_invalid']
const dexDiscovery=['platformIds','interval','pageSize','nextPageIndex']
const dexBatchKeys=['addresses','tokens']
/** Reviewed exact-contract DEX response schemas. Every registered DEX path now
 * has an exact-contract or exact-request validator in cmc-dex.ts, so the
 * transport calls a response that does not match its request malformed. Only
 * dexCandles ever becomes an observation clock (see cmcObservedAt). */
export const CMC_DEX_SCHEMA_VALIDATED=new Set<string>([...CMC_DEX_DISCOVERY,'dexPlatforms','dexToken','dexHolderCount','dexHolderHistory','dexSecurity','dexLiquidityEvents','dexPools','dexSwaps',
  'dexHolderTags','dexHolders','dexCandles','dexSearch','dexBatch','dexPriceBatch'])
/** Single-contract DEX capabilities: exactly one verified platform + address. */
const dexContract=(name:string)=>name.startsWith('dex')&&!isDexDiscovery(name)&&!['dexPlatforms','dexSearch','dexBatch','dexPriceBatch'].includes(name)
const klineIntervals=['1min','5min','15min','30min','1h','4h','1d','1w']
// Sampling interval fixes both observation spacing and the maximum window.
const historySpans:Record<string,[number,number]>={daily:[86400000,366],hourly:[3600000,744],'5m':[300000,576]}
function numericCeiling(name:string,key:string):number {
  if(key==='start')return 5000
  if(key==='limit')return name==='dexCandles'?1000:250
  return name==='history'?744:name==='exchangeHistory'?366:250
}
function batchList(key:string,value:unknown):string {
  const list=(Array.isArray(value)?value:String(value).split(',')).map(v=>v&&typeof v==='object'?`${(v as any).platform}:${(v as any).address}`:String(v).trim()).filter(Boolean)
  if(!list.length||list.length>50||list.some(v=>v.length>200||/[\u0000-\u001f,]/.test(v)))throw new Error(`invalid_batch:${key}`)
  return list.join(',')
}
function cap(path: string, feature: CmcFeature, params: string[], options: Partial<CmcCapability> = {}): CmcCapability {
  return { path,feature,params,tier:'basic',ttl:900,stale:21600,cost:'one',...options }
}
export const CMC_CAPABILITIES: Record<string,CmcCapability> = {
  map: cap('/v1/cryptocurrency/map','metadata',['symbol','start','limit','listing_status','sort'],{cost:'zero',ttl:86400,stale:86400}),
  listings: cap('/v3/cryptocurrency/listings/latest','market',market,{cost:'250',ttl:240}),
  quotes: cap('/v3/cryptocurrency/quotes/latest','market',ids,{cost:'250',ttl:300,required:['id','slug','symbol']}),
  metadata: cap('/v2/cryptocurrency/info','metadata',[...ids,'address'],{cost:'250',ttl:86400,stale:86400,required:['id','slug','symbol','address']}),
  history: cap('/v3/cryptocurrency/quotes/historical','history',[...ids,'time_start','time_end','interval','count'],{cost:'100',ttl:3600,required:['id']}),
  categories: cap('/v1/cryptocurrency/categories','regime',['start','limit',...ids],{cost:'categories',ttl:3600}),
  category: cap('/v1/cryptocurrency/category','regime',['id','start','limit'],{cost:'250',rows:'coins',required:['id']}),
  global: cap('/v1/global-metrics/quotes/latest','regime',[],{ttl:3600}),
  fearGreed: cap('/v3/fear-and-greed/latest','regime',[],{ttl:3600}),
  fearGreedHistory: cap('/v3/fear-and-greed/historical','regime',['start','limit'],{ttl:3600}),
  altcoinSeason: cap('/v1/altcoin-season-index/latest','regime',[],{ttl:3600}),
  altcoinSeasonHistory: cap('/v1/altcoin-season-index/historical','regime',['timeframe'],{ttl:3600}),
  cmc100: cap('/v3/index/cmc100-latest','regime',[],{ttl:3600}),
  cmc20: cap('/v3/index/cmc20-latest','regime',[],{ttl:3600}),
  globalHistory: cap('/v1/global-metrics/quotes/historical','regime',['time_start','time_end','interval','count'],{demand:false,cost:'100',rows:'quotes',ttl:3600}),
  cmc100History: cap('/v3/index/cmc100-historical','regime',['time_start','time_end','interval','count'],{demand:false,ttl:3600}),
  cmc20History: cap('/v3/index/cmc20-historical','regime',['time_start','time_end','interval','count'],{demand:false,ttl:3600}),
  rwaMap: cap('/v5/real-world-assets/map','metadata',['asset_type','symbol','sort','start','limit'],{cost:'zero',rows:'rwa_assets',ttl:86400,stale:86400}),
  rwaList: cap('/v5/real-world-assets/assets/list','rwa',rwa,{cost:'250',rows:'rwa_assets',ttl:3600}),
  rwaInfo: cap('/v5/real-world-assets/info','rwa',['rwa_id','rwa_slug','symbol'],{cost:'250',rows:'rwa_assets',ttl:86400,stale:86400,required:['rwa_id','rwa_slug','symbol']}),
  rwaQuotes: cap('/v5/real-world-assets/quotes/latest','rwa',['rwa_id','rwa_slug','symbol'],{cost:'250',rows:'rwa_assets',ttl:3600,required:['rwa_id','rwa_slug','symbol']}),
  issuers: cap('/v5/real-world-assets/issuers/list','rwa',['start','limit'],{rows:'issuers',ttl:86400,stale:86400}),
  issuer: cap('/v5/real-world-assets/issuers','rwa',['issuer_id','start','limit'],{ttl:86400,stale:86400,required:['issuer_id']}),
  derivativeExchanges: cap('/v5/exchange/derivatives/list','structure',['start','limit'],{rows:'exchanges',cost:'250',ttl:3600}),
  exchangeInfo: cap('/v1/exchange/info','metadata',['id','slug'],{cost:'250',ttl:86400,stale:86400,required:['id','slug']}),
  exchangeAssets: cap('/v1/exchange/assets','structure',['id'],{demand:false,cost:'one',ttl:3600,stale:86400,required:['id']}),
  // Registered 2026-09-15. The provider enforces the retained-history depth of
  // a plan (Basic one year, Startup from 2013); this registry does not restate it.
  listingsHistorical: cap('/v1/cryptocurrency/listings/historical','history',['date','start','limit','sort','sort_dir','cryptocurrency_type'],{demand:false,cost:'100',ttl:86400,stale:604800,required:['date']}),
  exchangeMap: cap('/v1/exchange/map','metadata',['listing_status','slug','start','limit','sort'],{ttl:86400,stale:86400}),
  // Registered 2026-09-15 for the venue-share lane: every active exchange with
  // its 24-hour spot volume and pair count in one page (100 rows a credit).
  // Probed 2026-09-15 01:50 UTC on the Startup key: insufficient_entitlement, so
  // the endpoint sits above Startup and the lane falls back to the exchange map.
  exchangeListings: cap('/v1/exchange/listings/latest','structure',['start','limit','sort','sort_dir','market_type','category'],{demand:false,tier:'growth',cost:'100',ttl:3600,stale:86400}),
  exchangeHistory: cap('/v1/exchange/quotes/historical','structure',['id','slug','time_start','time_end','count','interval'],{demand:false,cost:'100',ttl:3600,required:['id','slug']}),
  // Probed 2026-09-14 on the Startup key: 403 / 1006, the subscription plan does not include this endpoint.
  blockchainStats: cap('/v1/blockchain/statistics/latest','regime',['id','symbol','slug'],{tier:'growth',ttl:900,required:['id','symbol','slug']}),
  priceConversion: cap('/v2/tools/price-conversion','market',['amount','id','symbol','convert','convert_id','time'],{ttl:3600,required:['id','symbol']}),
  fiatMap: cap('/v1/fiat/map','metadata',['start','limit','sort','include_metals'],{ttl:86400,stale:86400}),
  exchangeDerivativePairs: cap('/v5/exchange/derivatives/market-pairs/list/latest','structure',['exchange_id','exchange_slug','start','limit','category','sort','sort_dir'],{rows:'market_pairs',cost:'250',ttl:120,stale:900,required:['exchange_id','exchange_slug']}),
  derivativePairs: cap('/v5/cryptocurrency/derivatives/market-pairs/list/latest','structure',['crypto_id','start','limit','category'],{rows:'market_pairs',cost:'250',ttl:120,stale:900,required:['crypto_id']}),
  liquidations: cap('/v5/derivatives/liquidations/quotes/latest','structure',[],{rows:'quotes',ttl:300,stale:3600}),
  liquidationAssets: cap('/v5/derivatives/liquidations/cryptocurrency/list/latest','structure',['crypto_id','start','limit'],{rows:'cryptocurrencies',cost:'250',ttl:300,stale:3600}),
  liquidationExchanges: cap('/v5/derivatives/liquidations/exchange/list/latest','structure',['exchange_id','start','limit','sort','sort_dir'],{demand:false,rows:'exchanges',cost:'250',ttl:300,stale:3600}),
  dexPlatforms: cap('/v1/dex/platform/list','metadata',[],{demand:false,tier:'startup',ttl:86400,stale:86400}),
  dexToken: cap('/v1/dex/token','structure',['platform','address'],{demand:false,tier:'startup',ttl:300,stale:900,required:['address']}),
  dexHolderCount: cap('/v1/dex/holders/count','structure',['platform','tokenAddress'],{demand:false,tier:'startup',ttl:900,stale:3600,required:['tokenAddress']}),
  dexHolderHistory: cap('/v1/dex/holders/trend/list','structure',['platform','tokenAddress','interval','limit'],{demand:false,tier:'startup',ttl:3600,stale:21600,required:['tokenAddress']}),
  dexSecurity: cap('/v1/dex/security/detail','structure',['platformName','address'],{demand:false,tier:'startup',ttl:3600,stale:21600,required:['address']}),
  dexLiquidityEvents: cap('/v1/dex/liquidity-change/list','structure',['platform','address','limit','lastId'],{demand:false,tier:'startup',rows:'lcs',ttl:300,stale:900,required:['address']}),
  dexPools: cap('/v1/dex/token/pools','structure',['platform','address','size'],{demand:false,tier:'startup',ttl:300,stale:900,required:['address']}),
  dexSwaps: cap('/v1/dex/tokens/transactions','structure',['platform','address','limit','lastId'],{demand:false,tier:'startup',rows:'swaps',ttl:120,stale:900,required:['address']}),
  dexTrending: cap('/v1/dex/tokens/trending/list','attention',dexDiscovery,{demand:false,method:'POST',tier:'startup',ttl:300,stale:900,rows:'leaderboardList'}),
  dexNew: cap('/v1/dex/new/list','attention',dexDiscovery,{demand:false,method:'POST',tier:'startup',ttl:300,stale:900,rows:'leaderboardList'}),
  dexMeme: cap('/v1/dex/meme/list','attention',dexDiscovery,{demand:false,method:'POST',tier:'startup',ttl:300,stale:900}),
  dexGainers: cap('/v1/dex/gainer-loser/list','attention',dexDiscovery,{demand:false,method:'POST',tier:'startup',ttl:300,stale:900,rows:'leaderboardList'}),
  // Registered 2026-09-15 and probed the same day on the Startup key: every one of these cost one credit.
  // tag_count returns data.holders [{tag,hc,tb,hr}] with tags tag_dev, tag_sniper, tag_kol, tag_whale, tag_bot,
  // tag_insider, tag_initial_bundler and tag_smart_money; holders/list rejects a request without a tag.
  dexHolderTags: cap('/v1/dex/holders/tag_count','structure',['platform','tokenAddress'],{demand:false,tier:'startup',rows:'holders',ttl:3600,stale:21600,required:['tokenAddress']}),
  dexHolders: cap('/v1/dex/holders/list','structure',['platform','tokenAddress','tag','limit','lastId'],{demand:false,method:'POST',tier:'startup',rows:'holders',ttl:3600,stale:21600,required:['tokenAddress']}),
  dexCandles: cap('/v1/k-line/candles','history',['platform','address','interval','from','to','unit','limit','pm'],{demand:false,tier:'startup',ttl:300,stale:900,required:['address']}),
  // Cost note for the three lookup/batch paths below. A single one-address probe
  // on 2026-09-14 reported credit_count 1 for each (evidence file
  // docs/investor-intel/evidence/cmc-cost-probe-2026-09-14.json), so they are
  // registered cost:'one'. What is NOT probed is whether a full 50-member batch
  // or a wide search page still costs one credit: the per-member curve is
  // unmeasured. estimateCmcCredits is therefore a floor, not a promise, and the
  // transport reconciles the actual credit_count at run time
  // (cmc_request_reconcile) — never treat the estimate as the charge.
  dexSearch: cap('/v1/dex/search','metadata',['q','platform','limit'],{demand:false,tier:'startup',ttl:900,required:['q']}),
  dexBatch: cap('/v1/dex/tokens/batch-query','metadata',['platform','addresses'],{demand:false,method:'POST',tier:'startup',ttl:900,required:['addresses']}),
  dexPriceBatch: cap('/v1/dex/token/price/batch','market',['tokens'],{demand:false,method:'POST',tier:'startup',ttl:120,stale:900,required:['tokens']}),
  newListings: cap('/v1/cryptocurrency/listings/new','market',['start','limit'],{tier:'startup',cost:'250'}),
  trending: cap('/v1/cryptocurrency/trending/latest','attention',['start','limit','time_period'],{tier:'startup',cost:'250',ttl:3600}),
  gainers: cap('/v1/cryptocurrency/trending/gainers-losers','market',['start','limit','time_period','sort_dir'],{tier:'startup',cost:'250'}),
  mostVisited: cap('/v1/cryptocurrency/trending/most-visited','attention',['start','limit','time_period'],{tier:'startup',cost:'250',ttl:86400}),
  performance: cap('/v2/cryptocurrency/price-performance-stats/latest','market',[...ids,'time_period'],{tier:'startup',cost:'250',required:['id']}),
  ohlcv: cap('/v2/cryptocurrency/ohlcv/historical','history',['id','time_start','time_end','interval','count','time_period'],{tier:'startup',cost:'100',ttl:3600,required:['id']}),
  airdrops: cap('/v1/cryptocurrency/airdrops','attention',['start','limit','status'],{tier:'builder',ttl:86400}),
  rwaPairs: cap('/v5/real-world-assets/market-pairs/list','rwa',['rwa_id','start','limit'],{tier:'growth',cost:'250',rows:'market_pairs',required:['rwa_id']}),
  marketPairs: cap('/v2/cryptocurrency/market-pairs/latest','structure',['id','start','limit'],{tier:'growth',cost:'250',rows:'market_pairs',required:['id']}),
  content: cap('/v1/content/latest','attention',['start','limit','id'],{tier:'growth',cost:'zero'}),
  community: cap('/v1/community/trending/token','attention',['limit'],{tier:'growth',cost:'zero'}),
}
export const CMC_FEATURE_CAPS: Record<CmcFeature,number> = { market:6000,metadata:500,history:500,regime:2500,rwa:1500,structure:1000,attention:500 }
export function planAllows(plan: string, minimum: CmcPlan): boolean {
  const levels = ['basic','builder','startup','growth','professional','enterprise']
  return levels.indexOf(plan) >= levels.indexOf(minimum)
}
export function cmcParams(name: string, input: Record<string,unknown> = {}): Record<string,string> {
  const spec = CMC_CAPABILITIES[name]; if (!spec) throw new Error('unsupported_capability')
  const out: Record<string,string> = {}
  for (const [key,value] of Object.entries(input)) {
    if (value == null || value === '') continue
    if (!spec.params.includes(key)) throw new Error(`invalid_parameter:${key}`)
    // Batch members carry their own platform; they are canonicalised below.
    if (dexBatchKeys.includes(key)) { out[key]=batchList(key,value); continue }
    const s = String(value)
    if (s.length>(['id','crypto_id','rwa_id','exchange_id'].includes(key)?4000:500) || /[\u0000-\u001f]/.test(s)) throw new Error(`invalid_parameter:${key}`)
    if (['start','limit','count'].includes(key) && (!/^\d+$/.test(s) || Number(s)<1 || Number(s)>numericCeiling(name,key))) throw new Error(`invalid_parameter:${key}`)
    if (key==='amount' && (!/^\d+(\.\d+)?$/.test(s) || Number(s)<=0)) throw new Error('invalid_amount')
    if (key==='date' && !/^\d{10,13}$/.test(s) && !Number.isFinite(Date.parse(s))) throw new Error('invalid_time:date')
    if (['from','to'].includes(key) && !/^\d{9,10}$/.test(s)) throw new Error(`invalid_time:${key}`)
    if (['id','crypto_id','rwa_id','exchange_id'].includes(key) && !(key==='id' && name==='category') && !/^\d+(,\d+){0,249}$/.test(s)) throw new Error(`invalid_identifier:${key}`)
    if (['address','tokenAddress'].includes(key) && !/^0x[0-9a-f]{40}$/i.test(s) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new Error('invalid_contract_address')
    if (key==='issuer_id' && !/^[a-f0-9]{24}$/i.test(s)) throw new Error('invalid_identifier:issuer_id')
    if (key==='asset_type' && !['stock','commodity','currency','government_security','etf','real_estate'].includes(s)) throw new Error('invalid_asset_type')
    if (key==='sort_dir' && !['asc','desc'].includes(s)) throw new Error('invalid_sort_dir')
    if (key.startsWith('time_') && ['time_start','time_end'].includes(key) && !Number.isFinite(Date.parse(s))) throw new Error(`invalid_time:${key}`)
    if (['id','crypto_id','rwa_id','exchange_id'].includes(key) && /^\d+(,\d+)*$/.test(s)) {
      const values=s.split(',').map(Number)
      if(values.some(v=>!Number.isSafeInteger(v)||v<1)) throw new Error(`invalid_identifier:${key}`)
      out[key]=[...new Set(values)].sort((a,b)=>a-b).join(',')
    } else if(['address','tokenAddress'].includes(key)) out[key]=/^0x/i.test(s)?s.toLowerCase():s
    else if (['slug','rwa_slug','exchange_slug'].includes(key)) {
      if(!/^[a-z0-9-]+(,[a-z0-9-]+)*$/i.test(s)) throw new Error(`invalid_identifier:${key}`)
      out[key]=[...new Set(s.toLowerCase().split(','))].sort().join(',')
    } else if (['time_start','time_end'].includes(key)) out[key]=new Date(s).toISOString()
    else if (key==='date') out.date=/^\d{10,13}$/.test(s)?s:new Date(s).toISOString()
    else out[key]=s
  }
  if (spec.required && !spec.required.some(k=>out[k])) throw new Error('missing_identifier')
  if(name==='exchangeAssets'&&out.id?.includes(','))throw new Error('single_exchange_required')
  if (['id','crypto_id','rwa_id','exchange_id','slug','rwa_slug','exchange_slug','symbol','address'].filter(k=>out[k]).length>1) throw new Error('multiple_identifier_types')
  if(['quotes','metadata','rwaInfo','rwaQuotes'].includes(name)&&out.symbol) throw new Error('stable_identifier_required')
  if(isDexDiscovery(name)){
    out.platformIds||='1';out.interval||='24h';out.pageSize||='25'
    if(!CMC_DEX_NETWORKS.some(n=>String(n.platformId)===out.platformIds))throw new Error('unverified_dex_platform')
    if(out.interval!=='24h')throw new Error('invalid_discovery_interval')
    if(!/^[1-9][0-9]*$/.test(out.pageSize)||Number(out.pageSize)>25)throw new Error('invalid_discovery_page_size')
    if(out.nextPageIndex&&!isCmcDexCursor(out.nextPageIndex))throw new Error('invalid_dex_cursor')
  }else if(name==='dexSearch'){
    // A free-text query is a lookup term, never an identity. Platform stays optional.
    if(out.platform&&!cmcDexNetwork(out.platform))throw new Error('unverified_dex_platform')
    if(out.q.trim().length<2||out.q.length>120)throw new Error('invalid_search_query')
  }else if(name==='dexHolders'){
    // Probed 2026-09-14: the provider answers 400 "Parameter error" without a tag, and only these tags exist.
    if(!cmcDexNetwork(out.platform))throw new Error('unverified_dex_platform')
    if(!cmcDexAddress(out.tokenAddress,out.platform))throw new Error('invalid_contract_address')
    if(!CMC_HOLDER_TAGS.includes(out.tag))throw new Error('invalid_holder_tag')
    if(out.lastId&&!isCmcDexCursor(out.lastId))throw new Error('invalid_dex_cursor')
  }else if(name==='dexBatch'){
    if(!cmcDexNetwork(out.platform))throw new Error('unverified_dex_platform')
    const list=[...new Set(out.addresses.split(',').map(v=>out.platform==='solana'?v:v.toLowerCase()))].sort()
    if(!list.every(a=>cmcDexAddress(a,out.platform)))throw new Error('invalid_contract_address')
    out.addresses=list.join(',')
  }else if(name==='dexPriceBatch'){
    // Each batch member states its own verified chain; one bad member fails all.
    const list=out.tokens.split(',').map(v=>[v.slice(0,v.indexOf(':')),v.slice(v.indexOf(':')+1)] as [string,string])
    if(!list.every(([p,a])=>cmcDexNetwork(p)&&cmcDexAddress(a,p)))throw new Error('invalid_contract_address')
    out.tokens=[...new Set(list.map(([p,a])=>`${p}:${p==='solana'?a:a.toLowerCase()}`))].sort().join(',')
  }else if(dexContract(name)) {
    // Only verified platform aliases. A symbol is never an on-chain identity.
    const platform=out.platform??out.platformName,address=out.address??out.tokenAddress
    if(!cmcDexNetwork(platform))throw new Error('unverified_dex_platform')
    if(!cmcDexAddress(address,platform))throw new Error('invalid_contract_address')
    if(name==='dexPools'){out.size||='12';if(!/^[1-9][0-9]*$/.test(out.size)||Number(out.size)>25)throw new Error('invalid_pool_page_size')}
    if(name==='dexHolderHistory'){out.interval||='1d';if(out.interval!=='1d')throw new Error('invalid_holder_interval')}
    if(name==='dexCandles'){
      // k-line periods are named candle widths; sub-minute sampling is refused.
      out.interval||='1h';out.unit||='usd'
      if(!klineIntervals.includes(out.interval))throw new Error('invalid_candle_interval')
      if(!['usd','native','quote'].includes(out.unit))throw new Error('invalid_candle_unit')
      if(out.from&&out.to&&Number(out.to)<Number(out.from))throw new Error('invalid_time_window')
    }
    if(out.lastId&&!isCmcDexCursor(out.lastId))throw new Error('invalid_dex_cursor')
  }
  if(name==='priceConversion'){
    if(!out.amount)throw new Error('missing_amount')
    if(out.convert&&out.convert_id)throw new Error('multiple_identifier_types')
    // Up to 30 conversion targets in one call: the hourly display-currency
    // capture prices the whole supported fiat set for one credit (the provider
    // allows 120 on a paid plan; 30 is what the app supports).
    if(out.convert&&(out.convert.split(',').length>30||!/^[a-z0-9]{1,20}(,[a-z0-9]{1,20}){0,29}$/i.test(out.convert)))throw new Error('invalid_parameter:convert')
    if(out.convert)out.convert=out.convert.toUpperCase()
    else if(!out.convert_id)out.convert='USD'
  }
  if(['globalHistory','cmc100History','cmc20History'].includes(name)) {
    out.count||=name==='globalHistory'?'30':'10';out.interval||='daily'
    if(out.interval!=='daily')throw new Error('history_requires_daily_interval')
    if(out.time_start)throw new Error('history_requires_end_and_count')
    if(name!=='globalHistory'&&Number(out.count)>10)throw new Error('maximum_index_observations_10')
  }
  if (['history','ohlcv','exchangeHistory'].includes(name)) {
    // Single-asset pages stay bounded. OHLCV sampling must equal the candle
    // period; interval=4h samples 1h candles and is NOT a four-hour aggregation.
    // Quote histories additionally accept hourly and 5m, each with its own
    // documented observation ceiling, so a fine interval cannot widen the window.
    if (out.id?.includes(',')) throw new Error('history_requires_single_id')
    out.count ||= name==='exchangeHistory'?'30':'90'; out.interval ||= 'daily'
    const hourly=name==='ohlcv'&&out.time_period==='hourly'&&out.interval==='hourly'
    const span=name==='ohlcv'?null:historySpans[out.interval]
    if(name==='ohlcv'){
      if(!hourly&&(out.interval!=='daily' || (out.time_period && out.time_period!=='daily'))) throw new Error('history_requires_daily_interval')
    }else if(!span) throw new Error('history_requires_daily_interval')
    else if(Number(out.count)>(name==='exchangeHistory'?Math.min(366,span[1]):span[1])) throw new Error('history_window_too_large')
    const step=span?span[0]:hourly?3600000:86400000
    if (out.time_start && out.time_end && Date.parse(out.time_end)<Date.parse(out.time_start)) throw new Error('invalid_time_window')
    if (out.time_start && (Date.parse(out.time_end || new Date().toISOString())-Date.parse(out.time_start)>(Number(out.count)-1)*step)) throw new Error('history_window_too_large')
  }
  if (spec.params.includes('limit')) out.limit ||= name==='community'?'5':'100'
  if (spec.params.includes('start')) out.start ||= '1'
  return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)))
}
/** POST bodies are rebuilt from the canonical cached scalar params only; a
 * caller never supplies JSON. List and numeric shapes are restored per
 * registered capability so the body matches the documented request schema. */
export function cmcRequestBody(name: string, params: Record<string,string>): Record<string,unknown> {
  if(isDexDiscovery(name)) return {...params,pageSize:Number(params.pageSize)}
  const body: Record<string,unknown>={...params}
  if(params.limit!=null) body.limit=Number(params.limit)
  if(name==='dexBatch') body.addresses=params.addresses.split(',')
  if(name==='dexPriceBatch') body.tokens=params.tokens.split(',').map(v=>({platform:v.slice(0,v.indexOf(':')),address:v.slice(v.indexOf(':')+1)}))
  return body
}
export function estimateCmcCredits(name: string, params: Record<string,string>): number {
  const cost=CMC_CAPABILITIES[name].cost
  const count=Math.max(1,Number(params.count||params.limit)||params.id?.split(',').length||params.exchange_id?.split(',').length||params.rwa_id?.split(',').length||params.symbol?.split(',').length||params.slug?.split(',').length||params.rwa_slug?.split(',').length||1)
  if (cost==='zero') return 0
  if (cost==='one') return 1
  if (cost==='categories') return 1+Math.ceil(count/200)
  return Math.ceil(count/(cost==='250'?250:100))
}

export function cmcUsdQuote(row: Record<string,unknown>): Record<string,unknown> {
  const q=row.quote ?? row.quotes
  if (Array.isArray(q)) return q.find(v=>v?.symbol==='USD'||v?.convert_symbol==='USD'||Number(v?.id)===2781||Number(v?.crypto_id)===2781||Number(v?.convert_id)===2781) ?? {}
  return q && typeof q==='object' ? (q as Record<string,any>).USD ?? q : {}
}
export function cmcRows(name:string,body:any): {rows:Record<string,any>[];total:number|null;hasMore:boolean;nextCursor?:string|null} {
  const data=body?.data ?? body
  if(name==='dexCandles'){
    // k-line rows are positional arrays [o,h,l,c,v,t,traders], not objects.
    const raw=Array.isArray(data)?data:Array.isArray(data?.candles)?data.candles:[]
    const rows=raw.slice(0,1000).filter((r:any)=>Array.isArray(r)&&r.length>=6)
      .map((r:any)=>({o:Number(r[0]),h:Number(r[1]),l:Number(r[2]),c:Number(r[3]),v:Number(r[4]),t:Number(r[5]),traders:r[6]==null?null:Number(r[6])}))
    return {rows,total:rows.length,hasMore:false}
  }
  if(name==='dexHolderTags'){
    // Probed 2026-09-14: data.holders rows are exactly {tag,hc,tb,hr} — tag, holder
    // account count, tagged balance, holding ratio. They carry no USD quote, so the
    // generic tail's empty quote:{} would be an invented (and empty) market fact.
    const raw=Array.isArray(data)?data:Array.isArray(data?.holders)?data.holders:[]
    const rows=raw.filter((v:any)=>v&&typeof v==='object'&&!Array.isArray(v)).slice(0,CMC_HOLDER_TAGS.length)
      .map((r:any)=>({tag:typeof r.tag==='string'?r.tag:null,hc:cmcDexNumber(r.hc),tb:cmcDexNumber(r.tb),hr:cmcDexNumber(r.hr)}))
    return {rows,total:rows.length,hasMore:false}
  }
  if(name==='dexHolders'){
    // Container, wallet key and tag shape are read through the same helpers the
    // validator uses (data.holders | data.list | a bare array; walletAddress |
    // address | holderAddress; tags as an array or one comma string), so a
    // documented alias can never make validation and projection disagree.
    // Only these fields survive;
    // every other provider key (name, symbol, price, totalSupply, risk flags, the
    // separate buyCount/sellCount, avg prices) is dropped rather than carried.
    // An address is a classified account, never a person: no row here may be given
    // a label that names or describes a human being.
    // Provider key -> retained field, as documented for /v1/dex/holders/list:
    //   walletAddress->walletAddress, balance->balance, percent->percent,
    //   tags->tags, fundingSource->fundingSource, buyUsd->buyVolumeUsd,
    //   sellUsd->sellVolumeUsd, realizedPnl->realizedPnlUsd,
    //   firstActiveTime->firstSeenAt, lastActiveTime->lastSeenAt.
    // UNKNOWN provider names, left null until a probe names them: unrealizedPnlUsd
    // (no unrealised field is documented) and txCount (the response documents
    // separate buyCount and sellCount, which are deliberately NOT summed here).
    const page=cmcDexHolderPage(data)
    const rows=(page?.rows??[]).filter((v:any)=>v&&typeof v==='object'&&!Array.isArray(v)).slice(0,250).map((r:any)=>({
      walletAddress:cmcDexHolderAddress(r),
      balance:r.balance??r.actualBalance??null,percent:r.percent??null,
      tags:cmcDexHolderTagList(r.tags)?.slice(0,CMC_HOLDER_TAGS.length)??null,
      fundingSource:typeof r.fundingSource==='string'?r.fundingSource:null,
      buyVolumeUsd:cmcDexNumber(r.buyVolumeUsd??r.buyUsd),sellVolumeUsd:cmcDexNumber(r.sellVolumeUsd??r.sellUsd),
      realizedPnlUsd:cmcDexNumber(r.realizedPnlUsd??r.realizedPnl),unrealizedPnlUsd:cmcDexNumber(r.unrealizedPnlUsd??r.unrealizedPnl),
      txCount:cmcDexNumber(r.txCount??r.txnCount),
      firstSeenAt:r.firstSeenAt??r.firstActiveTime??null,lastSeenAt:r.lastSeenAt??r.lastActiveTime??null}))
    return {rows,total:null,hasMore:false,nextCursor:isCmcDexCursor(page?.cursor)?page!.cursor:null}
  }
  if(isDexDiscovery(name)){
    const raw=name==='dexMeme'?['newCreations','aboutGraduates','graduates'].flatMap(stage=>(Array.isArray(data?.[stage])?data[stage]:[]).map((r:any)=>({...r,discoveryStage:stage}))):data?.leaderboardList??[]
    const rows=raw.slice(0,75).map((r:any)=>({...r,canonicalKey:`${CMC_DEX_NETWORKS.find(n=>n.platformId===r.pid)?.chain}:${r.pid===16?r.addr:String(r.addr).toLowerCase()}`,
      name:r.n,symbol:r.sym,quote:{price:r.p==null?null:Number(r.p),last_updated:r.pt&&Number.isFinite(Number(r.pt))?new Date(Number(r.pt)<1e12?Number(r.pt)*1000:Number(r.pt)).toISOString():null}}))
    return {rows,total:data.total!=null&&Number.isFinite(Number(data.total))?Number(data.total):null,hasMore:data.hasNextPage===true||!!data.nextPageIndex,nextCursor:isCmcDexCursor(data.nextPageIndex)?data.nextPageIndex:null}
  }
  const spec=CMC_CAPABILITIES[name]
  let rows=spec.rows ? data?.[spec.rows]??[] : data
  if(data&&typeof data==='object'&&!Array.isArray(data)&&Object.keys(data).length===0)rows=[]
  if (!Array.isArray(rows)) {
    // Metadata uses an ID map, issuer/regime responses use a single object.
    rows=rows && typeof rows==='object' ? (/^(metadata|exchangeInfo|history|ohlcv|performance)$/.test(name) && !rows.id ? Object.values(rows).flat() : [rows]) : []
  }
  rows=rows.filter((v:any)=>v && typeof v==='object' && !Array.isArray(v)).slice(0,250).map((v:any)=>({ ...v, quote: cmcUsdQuote(v),...(v.exchange_reported_quotes?{exchangeReportedQuote:cmcUsdQuote({quote:v.exchange_reported_quotes})}:{}) }))
  if (name === 'exchangeDerivativePairs' && data?.exchange_id != null) rows=rows.map((row:any)=>({...row,exchange:row.exchange||{exchange_id:data.exchange_id,name:data.exchange_name,slug:data.exchange_slug}}))
  const total=data?.total_size ?? data?.total ?? data?.num_market_pairs ?? body?.status?.total_count ?? null
  return { rows,total:Number.isFinite(Number(total))&&total!=null?Number(total):null,hasMore:data?.has_more===true }
}

export function cmcObservedAt(body:any, capability?:string):string|null {
  if(capability==='exchangeAssets')return null // Retrieval does not date static reported balances or their prices.
  if(capability==='dexCandles'){
    // k-line rows carry their own period clock. The oldest retained candle is
    // the conservative observation time for the snapshot.
    const times=cmcRows(capability,body).rows.map(row=>Number(row.t)).filter(t=>Number.isFinite(t)&&t>0)
      .map(t=>t<1e12?t*1000:t).filter(t=>t<=Date.now()+300000)
    return times.length ? new Date(Math.min(...times)).toISOString() : null
  }
  // Endpoint retrieval is not a holder/tag/security/search/batch observation clock.
  if(capability?.startsWith('dex'))return null
  // RWA record updates include metadata changes. Only the USD quote clock
  // describes the market values displayed by the list and quote endpoints.
  if (capability === 'rwaList' || capability === 'rwaQuotes') {
    const quoteTimes=cmcRows(capability,body).rows.map(row=>Date.parse(String(row.quote?.last_updated||''))).filter(t=>Number.isFinite(t)&&t<=Date.now()+300000)
    return quoteTimes.length ? new Date(Math.min(...quoteTimes)).toISOString() : null
  }
  const times:string[]=[]
  function visit(v:any,depth:number) {
    if (!v || depth>6) return
    if (Array.isArray(v)) { for(const x of v.slice(0,250)) visit(x,depth+1); return }
    if(typeof v!=='object') return
    for(const [k,x] of Object.entries(v)) {
      if(['last_updated','last_update','snapshot_time','time_close','update_time','timestamp'].includes(k) && (typeof x==='string'||typeof x==='number')) {
        const numeric=typeof x==='number'||/^\d{10,13}$/.test(String(x))?Number(x):null
        const parsed=numeric!=null?(numeric<1e12?numeric*1000:numeric):Date.parse(String(x))
        if(Number.isFinite(parsed)&&parsed<=Date.now()+300000)times.push(new Date(parsed).toISOString())
      }
      else if(k!=='status' && typeof x==='object') visit(x,depth+1)
    }
  }
  visit(body,0)
  return times.length ? new Date(Math.min(...times.map(Date.parse))).toISOString() : null
}
