// Investor adapter — Daily Brief deterministic assembly (pure, no I/O, no AI).
//
// Builds the brief's sections entirely from STORED intelligence the caller
// fetched from cached tables: market regime, what changed overnight, watchlist
// impact, portfolio impact, narrative heat (+ clarity labels), major risks
// (bullish AND bearish retained), news that matters, what to watch next — and a
// "no meaningful change" flag when the change fingerprint matches the previous
// period. Research context only; never advice.

import { h32 } from '../core-intel/hashing.ts'
import { briefNativeSymbol, briefSignalMatches } from './brief-identity.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface BriefInputs {
  regime?: Any | null                 // intel_current_regime row
  narratives?: Any[]                  // narrative_state + taxonomy (top by priority)
  signals?: Any[]                     // intel_signal_state rows (top by global_score)
  news?: Any[]                        // intel_curated_news should_surface rows
  macro?: Any[]                       // market_macro_snapshots rows
  rankings?: Any[]                    // market_ranking_snapshots rows
  categories?: Any[]                  // narrative_category_snapshots rows
  protocolTvl?: Any[]                 // protocol_tvl_snapshots rows
  chainTvl?: Any[]                    // chain_tvl_snapshots rows
  flowHighlights?: Any[]              // large_transfer_events rows
  watchlistSymbols?: string[]         // org watchlist display symbols (UPPER)
  watchlistAssets?: Any[]
  portfolio?: {id: string; name?: string} | null
  holdings?: Array<{ canonicalKey?: string | null; chain?: string | null; tokenAddress?: string | null; quantity?: number; symbol: string; value?: number | null; dayPnl?: number | null; dayPnlPct?: number | null }>
  prevFingerprint?: string | null
}

export interface AssembledBrief {
  sections: Record<string, Any>
  change_fingerprint: string
  material: boolean
  no_meaningful_change: boolean
}

const upper = (s: unknown) => String(s || '').toUpperCase().replace(/^\$/, '')

