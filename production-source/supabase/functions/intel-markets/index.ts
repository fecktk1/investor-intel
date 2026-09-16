// Investor Intel — Markets page read API (canonical Top-N + enrichment).
//
// LIST mode: the canonical universe is `market_assets` (top-N by market cap from
// a swappable provider). CEX data (Binance/Coinbase/Kraken/KuCoin) and DEX data
// (DexScreener/GeckoTerminal via memecoin_latest_tokens) are LEFT-JOINed as
// ENRICHMENT only — a token never drops for missing CEX/DEX. CEX matching is
// confidence-gated (cex-match.ts); spread/arbitrage render ONLY at high
// confidence. Reads cached tables only — never a live provider call.
//
// DETAIL mode (?symbol): full single-asset CEX breakdown (+ on-demand candles),
// unchanged from the exchange-market layer.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { matchCexEnrichment } from '../_shared/market-assets/cex-match.ts'
import { requireIntelAccess } from '../_shared/intel/research-service.ts'
import { orgAuthzErrorResponse, type OrgActor } from '../_shared/org-authz.ts'
import { requireIntelSurface, surfaceLockedResponse } from '../_shared/intel/intel-surface-access.ts'
import { marketChain, marketCanonicalIdentity, marketIdentityChoices, verifiedNativeMarketSymbol, hasVerifiedCexIdentity, usableSpread } from '../_shared/intel/market-read-quality.ts'
import {readNativeChainPerformance} from '../_shared/intel/chain-performance-read.ts'
import { marketScreenResponse } from '../_shared/intel/markets-screen.ts'
import {resolveMarketAsset} from '../_shared/intel/market-asset-resolver.ts'
import {parseContractProviderId} from '../_shared/intel/contract-market-asset.ts'
import {loadAssetHistory,historyPlan,unavailableHistory} from '../_shared/intel/asset-history.ts'
import {realizedVolatility,maxDrawdown,distanceFromHigh,timeUnderWaterDays} from '../_shared/intel/risk-metrics.ts'
import {marketCoverage,type MarketIdentityKind} from '../_shared/intel/market-coverage.ts'
import { resolveCmcAsset } from '../_shared/intel/cmc-asset-identity.ts'
import {assetMarketRead,marketCmcIdentity} from '../_shared/intel/market-asset-source.ts'
import type {MarketAssetsContext} from '../_shared/market-assets/types.ts'
import { fetchCoingeckoOhlc } from '../_shared/market-assets/coingecko-provider.ts'
import { getChain } from '../_shared/chains.ts'
import {positionDepthQuotes} from '../_shared/intel/position-depth.ts'
import {loadCmcChart,CHART_WINDOWS,CHART_INTERVALS} from '../_shared/intel/cmc-chart.ts'
import {contractCandleLadder,klineIdentity} from '../_shared/intel/cmc-kline-chart.ts'
import {loadMarketCandles} from '../_shared/intel/market-candle-read.ts'
import {MAX_LOOKBACK_BARS} from '../_shared/intel/chart-analysis.ts'
import {autoInterval,CANDLE_RANGE_MS} from '../_shared/intel/candle-ladder.ts'
import {loadExchangeCandles} from '../_shared/intel/exchange-candles.ts'
import {archiveSeries} from '../_shared/intel/candle-archive.ts'
import {chartSeriesResponse} from '../_shared/intel/chart-series-contract.ts'
import {makeChartCaptureProof} from '../_shared/intel/chart-capture-proof.ts'
import {screenProvenance,quoteProvenance,chartProvenance,venueProvenance,curatedNewsWithEnvelopes} from '../_shared/intel/market-provenance.ts'
import {readMetricAgreement} from '../_shared/intel/metric-agreement-read.ts'
import {metricAgreementReceipt} from '../_shared/intel/metric-agreement.ts'
import { assembleEcosystemNarrativeState, assembleCatalystNewsState, assemblePublicOnchainState, assembleTokenUnlockState } from '../_shared/intel/market-enrichment.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
async function json(b: any, s = 200) {
 if(Array.isArray(b?.candles)){const series=chartSeriesResponse({...b,source:b.source||b.bestProvider});b={...b,candles:series.candles,chartSource:series.source};const asset=b.chartAsset||(b.sourceProvider&&b.providerId?`market:${b.sourceProvider}:${b.providerId}`:null);if(asset&&series.candles.length)try{b.captureProof=await makeChartCaptureProof(asset,series.candles,series.source,Deno.env.get('INTEL_CHART_PROOF_SECRET')||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'')}catch{b.captureReason='Verified chart capture is unavailable.'}}
 return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json','Cache-Control':'private, no-store' } }) }

const FRESH_MS = 5 * 60_000, STALE_MS = 60 * 60_000
function freshness(asOf: string | null, providerDegraded: boolean): 'fresh' | 'stale' | 'degraded' | 'unavailable' {
  if (!asOf) return 'unavailable'
  const age = Date.now() - new Date(asOf).getTime()
  if (providerDegraded) return 'degraded'
  if (age <= FRESH_MS) return 'fresh'
  if (age <= STALE_MS) return 'stale'
  return 'degraded'
}
const n = (v: unknown) => (typeof v === 'number' ? v : -Infinity)
/** Warm-up periods a chart request may ask for: an integer from 0 to
 * `MAX_LOOKBACK_BARS`. Provider pages cost credits, so the ceiling is the
 * ladder's own and anything outside it is treated as no warm-up rather than as
 * an error the reader sees instead of a chart. */
const lookbackBars = (value: unknown): number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_LOOKBACK_BARS ? value as number : 0

function appChainFromPlatform(platform: string): string {
  return marketChain(platform)
}

function dexEnrichment(row: Record<string, unknown>, chain: string): Record<string, unknown> {
  return {
    liquidityUsd: row.liquidity_usd ?? null,
    volume24hUsd: row.volume_24h ?? row.volume_24h_usd ?? null,
    priceUsd: row.price_usd ?? null,
    marketCap: row.market_cap ?? null,
    fdv: row.fdv ?? null,
    pairAddress: row.pair_address ?? null,
    sourceUrl: row.source_ref ?? null,
    fetchedAt: row.fetched_at ?? null,
    staleAfter: row.stale_after ?? null,
    chain,
  }
}

let marketRuntimeRequests=0
export async function handleMarkets(req:Request,clientFactory:any=createClient,readChains=readNativeChainPerformance) {
  // Cache the browser's CORS permission, never the authenticated data response.
  if (req.method === 'OPTIONS') return new Response('ok', { headers: {...corsHeaders,'Access-Control-Max-Age':'600'} })
  const started=performance.now(),trace=crypto.randomUUID(),runtime=++marketRuntimeRequests===1?'first':'reused'
  const configuredRegion=Deno.env.get('SB_REGION')||''
  const region=/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(configuredRegion)&&configuredRegion.length<=32?configuredRegion:'unknown'
  let mode='screen'
  const timings:string[]=[]
  const measured=async<T>(name:string,read:()=>PromiseLike<T>):Promise<T>=>{const start=performance.now();try{return await read()}finally{timings.push(`${name};dur=${(performance.now()-start).toFixed(1)}`)}}
  // A generated diagnostic ID is independent of user/org/request contents.
  // Total ends when the response is ready; it excludes gateway and wire time.
  const finish=async(pending:Response|Promise<Response>)=>{
    const response=await pending
    timings.push(`total;dur=${(performance.now()-started).toFixed(1)}`)
    response.headers.set('Server-Timing',[...timings,`trace;desc="${trace}"`,`region;desc="${region}"`,`runtime;desc="${runtime}"`].join(', '))
    response.headers.set('Timing-Allow-Origin','*')
    console.info('intel_markets_request',{trace,region,runtime,mode,status:response.status,timings:Object.fromEntries(timings.map(t=>{const[k,v]=t.split(';dur=');return[k,Number(v)]}))})
    return response
  }
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return finish(json({ error: 'unauthorized' }, 401))
    const admin = clientFactory(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const body = await measured('body',()=>req.json().catch(() => ({}))) as Record<string, unknown>
    const orgId = typeof body.orgId === 'string' ? body.orgId : null
    // This guard already verifies the user with Auth before membership/access.
    const actor = await measured('access',()=>requireIntelAccess(req,clientFactory,admin,orgId))
    const verifiedUserId=actor.userId
    if (!verifiedUserId) return finish(json({ error: 'unauthorized' }, 401))

    // HISTORY mode: on-demand price history + derived risk for ONE asset. Same
    // access check as detail; it is a read, so it is dispatched before it.
    if (body.history === true) {
      mode='history'
      return await finish(measured('history',()=>marketHistory(admin, String(body.symbol || '').toUpperCase().replace(/^\$/, ''), {
        sourceProvider:typeof body.sourceProvider==='string'?body.sourceProvider:undefined,
        providerId:body.providerId != null ? String(body.providerId) : undefined,
        range: typeof body.range==='string'?body.range:'90d',
      }, actor)))
    }

    if ((typeof body.symbol === 'string' && body.symbol.trim()) || (typeof body.sourceProvider === 'string' && body.providerId != null)) {
      mode='detail'
      return await finish(measured('detail',()=>marketDetail(admin, String(body.symbol || '').toUpperCase().replace(/^\$/, ''), {
        sourceProvider:typeof body.sourceProvider==='string'?body.sourceProvider:undefined,
        providerId:body.providerId != null ? String(body.providerId) : undefined,
        timeframe: typeof body.timeframe === 'string' ? body.timeframe : '7D',
        candlesOnly: body.candlesOnly === true,
        quotesOnly: body.quotesOnly === true,
        interval: typeof body.interval==='string'?body.interval:'auto',
        // Extra COMPLETED periods before the window, so a study on the chart has
        // a value at the first visible bar. Anything that is not an integer in
        // range is no warm-up at all, never a rejected chart.
        lookbackBars: lookbackBars(body.lookbackBars),
        orgId,userId:verifiedUserId,
      })))
    }

    // One bounded, authenticated cached-data screen. PostgreSQL applies filters,
    // derived views, ordering and global summaries before any rows cross the wire.
    const [{ data: screen, error: screenError },nativeChains] = await Promise.all([measured<any>('screen',()=>admin.rpc('intel_markets_screen_for_user', { p_org_id: orgId, p_user_id: actor.userId, p_query: body })),measured('native',()=>readChains(admin).catch(()=>({rows:[],unavailable:true})))])
    if (screenError) {
      console.warn('[intel-markets-screen]', { code: screenError.code, message: screenError.message })
      const status = screenError.code === '42501' ? 403 : ['22023', '22P02'].includes(screenError.code) ? 400 : 503
      return finish(json({ error: status === 503 ? 'market_snapshot_unavailable' : screenError.message }, status))
    }
    if (!screen) return finish(json({ error: 'market_snapshot_unavailable' }, 503))
    return await finish(measured('assemble',()=>{
      const formatted=marketScreenResponse(screen)
      // The screen is the stored catalogue, so its receipt describes that stored
      // snapshot. Assembled from the page already read: no extra read or call.
      const {receipt,figureProvenance}=screenProvenance(formatted)
      return json({...formatted,receipt,figureProvenance,nativeChains:nativeChains.rows,nativeChainsUnavailable:nativeChains.unavailable})
    }))
  } catch (e) {
    const locked=surfaceLockedResponse(e,corsHeaders);if(locked)return finish(locked)
    const denied=orgAuthzErrorResponse(e,corsHeaders);if(denied)return finish(denied)
    return finish(json({ error: (e as Error)?.message || 'intel_markets_failed' }, 500))
  }
}
if(import.meta.main)Deno.serve(req=>handleMarkets(req))

// ─── DETAIL mode (CEX breakdown + on-demand candles) ─────────────────────────
//
// The ladder and its bounds live in `_shared/intel/market-candle-read.ts`; this
// function is the WIRING that gives each rung its real dependencies. Source
// order for every identity: the free public exchange registry first (when the
// asset has a verified exchange identity), then CoinMarketCap OHLCV, then the
// DEX k-line aggregate for a contract, then the CoinGecko window — with the
// stored daily archive merged under the long ranges.
//
// A same-symbol market is still never a substitute history: the exchange rung is
// offered ONLY on a confidence-gated verified identity, so a pasted contract
// reaches the k-line rung first exactly as before.
/** Days of CoinGecko OHLC a range asks for. Its spacing is the provider's own
 * and is never relabelled as a candle width. */
const COINGECKO_DAYS: Record<string, number> = { '1H':1,'12H':1,'24H':1,'3D':7,'7D':7,'1M':30,'3M':90,'6M':180,'1Y':365,'2Y':365,'5Y':365,'ALL':365 }
const RANGE_DAYS: Record<string, number> = { '1H':1/24,'12H':.5,'24H':1,'3D':3,'7D':7,'1M':30,'3M':90,'6M':180,'1Y':365,'2Y':730,'5Y':1825,'ALL':7300 }
/** The CoinGecko window is asked for in DAYS, so the warm-up is converted from
 * periods to days at the automatic width of the timeframe and rounded up. The
 * provider's own longest OHLC window is a year, so the total is capped there. */
function coingeckoLookbackDays(timeframe: string, lookback: number): number {
  const periods = Number.isFinite(Number(lookback)) ? Math.max(0, Math.trunc(Number(lookback))) : 0
  if (!periods) return 0
  const step = CHART_INTERVALS[autoInterval(CANDLE_RANGE_MS[timeframe] || 0)] || 3600000
  return Math.ceil(periods * step / 86400000)
}
// deno-lint-ignore no-explicit-any
async function coingeckoCandles(admin: any, canonical: any, timeframe: string, lookback = 0) {
  const extraDays = coingeckoLookbackDays(timeframe, lookback)
  const days = Math.min(365, (COINGECKO_DAYS[timeframe] || 7) + extraDays)
  const rows = await fetchCoingeckoOhlc(String(canonical.provider_id), days, { supabase: admin, jobName: 'intel-markets-detail', caller: 'canonical-chart', kind: 'request' }).catch(() => null)
  const end = Date.now(), start = end - ((RANGE_DAYS[timeframe] || 7) + extraDays) * 86400000
  // deno-lint-ignore no-explicit-any
  const candles = Array.isArray(rows) ? rows.filter((row:any) => Number(row[0]) >= start && Number(row[0]) <= end).map((row:any) => ({t:Number(row[0]),o:Number(row[1]),h:Number(row[2]),l:Number(row[3]),c:Number(row[4]),v:null})) : []
  return { candles, source: 'coingecko', bestPair: null, bestProvider: candles.length ? 'coingecko' : null, sourceReason: candles.length ? null : 'no_completed_candles' }
}

// `lookback` is extra COMPLETED periods before the window, so a study drawn on
// the chart has a value at the first visible bar instead of an empty warm-up.
// Every rung receives it, and every rung serves the window first.
// deno-lint-ignore no-explicit-any
async function assetCandles(admin: any, canonical: any, verified: boolean, timeframe: string, interval='auto',context:MarketAssetsContext={},lookback=0) {
  const identityKey = marketCanonicalIdentity(canonical).canonicalAssetKey || (canonical?.source_provider && canonical?.provider_id != null ? `market:${canonical.source_provider}:${canonical.provider_id}` : null)
  return loadMarketCandles({
    assetKey: identityKey,
    symbol: canonical?.normalized_symbol ? String(canonical.normalized_symbol) : null,
    cexVerified: verified,
    cmcId: marketCmcIdentity(canonical),
    klineIdentity: canonical?.source_provider === 'contract' && !!klineIdentity(canonical),
    coingeckoId: canonical?.source_provider === 'coingecko' && canonical?.provider_id != null,
  }, timeframe, interval, Date.now(), {
    exchange: (range, width, lb) => loadExchangeCandles(admin, String(canonical?.normalized_symbol || ''), range, width, Date.now(), undefined, lb),
    cmc: (id, range, width, lb) => loadCmcChart(admin, id, range, width, Date.now(), undefined, context, lb),
    kline: (range, width, lb) => contractCandleLadder(admin, canonical, range, width, context, undefined, Date.now(), lb),
    coingecko: (lb) => coingeckoCandles(admin, canonical, timeframe, lb),
    archive: (assetKey, width, from, to) => archiveSeries(admin, assetKey, width, from, to),
  }, lookback)
}

// deno-lint-ignore no-explicit-any
async function latestDexSnapshotForPlatforms(admin: any, platforms: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  if (!platforms) return null
  for (const [platform, address] of Object.entries(platforms)) {
    const addr = String(address || '').trim()
    if (!addr) continue
    const appChain = appChainFromPlatform(platform)
    const candidates = getChain(appChain)?.evmChainId != null ? [...new Set([addr, addr.toLowerCase()])] : [addr]
    for (const tokenAddress of candidates) {
      try {
        const { data } = await admin.from('dex_pair_snapshots')
          .select('chain, token_address, pair_address, price_usd, liquidity_usd, volume_24h, market_cap, fdv, source_ref, fetched_at, stale_after')
          .eq('chain', appChain)
          .eq('token_address', tokenAddress)
          .order('fetched_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (data) return data
      } catch {
        return null
      }
    }
  }
  return null
}

// Bare symbols must be unique. A requested CMC ID may resolve from the governed
// quote/metadata snapshots when the current canonical universe uses CoinGecko.
// The resulting row is a response projection, never a synthetic database insert.
// deno-lint-ignore no-explicit-any
// deno-lint-ignore no-explicit-any
async function marketDetail(admin: any, sym: string, opts: { timeframe?: string; interval?:string; lookbackBars?:number; candlesOnly?: boolean; quotesOnly?:boolean; sourceProvider?:string; providerId?:string;orgId?:string|null;userId?:string } = {}): Promise<Response> {
  const timeframe = opts.timeframe || '7D'
  const interval = opts.interval || 'auto'
  // Re-validated here, so a direct caller of `marketDetail` cannot ask a provider
  // for an unbounded warm-up.
  const lookback = lookbackBars(opts.lookbackBars)
  // EVERY identity may ask for every width. The four sub-hour widths used to be
  // refused outside a contract identity because the k-line aggregate was the only
  // source that could sample them; the free public exchange registry samples them
  // for any pair a venue lists, so the LADDER now decides whether a width can be
  // served and the coverage sentence names the width that WAS served. A width no
  // source can sample is answered at the finest width one of them can, said
  // plainly — never relabelled. Only a range or width outside the vocabulary
  // itself is still a 400.
  if(!CHART_WINDOWS[timeframe]||(interval!=='auto'&&!CHART_INTERVALS[interval]))return json({error:'invalid_chart_range'},400)
  const resolved=await resolveMarketAsset(admin,sym,opts.sourceProvider,opts.providerId)
  if(resolved.ambiguous)return json({error:'ambiguous_asset',symbol:sym},409)
  if(resolved.error)return json({error:'identity_unavailable'},503)
  if(!resolved.data)return json({error:'asset_not_found',symbol:sym},404)
  const context={supabase:admin,orgId:opts.orgId,userId:opts.userId,kind:'request' as const,waitForFresh:opts.quotesOnly===true}
  const cmcId=marketCmcIdentity(resolved.data)
  const cmc=cmcId&&!opts.candlesOnly?await resolveCmcAsset(admin,cmcId,undefined,context):null
  const quote=assetMarketRead(resolved.data,cmc?.data)
  const quoteReason=cmc?.error||resolved.data.quote_reason||null
  // What answered the quote rides in the body. The CMC receipts were produced by
  // the reads above; nothing new is requested to build them.
  const quoteRead=quoteProvenance(quote,cmc?.receipts||[])
  if(opts.quotesOnly)return json({...quote,sourceProvider:resolved.data.source_provider,providerId:resolved.data.provider_id,quoteReason,quoteReceipts:quoteRead.receipts,quoteProvenance:quoteRead.figureProvenance})
  sym=String(resolved.data.normalized_symbol || resolved.data.symbol || sym).toUpperCase()
  const [identityProfile,identityMapping,claimants]=await Promise.all([
    admin.from('exchange_latest_asset_profiles').select('*').eq('normalized_symbol',sym).maybeSingle(),
    admin.from('exchange_asset_mappings').select('*').eq('normalized_symbol',sym).eq('is_active',true).maybeSingle(),
    admin.from('market_assets').select('provider_id',{count:'exact',head:true}).eq('normalized_symbol',sym),
  ])
  const identityMatch=matchCexEnrichment({normalizedSymbol:sym,providerId:resolved.data.provider_id,platforms:resolved.data.platforms},{profileBySym:new Map(identityProfile.data?[[sym,identityProfile.data]]:[]),mappingBySym:new Map(identityMapping.data?[[sym,identityMapping.data]]:[]),symbolCounts:new Map([[sym,claimants.count??2]])})
  const cexVerified=hasVerifiedCexIdentity(resolved.data,identityMapping.data) && (identityMatch.confidence==='high'||!!verifiedNativeMarketSymbol(resolved.data))
  // Lightweight path for chart timeframe cycling — candles only, no full assembly.
  if (opts.candlesOnly) {
    const c = await assetCandles(admin, resolved.data, cexVerified, timeframe,interval,context,lookback)
    return json({ ...c, timeframe,lookbackBars:lookback,chartAsset:marketCanonicalIdentity(resolved.data).canonicalAssetKey||`market:${resolved.data.source_provider}:${resolved.data.provider_id}` })
  }
  const [profR, sigR, capR, sprR, rollR, tickR, provSigR, bookR, memR, maR] = await Promise.all([
    admin.from('exchange_latest_asset_profiles').select('*').eq('normalized_symbol', sym).maybeSingle(),
    admin.from('exchange_latest_market_signals').select('*').eq('normalized_symbol', sym).maybeSingle(),
    admin.from('exchange_latest_market_caps').select('*').eq('normalized_symbol', sym).maybeSingle(),
    admin.from('exchange_latest_cross_market_spreads').select('*').eq('normalized_symbol', sym).maybeSingle(),
    admin.from('exchange_market_rollups').select('*').eq('normalized_symbol', sym),
    admin.from('exchange_latest_tickers').select('*').eq('normalized_symbol', sym),
    admin.from('exchange_latest_provider_market_signals').select('provider, direction, strength, confidence, signal_type, factors, raw_metrics, as_of').eq('normalized_symbol', sym).order('as_of', { ascending: false }).limit(24),
    admin.from('exchange_latest_orderbook').select('*').eq('normalized_symbol', sym).order('as_of', { ascending: false }).limit(8),
    admin.from('exchange_market_memory').select('summary, why_it_matters, memory_type, as_of').eq('normalized_symbol', sym).eq('is_active', true).order('as_of', { ascending: false }).limit(1),
    Promise.resolve(resolved),
  ])
  if(!cexVerified){for(const result of [profR,sigR,capR,sprR])result.data=null;for(const result of [rollR,tickR,provSigR,bookR,memR])result.data=[]}
  const canonical = maR.data
  if (!profR.data && !sigR.data && !(tickR.data || []).length && !canonical) return json({ error: 'asset_not_found', symbol: sym }, 404)

  // deno-lint-ignore no-explicit-any
  const provSig = new Map<string, any>()
  for (const s of (provSigR.data || [])) if (!provSig.has(s.provider)) provSig.set(s.provider, s)
  // deno-lint-ignore no-explicit-any
  const tickByProv = new Map<string, any>((tickR.data || []).map((t: any) => [t.provider, t]))
  // deno-lint-ignore no-explicit-any
  const bookByProv = new Map<string, any>((bookR.data || []).map((b: any) => [b.provider, b]))
  const providers = [...new Set([...(tickR.data || []).map((t: any) => t.provider), ...provSig.keys()])].map((p) => {
    const t = tickByProv.get(p); const s = provSig.get(p)
    const b = bookByProv.get(p)
    return { provider: p, providerSymbol: t?.provider_symbol ?? b?.provider_symbol ?? null, price: t?.price ?? null, change24h: t?.price_change_pct_24h ?? null, volume24h: t?.volume_quote_24h ?? null, spreadPct: t?.spread_pct ?? b?.spread_pct ?? null, direction: s?.direction ?? null, strength: s?.strength ?? null, confidence: s?.confidence ?? null, factors: s?.factors || [], orderbook: b ? { depthLevel: b.depth_level, bidDepthUsd: b.bid_depth_usd, askDepthUsd: b.ask_depth_usd, imbalancePct: b.imbalance_pct, bidPrice: b.bid_price, askPrice: b.ask_price, asOf: b.as_of } : null }
  }).sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))

  const orderbookRows = [...(bookR.data || [])].sort((a, b) => ((b.bid_depth_usd || 0) + (b.ask_depth_usd || 0)) - ((a.bid_depth_usd || 0) + (a.ask_depth_usd || 0)))
  const orderbook = orderbookRows.length ? {
    providerCount: orderbookRows.length,
    totalBidDepthUsd: orderbookRows.reduce((s, r) => s + (Number(r.bid_depth_usd) || 0), 0),
    totalAskDepthUsd: orderbookRows.reduce((s, r) => s + (Number(r.ask_depth_usd) || 0), 0),
    bestDepthProvider: orderbookRows[0]?.provider || null,
    minSpreadPct: orderbookRows.map((r) => Number(r.spread_pct)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b)[0] ?? null,
    asOf: orderbookRows.reduce((m, r) => r.as_of && r.as_of > m ? r.as_of : m, ''),
    providers: orderbookRows.map((r) => ({ provider: r.provider, providerSymbol: r.provider_symbol, depthLevel: r.depth_level, bidPrice: r.bid_price, askPrice: r.ask_price, bidDepthUsd: r.bid_depth_usd, askDepthUsd: r.ask_depth_usd, imbalancePct: r.imbalance_pct, spreadPct: r.spread_pct, asOf: r.as_of })),
  } : null

  // deno-lint-ignore no-explicit-any
  const rollups: Record<string, any> = {}
  for (const r of (rollR.data || [])) rollups[r.timeframe] = r
  const chart = await assetCandles(admin, canonical, cexVerified, timeframe,interval,context,lookback)
  const { candles, bestPair, bestProvider } = chart
  const prof = profR.data, sig = sigR.data
  const canonicalPlatforms = canonical?.platforms && typeof canonical.platforms === 'object' ? canonical.platforms as Record<string, unknown> : null
  const dexSnapshot = await latestDexSnapshotForPlatforms(admin, canonicalPlatforms)
  const dex = dexSnapshot ? dexEnrichment(dexSnapshot, String(dexSnapshot.chain || '')) : null

  // Enrichment for the always-visible cards (ecosystem narratives, curated news +
  // catalysts, public on-chain activity). The SAME helpers feed the AI evidence
  // pack, so the cards and the "Explain why" read draw on identical data. Each
  // degrades to a 'missing' status; on-chain may make a budgeted live Birdeye call.
  const ecoChain = quote.chain
  const onchainChain = String(dexSnapshot?.chain || ecoChain || '').toLowerCase() || null
  // A contract identity always knows its own address, even with no cached pair.
  const onchainAddress = dexSnapshot?.token_address ? String(dexSnapshot.token_address) : canonical?.contract?.address ? String(canonical.contract.address) : null
  const [ecosystemNarratives, catalystRead, onchain, unlocks] = await Promise.all([
    assembleEcosystemNarrativeState(admin, { chain: ecoChain, symbol: sym }),
    assembleCatalystNewsState(admin, { symbol: sym, chain: ecoChain }),
    assemblePublicOnchainState({
      chain: onchainChain,
      tokenAddress: onchainAddress,
      allowLive: true,
      nowIso: new Date().toISOString(),
      birdeyeCtx: { supabase: admin, jobName: 'intel-markets', caller: 'market-detail', kind: 'request' },
    }),
    assembleTokenUnlockState(admin, { symbol: sym, nowMs: Date.now() }),
  ])
  // Play 7: a curated story past its review window is its own kind on this page.
  const catalysts = { ...catalystRead, curated_news: curatedNewsWithEnvelopes(catalystRead.curated_news) }

  const payload = {
    detail: true, symbol: sym, ...quote,
    // Canonical identity → lets the detail page load the rich CoinGecko profile.
    providerId: canonical?.provider_id ?? null, sourceProvider: canonical?.source_provider ?? null, primaryChain: canonical?.primary_chain ?? null,
    signal: sig ? { direction: sig.direction, strength: sig.strength, confidence: sig.confidence, signalType: sig.signal_type, title: sig.title, summary: sig.summary, whyItMatters: sig.why_it_matters, factors: sig.factors || [], confirmingProviders: sig.confirming_providers || [], conflictingProviders: sig.conflicting_providers || [], providerCount: sig.provider_count } : null,
    profile: prof ? { liquidityScore: prof.liquidity_score, retailRelevanceScore: prof.retail_relevance_score, marketQualityScore: prof.market_quality_score, trendScore: prof.trend_score, bestGlobalPair: prof.best_global_pair, bestUsRetailPair: prof.best_us_retail_pair } : null,
    ...marketCanonicalIdentity(canonical),
    identityChoices: marketIdentityChoices(canonical),
    sourceFreshness:quote.sourceFreshness||freshness(quote.asOf,false),quoteReason,
    cexCoverage:cexVerified&&providers.length?'available':'unverified',
    depthQuotes:positionDepthQuotes(canonical,cexVerified,bookR.data||[],tickR.data||[]),
    spread: cexVerified && usableSpread(sprR.data) ? sprR.data : null, orderbook, rollups, providers, dex,
    memorySummary: memR.data?.[0]?.summary || null,
    ecosystemNarratives, catalysts, onchain, unlocks,
    ...chart,chartAsset:marketCanonicalIdentity(canonical).canonicalAssetKey||`market:${canonical.source_provider}:${canonical.provider_id}`, candles, bestPair, bestProvider, chartCoverage: 'coverage' in chart ? chart.coverage : null,
    chartState: 'sourceState' in chart ? chart.sourceState : null,
    chartReason: 'sourceReason' in chart ? chart.sourceReason : null,
    chartProvenance: 'provenance' in chart ? chart.provenance : null,
    // The on-chain workspace for a pasted contract — present ONLY for a
    // contract identity, so catalogue responses are unchanged.
    ...(canonical?.contract ? { contract: canonical.contract } : {}),
  }
  // Every identity reports the SAME section list: what is present, and why the
  // rest is not. Sections are never dropped for a less-covered asset.
  const identity = detailIdentity(canonical, quote.chain)
  // Play 4: the evidentiary standard for this asset's move, read from retained
  // observations only (no provider call, no credit). A non-CMC identity has no
  // dated observations to test, so it carries no verdict at all.
  let metricAgreement=null
  if(cmcId)try{metricAgreement=metricAgreementReceipt(await readMetricAgreement(admin,`market:coinmarketcap:${cmcId}`,Date.now()))}catch{/* additive */}
  // Play 1 and 7: receipts and one provenance envelope per figure group.
  const chartRead=chartProvenance(chart)
  const figureProvenance={...quoteRead.figureProvenance,...venueProvenance({tickers:tickR.data||[],orderbookAsOf:orderbook?.asOf||null,dex}),chart:chartRead.envelope}
  return json({ ...payload, identity, coverage: marketCoverage(payload, { identityKind: identity.kind, cmcId }), quoteReceipts:quoteRead.receipts, quoteProvenance:quoteRead.figureProvenance, chartReceipts:chartRead.receipts, figureProvenance, metricAgreement })
}

