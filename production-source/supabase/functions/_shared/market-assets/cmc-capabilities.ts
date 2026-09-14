import {isCmcDexCursor,isDexDiscovery,cmcDexNetwork,cmcDexAddress,CMC_DEX_NETWORKS} from './cmc-dex.ts'
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
    const s = String(value)
    if (s.length>(['id','crypto_id','rwa_id','exchange_id'].includes(key)?4000:500) || /[\u0000-\u001f]/.test(s)) throw new Error(`invalid_parameter:${key}`)
    if (['start','limit','count'].includes(key) && (!/^\d+$/.test(s) || Number(s)<1 || Number(s)>(key==='start'?5000:250))) throw new Error(`invalid_parameter:${key}`)
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
  }else if(name.startsWith('dex')&&name!=='dexPlatforms') {
    // Only verified platform aliases. A symbol is never an on-chain identity.
    const platform=out.platform??out.platformName,address=out.address??out.tokenAddress
    if(!cmcDexNetwork(platform))throw new Error('unverified_dex_platform')
    if(!cmcDexAddress(address,platform))throw new Error('invalid_contract_address')
    if(name==='dexPools'){out.size||='12';if(!/^[1-9][0-9]*$/.test(out.size)||Number(out.size)>25)throw new Error('invalid_pool_page_size')}
    if(name==='dexHolderHistory'){out.interval||='1d';if(out.interval!=='1d')throw new Error('invalid_holder_interval')}
    if(out.lastId&&!isCmcDexCursor(out.lastId))throw new Error('invalid_dex_cursor')
  }
  if(['globalHistory','cmc100History','cmc20History'].includes(name)) {
    out.count||=name==='globalHistory'?'30':'10';out.interval||='daily'
    if(out.interval!=='daily')throw new Error('history_requires_daily_interval')
    if(out.time_start)throw new Error('history_requires_end_and_count')
    if(name!=='globalHistory'&&Number(out.count)>10)throw new Error('maximum_index_observations_10')
  }
  if (['history','ohlcv'].includes(name)) {
    // Single-asset pages stay bounded. OHLCV sampling must equal the candle
    // period; interval=4h samples 1h candles and is NOT a four-hour aggregation.
    if (out.id?.includes(',')) throw new Error('history_requires_single_id')
    out.count ||= '90'; out.interval ||= 'daily'
    const hourly=name==='ohlcv'&&out.time_period==='hourly'&&out.interval==='hourly'
    if(!hourly&&(out.interval!=='daily' || (out.time_period && out.time_period!=='daily'))) throw new Error('history_requires_daily_interval')
    if (out.time_start && out.time_end && Date.parse(out.time_end)<Date.parse(out.time_start)) throw new Error('invalid_time_window')
    if (out.time_start && (Date.parse(out.time_end || new Date().toISOString())-Date.parse(out.time_start)>(Number(out.count)-1)*(hourly?3600000:86400000))) throw new Error('history_window_too_large')
  }
  if (spec.params.includes('limit')) out.limit ||= name==='community'?'5':'100'
  if (spec.params.includes('start')) out.start ||= '1'
  return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)))
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
  if(capability?.startsWith('dex'))return null // Endpoint retrieval is not a holder/security observation clock.
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
