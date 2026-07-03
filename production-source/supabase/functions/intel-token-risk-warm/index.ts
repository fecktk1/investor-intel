// Warm-cache cron for token risk (v3.1). The ONLY proactive updater: re-scores
// the top-100 markets (by market-cap rank, contract tokens only) + the top-50
// degen tokens (by momentum) once a day by calling intel-token-risk-enrich for
// each with auto=true. Everything else stays lazy (enriched on view). The enrich
// fn's freshness gate makes already-fresh tokens cheap cache-hits, so re-runs are
// cost-safe. cron-secret auth. Flag-gated (RISK_SCORE_ENABLED + TOKEN_RISK_LAZY_ENABLED).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { isFeatureEnabled } from '../_shared/intel/runtime-flags.ts'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
// deno-lint-ignore no-explicit-any
type DB = any

const GT_NET = new Set(['solana', 'ethereum', 'base', 'arbitrum', 'polygon', 'bsc', 'avalanche', 'optimism'])
function normChain(c: string): string {
  const x = String(c || '').toLowerCase().trim()
  const map: Record<string, string> = {
    'sol': 'solana', 'solana': 'solana', 'eth': 'ethereum', 'ethereum': 'ethereum', 'bnb': 'bsc', 'bsc': 'bsc',
    'binance-smart-chain': 'bsc', 'matic': 'polygon', 'polygon': 'polygon', 'polygon-pos': 'polygon',
    'arbitrum': 'arbitrum', 'arbitrum-one': 'arbitrum', 'base': 'base', 'avax': 'avalanche', 'avalanche': 'avalanche',
    'optimism': 'optimism', 'optimistic-ethereum': 'optimism',
  }
  return map[x] || x
}

// Pick an enrichable {chain,address} from a CoinGecko platforms map, preferring
// the asset's primary chain.
// deno-lint-ignore no-explicit-any
function resolveMarket(a: any): { chain: string; address: string } | null {
  const platforms = a?.platforms && typeof a.platforms === 'object' ? a.platforms as Record<string, string> : null
  if (!platforms) return null
  const primary = normChain(a.primary_chain || '')
  const entries = Object.entries(platforms).filter(([, v]) => v)
  const primHit = entries.find(([k]) => normChain(k) === primary && GT_NET.has(normChain(k)))
  if (primHit) return { chain: normChain(primHit[0]), address: String(primHit[1]) }
  const anyHit = entries.find(([k]) => GT_NET.has(normChain(k)))
  return anyHit ? { chain: normChain(anyHit[0]), address: String(anyHit[1]) } : null
}

async function runPool<T>(items: T[], size: number, fn: (t: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map((t) => fn(t).catch(() => {})))
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const cronOk = !!req.headers.get('x-cron-secret') && req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
    if (!cronOk) return json({ error: 'unauthorized' }, 401)
    const admin: DB = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    if (!await isFeatureEnabled(admin, 'RISK_SCORE_ENABLED', false) || !await isFeatureEnabled(admin, 'TOKEN_RISK_LAZY_ENABLED', true)) {
      return json({ ok: true, enabled: false })
    }
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const marketTop = Math.min(Number(body.marketTop) > 0 ? Number(body.marketTop) : 100, 200)
    const degenTop = Math.min(Number(body.degenTop) > 0 ? Number(body.degenTop) : 50, 100)

    const url = Deno.env.get('SUPABASE_URL')!
    const secret = Deno.env.get('CRON_SECRET')!

    // Top-100 markets (contract tokens only) + top-50 degen by momentum.
    const [{ data: markets }, { data: degen }] = await Promise.all([
      admin.from('market_assets').select('normalized_symbol, symbol, name, primary_chain, platforms, market_cap_rank')
        .not('market_cap_rank', 'is', null).not('platforms', 'is', null)
        .order('market_cap_rank', { ascending: true }).limit(marketTop * 4),
      admin.from('memecoin_latest_tokens').select('chain, token_address, symbol, name, momentum_score')
        .order('momentum_score', { ascending: false, nullsFirst: false }).limit(degenTop * 2),
    ])

    type Cand = { chain: string; address: string; symbol: string | null; name: string | null; source: string; rank: number | null }
    const cands: Cand[] = []
    let mRank = 0
    for (const a of (markets || [])) {
      if (cands.filter((c) => c.source === 'markets').length >= marketTop) break
      const res = resolveMarket(a)
      if (!res) continue
      mRank += 1
      cands.push({ ...res, symbol: a.symbol || a.normalized_symbol || null, name: a.name || null, source: 'markets', rank: a.market_cap_rank ?? mRank })
    }
    let dCount = 0
    for (const d of (degen || [])) {
      if (dCount >= degenTop) break
      const chain = normChain(d.chain || '')
      if (!GT_NET.has(chain) || !d.token_address) continue
      dCount += 1
      cands.push({ chain, address: String(d.token_address), symbol: d.symbol || null, name: d.name || null, source: 'degen', rank: dCount })
    }

    let enriched = 0, cached = 0, skipped = 0, failed = 0
    await runPool(cands, 6, async (c) => {
      try {
        const r = await fetch(`${url}/functions/v1/intel-token-risk-enrich`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
          body: JSON.stringify({ chain: c.chain, address: c.address, symbol: c.symbol, name: c.name, source: c.source, rank: c.rank, auto: true }),
        })
        const j = await r.json().catch(() => ({}))
        if (j?.cached) cached++
        else if (j?.enrichable === false || j?.rated === false) skipped++
        else if (j?.ok) enriched++
        else failed++
      } catch { failed++ }
    })

    return json({ ok: true, candidates: cands.length, markets: cands.filter((c) => c.source === 'markets').length, degen: dCount, enriched, cached, skipped, failed })
  } catch (err) {
    return json({ error: (err as Error)?.message || 'warm_failed' }, 500)
  }
})
