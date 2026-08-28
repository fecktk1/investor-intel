// Investor Intel — Portfolio Tracker: grounded AI portfolio intelligence.
//
// Built LAST (after holdings math, pricing, cost basis, risk, and RLS are
// trustworthy). Mirrors intel-generate's grounding + guardrail + rewrite/block
// flow. Reads the user's REAL holdings + the exchange-market snapshot + global
// public market memory + the user's PRIVATE portfolio memory. Raw holdings,
// balances, addresses, amounts, and ownership facts only persist to private
// portfolio memory; reusable decision/outcome memory must be private-user-scoped.
// Never invents balances/prices/P&L; never financial or tax advice.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { validateSafeLanguage, SAFE_LANGUAGE_RULES } from '../_shared/intel-guardrails.ts'
import { buildMarketMemoryPromptBlock } from '../_shared/exchange-market/memory.ts'
import { loadPriceContexts } from '../_shared/investor-portfolio/pricing.ts'
import { computeTotals } from '../_shared/investor-portfolio/holdings.ts'
import { computePortfolioRisk } from '../_shared/investor-portfolio/risk.ts'
import { buildPortfolioMemoryRecords, writePortfolioMemory, buildPortfolioMemoryPromptBlock } from '../_shared/investor-portfolio/portfolio-memory.ts'
import type { PortfolioHolding, PortfolioTotals, RiskResult } from '../_shared/investor-portfolio/types.ts'
import {
  assembleIntelligenceContext,
  formatIntelligenceContextForPrompt,
  recordDecisionMemory,
  recordExecutionDecisionOutcome,
  type IntelligenceContextBlock,
} from '../_shared/intelligence-core.ts'
import { intelModel, intelEffort } from '../_shared/intel-model-config.ts'
import { recordAIUsage } from '../_shared/usage.ts'
import { recordCostEvent } from '../_shared/core-intel/cost-ledger.ts'
import { makeCostWriter } from '../_shared/intel/intel-cost-writer.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const GROUNDING_PRIVACY = `
GROUNDING (hard requirement):
- Exact current metrics (price, % change, market cap, liquidity, signal direction/strength/confidence)
  MUST come from the provided holdings + exchange_market snapshot, NOT from memory and NOT invented.
  If a metric is absent, say it is unavailable — never imply it is positive.
- Memory blocks (global market + this user's private portfolio memory) are CONTEXT ONLY for
  rationale/history; they never supply exact current numbers.
- Unpriced / stale / estimated-market-cap holdings must be described as such.
- If transaction history is incomplete, say cost basis or P&L may be incomplete.
- NEVER invent, infer, translate, or correct asset names, amounts, balances, transaction
  types, prices, or cost basis. They are provided as authoritative facts — use them exactly.
- For assets flagged unverified, refer to them exactly as given and note the name is unverified.
- For balance-only chains (coverage.balanceOnlyChains), state that ONLY balances are tracked
  (no transactions, no P&L). For beta-history chains, state history is in beta and may be partial.
- For assets with cost_basis_status incomplete/none, you MUST state cost basis / P&L is incomplete
  and MUST NOT estimate it.
- NEVER invent holdings, balances, transactions, cost basis, or P&L.

PRIVACY (hard requirement):
- This analysis is for a single user's private portfolio. NEVER write portfolio holdings, balances,
  addresses, ownership, amounts, or user/org identifiers into any global/public store. Raw
  portfolio facts may persist only in private portfolio memory; summaries and outcomes may persist
  only as private-user-scoped Decision + Execution Intelligence.

NOT ADVICE: Portfolio calculations are informational only and are not tax, accounting, investment,
or financial advice. Cost basis and P&L may be incomplete when transaction history is missing,
unclassified, or manually edited.`

const OUTPUT_CONTRACT = `Return ONLY a JSON object with these string fields (each grounded in the provided data):
{ "summary": "...", "what_changed": "...", "contributors": "...", "signal_exposure": "...",
  "risks": "...", "news_that_matters": "...", "confidence": "high|medium|low" }
If there is no portfolio-relevant news in the provided context, say so plainly in news_that_matters.`

function textOf(s: any): string {
  return [s?.summary, s?.what_changed, s?.contributors, s?.signal_exposure, s?.risks, s?.news_that_matters].filter((x) => typeof x === 'string').join('\n')
}

function compactText(value: unknown, max = 600): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function uniqueRefs(values: Array<string | number | null | undefined>, max = 50): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = compactText(raw, 160)
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

function confidenceScore(value: unknown): number {
  const text = String(value ?? '').toLowerCase()
  if (text.includes('high')) return 0.85
  if (text.includes('low')) return 0.35
  return 0.60
}

function contextRefs(blocks: IntelligenceContextBlock[]): Array<Record<string, unknown>> {
  return blocks.slice(0, 8).map((b) => ({
    memory_class: b.memory_class,
    title: b.title,
    entity_refs: b.entity_refs?.slice(0, 8) || [],
    narrative_refs: b.narrative_refs?.slice(0, 8) || [],
    confidence: b.confidence,
    created_at: b.created_at,
  }))
}

async function callOpenAI(model: string, system: string, user: string, apiKey: string, effort: string = intelEffort()) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }, reasoning_effort: effort,  // cost rule: default low, capped at medium
    }),
  })
  if (!res.ok) throw new Error(`openai_${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  let parsed: any
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}') } catch { parsed = {} }
  return { structured: parsed, usage: data.usage }
}

