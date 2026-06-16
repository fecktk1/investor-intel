import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { assembleBrief } from './brief-assemble.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inputs = (): any => ({
  regime: { regime: 'risk_on', flavor: 'btc_led', confidence: 'medium', rationale: 'BTC leading', what_confirms: 'breadth', what_invalidates: 'BTC reversal' },
  narratives: [
    { slug: 'sol-defi', name: 'Solana DeFi', lifecycle_stage: 'heating_up', prev_stage: 'early', signal_class: 'bullish', global_priority_score: 70, clarity_labels: [{ key: 'heating_confirmed', severity: 'ok' }] },
    { slug: 'meme-x', name: 'Meme X', lifecycle_stage: 'crowded', prev_stage: 'crowded', signal_class: 'mixed', global_priority_score: 55, clarity_labels: [{ key: 'crowded_risky', severity: 'warn' }] },
  ],
  signals: [
    { signal_key: 'asset:cg:solana', subject_type: 'asset', subject_id: 'cg:solana', display_symbol: 'SOL', direction: 'bullish', severity: 0.6, global_score: 0.6, why_it_matters: 'Cross-venue strength', what_to_watch_next: 'Volume holding', related_assets: [], score_delta: { prev_direction: 'mixed' } },
    { signal_key: 'asset:cg:bonk', subject_type: 'asset', subject_id: 'cg:bonk', display_symbol: 'BONK', direction: 'bearish', severity: 0.5, global_score: 0.5, why_it_matters: 'Distribution', what_to_watch_next: 'Liquidity', related_assets: [], score_delta: {} },
  ],
  news: [{ cluster_hash: 'n1', cleaned_title: 'SOL ETF advances', why_it_matters: 'Demand', signal: 'bullish', tokens: ['SOL'], final_score: 80 }],
  macro: [{ provider: 'coingecko', total_market_cap_usd: 3_000_000_000_000, total_volume_24h_usd: 120_000_000_000, market_cap_change_24h_pct: 1.8, btc_dominance_pct: 52, as_of: '2026-06-16T10:00:00Z' }],
  rankings: [{ rank: 5, normalized_symbol: 'SOL', name: 'Solana', change_24h_pct: 4.1, market_cap_usd: 80_000_000_000, volume_24h_usd: 4_000_000_000 }],
  categories: [{ category_id: 'solana-ecosystem', category_label: 'Solana Ecosystem', rank: 4, market_cap_change_24h_pct: 2.4, top_3_coins: ['SOL', 'JUP', 'PYTH'] }],
  protocolTvl: [{ protocol_slug: 'marinade', protocol_name: 'Marinade', chain: 'solana', tvl_usd: 1_000_000_000, ts: '2026-06-16T10:00:00Z' }],
  chainTvl: [{ chain: 'solana', tvl_usd: 9_000_000_000, ts: '2026-06-16T10:00:00Z' }],
  flowHighlights: [{ symbol: 'SOL', chain: 'solana', usd_value: 151_000, direction: 'out', label: 'large transfer', observed_at: '2026-06-16T09:30:00Z' }],
  watchlistSymbols: ['SOL'],
  holdings: [{ symbol: 'SOL', value: 1000, dayPnl: 40, dayPnlPct: 4 }],
  prevFingerprint: null,
})

Deno.test('material brief: sections populated, watchlist + portfolio matched', () => {
  const out = assembleBrief(inputs())
  assert(out.material)
  assert(!out.no_meaningful_change)
  assert(out.sections.market_regime)
  assert(out.sections.what_changed_overnight.some((c: { subject: string }) => c.subject === 'Solana DeFi'))
  assert(out.sections.watchlist_impact.signals.some((s: { subject: string }) => s.subject === 'SOL'))
  assert(out.sections.portfolio_impact.biggest_movers[0].symbol === 'SOL')
  assert(out.sections.macro_rotation.global[0].btc_dominance_pct === 52, 'macro context included')
  assert(out.sections.protocol_chain_context.protocol_tvl[0].protocol === 'Marinade', 'protocol TVL context included')
  assert(out.sections.flow_highlights[0].note.includes('Poll-cadence'), 'flow highlights degrade honestly')
  assert(out.sections.major_risks.length > 0, 'bearish + crowded risks retained')
  assert(out.sections.news_that_matters[0].watchlist_match)
})

Deno.test('same inputs → same fingerprint; matching prev fingerprint → no meaningful change, deterministic', () => {
  const a = assembleBrief(inputs())
  const b = assembleBrief(inputs())
  assertEquals(a.change_fingerprint, b.change_fingerprint)
  const c = assembleBrief({ ...inputs(), prevFingerprint: a.change_fingerprint })
  assert(!c.material)
  assert(c.no_meaningful_change)
  assert(typeof c.sections.no_meaningful_change === 'string')
})

Deno.test('changed inputs change the fingerprint', () => {
  const a = assembleBrief(inputs())
  const mod = inputs(); mod.signals[0].direction = 'bearish'
  const b = assembleBrief(mod)
  assert(a.change_fingerprint !== b.change_fingerprint)
})

Deno.test('no-advice lint: descriptive strings contain no buy/sell/hold verbs', () => {
  const out = assembleBrief(inputs())
  const text = JSON.stringify(out.sections).toLowerCase()
  for (const banned of ['you should buy', 'you should sell', ' buy now', ' sell now', 'rebalance your', 'recommended allocation']) {
    assert(!text.includes(banned), `banned phrase present: ${banned}`)
  }
  assert(text.includes('not a recommendation'), 'research framing present')
})
