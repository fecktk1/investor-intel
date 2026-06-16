import {
  compactAssetEvidencePackForPrompt,
  getOrAssembleAssetEvidencePack,
  type AssetEvidencePackOptions,
  type AssetEvidenceSubject,
  type DataCoverage,
} from './asset-evidence-pack.ts'

// deno-lint-ignore no-explicit-any
type DB = any

export interface AssetMiniPackSubject extends AssetEvidenceSubject {
  ref?: string | null
}

export interface AssetMiniPack {
  subject: {
    canonical_key: string
    symbol: string | null
    chain: string | null
    token_address: string | null
    provider_id: string | null
    source_provider: string | null
  }
  content_hash: string
  stale_after: string
  headlines: Record<string, unknown>
  coverage: DataCoverage
  provenance: Record<string, unknown>
  prompt_pack: Record<string, unknown> | null
  cached?: boolean
}

function normalizeMiniSubject(input: string | AssetMiniPackSubject): AssetEvidenceSubject {
  if (typeof input === 'string') {
    const ref = input.trim()
    return ref.includes(':') ? { canonicalKey: ref } : { symbol: ref }
  }
  const ref = String(input.ref || '').trim()
  return {
    ...input,
    canonicalKey: input.canonicalKey || (ref.includes(':') ? ref : null),
    symbol: input.symbol || (ref && !ref.includes(':') ? ref : null),
  }
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function pick(source: unknown, keys: string[]): Record<string, unknown> {
  const r = rec(source)
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (r[key] !== undefined && r[key] !== null) out[key] = r[key]
  }
  return out
}

function firstRow(value: unknown): Record<string, unknown> {
  return Array.isArray(value) ? rec(value[0]) : rec(value)
}

export async function assembleAssetMiniPack(
  db: DB,
  subject: string | AssetMiniPackSubject,
  options: AssetEvidencePackOptions & { maxPromptChars?: number } = {},
): Promise<AssetMiniPack> {
  const evidence = await getOrAssembleAssetEvidencePack(db, normalizeMiniSubject(subject), options)
  const pack = rec(evidence.pack)
  const market = rec(pack.market_summary)
  const dex = rec(pack.dex_state)
  const cex = rec(pack.cex_state)
  const liquidity = rec(pack.liquidity_state)
  const flow = rec(pack.flow_state)
  const holders = rec(pack.holder_state)
  const narrative = rec(pack.narrative_state)
  const news = rec(pack.news_state)
  const risk = rec(pack.risk_state)

  return {
    subject: evidence.subject,
    content_hash: evidence.contentHash,
    stale_after: evidence.staleAfter,
    headlines: {
      market: pick(market, ['current_price', 'change_24h_pct', 'change_7d_pct', 'volume_24h', 'market_cap', 'fdv', 'freshness']),
      dex: {
        status: dex.status || 'missing',
        best_pair: pick(rec(dex.best_pair), ['dex_id', 'price_usd', 'liquidity_usd', 'volume_24h', 'price_change', 'fetched_at']),
      },
      cex: {
        status: cex.status || 'missing',
        profile: pick(rec(cex.profile), ['best_global_provider', 'best_global_pair', 'liquidity_score', 'market_quality_score', 'signal_direction']),
        signal: pick(rec(cex.signal), ['direction', 'strength', 'confidence', 'summary', 'why_it_matters']),
        top_ticker: pick(firstRow(cex.tickers), ['provider', 'price', 'price_change_pct_24h', 'volume_quote_24h', 'spread_pct', 'as_of']),
      },
      liquidity: pick(liquidity, ['cex_bid_depth_usd', 'cex_ask_depth_usd', 'cex_min_spread_pct', 'dex_liquidity_usd', 'freshness']),
      flow: {
        status: flow.status || 'missing',
        latest_large_transfer: pick(firstRow(flow.large_transfers), ['chain', 'symbol', 'amount', 'usd_value', 'direction', 'observed_at']),
        poll_cadence_note: flow.poll_cadence_note || null,
      },
      holders: pick(holders, ['status', 'note']),
      narrative: {
        status: narrative.status || 'missing',
        signal: pick(rec(narrative.intel_signal), ['direction', 'confidence', 'source_count', 'why_it_matters', 'what_to_watch_next']),
        categories: Array.isArray(narrative.categories) ? narrative.categories.slice(0, 3) : [],
      },
      news: {
        status: news.status || 'missing',
        stories: Array.isArray(news.stories) ? news.stories.slice(0, 3) : [],
      },
      risk: pick(risk, ['caution_flags', 'market_cap_estimated', 'signal_direction', 'signal_confidence', 'gaps_affecting_confidence']),
    },
    coverage: evidence.dataCoverage,
    provenance: evidence.sourceProvenance,
    prompt_pack: compactAssetEvidencePackForPrompt(evidence, options.maxPromptChars ?? 4500),
    cached: evidence.cached,
  }
}