function rowToHolding(r: any): PortfolioHolding {
  return {
    assetSymbol: r.asset_symbol, normalizedSymbol: r.normalized_symbol, canonicalAssetKey: r.canonical_asset_key,
    contractAddress: r.contract_address, mintOrContract: r.mint_or_contract, chain: r.chain,
    assetClass: r.asset_class || 'token', name: r.name, logoUrl: r.logo_url, verified: r.verified, decimals: r.decimals,
    supportLevel: r.support_level, provider: r.provider, providerNetwork: r.provider_network, costBasisStatus: r.cost_basis_status,
    quantity: Number(r.quantity) || 0, averageCost: r.average_cost, costBasisUsd: r.cost_basis_usd,
    currentPrice: r.current_price, currentValue: r.current_value, priceSource: r.price_source, priceStatus: r.price_status || 'unpriced',
    lastPricedAt: r.last_priced_at, unrealizedPnl: r.unrealized_pnl, unrealizedPnlPct: r.unrealized_pnl_pct, realizedPnl: r.realized_pnl,
    dayPnl: r.day_pnl, dayPnlPct: r.day_pnl_pct, allocationPct: r.allocation_pct, pnlState: r.pnl_state || 'estimate',
    reconciliationStatus: r.reconciliation_status, marketContext: r.market_context || {}, isDust: !!r.is_dust,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No authorization header' }, 401)
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const db = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const serviceClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: { user } } = await db.auth.getUser()
    if (!user) return json({ error: 'unauthorized' }, 401)

    const body = await req.json().catch(() => ({}))
    const portfolioId = body?.portfolioId
    if (!portfolioId) return json({ error: 'portfolioId required' }, 400)

    const { data: portfolio } = await db.from('investor_portfolios')
      .select('id, org_id, user_id, name, base_currency').eq('id', portfolioId).maybeSingle()
    if (!portfolio) return json({ error: 'not_found' }, 404)   // RLS guarantees ownership

    const { data: rows } = await db.from('investor_portfolio_holdings').select('*').eq('portfolio_id', portfolioId).eq('is_closed', false).order('current_value', { ascending: false, nullsFirst: false })
    const holdings: PortfolioHolding[] = (rows || []).map(rowToHolding)
    if (!holdings.length) return json({ ok: true, empty: true, artifact: { artifact_type: 'portfolio_intel', structured: { summary: 'No holdings yet — add a transaction or connect a wallet to generate portfolio intelligence.', confidence: 'low' } } })

    const totals: PortfolioTotals = computeTotals(holdings)
    const risk: RiskResult = computePortfolioRisk(holdings, totals)

    // exchange snapshot for held symbols (cache-only)
    const symbols = holdings.map((h) => h.normalizedSymbol).filter(Boolean) as string[]
    const priced = await loadPriceContexts(serviceClient, symbols)
    const marketBlock = holdings.slice(0, 25).map((h) => {
      const c = priced.contexts.get((h.normalizedSymbol || '').toUpperCase())
      const nm = h.name ? ` (${h.name})` : ''
      const sl = h.supportLevel && h.supportLevel !== 'full_history_pnl' ? `, support ${h.supportLevel}` : ''
      const unv = h.verified === false ? ', name UNVERIFIED' : ''
      return `${h.assetSymbol || h.normalizedSymbol}${nm}: value ${h.currentValue == null ? 'unpriced' : `$${Math.round(h.currentValue)}`}, alloc ${h.allocationPct == null ? 'n/a' : h.allocationPct.toFixed(1) + '%'}, 24h ${h.dayPnlPct == null ? 'n/a' : h.dayPnlPct.toFixed(1) + '%'}, signal ${c?.signalDirection || 'n/a'}, price_status ${h.priceStatus}, cost_basis ${h.costBasisStatus || h.pnlState}${sl}${unv}${(c?.cautionFlags?.length) ? `, caution: ${c.cautionFlags.join('; ')}` : ''}`
    }).join('\n')

    // Deterministic coverage disclosures the AI must surface honestly.
    const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter(Boolean))] as string[]
    const coverage = {
      incompleteCostBasis: uniq(holdings.filter((h) => h.costBasisStatus === 'incomplete' || h.costBasisStatus === 'partial' || (!h.costBasisStatus && h.pnlState === 'incomplete_history')).map((h) => h.assetSymbol)).slice(0, 20),
      balanceOnlyChains: uniq(holdings.filter((h) => h.supportLevel === 'balance_only').map((h) => h.chain)),
      betaHistoryChains: uniq(holdings.filter((h) => h.supportLevel === 'beta_history').map((h) => h.chain)),
      unverifiedAssets: uniq(holdings.filter((h) => h.verified === false).map((h) => h.assetSymbol)).slice(0, 20),
    }

    // recent classified activity (grounding for "what changed")
    const { data: recentTx } = await db.from('investor_portfolio_tx')
      .select('type, title, protocol, block_time').eq('portfolio_id', portfolioId)
      .order('block_time', { ascending: false, nullsFirst: false }).limit(15)
    const activityBlock = (recentTx || []).map((x: any) => `${x.block_time ? new Date(x.block_time).toISOString().slice(0, 10) : ''} ${x.type}: ${x.title || ''}${x.protocol ? ` (${x.protocol})` : ''}`).join('\n')

    const openaiKey = Deno.env.get('OPENAI_API_KEY') || ''
    const q = `portfolio ${portfolio.name} value ${Math.round(totals.totalValueUsd)} risk ${risk.band} top ${holdings.slice(0, 3).map((h) => h.assetSymbol).join(' ')}`
    const portfolioEntityRefs = uniqueRefs([
      portfolioId,
      portfolio.name,
      ...holdings.flatMap((h) => [h.normalizedSymbol, h.assetSymbol, h.canonicalAssetKey]),
    ], 80)
    const [globalMem, privateMem, platformIntelligence] = await Promise.all([
      buildMarketMemoryPromptBlock(serviceClient, { query: q, openaiKey }).catch(() => ''),
      buildPortfolioMemoryPromptBlock(db, { query: q, portfolioId, openaiKey }).catch(() => ''),
      assembleIntelligenceContext(db, {
        surface: 'portfolio_intelligence',
        orgId: portfolio.org_id,
        userId: portfolio.user_id,
        query: q,
        entityRefs: portfolioEntityRefs,
        includePrivateKnowledge: false,
        limit: 8,
      }).catch(() => ({ blocks: [] as IntelligenceContextBlock[] })),
    ])
    const platformContextRefs = contextRefs(platformIntelligence.blocks)
    const platformMem = formatIntelligenceContextForPrompt(platformIntelligence.blocks, {
      heading: 'PLATFORM PORTFOLIO INTELLIGENCE MEMORY',
      maxBlocks: 8,
      maxSummaryChars: 320,
    })

    const factPack = {
      totals: { totalValue: totals.totalValueUsd, dayPnlPct: totals.dayPnlPct, unrealizedPnl: totals.unrealizedPnlUsd, realizedPnl: totals.realizedPnlUsd, stablecoinPct: totals.stablecoinPct, unpriced: totals.unpricedCount, stale: totals.staleCount, incompleteHistory: totals.incompleteHistory },
      risk: { score: risk.score, band: risk.band, drivers: risk.factors.filter((f) => f.effect === 'risk').slice(0, 5).map((f) => ({ factor: f.factor, detail: f.detail })) },
      marketDataAvailable: priced.marketDataAvailable,
      coverage,
    }

    const system = `You are Investor Intel's portfolio analyst. Produce grounded, plain-English portfolio context for a retail crypto user.\n${SAFE_LANGUAGE_RULES}\n${GROUNDING_PRIVACY}\n${OUTPUT_CONTRACT}`
    const userMsg = `PORTFOLIO FACTS (authoritative — do not contradict):\n${JSON.stringify(factPack)}\n\nHOLDINGS + MARKET SNAPSHOT:\n${marketBlock}\n\nRECENT ACTIVITY (classified deterministically — do not reinterpret types/assets):\n${activityBlock || 'none imported yet'}\n\n${globalMem}\n\n${privateMem}\n\n${platformMem}\n\nWrite the JSON now. Ground every number in the facts above; describe unpriced/stale/incomplete states honestly, and surface coverage limitations (incomplete cost basis, balance-only chains, beta history) plainly.`

    let structured: any
    let blocked = false
    // Portfolio is a grounded compile over the user's holdings + cached market facts using
    // gpt-5.6-luna; a guardrail miss permits one constrained rewrite on the same model.
    let modelUsed = 'deterministic'
    let usage: any = null            // final-call OpenAI usage → cost ledger
    let providerCalls = 0
    if (!openaiKey) {
      // degrade gracefully without AI — return the deterministic risk summary
      structured = { summary: `Portfolio value ${totals.totalValueUsd ? '$' + Math.round(totals.totalValueUsd) : 'unavailable'}. ${risk.summary}`, what_changed: 'AI narrative unavailable (no model key); showing deterministic risk context.', risks: risk.summary, confidence: 'low' }
    } else {
      modelUsed = intelModel('standard')
      const first = await callOpenAI(modelUsed, system, userMsg, openaiKey)
      structured = first.structured; usage = first.usage; providerCalls++
      // Telemetry: record the OpenAI call so portfolio spend is visible in ai_usage.
      void recordAIUsage(serviceClient, { orgId: portfolio.org_id, userId: portfolio.user_id, provider: 'openai', model: modelUsed, surface: 'investor_intel', subMode: 'portfolio_intel', providerUsage: first.usage, status: 'success' })
      let check = validateSafeLanguage(textOf(structured))
      if (!check.ok) {
        // One constrained Luna rewrite is permitted only because the guardrail failed.
        modelUsed = intelModel('escalate')
        const retry = await callOpenAI(modelUsed, system, `${userMsg}\n\nYour previous draft used advice-like language (${check.hits.map((h: any) => h.match).slice(0, 5).join(', ')}). Rewrite as neutral research/risk context with NO buy/sell/hold guidance.`, openaiKey)
        structured = retry.structured; usage = retry.usage; providerCalls++
        void recordAIUsage(serviceClient, { orgId: portfolio.org_id, userId: portfolio.user_id, provider: 'openai', model: modelUsed, surface: 'investor_intel', subMode: 'portfolio_intel:escalate_rewrite', providerUsage: retry.usage, status: 'success' })
        check = validateSafeLanguage(textOf(structured))
        if (!check.ok) { blocked = true; structured = { summary: 'Output withheld — could not produce portfolio context within the non-advice guardrails. Please try again.', confidence: 'low' } }
      }
    }

    // Cost ledger: one row per portfolio_intel decision (mirrors intel-generate / intel-brief-cron)
    // so portfolio shows up in intel_cost_ledger alongside the per-call ai_usage rows above.
    try {
      await recordCostEvent(makeCostWriter(serviceClient), {
        feature: 'portfolio_intel', orgId: portfolio.org_id, artifactType: 'portfolio_intel', subjectRef: portfolioId,
        model: providerCalls ? modelUsed : null,
        cacheStatus: providerCalls ? 'fresh' : 'no_ai',
        allowReason: providerCalls ? (providerCalls > 1 ? 'guardrail_rewrite' : 'fresh') : 'n/a_no_ai',
        providerCallsMade: providerCalls,
        usage: { tokens_in: usage?.prompt_tokens, tokens_out: usage?.completion_tokens, blocked },
      }, { precision: 'exact', nowMs: Date.now() })
    } catch { /* ledger best-effort — telemetry must never break the request */ }

    // persist ONLY to private memory (deterministic facts + the AI change-log)
    if (!blocked) {
      const records = buildPortfolioMemoryRecords({ holdings, totals, risk })
      if (typeof structured?.what_changed === 'string' && structured.what_changed.length > 8) {
        records.push({ subjectKey: `change:${new Date().toISOString().slice(0, 10)}`, normalizedSymbol: null, memoryType: 'change_log', timeframe: 'daily', title: 'What changed', summary: String(structured.what_changed).slice(0, 1000), facts: {}, confidenceScore: 55, contentHash: '', asOf: Date.now() })
      }
      await writePortfolioMemory(db, portfolioId, portfolio.org_id, portfolio.user_id, records, { openaiKey, now: Date.now() }).catch(() => {})
    }

    const decisionId = await recordDecisionMemory(serviceClient, {
      visibility: 'org_private',
      orgId: portfolio.org_id,
      userId: portfolio.user_id,
      surface: 'portfolio_intelligence',
      decisionKind: blocked ? 'portfolio_intel_blocked' : 'portfolio_intel_generated',
      subjectType: 'portfolio',
      subjectRef: portfolioId,
      recommendation: compactText(structured?.summary || (blocked ? 'Portfolio intelligence output withheld' : 'Portfolio intelligence generated'), 500),
      conclusion: compactText(textOf(structured), 1200) || null,
      reasoningSummary: compactText(
        `Generated private portfolio intelligence from current holdings, exchange market memory, user-private portfolio memory, and ${platformContextRefs.length} platform intelligence block(s).`,
        900,
      ),
      evidenceRefs: [
        { source_table: 'investor_portfolios', source_id: portfolioId },
        { source_table: 'investor_portfolio_holdings', portfolio_id: portfolioId, row_count: holdings.length },
        { source_table: 'investor_portfolio_tx', portfolio_id: portfolioId, row_count: (recentTx || []).length },
      ],
      retrievedContextRefs: platformContextRefs,
      sourceRefs: [{ source: 'portfolio_intelligence', portfolio_id: portfolioId }],
      entityRefs: portfolioEntityRefs,
      confidence: structured?.confidence || (blocked ? 'low' : 'medium'),
      confidenceScore: confidenceScore(structured?.confidence),
      assumptions: [
        'Holdings, prices, and transaction classifications are authoritative only when present in the supplied portfolio facts.',
        'Generated text is informational context, not financial, tax, or investment advice.',
      ],
      alternativesConsidered: [
        'Return deterministic risk summary only when model generation is unavailable.',
        'Withhold output when the safety rewrite still violates non-advice guardrails.',
      ],
      model: modelUsed,
      decisionHash: `portfolio_intel:${portfolioId}:${new Date().toISOString().slice(0, 10)}`,
      metadata: {
        private_user_scope: true,
        source_table: 'intel-portfolio',
        portfolio_id: portfolioId,
        holdings_count: holdings.length,
        risk_band: risk.band,
        blocked,
        market_data_available: priced.marketDataAvailable,
        platform_intelligence_blocks: platformContextRefs.length,
      },
    }).catch(() => null)

    await recordExecutionDecisionOutcome(serviceClient, {
      decisionId,
      orgId: portfolio.org_id,
      userId: portfolio.user_id,
      surface: 'portfolio_intelligence',
      outcomeKind: blocked ? 'portfolio_intel_blocked' : 'portfolio_intel_generated',
      subjectType: 'portfolio',
      subjectRef: portfolioId,
      metrics: {
        holdings_count: holdings.length,
        risk_band: risk.band,
        risk_score: risk.score,
        unpriced_count: totals.unpricedCount,
        stale_count: totals.staleCount,
        incomplete_history: totals.incompleteHistory,
        market_data_available: priced.marketDataAvailable,
        platform_intelligence_blocks: platformContextRefs.length,
      },
      accuracyLabel: 'unknown',
      usefulnessScore: blocked ? 0.20 : 0.65,
      sourceOutcomeRefs: [{ source_table: 'intel-portfolio', source_id: portfolioId }],
      metadata: {
        private_user_scope: true,
        source_table: 'intel-portfolio',
        portfolio_id: portfolioId,
        blocked,
      },
    }).catch(() => null)

    return json({
      ok: true, blocked,
      artifact: {
        artifact_type: 'portfolio_intel', confidence: structured?.confidence || 'medium',
        sources: ['Holdings', 'Exchange market data', priced.marketDataAvailable ? 'Live prices' : 'Pricing unavailable'],
        structured,
        risk: { score: risk.score, band: risk.band, factors: risk.factors },
      },
    })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'failed' }, 500)
  }
})
