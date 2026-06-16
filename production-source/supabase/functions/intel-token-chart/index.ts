// Investor Intel — token chart + live snapshot.
// Returns OHLCV candles plus a current market overview for the token
// intelligence page (chart + stats + analysis + news).
//   • Degen / contract by app `chain:address` (synthetic entity, no org row) →
//     GeckoTerminal OHLCV (free, pool-based, resilient) + overview from cached
//     memecoin data / DexScreener. NEVER auto-calls Birdeye.
//   • Tokens with a contract (resolved entity) → Birdeye (liquidity-grade) when
//     enabled, else GeckoTerminal fallback for supported chains.
//   • Native coins / no contract → CoinGecko. ref='native:<chainId>' needs NO entity row.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { birdeyeChainFor, birdeyeOverview } from '../_shared/intel-providers.ts'
import { birdeyeGet, type BirdeyeContext } from '../_shared/birdeye-client.ts'
import { CHAINS, CHAIN_COINGECKO, CHAIN_PROVIDERS, chainIdFor, getChain } from '../_shared/chains.ts'
import { getOhlcv, getTokenPools } from '../_shared/memecoin/geckoterminal.ts'
import { getTokenPairs } from '../_shared/memecoin/dexscreener.ts'
import { fetchCoingeckoOhlc, fetchCoingeckoSimplePrice } from '../_shared/market-assets/coingecko-provider.ts'
import type { MarketAssetsContext } from '../_shared/market-assets/types.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }
const num = (v: unknown) => v == null || Number.isNaN(Number(v)) ? null : Number(v)

const TF: Record<string, { type: string; days: number; cgDays: number }> = {
  '1H': { type: '1H', days: 7, cgDays: 1 }, '4H': { type: '4H', days: 30, cgDays: 7 },
  '1D': { type: '1D', days: 180, cgDays: 30 }, '1W': { type: '1W', days: 365, cgDays: 365 },
}

async function coingeckoChart(cgId: string, timeframe: string, ctx?: MarketAssetsContext) {
  const tf = TF[timeframe] || TF['1D']
  const [ohlcRows, priceData] = await Promise.all([
    fetchCoingeckoOhlc(cgId, tf.cgDays, ctx).catch(() => null),
    fetchCoingeckoSimplePrice([cgId], { includeMarketCap: true, include24hVol: true, include24hChange: true, ttlMs: 90_000, ctx }).catch(() => null),
  ])
  // deno-lint-ignore no-explicit-any
  let candles: any[] = []
  if (Array.isArray(ohlcRows)) candles = ohlcRows.map((r: any) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: null })).filter((c: any) => c.c != null)
  // deno-lint-ignore no-explicit-any
  let overview: any = null
  const d = (priceData as Record<string, any> | null)?.[cgId]
  if (d) overview = { price: num(d.usd), market_cap: num(d.usd_market_cap), fdv: null, liquidity: null, volume_24h_usd: num(d.usd_24h_vol), holders: null, price_change_24h_pct: num(d.usd_24h_change) }
  return { overview, candles }
}

