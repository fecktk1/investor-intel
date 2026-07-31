// Lazy per-token risk enrichment (v3.1). The on-demand worker behind the risk
// badge: given {chain, address}, returns a fresh token_risk_scores row if one is
// <stale_after, otherwise runs the Batch-5/6 pipeline for THIS ONE token
// (Birdeye token_security + holders → CoinGecko GT cross-check → deterministic
// score → RAG fact) and records it in token_risk_universe. Nothing is bulk
// enriched — only what a user actually opens, plus the top-100/top-50 warmed by
// intel-token-risk-warm. Auth: valid user JWT (frontend) OR x-cron-secret (warm
// cron). Self-contained deploy. Flag-gated (RISK_SCORE_ENABLED + TOKEN_RISK_LAZY_ENABLED).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { computeConcentration, computeTokenRisk, riskSummary, securityInputFromRaw } from '../_shared/intel/token-risk.ts'
import { promoteProviderFact } from '../_shared/intel/provider-fact-rag.ts'
import { isFeatureEnabled } from '../_shared/intel/runtime-flags.ts'
import { fetchCoingeckoOnchainTokenInfo } from '../_shared/market-assets/coingecko-provider.ts'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
// deno-lint-ignore no-explicit-any
type DB = any

const CU = { security: 40, holders: 40 }
// Canonical chain → CoinGecko GT network (cross-check). Keys = the enrichable set.
const GT_NET: Record<string, string> = {
  solana: 'solana', ethereum: 'eth', base: 'base', arbitrum: 'arbitrum',
  polygon: 'polygon_pos', bsc: 'bsc', avalanche: 'avax', optimism: 'optimism',
}
// Birdeye token_security is Solana-primary but covers major EVM chains too.
const BIRDEYE_CHAINS = new Set(['solana', 'ethereum', 'base', 'arbitrum', 'polygon', 'bsc', 'avalanche', 'optimism'])

function normChain(c: string): string {
  const x = String(c || '').toLowerCase().trim()
  const map: Record<string, string> = {
    'sol': 'solana', 'solana': 'solana', 'eth': 'ethereum', 'ethereum': 'ethereum',
    'bnb': 'bsc', 'bsc': 'bsc', 'binance-smart-chain': 'bsc', 'matic': 'polygon',
    'polygon': 'polygon', 'polygon-pos': 'polygon', 'arbitrum': 'arbitrum', 'arbitrum-one': 'arbitrum',
    'base': 'base', 'avax': 'avalanche', 'avalanche': 'avalanche', 'optimism': 'optimism', 'optimistic-ethereum': 'optimism',
  }
  return map[x] || x
}

