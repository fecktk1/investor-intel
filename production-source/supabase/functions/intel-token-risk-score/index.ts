// Token risk + holder concentration scoring (v3.1, Batch 6).
//
// Reads the Batch-5 Birdeye snapshots (token_security_snapshots +
// token_holder_snapshots), computes deterministic versioned scores, stores them,
// and promotes a durable risk SUMMARY to the RAG layer (decision_memory →
// embedding → assembleIntelligenceContext). Flag-gated (RISK_SCORE_ENABLED).
// Self-contained deploy (token-risk + provider-fact-rag + runtime-flags).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { computeConcentration, computeTokenRisk, riskSummary, securityInputFromRaw } from '../_shared/intel/token-risk.ts'
import { promoteProviderFact } from '../_shared/intel/provider-fact-rag.ts'
import { isFeatureEnabled } from '../_shared/intel/runtime-flags.ts'
import { fetchCoingeckoOnchainTokenInfo } from '../_shared/market-assets/coingecko-provider.ts'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
// deno-lint-ignore no-explicit-any
type DB = any

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const cronOk = !!req.headers.get('x-cron-secret') && req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
    if (!cronOk) return json({ error: 'unauthorized' }, 401)
    const admin: DB = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({}))
    const debug = body?.debug === true

    if (!await isFeatureEnabled(admin, 'RISK_SCORE_ENABLED', false)) {
      return json({ ok: true, enabled: false, note: 'RISK_SCORE_ENABLED off' })
    }
    const limit = Math.min(Number(body?.limit) > 0 ? Number(body.limit) : 200, 500)

    // CoinGecko on-chain cross-check (GT score / honeypot) — fetched inline when a
    // token has no fresh coingecko row, raising risk confidence to 0.9.
    const cgOnchain = await isFeatureEnabled(admin, 'COINGECKO_ONCHAIN_ENABLED', false)
    const gtNet = (c: string) => c === 'ethereum' ? 'eth' : c === 'polygon' ? 'polygon_pos' : c

    // Tokens we have Birdeye security data for (optionally filtered to a list).
    let q = admin.from('token_security_snapshots')
      .select('id, entity_id, chain, token_address, canonical_ref_key, top10_holder_pct, raw_response, fetched_at')
      .eq('provider', 'birdeye').order('fetched_at', { ascending: false }).limit(limit)
    if (Array.isArray(body?.tokens) && body.tokens.length) {
      q = q.in('token_address', body.tokens.map((t: any) => String(t.address ?? t)))
    }
    const { data: secRows } = await q
    if (!secRows || !secRows.length) return json({ ok: true, note: 'no token_security_snapshots to score' })

    // Optional CoinGecko GT cross-check (present once coingecko rows exist).
    const results: any[] = []
    let scored = 0, hardFails = 0, ragged = 0, skipped = 0

    for (const s of secRows) {
      const { data: gt } = await admin.from('token_security_snapshots')
        .select('gt_score, is_honeypot, raw_response').eq('provider', 'coingecko').eq('chain', s.chain).eq('token_address', s.token_address).maybeSingle()
      const { data: holder } = await admin.from('token_holder_snapshots')
        .select('top_holders, holder_count, top10_pct').eq('chain', s.chain).eq('token_address', s.token_address)
        .order('snapshot_at', { ascending: false }).limit(1).maybeSingle()

      // Fetch the CoinGecko cross-check inline if missing (keeps it ongoing).
      // deno-lint-ignore no-explicit-any
      let gtx: any = gt
      if (!gtx && cgOnchain) {
        try {
          const response = await fetchCoingeckoOnchainTokenInfo(gtNet(s.chain), s.token_address, {
            supabase: admin,
            jobName: 'intel-token-risk-score',
            caller: 'intel-token-risk-score',
            kind: 'job',
            maxCalls: limit,
          })
          if (response) {
            const a = (response as any)?.data?.attributes || {}
            const gscore = a.gt_score ?? a.gt_score_details?.total ?? null
            gtx = { gt_score: gscore != null ? Math.round(Number(gscore)) : null, is_honeypot: a.is_honeypot != null ? String(a.is_honeypot) : 'unknown', raw_response: a }
            await admin.from('token_security_snapshots').upsert({
              chain: s.chain, token_address: s.token_address, canonical_ref_key: s.canonical_ref_key || `${s.chain}:${s.token_address}`, provider: 'coingecko',
              gt_score: gtx.gt_score, is_honeypot: gtx.is_honeypot, mint_authority: a.mint_authority ?? null, freeze_authority: a.freeze_authority ?? null,
              raw_response: a, confidence: 0.75, fetched_at: new Date().toISOString(), stale_after: new Date(Date.now() + 86400000).toISOString(), updated_at: new Date().toISOString(),
            }, { onConflict: 'chain,token_address,provider' })
          }
        } catch { /* best-effort */ }
      }

      const input = securityInputFromRaw(s.raw_response, { gtScore: gtx?.gt_score ?? null, gtHoneypot: gtx?.is_honeypot ?? null })
      const risk = computeTokenRisk(input)
      // No provider actually returned security data (e.g. Birdeye Solana-primary
      // endpoint on an EVM token) → skip rather than write a false "100/100 safe".
      if (!risk.rated) { skipped++; if (debug) results.push({ ref: s.canonical_ref_key || `${s.chain}:${s.token_address}`, skipped: 'insufficient_data' }); continue }
      const top10 = s.top10_holder_pct != null ? Number(s.top10_holder_pct) / 100 : (input.top10HolderPercent ?? null)
      const conc = computeConcentration(top10, holder?.top_holders ?? null)
      const ref = s.canonical_ref_key || `${s.chain}:${s.token_address}`
      // symbol: Birdeye security has none → prefer CoinGecko on-chain, else the ref tail.
      const refTail = ref.includes(':') ? ref.split(':').pop()!.toUpperCase() : null
      const symbol = (gtx?.raw_response?.symbol ? String(gtx.raw_response.symbol).toUpperCase() : null)
        ?? (s.raw_response?.symbol ? String(s.raw_response.symbol).toUpperCase() : null) ?? refTail

      // prior concentration (24h) for the delta.
      const { data: prior } = await admin.from('holder_concentration_scores')
        .select('top10_pct').eq('chain', s.chain).eq('token_address', s.token_address)
        .lt('computed_at', new Date(Date.now() - 60_000).toISOString())
        .order('computed_at', { ascending: false }).limit(1).maybeSingle()
      const deltaTop10 = (prior?.top10_pct != null && conc.top10_pct != null) ? Math.round((conc.top10_pct - Number(prior.top10_pct)) * 10) / 10 : null

      await admin.from('token_risk_scores').upsert({
        entity_id: s.entity_id, chain: s.chain, token_address: s.token_address, canonical_ref_key: ref, symbol,
        score: risk.score, hard_fail: risk.hard_fail, hard_fail_flags: risk.hard_fail_flags,
        sub_scores: risk.sub_scores, penalties: risk.penalties,
        cross_provider_confidence: risk.confidence, disagreements: risk.disagreements,
        input_snapshot_ids: { security: s.id, holder: holder ? true : null }, score_version: risk.score_version,
        computed_at: new Date().toISOString(), stale_after: new Date(Date.now() + 86400_000).toISOString(),
      }, { onConflict: 'chain,token_address' })

      const day = new Date().toISOString().slice(0, 10)
      await admin.from('holder_concentration_scores').upsert({
        entity_id: s.entity_id, chain: s.chain, token_address: s.token_address, canonical_ref_key: ref,
        score: conc.score, top1_pct: conc.top1_pct, top10_pct: conc.top10_pct, gini: conc.gini, band: conc.band,
        holder_count: holder?.holder_count ?? null, delta_top10_pct_24h: deltaTop10,
        source_providers: ['birdeye'], score_version: conc.score_version, computed_at: new Date().toISOString(),
        dedup_key: `${s.chain}:${s.token_address}:${day}`,
      }, { onConflict: 'dedup_key', ignoreDuplicates: false })

      if (risk.hard_fail) hardFails++

      // RAG: durable risk summary (material event when hard-fail = rug/honeypot).
      const summary = riskSummary(symbol, risk, conc)
      try {
        await promoteProviderFact(admin, {
          decisionKind: 'token_risk_summary', subjectType: 'token', subjectRef: ref, entityRefs: [ref], chains: [s.chain],
          title: summary, summary: `${summary}. Sub-scores ${JSON.stringify(risk.sub_scores)}. Confidence ${risk.confidence}.`,
          confidenceScore: risk.confidence, provider: 'birdeye', endpoint: 'birdeye:/defi/token_security',
          sourceTable: 'token_risk_scores', sourceId: `${s.chain}:${s.token_address}`, fetchedAt: new Date().toISOString(),
          evidenceRefs: [{ table: 'token_security_snapshots', id: s.id, metric: 'risk_score' }],
          materialEvent: risk.hard_fail, eventType: 'token_risk_high', importanceScore: risk.hard_fail ? 85 : undefined,
          payload: { score: risk.score, top10_pct: conc.top10_pct, flags: risk.hard_fail_flags },
        })
        ragged++
      } catch { /* best-effort */ }

      scored++
      if (debug) results.push({ ref, symbol, risk: risk.score, hard_fail: risk.hard_fail, top10_pct: conc.top10_pct, band: conc.band, summary })
    }

    return json({ ok: true, scored, skipped_insufficient_data: skipped, hard_fails: hardFails, ragged, ...(debug ? { results } : {}) })
  } catch (err) {
    return json({ error: (err as Error)?.message || 'risk_score_failed' }, 500)
  }
})