// deno-lint-ignore no-explicit-any
async function latestDexPairSnapshot(admin: any, chain: string, address: string): Promise<any | null> {
  const candidates = [...new Set([address, chain === 'solana' || chain === 'sui' ? null : address.toLowerCase()].filter(Boolean) as string[])]
  for (const tokenAddress of candidates) {
    try {
      const { data } = await admin.from('dex_pair_snapshots')
        .select('*')
        .eq('chain', chain)
        .eq('token_address', tokenAddress)
        .order('fetched_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (data) return data
    } catch { return null }
  }
  return null
}

// deno-lint-ignore no-explicit-any
async function latestOhlcvSnapshot(admin: any, chain: string, address: string, timeframe: string): Promise<any | null> {
  const candidates = [...new Set([address, chain === 'solana' || chain === 'sui' ? null : address.toLowerCase()].filter(Boolean) as string[])]
  for (const tokenAddress of candidates) {
    try {
      const { data } = await admin.from('pool_ohlcv_snapshots')
        .select('*')
        .eq('chain', chain)
        .eq('token_address', tokenAddress)
        .eq('timeframe', timeframe)
        .order('fetched_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (Array.isArray(data?.candles) && data.candles.length) return data
    } catch { return null }
  }
  return null
}

function dexSnapshotOverview(row: Record<string, unknown> | null | undefined) {
  if (!row) return null
  return {
    price: num(row.price_usd),
    market_cap: num(row.market_cap),
    fdv: num(row.fdv),
    liquidity: num(row.liquidity_usd),
    volume_24h_usd: num(row.volume_24h),
    holders: null,
    price_change_24h_pct: num((row.price_change as Record<string, unknown> | null)?.h24),
  }
}

// Degen / contract token chart by app chain id + address. Free + resilient:
// validate the cached pool against GeckoTerminal, else pick the best GT pool,
// else DexScreener overview-only with a clean unsupported state. No Birdeye.
async function degenChart(chain: string, address: string, timeframe: string): Promise<Response> {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const ctx = { supabase: admin, jobName: 'intel-token-chart', kind: 'request' as const, chain, tokenAddress: address }
  const dsId = CHAIN_PROVIDERS[chain]?.dexscreener || chain
  const gtNet = CHAIN_PROVIDERS[chain]?.geckoterminal
  const nowIso = new Date().toISOString()

  const { data: row } = await admin.from('memecoin_latest_tokens').select('*').eq('chain', chain).eq('token_address', address).maybeSingle()
  const dexSnapshot = await latestDexPairSnapshot(admin, chain, address)
  // deno-lint-ignore no-explicit-any
  let ov: any = dexSnapshotOverview(dexSnapshot) || (row ? { price: num(row.price_usd), market_cap: num(row.market_cap), fdv: num(row.fdv), liquidity: num(row.liquidity_usd), volume_24h_usd: num(row.volume_24h_usd), holders: null, price_change_24h_pct: num(row.change_24h_pct) } : null)
  let pool: string | null = dexSnapshot?.pair_address || row?.pair_address || null
  let dexId: string | null = dexSnapshot?.dex_id || row?.dex_id || null
  let pairUrl: string | null = pool ? `https://dexscreener.com/${dsId}/${pool}` : null
  // deno-lint-ignore no-explicit-any
  let candles: any[] = []
  const ohlcvSnapshot = await latestOhlcvSnapshot(admin, chain, address, timeframe)
  if (ohlcvSnapshot) {
    candles = ohlcvSnapshot.candles
    pool = ohlcvSnapshot.pool_or_token_address || pool
    pairUrl = ohlcvSnapshot.source_ref || (pool ? `https://www.geckoterminal.com/${gtNet}/pools/${pool}` : pairUrl)
  }

  // 1) validate cached pair_address against GeckoTerminal
  if (!candles.length && pool) candles = await getOhlcv(chain, pool, timeframe, ctx)
  // 2) no candles → choose the best GeckoTerminal pool for the token
  if (!candles.length) {
    const pools = await getTokenPools(chain, address, ctx)
    if (pools.length) { pool = pools[0].address; dexId = pools[0].dexId || dexId; pairUrl = `https://www.geckoterminal.com/${gtNet}/pools/${pool}`; candles = await getOhlcv(chain, pool, timeframe, ctx) }
  }
  // 3) overview fallback from DexScreener if we had no cached row
  if (!ov || ov.price == null) {
    const t = await getTokenPairs(chain, address, ctx)
    if (t) {
      ov = { price: num(t.priceUsd), market_cap: num(t.marketCap), fdv: num(t.fdv), liquidity: num(t.liquidityUsd), volume_24h_usd: num(t.volume24hUsd), holders: null, price_change_24h_pct: num(t.change24hPct) }
      if (!candles.length && t.pairAddress) { pool = t.pairAddress; dexId = t.dexId || dexId; pairUrl = `https://dexscreener.com/${dsId}/${t.pairAddress}`; candles = await getOhlcv(chain, pool, timeframe, ctx) }
    }
  }

  const entity = { symbol: row?.symbol ?? null, name: row?.name ?? null, ref: `${chain}:${address}`, chain }
  if (candles.length && pool) {
    return json({ entity, overview: ov, candles, timeframe, source: 'geckoterminal', source_label: 'GeckoTerminal', source_url: gtNet ? `https://www.geckoterminal.com/${gtNet}/pools/${pool}` : null, pool_address: pool, dex_id: dexId, pair_url: pairUrl, as_of: nowIso, last_refreshed_at: ohlcvSnapshot?.fetched_at ?? dexSnapshot?.fetched_at ?? row?.last_refreshed_at ?? nowIso })
  }
  // No verified pool → clean unsupported state (overview-only). Never break the page.
  const state = (row?.listing_state === 'pre_liquidity' || row?.is_new) ? 'pre_liquidity' : (row?.is_migrated ? 'pool_pending' : 'no_pool')
  return json({ entity, overview: ov, candles: [], timeframe, unsupported: true, state, source: ov ? 'dexscreener' : null, source_label: ov ? 'DEX Screener' : null, pair_url: pairUrl, pool_address: pool, dex_id: dexId, as_of: nowIso })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No authorization header' }, 401)
    const { orgId, entityId = null, ref = null, timeframe = '1D' } = await req.json() || {}
    if (!orgId || (!entityId && !ref)) return json({ error: 'orgId and entityId|ref required' }, 400)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const marketCtx: MarketAssetsContext = { supabase: admin, jobName: 'intel-token-chart', caller: 'token-chart', kind: 'request' }

    // Native chain coin (ref='native:<chainId>') — chart via CoinGecko, no entity row.
    if (typeof ref === 'string' && ref.startsWith('native:')) {
      const cid = ref.slice('native:'.length)
      const ch = CHAINS.find((c) => c.id === cid)
      const cg = CHAIN_COINGECKO[cid]
      if (ch && cg) {
        const { overview, candles } = await coingeckoChart(cg, timeframe, marketCtx)
        return json({ entity: { symbol: ch.nativeSymbol, name: ch.label, ref, chain: cid, native: true }, overview, candles, timeframe, source: 'coingecko' })
      }
      return json({ entity: { ref, chain: cid }, overview: null, candles: [], timeframe, unsupported: true })
    }

    // Degen / contract by app `chain:address` (synthetic entity — no '/' in the
    // ref, chain is a known app id, not native). Free GeckoTerminal chart.
    if (typeof ref === 'string' && ref.includes(':') && !ref.includes('/') && !ref.startsWith('native:')) {
      const idx = ref.indexOf(':')
      const chainPart = ref.slice(0, idx)
      const address = ref.slice(idx + 1)
      if (address && getChain(chainPart) && CHAIN_PROVIDERS[chainPart]?.geckoterminal) {
        return await degenChart(chainPart, address, timeframe)
      }
    }

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    let q = supabase.from('entities').select('*').eq('org_id', orgId)
    q = entityId ? q.eq('id', entityId) : q.eq('canonical_ref_key', ref)
    const { data: ent } = await q.maybeSingle()
    if (!ent) return json({ error: 'entity_not_found' }, 404)

    const appId = chainIdFor(ent.chain_namespace, ent.chain_id)
    const beKey = Deno.env.get('BIRDEYE_API_KEY')
    const beChain = birdeyeChainFor(ent.chain_namespace, ent.chain_id)

    // Resolved contract entity → Birdeye OHLCV (liquidity-grade) when enabled.
    if (beKey && beChain && ent.contract_address) {
      const tf = TF[timeframe] || TF['1D']
      const now = Math.floor(Date.now() / 1000)
      const from = now - tf.days * 86_400
      const beCtx: BirdeyeContext = { supabase, jobName: 'intel-token-chart', caller: 'token-chart', kind: 'request', orgId }
      const [overview, ohlcv] = await Promise.all([
        birdeyeOverview(beChain, ent.contract_address, beKey, beCtx),
        birdeyeGet(`/defi/ohlcv?address=${ent.contract_address}&type=${tf.type}&time_from=${from}&time_to=${now}`, { chain: beChain, ctx: beCtx, tokenAddress: ent.contract_address }),
      ])
      // deno-lint-ignore no-explicit-any
      let candles: any[] = []
      if (ohlcv?.ok) { const items = ohlcv.data?.data?.items || []; candles = items.map((i: any) => ({ t: (i.unixTime || i.time) * 1000, o: i.o, h: i.h, l: i.l, c: i.c, v: i.v })).filter((c: any) => c.c != null) }
      if (candles.length) return json({ entity: { symbol: ent.display_symbol || overview?.symbol, ref: ent.canonical_ref_key, chain: ent.chain_namespace, privacy_limited: ent.privacy_limited }, overview, candles, timeframe, source: 'birdeye' })
      // Birdeye returned nothing → fall through to the free GeckoTerminal path below.
    }

    // Contract on a GeckoTerminal-supported chain (Birdeye off / empty) → free chart.
    if (ent.contract_address && appId && CHAIN_PROVIDERS[appId]?.geckoterminal) {
      return await degenChart(appId, ent.contract_address, timeframe)
    }

    // No contract (native in watchlist) → CoinGecko if we know the id.
    const cg = ent.provider_ids?.coingecko || (ent.asset_type === 'native' ? CHAIN_COINGECKO[ent.chain_id] : null)
    if (cg) {
      const { overview, candles } = await coingeckoChart(cg, timeframe, marketCtx)
      return json({ entity: { symbol: ent.display_symbol, ref: ent.canonical_ref_key, chain: ent.chain_namespace }, overview, candles, timeframe, source: 'coingecko' })
    }
    return json({ entity: { symbol: ent.display_symbol, ref: ent.canonical_ref_key, chain: ent.chain_namespace }, overview: null, candles: [], timeframe, unsupported: true })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'chart_failed' }, 400)
  }
})
