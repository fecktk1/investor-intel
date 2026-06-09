// Investor Intel — market regime classifier (shared, cron + on-demand).
//
// ONE global classification for everyone. Deterministic: majors + BTC dominance
// from the free CoinGecko endpoints (2 calls per run, a few runs/day for the
// WHOLE platform), plus best-effort hot-narrative counts from the shared corpus.
// No LLM. Writes a row read by Market Pulse + Briefs. Degrades to a low-
// confidence "chop" read if the price source is unavailable (honest, not faked).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { CHAINS, CHAIN_COINGECKO } from '../_shared/chains.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }
const num = (x: any) => (typeof x === 'number' && !Number.isNaN(x)) ? x : null
const SECTORS = ['DeFi', 'AI', 'Gaming', 'Memecoins', 'ETFs', 'Regulation', 'Security', 'Stablecoins', 'RWAs', 'DePIN', 'NFTs', 'Restaking', 'Layer 2']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const cronOk = req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    if (!cronOk) {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return json({ error: 'unauthorized' }, 401)
      const u = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: { user } } = await u.auth.getUser()
      const { data: prof } = user ? await u.from('profiles').select('is_super_admin').eq('id', user.id).maybeSingle() : { data: null }
      if (!prof?.is_super_admin) return json({ error: 'forbidden' }, 403)
    }

    // 1) Majors + dominance + per-chain perf (ONE free CoinGecko call, shared).
    let btc: number | null = null, eth: number | null = null, sol: number | null = null, btcDom: number | null = null, totalChg: number | null = null
    let priceData: any = null
    try {
      const ids = [...new Set(Object.values(CHAIN_COINGECKO))].join(',')
      const p = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`, { signal: AbortSignal.timeout(12000) })
      if (p.ok) { priceData = await p.json(); btc = num(priceData?.bitcoin?.usd_24h_change); eth = num(priceData?.ethereum?.usd_24h_change); sol = num(priceData?.solana?.usd_24h_change) }
    } catch { /* degrade */ }

    // Per-chain native-token performance (Market Pulse shows the user's followed chains).
    if (priceData) {
      const perf = CHAINS.map((c) => {
        const cg = CHAIN_COINGECKO[c.id]; const d = cg ? priceData[cg] : null
        if (!d || d.usd == null) return null
        return { chain_id: c.id, symbol: c.nativeSymbol, coingecko_id: cg, price: num(d.usd), change_24h: num(d.usd_24h_change), market_cap: num(d.usd_market_cap), updated_at: new Date().toISOString() }
      }).filter(Boolean)
      if (perf.length) { try { await admin.from('intel_chain_perf').upsert(perf, { onConflict: 'chain_id' }) } catch { /* best-effort */ } }
    }
    try {
      const g = await fetch('https://api.coingecko.com/api/v3/global', { signal: AbortSignal.timeout(10000) })
      if (g.ok) { const d = (await g.json())?.data; btcDom = num(d?.market_cap_percentage?.btc); totalChg = num(d?.market_cap_change_percentage_24h_usd) }
    } catch { /* degrade */ }

    // 2) Hot narratives (best-effort, from shared corpus tags, last 24h).
    const since = new Date(Date.now() - 86_400_000).toISOString()
    const { data: recent } = await admin.from('intel_global_news').select('tags').gte('created_at', since).limit(800)
    const freq = new Map<string, number>()
    for (const r of (recent || [])) for (const tg of (r.tags || [])) { const m = SECTORS.find((s) => s.toLowerCase() === String(tg).toLowerCase()); if (m) freq.set(m, (freq.get(m) || 0) + 1) }
    const hot = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((e) => e[0])

    // 3) Previous dominance for delta.
    const { data: prev } = await admin.from('intel_market_regime').select('majors').order('computed_at', { ascending: false }).limit(1).maybeSingle()
    const prevDom = num(prev?.majors?.btc_dominance)
    const domDelta = (btcDom != null && prevDom != null) ? btcDom - prevDom : null

    // 4) Deterministic classification.
    const leader = [['btc', btc], ['eth', eth], ['sol', sol]].filter(([, v]) => v != null).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || null
    let regime = 'chop', flavor: string | null = null
    const haveData = totalChg != null || leader != null
    if (totalChg != null && totalChg <= -2.5) regime = 'risk_off'
    else if (totalChg != null && totalChg >= 2.5) {
      if (leader === 'btc' && (domDelta == null || domDelta >= 0)) regime = 'btc_led'
      else if ((leader === 'eth' || leader === 'sol') && (domDelta == null || domDelta < 0)) { regime = 'altcoin_rotation'; flavor = leader === 'sol' ? 'sol_led' : 'eth_led' }
      else regime = 'risk_on'
    } else if (totalChg != null && Math.abs(totalChg) < 2.5) regime = 'chop'
    if (!flavor && hot.length && (regime === 'risk_on' || regime === 'chop' || regime === 'altcoin_rotation')) flavor = hot[0].toLowerCase()
    const confidence = !haveData ? 'low' : (totalChg != null && Math.abs(totalChg) >= 4) ? 'high' : (totalChg != null && Math.abs(totalChg) >= 1.5) ? 'medium' : 'low'

    // 5) Plain, compliant rationale + confirm/invalidate (templated, no advice).
    const pct = (v: number | null) => v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
    const REGIME_LABEL: Record<string, string> = { risk_on: 'Risk-on', risk_off: 'Risk-off', btc_led: 'BTC-led', altcoin_rotation: 'Altcoin rotation', chop: 'No clear regime (chop)' }
    const rationale = !haveData
      ? 'Live market breadth data is unavailable right now, so the regime read is low-confidence.'
      : `Total crypto market cap is ${pct(totalChg)} over 24h; BTC ${pct(btc)}, ETH ${pct(eth)}, SOL ${pct(sol)}. BTC dominance ${btcDom != null ? btcDom.toFixed(1) + '%' : 'n/a'}${domDelta != null ? ` (${pct(domDelta)} vs last read)` : ''}. ${regime === 'btc_led' ? 'Strength is concentrated in BTC with dominance holding or rising — capital favors the majors over alts.' : regime === 'altcoin_rotation' ? 'Alts are outpacing BTC while dominance slips — capital is rotating down the risk curve.' : regime === 'risk_off' ? 'Broad market cap is contracting — risk appetite is reduced across crypto.' : regime === 'risk_on' ? 'Broad green with participation beyond BTC — risk appetite is firm.' : 'Mixed, low-conviction tape with no clear leadership.'}${hot.length ? ` Most-covered narratives: ${hot.join(', ')}.` : ''}`
    const whatConfirms = regime === 'btc_led' ? 'Continued BTC dominance gains with majors green and alts lagging.'
      : regime === 'altcoin_rotation' ? 'Falling BTC dominance with ETH/SOL and sector alts outperforming on rising volume.'
      : regime === 'risk_off' ? 'Further total-market-cap contraction and widening liquidity stress.'
      : regime === 'risk_on' ? 'Broad participation (alts + majors green) and expanding total market cap.'
      : 'A decisive break in total market cap or a clear dominance trend.'
    const whatInvalidates = regime === 'risk_off' ? 'A reclaim of total market cap with majors turning green.'
      : 'A sharp reversal in total market cap or BTC dominance against the current direction.'

    const { error } = await admin.from('intel_market_regime').insert({
      regime, flavor, confidence, rationale,
      majors: { btc, eth, sol, btc_dominance: btcDom, total_mcap_change: totalChg, dom_delta: domDelta },
      hot_narratives: hot, what_confirms: whatConfirms, what_invalidates: whatInvalidates,
    })
    if (error) throw error
    return json({ ok: true, regime, flavor, confidence, label: REGIME_LABEL[regime] || regime, majors: { btc, eth, sol, btcDom, totalChg } })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'regime_failed' }, 500)
  }
})