// ─── HISTORY mode (on-demand history + derived risk) ─────────────────────────
// One range is one provider sampling, charged to the shared credit budget. A
// pasted contract has no CoinMarketCap listing: it is answered from its own
// identity, with no provider call and no metrics invented from nothing.
const NO_RISK_METRICS = { volatility30d: null, maxDrawdown: null, distanceFromHigh: null, timeUnderWaterDays: null }
// deno-lint-ignore no-explicit-any
async function marketHistory(admin: any, sym: string, opts: { range?: string; sourceProvider?: string; providerId?: string } = {}, actor: OrgActor): Promise<Response> {
  const range = opts.range || '90d'
  if (!historyPlan(range)) return json({ error: 'invalid_history_range' }, 400)
  if (opts.sourceProvider === 'contract') {
    const parsed = opts.providerId ? parseContractProviderId(opts.providerId) : null
    if (!parsed) return json({ error: 'invalid_provider' }, 400)
    return json({ history: unavailableHistory(range, 'no_coinmarketcap_listing'), metrics: NO_RISK_METRICS,
      identity: { kind: 'contract' as const, provider: 'contract', providerId: `${parsed.chain}:${parsed.address}`, chain: parsed.chain, address: parsed.address } })
  }
  const resolved = await resolveMarketAsset(admin, sym, opts.sourceProvider, opts.providerId)
  if (resolved.ambiguous) return json({ error: 'ambiguous_asset', symbol: sym }, 409)
  if (resolved.error) return json({ error: 'identity_unavailable' }, 503)
  if (!resolved.data) return json({ error: 'asset_not_found', symbol: sym }, 404)
  const identity = detailIdentity(resolved.data, null)
  const cmcId = marketCmcIdentity(resolved.data)
  if (!cmcId) return json({ history: unavailableHistory(range, 'no_coinmarketcap_listing'), metrics: NO_RISK_METRICS, identity })
  // Everything above answers from identity alone and spends nothing. The next
  // line is the provider sampling, charged to the shared credit budget for this
  // member, so the tier is checked here rather than at the top: a free member
  // keeps the identity answers and is refused only the part that costs.
  await requireIntelSurface(admin, actor, 'market_history')
  const history = await loadAssetHistory(admin, { cmcId, range, ctx: { caller: 'market-history' } })
  const now = Date.now()
  const metrics = history.points.length ? {
    volatility30d: realizedVolatility(history.points),
    maxDrawdown: maxDrawdown(history.points),
    distanceFromHigh: distanceFromHigh(history.points, now),
    timeUnderWaterDays: timeUnderWaterDays(history.points),
  } : NO_RISK_METRICS
  return json({ history, metrics, identity })
}

/** Exact provider identity for the page — a contract is one chain + one address. */
// deno-lint-ignore no-explicit-any
function detailIdentity(asset: any, quoteChain: string | null): { kind: MarketIdentityKind; provider: string | null; providerId: string | null; chain: string | null; address: string | null } {
  const provider = asset?.source_provider ? String(asset.source_provider) : null
  const kind: MarketIdentityKind = provider === 'contract' ? 'contract' : provider === 'coinmarketcap' ? 'cmc' : 'coingecko'
  const chain = asset?.contract?.chain ? String(asset.contract.chain) : quoteChain || asset?.primary_chain || null
  let address: string | null = asset?.contract?.address ? String(asset.contract.address) : null
  if (!address) {
    const entries = Object.entries(asset?.platforms || {}).filter(([platform, value]) => typeof value === 'string' && value && (!chain || marketChain(platform) === chain))
    if (entries.length === 1) address = String(entries[0][1])
  }
  return { kind, provider, providerId: asset?.provider_id != null ? String(asset.provider_id) : null, chain, address }
}