export function assembleBrief(inp: BriefInputs): AssembledBrief {
  const regime = inp.regime || null
  const narratives = inp.narratives || []
  const signals = inp.signals || []
  const news = inp.news || []
  const macro = inp.macro || []
  const rankings = inp.rankings || []
  const categories = inp.categories || []
  const protocolTvl = inp.protocolTvl || []
  const chainTvl = inp.chainTvl || []
  const flowHighlights = inp.flowHighlights || []
  const wl = new Set(inp.watchlistAssets ? inp.watchlistAssets.map(briefNativeSymbol).filter(Boolean) : (inp.watchlistSymbols || []).map(upper))
  const holdings = (inp.holdings || []).filter((h) => h.symbol)
  const heldSet = new Set(holdings.map((h) => upper(h.symbol)))

  // What changed overnight: narrative stage moves + signal flips/material moves.
  const overnight: Any[] = []
  for (const n of narratives) {
    if (n.prev_stage && n.lifecycle_stage && n.prev_stage !== n.lifecycle_stage) {
      overnight.push({ kind: 'narrative', subject: n.name || n.slug, summary: `Moved ${n.prev_stage} → ${n.lifecycle_stage}`, ref: n.slug })
    }
  }
  for (const s of signals) {
    const sd = s.score_delta || {}
    if (sd.prev_direction && sd.prev_direction !== s.direction) {
      overnight.push({ kind: 'signal', subject: s.display_symbol || s.subject_id, summary: `Signal flipped ${sd.prev_direction} → ${s.direction}` })
    } else if (typeof sd.d_global_score === 'number' && Math.abs(sd.d_global_score) >= 0.18) {
      overnight.push({ kind: 'signal', subject: s.display_symbol || s.subject_id, summary: sd.d_global_score > 0 ? 'Signal strengthened materially' : 'Signal weakened materially' })
    }
  }

  // Watchlist impact: signals + news touching watched symbols.
  const sigSym = (s: Any) => upper(s.display_symbol)
  const watchlistSignals = signals.filter((s) => inp.watchlistAssets ? inp.watchlistAssets.some(row => briefSignalMatches(row, s)) : wl.has(sigSym(s)))
  const watchlistNews = news.filter((c) => Array.isArray(c.tokens) && c.tokens.some((t: string) => wl.has(upper(t))))

  // Portfolio impact (deterministic; descriptive only).
  const movers = holdings.filter((h) => typeof h.dayPnl === 'number').sort((a, b) => Math.abs(b.dayPnl!) - Math.abs(a.dayPnl!))
  const portfolioSignals = signals.filter((s) => holdings.some(row => briefSignalMatches(row, s)))

  // Narrative heat: top narratives + their clarity labels.
  const heat = narratives.slice(0, 6).map((n) => ({
    slug: n.slug, name: n.name || n.slug, stage: n.lifecycle_stage, signal: n.signal_class,
    priority: n.global_priority_score, clarity_labels: n.clarity_labels || [],
  }))

  // Major risks: bearish/high-severity signals + crowded/hype narratives.
  // Bullish AND bearish are both retained across the brief — this section is
  // specifically the risk side.
  const risks: Any[] = []
  for (const s of signals.filter((x) => x.direction === 'bearish' && (x.severity ?? 0) >= 0.45).slice(0, 4)) {
    risks.push({ kind: 'signal', subject: s.display_symbol || s.subject_id, note: s.why_it_matters || 'Bearish signal with elevated severity.' })
  }
  for (const n of narratives.filter((x) => Array.isArray(x.clarity_labels) && x.clarity_labels.some((l: Any) => l.key === 'crowded_risky' || l.key === 'mostly_social_hype')).slice(0, 3)) {
    risks.push({ kind: 'narrative', subject: n.name || n.slug, note: 'Crowded or hype-heavy — confirmation is weak relative to attention.' })
  }

  // News that matters: top curated; watchlist-matched first.
  const newsRanked = [...news].sort((a, b) => ((watchlistNews.includes(b) ? 20 : 0) + (b.final_score || 0)) - ((watchlistNews.includes(a) ? 20 : 0) + (a.final_score || 0)))
  const newsOut = newsRanked.slice(0, 5).map((c) => ({ title: c.cleaned_title || c.title, why: c.why_it_matters || null, signal: c.signal || null, watchlist_match: watchlistNews.includes(c) }))

  // Stage F2 context: cached macro/category rotation, protocol/chain TVL, and
  // poll-cadence flow highlights. Compact and descriptive; no advice language.
  const macroContext = {
    global: macro.slice(0, 2).map((m) => ({
      provider: m.provider,
      market_cap: m.total_market_cap_usd ?? null,
      volume_24h: m.total_volume_24h_usd ?? null,
      market_cap_change_24h_pct: m.market_cap_change_24h_pct ?? null,
      btc_dominance_pct: m.btc_dominance_pct ?? null,
      eth_dominance_pct: m.eth_dominance_pct ?? null,
      stablecoin_market_cap_usd: m.stablecoin_market_cap_usd ?? null,
      as_of: m.as_of || m.fetched_at || null,
    })),
    ranking_rotation: rankings.slice(0, 8).map((r) => ({
      rank: r.rank,
      symbol: upper(r.normalized_symbol || r.symbol),
      name: r.name || null,
      change_24h_pct: r.change_24h_pct ?? null,
      market_cap_usd: r.market_cap_usd ?? null,
      volume_24h_usd: r.volume_24h_usd ?? null,
    })),
    category_rotation: categories.slice(0, 6).map((c) => ({
      category: c.category_label || c.category_id,
      rank: c.rank ?? null,
      market_cap_change_24h_pct: c.market_cap_change_24h_pct ?? null,
      top_3_coins: c.top_3_coins || [],
    })),
  }
  const protocolChainContext = {
    protocol_tvl: protocolTvl.slice(0, 6).map((p) => ({
      protocol: p.protocol_name || p.protocol_slug,
      chain: p.chain || null,
      tvl_usd: p.tvl_usd ?? null,
      as_of: p.ts || p.fetched_at || null,
    })),
    chain_tvl: chainTvl.slice(0, 6).map((c) => ({
      chain: c.chain,
      tvl_usd: c.tvl_usd ?? null,
      as_of: c.ts || c.fetched_at || null,
    })),
  }
  const flowOut = flowHighlights.slice(0, 5).map((f) => ({
    symbol: upper(f.symbol),
    chain: f.chain || null,
    usd_value: f.usd_value ?? null,
    direction: f.direction || null,
    label: f.label || null,
    observed_at: f.observed_at || f.fetched_at || null,
    note: 'Poll-cadence flow highlight; webhook lanes remain dormant until registered.',
  }))

  // What to watch next: stored what_to_watch_next + regime invalidators.
  const watchNext = [
    ...signals.slice(0, 4).map((s) => s.what_to_watch_next).filter(Boolean),
    ...(regime?.what_invalidates ? [regime.what_invalidates] : []),
  ].slice(0, 5)

  // Fingerprint over the MATERIAL inputs (regime + stages + signal directions +
  // top news + holdings movers). Same fingerprint as yesterday → no change.
  const change_fingerprint = h32([
    `portfolio:${inp.portfolio?.id || 'none'}`,
    ...holdings.map(h => `holding:${h.canonicalKey || 'unresolved'}:${h.quantity ?? ''}:${h.value ?? ''}`).sort(),
    regime ? `${regime.regime}|${regime.flavor || ''}` : 'no-regime',
    ...narratives.slice(0, 10).map((n) => `${n.slug}:${n.lifecycle_stage}`),
    ...signals.slice(0, 12).map((s) => `${s.signal_key || s.subject_id}:${s.direction}`),
    ...newsRanked.slice(0, 5).map((c) => String(c.cluster_hash || c.title)),
    ...movers.slice(0, 3).map((m) => `${upper(m.symbol)}:${Math.round((m.dayPnlPct ?? 0))}`),
    ...macro.slice(0, 2).map((m) => `macro:${m.provider}:${m.as_of}:${m.market_cap_change_24h_pct}`),
    ...categories.slice(0, 6).map((c) => `cat:${c.category_id}:${c.rank}:${c.market_cap_change_24h_pct}`),
    ...protocolTvl.slice(0, 6).map((p) => `ptvl:${p.protocol_slug}:${p.chain}:${Math.round(Number(p.tvl_usd || 0))}`),
    ...chainTvl.slice(0, 6).map((c) => `ctvl:${c.chain}:${Math.round(Number(c.tvl_usd || 0))}`),
    ...flowHighlights.slice(0, 5).map((f) => `flow:${f.tx_hash || f.event_key || f.observed_at}:${Math.round(Number(f.usd_value || 0))}`),
  ].join('~'))

  const material = !inp.prevFingerprint || inp.prevFingerprint !== change_fingerprint
  const no_meaningful_change = !material

  const sections: Record<string, Any> = {
    portfolio_scope: inp.portfolio || null,
    market_regime: regime ? { regime: regime.regime, flavor: regime.flavor, confidence: regime.confidence, rationale: regime.rationale, what_confirms: regime.what_confirms, what_invalidates: regime.what_invalidates } : null,
    what_changed_overnight: overnight.slice(0, 8),
    watchlist_impact: { signals: watchlistSignals.slice(0, 5).map((s) => ({ subject: sigSym(s), direction: s.direction, why: s.why_it_matters })), news: watchlistNews.slice(0, 4).map((c) => ({ title: c.cleaned_title || c.title, signal: c.signal })) },
    portfolio_impact: heldSet.size ? {
      biggest_movers: movers.slice(0, 3).map((m) => ({ symbol: upper(m.symbol), day_change_usd: m.dayPnl ?? null, day_change_pct: m.dayPnlPct ?? null })),
      signals: portfolioSignals.slice(0, 4).map((s) => ({ subject: sigSym(s), direction: s.direction, why: s.why_it_matters })),
      framing: 'Research context describing your holdings — not a recommendation.',
    } : null,
    narrative_heat: heat,
    macro_rotation: macroContext,
    protocol_chain_context: protocolChainContext,
    flow_highlights: flowOut,
    major_risks: risks.slice(0, 6),
    news_that_matters: newsOut,
    what_to_watch_next: watchNext,
  }
  if (no_meaningful_change) {
    sections.no_meaningful_change = 'No material overnight change across your watchlist, holdings, and tracked narratives — the regime and narrative heat sections below carry today\'s standing context.'
  }

  return { sections, change_fingerprint, material, no_meaningful_change }
}