function beBase(): string { return Deno.env.get('BIRDEYE_BASE_URL') || 'https://public-api.birdeye.so' }
// deno-lint-ignore no-explicit-any
async function beGet(path: string, chain: string): Promise<{ ok: boolean; data: any; status: number; ms: number }> {
  const key = Deno.env.get('BIRDEYE_API_KEY')
  const started = Date.now()
  if (!key) return { ok: false, data: null, status: 0, ms: 0 }
  try {
    const res = await fetch(`${beBase()}${path}`, { headers: { 'X-API-KEY': key, 'x-chain': chain } })
    const j = res.ok ? await res.json() : null
    return { ok: res.ok, data: j, status: res.status, ms: Date.now() - started }
  } catch { return { ok: false, data: null, status: 0, ms: Date.now() - started } }
}
async function logCall(db: DB, endpoint: string, chain: string, addr: string, cu: number, r: { status: number; ms: number; ok: boolean }) {
  try {
    await db.from('provider_call_logs').insert({
      provider: 'birdeye', data_type: endpoint.includes('holder') ? 'holders' : 'token', endpoint, chain, subject_ref: addr,
      cache_status: 'miss', calls: 1, credits_or_cu: cu, latency_ms: r.ms, status: r.ok ? 'ok' : 'error', status_code: r.status,
      caller: 'intel-token-risk-enrich', job_name: 'intel-token-risk-enrich',
    })
  } catch { /* best-effort */ }
}
async function budgetOk(db: DB, cu: number): Promise<boolean> {
  try {
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
    const { data, error } = await db.rpc('provider_budget_bump', {
      p_provider: 'birdeye', p_data_type: 'calls', p_period_start: start, p_period_end: end,
      p_calls: 1, p_credits: cu, p_soft_cap: 36000, p_hard_cap: 45000,
    })
    if (error) return true
    return data?.allowed !== false
  } catch { return true }
}
async function quiet(p: unknown): Promise<void> { try { await p } catch { /* best-effort DB write */ } }
// deno-lint-ignore no-explicit-any
function pick(o: any, keys: string[]): any { if (!o) return null; for (const k of keys) if (o[k] != null) return o[k]; return null }
function asStr(v: unknown): string | null { return v == null ? null : String(v) }
function asPct(v: unknown): number | null { const n = Number(v); if (!Number.isFinite(n)) return null; return n <= 1 && n >= 0 ? n * 100 : n }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const admin: DB = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // Auth: cron secret (warm fn) OR a valid user JWT (frontend lazy call).
    const cronOk = !!req.headers.get('x-cron-secret') && req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
    let authed = cronOk
    const authHeader = req.headers.get('Authorization')
    if (!authed && authHeader) {
      const u = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: { user } } = await u.auth.getUser()
      authed = !!user
    }
    if (!authed) return json({ error: 'unauthorized' }, 401)

    if (!await isFeatureEnabled(admin, 'RISK_SCORE_ENABLED', false) || !await isFeatureEnabled(admin, 'TOKEN_RISK_LAZY_ENABLED', true)) {
      return json({ ok: true, enabled: false })
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const chain = normChain(String(body.chain || ''))
    const address = String(body.address || body.tokenAddress || '').trim()
    if (!chain || !address) return json({ error: 'chain_and_address_required' }, 400)
    const symbol = body.symbol ? String(body.symbol).toUpperCase() : null
    const name = body.name ? String(body.name) : null
    const source = ['markets', 'degen', 'lookup'].includes(String(body.source)) ? String(body.source) : 'lookup'
    const rank = Number(body.rank) > 0 ? Math.floor(Number(body.rank)) : null
    const auto = typeof body.auto === 'boolean' ? body.auto : null
    const force = body.force === true
    const ref = `${chain}:${address}`

    if (!(chain in GT_NET)) {
      // Not on an enrichable chain (e.g. a native asset like BTC) — record + no score.
      await quiet(admin.rpc('token_risk_universe_touch', { p_chain: chain, p_address: address, p_symbol: symbol, p_name: name, p_source: source, p_rank: rank, p_auto: auto, p_enriched: false }))
      await quiet(admin.from('token_risk_universe').update({ enrichable: false }).eq('chain', chain).eq('token_address', address))
      return json({ ok: true, enrichable: false, chain })
    }

    // 1) Freshness gate — a warm token_risk_scores row short-circuits everything.
    const { data: existing } = await admin.from('token_risk_scores')
      .select('symbol, score, hard_fail, hard_fail_flags, penalties, cross_provider_confidence, computed_at, stale_after')
      .eq('chain', chain).eq('token_address', address).maybeSingle()
    const fresh = existing && existing.stale_after && new Date(existing.stale_after).getTime() > Date.now()
    // Always record the view; only stamp enriched when we (re)score below.
    await quiet(admin.rpc('token_risk_universe_touch', { p_chain: chain, p_address: address, p_symbol: symbol, p_name: name, p_source: source, p_rank: rank, p_auto: auto, p_enriched: false }))
    if (fresh && !force) return json({ ok: true, cached: true, score: existing })

    // 2) Birdeye token_security (+ holders) — the primary security signal.
    let secRaw: Record<string, unknown> | null = null
    let holderItems: Record<string, unknown>[] = []
    let holderTotal: number | null = null
    if (BIRDEYE_CHAINS.has(chain) && await budgetOk(admin, CU.security)) {
      const r = await beGet(`/defi/token_security?address=${encodeURIComponent(address)}`, chain)
      await logCall(admin, '/defi/token_security', chain, address, CU.security, r)
      secRaw = r.ok ? (r.data?.data ?? r.data) : null
      if (secRaw) {
        await admin.from('token_security_snapshots').upsert({
          chain, token_address: address, canonical_ref_key: ref, provider: 'birdeye',
          freeze_authority: asStr(pick(secRaw, ['freezeAuthority', 'freeze_authority'])),
          mint_authority: asStr(pick(secRaw, ['mintAuthority', 'mint_authority'])),
          top10_holder_pct: asPct(pick(secRaw, ['top10HolderPercent', 'top10_holder_percent'])),
          raw_response: secRaw, confidence: 0.8, fetched_at: new Date().toISOString(),
          stale_after: new Date(Date.now() + 86400_000).toISOString(), updated_at: new Date().toISOString(),
        }, { onConflict: 'chain,token_address,provider' })
      }
      if (await budgetOk(admin, CU.holders)) {
        const h = await beGet(`/defi/v3/token/holder?address=${encodeURIComponent(address)}&offset=0&limit=100`, chain)
        await logCall(admin, '/defi/v3/token/holder', chain, address, CU.holders, h)
        const hd = h.ok ? h.data?.data : null
        holderItems = (hd?.items ?? hd?.holders ?? (Array.isArray(hd) ? hd : [])) as Record<string, unknown>[]
        holderTotal = hd?.total ?? (holderItems.length || null)
        if (holderItems.length) {
          const top = holderItems.slice(0, 20).map((x) => ({ address: pick(x, ['owner', 'address', 'wallet']), ui_amount: pick(x, ['ui_amount', 'uiAmount', 'amount']) }))
          await admin.from('token_holder_snapshots').upsert({
            chain, token_address: address, canonical_ref_key: ref, provider: 'birdeye', holder_count: holderTotal,
            top_holders: top, raw_response: { total: holderTotal, sample: holderItems.slice(0, 10) },
            snapshot_at: new Date().toISOString(), stale_after: new Date(Date.now() + 6 * 3600_000).toISOString(),
            dedup_key: `${chain}:${address}:birdeye:${new Date().toISOString().slice(0, 13)}`,
          }, { onConflict: 'dedup_key', ignoreDuplicates: true })
        }
      }
    }

    // 3) CoinGecko GT cross-check (second source → confidence 0.9).
    let gtScore: number | null = null, gtHoneypot: string | null = null, gtSymbol: string | null = null
    try {
      const response = await fetchCoingeckoOnchainTokenInfo(GT_NET[chain], address, {
        supabase: admin,
        caller: 'intel-token-risk-enrich',
        kind: 'request',
        maxCalls: 1,
      })
      if (response) {
        const a = (response as any)?.data?.attributes || {}
        const gs = a.gt_score ?? a.gt_score_details?.total ?? null
        gtScore = gs != null ? Math.round(Number(gs)) : null
        gtHoneypot = a.is_honeypot != null ? String(a.is_honeypot) : null
        gtSymbol = a.symbol ? String(a.symbol).toUpperCase() : null
        await admin.from('token_security_snapshots').upsert({
          chain, token_address: address, canonical_ref_key: ref, provider: 'coingecko',
          gt_score: gtScore, is_honeypot: gtHoneypot ?? 'unknown', raw_response: a, confidence: 0.75,
          fetched_at: new Date().toISOString(), stale_after: new Date(Date.now() + 86400_000).toISOString(), updated_at: new Date().toISOString(),
        }, { onConflict: 'chain,token_address,provider' })
      }
    } catch { /* best-effort */ }

    // 4) Score. If no provider returned signal → UNRATED (don't fabricate a 100).
    const input = securityInputFromRaw(secRaw, { gtScore, gtHoneypot })
    const risk = computeTokenRisk(input)
    if (!risk.rated) return json({ ok: true, rated: false, note: 'no provider security data' })

    const top10 = asPct(pick(secRaw, ['top10HolderPercent', 'top10_holder_percent'])) ?? (input.top10HolderPercent != null ? Number(input.top10HolderPercent) * 100 : null)
    const conc = computeConcentration(top10 != null ? top10 / 100 : null, holderItems.length ? holderItems.slice(0, 20).map((x) => ({ ui_amount: pick(x, ['ui_amount', 'uiAmount', 'amount']) })) : null)
    const finalSymbol = symbol ?? gtSymbol ?? (secRaw?.symbol ? String(secRaw.symbol).toUpperCase() : null)

    const { data: prior } = await admin.from('holder_concentration_scores')
      .select('top10_pct').eq('chain', chain).eq('token_address', address)
      .lt('computed_at', new Date(Date.now() - 60_000).toISOString()).order('computed_at', { ascending: false }).limit(1).maybeSingle()
    const deltaTop10 = (prior?.top10_pct != null && conc.top10_pct != null) ? Math.round((conc.top10_pct - Number(prior.top10_pct)) * 10) / 10 : null

    await admin.from('token_risk_scores').upsert({
      chain, token_address: address, canonical_ref_key: ref, symbol: finalSymbol,
      score: risk.score, hard_fail: risk.hard_fail, hard_fail_flags: risk.hard_fail_flags,
      sub_scores: risk.sub_scores, penalties: risk.penalties, cross_provider_confidence: risk.confidence,
      disagreements: risk.disagreements, input_snapshot_ids: {}, score_version: risk.score_version,
      computed_at: new Date().toISOString(), stale_after: new Date(Date.now() + 86400_000).toISOString(),
    }, { onConflict: 'chain,token_address' })

    await admin.from('holder_concentration_scores').upsert({
      chain, token_address: address, canonical_ref_key: ref, score: conc.score, top1_pct: conc.top1_pct,
      top10_pct: conc.top10_pct, gini: conc.gini, band: conc.band, holder_count: holderTotal, delta_top10_pct_24h: deltaTop10,
      source_providers: BIRDEYE_CHAINS.has(chain) && secRaw ? ['birdeye'] : ['coingecko'], score_version: conc.score_version,
      computed_at: new Date().toISOString(), dedup_key: `${chain}:${address}:${new Date().toISOString().slice(0, 10)}`,
    }, { onConflict: 'dedup_key', ignoreDuplicates: false })

    // 5) RAG + universe (enriched).
    const summary = riskSummary(finalSymbol, risk, conc)
    try {
      await promoteProviderFact(admin, {
        decisionKind: 'token_risk_summary', subjectType: 'token', subjectRef: ref, entityRefs: [ref], chains: [chain],
        title: summary, summary: `${summary}. Confidence ${risk.confidence}.`, confidenceScore: risk.confidence,
        provider: 'birdeye', endpoint: 'birdeye:/defi/token_security', sourceTable: 'token_risk_scores', sourceId: ref,
        fetchedAt: new Date().toISOString(), evidenceRefs: [{ table: 'token_security_snapshots', metric: 'risk_score' }],
        materialEvent: risk.hard_fail, eventType: 'token_risk_high', importanceScore: risk.hard_fail ? 85 : undefined,
        payload: { score: risk.score, top10_pct: conc.top10_pct, flags: risk.hard_fail_flags },
      })
    } catch { /* best-effort */ }
    await quiet(admin.rpc('token_risk_universe_touch', { p_chain: chain, p_address: address, p_symbol: finalSymbol, p_name: name, p_source: source, p_rank: rank, p_auto: auto, p_enriched: true }))

    return json({ ok: true, cached: false, score: { symbol: finalSymbol, score: risk.score, hard_fail: risk.hard_fail, hard_fail_flags: risk.hard_fail_flags, penalties: risk.penalties, cross_provider_confidence: risk.confidence, top10_pct: conc.top10_pct } })
  } catch (err) {
    return json({ error: (err as Error)?.message || 'enrich_failed' }, 500)
  }
})
