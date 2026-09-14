import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  cardsFromAssetPack, classifyEventType, classifyEventForThesis,
  computeThesisStatus, partnershipMateriality, scoreThesisQuality, normSentiment,
} from './thesis-evidence.ts'

// ── fixtures ────────────────────────────────────────────────
const announcedPartnership = { title: 'FooChain partners with BigCo', summary: 'The two firms announced a strategic partnership to explore integration.' }
const livePartnership = { title: 'FooChain integration live, now driving volume', summary: 'The integration is live and now processing $40M in daily volume, a 30% increase in active users.' }

const packWith = (over: Record<string, unknown> = {}) => ({
  asset: { symbol: 'FOO', chain: 'solana' },
  market_summary: { current_price: 1.2, market_cap: 1e8 },
  catalyst_state: { curated_news: [], catalysts: [] },
  news_state: { stories: [] },
  narrative_state: {},
  ecosystem_narrative_state: { signals: [] },
  unlock_state: {},
  protocol_state: { protocol_tvl: [] },
  risk_state: {},
  ...over,
})

Deno.test('protocol TVL cards preserve chain scope and do not promote unrelated TVL into token usage',()=>{
 const pack=packWith({asset:{symbol:'TOKEN',chain:'base'},protocol_state:{scope:'chain_context',asset_specific:false,context_chain:'base',protocol_tvl:[{protocol_name:'Different protocol',protocol_slug:'different',chain:'base',tvl_usd:0,ts:'2026-09-12T00:00:00Z',provider:'defillama'}]}})
 const card=cardsFromAssetPack(pack)[0]
 assert(card.title.includes('chain context'));assert(card.summary?.includes('not a verified fundamental of TOKEN'))
 assert(card.summary?.includes('included in base chain context'));assert(card.summary?.includes('chain-specific allocation'))
 assert(card.title.includes('$0'));assertEquals(card.date,'2026-09-12T00:00:00Z');assertEquals(card.suggested_thesis_impact,'no_effect')
 assert(!card.watch_metric?.includes('revenue'))
 const legacy=cardsFromAssetPack(packWith({protocol_state:{protocol_tvl:[{protocol_name:'Legacy protocol',tvl_usd:5}]}}))[0]
 assert(legacy.summary?.includes('not a verified fundamental'),'legacy context cannot gain an invented token relationship')
})

// ── classifyEventType ───────────────────────────────────────
Deno.test('classifyEventType routes keywords to the taxonomy', () => {
  assertEquals(classifyEventType('Project X announces partnership with Y'), 'partnership')
  assertEquals(classifyEventType('Protocol suffers $10M exploit'), 'security')
  assertEquals(classifyEventType('SEC files lawsuit against the team'), 'regulatory')
  assertEquals(classifyEventType('Token unlock cliff next week'), 'unlock')
  assertEquals(classifyEventType('Mainnet upgrade ships v2'), 'roadmap')
  assertEquals(classifyEventType('Binance lists FOO'), 'listing')
  assertEquals(classifyEventType('Random market wrap'), 'news')
})

Deno.test('normSentiment normalizes labels', () => {
  assertEquals(normSentiment('Bullish'), 'bullish')
  assertEquals(normSentiment('very bearish'), 'bearish')
  assertEquals(normSentiment('mixed signals'), 'mixed')
  assertEquals(normSentiment(''), null)
})

// ── partnership materiality (the overhype guard) ────────────
Deno.test('announced partnership with no usage is low-materiality and asks for a usage metric', () => {
  const m = partnershipMateriality({ ...announcedPartnership, event_type: 'partnership' })
  assert(['announced', 'signed', 'rumored'].includes(m.partnership_status), `status=${m.partnership_status}`)
  assertEquals(m.impact_metric, 'none_yet')
  assert(m.materiality_score < 0.6)
  assert(/track|confirm/i.test(m.critique_hint))
})

Deno.test('live partnership with measurable usage is high-materiality', () => {
  const m = partnershipMateriality({ ...livePartnership, event_type: 'integration' })
  assertEquals(m.partnership_status, 'measurable_usage')
  assert(m.materiality_score >= 0.6, `score=${m.materiality_score}`)
})

// ── cardsFromAssetPack ──────────────────────────────────────
Deno.test('thin-coverage / empty pack yields no cards', () => {
  assertEquals(cardsFromAssetPack(null).length, 0)
  assertEquals(cardsFromAssetPack(packWith()).length, 0)
})

Deno.test('curated news maps into sectioned cards with stable refs and stance-aware impact', () => {
  const pack = packWith({
    catalyst_state: { curated_news: [
      { title: 'FOO announces partnership with major exchange', why_it_matters: 'Could drive listings and volume', signal: 'bullish', final_score: 0.8, source_count: 4, primary_url: 'https://x.com/a', published_at: '2026-06-10' },
      { title: 'FOO token unlock cliff approaches', signal: 'bearish', final_score: 0.5, published_at: '2026-06-11' },
    ], catalysts: [] },
  })
  const bull = cardsFromAssetPack(pack, 'bullish')
  const partner = bull.find((c) => c.event_type === 'partnership')
  assert(partner, 'has a partnership card')
  assertEquals(partner!.section, 'partnerships')
  assertEquals(partner!.source_table, 'intel_curated_news')
  assertEquals(partner!.materiality, 'high')
  assertEquals(partner!.suggested_thesis_impact, 'supports') // bullish news + bullish stance
  assert(partner!.event_status) // partnership cards carry a status label

  // same pack, bearish stance → the bullish partnership now weakens
  const bear = cardsFromAssetPack(pack, 'bearish')
  assertEquals(bear.find((c) => c.event_type === 'partnership')!.suggested_thesis_impact, 'weakens')

  // stable ref: identical card across runs
  assertEquals(cardsFromAssetPack(pack, 'bullish').find((c) => c.event_type === 'partnership')!.source_ref, partner!.source_ref)
})

Deno.test('token unlock becomes a bearish tokenomics card', () => {
  const pack = packWith({ unlock_state: { next_unlock: { unlock_date: '2026-07-01', days_until: 14, pct_supply: 6 } } })
  const cards = cardsFromAssetPack(pack, 'bullish')
  const unlock = cards.find((c) => c.event_type === 'unlock')
  assert(unlock)
  assertEquals(unlock!.section, 'tokenomics_unlocks')
  assertEquals(unlock!.sentiment, 'bearish')
  assertEquals(unlock!.materiality, 'high') // 6% >= 5%
  assertEquals(unlock!.suggested_thesis_impact, 'weakens') // bearish vs bullish stance
})

// ── classifyEventForThesis ──────────────────────────────────
Deno.test('an invalidation rule match classifies an event as invalidates', () => {
  const card = cardsFromAssetPack(packWith({ unlock_state: { next_unlock: { unlock_date: '2026-07-01', days_until: 10, pct_supply: 8 } } }), 'bullish')
    .find((c) => c.event_type === 'unlock')!
  const out = classifyEventForThesis(card, { stance: 'bullish', rules: [{ id: 'r1', rule_kind: 'invalidation', metric: 'unlock' }] })
  assertEquals(out.impact, 'invalidates')
  assertEquals(out.matched_rule_id, 'r1')
})

Deno.test('without a matching rule, classification falls back to stance vs sentiment', () => {
  const card = cardsFromAssetPack(packWith({ catalyst_state: { curated_news: [{ title: 'Major exploit drains protocol', signal: 'bearish', final_score: 0.9, published_at: '2026-06-10' }], catalysts: [] } }), 'bullish')
    .find((c) => c.event_type === 'security')!
  const out = classifyEventForThesis(card, { stance: 'bullish', rules: [] })
  assertEquals(out.impact, 'weakens')
})

// ── status engine (suggestion only) ─────────────────────────
Deno.test('triggered invalidation rule suggests invalidated and flags user review', () => {
  const r = computeThesisStatus({ stance: 'bullish', triggeredRules: { invalidation: 1 } })
  assertEquals(r.engine_suggested_status, 'invalidated')
  assertEquals(r.needs_user_review, true)
})

Deno.test('all confirmation rules triggered → confirmed; some → partially_confirmed', () => {
  assertEquals(computeThesisStatus({ triggeredRules: { confirmation: 2, totalConfirmation: 2 } }).engine_suggested_status, 'confirmed')
  assertEquals(computeThesisStatus({ triggeredRules: { confirmation: 1, totalConfirmation: 3 } }).engine_suggested_status, 'partially_confirmed')
})

Deno.test('evidence + benchmark tilt drives strengthening / weakening', () => {
  const up = computeThesisStatus({ stance: 'bullish', evidenceCounts: { supports: 3, weakens: 0 }, baselinePrice: 100, livePrice: 130, baselineBenchmark: 100, liveBenchmark: 105 })
  assertEquals(up.engine_suggested_status, 'strengthening')
  const down = computeThesisStatus({ stance: 'bullish', evidenceCounts: { supports: 0, weakens: 3 }, baselinePrice: 100, livePrice: 80, baselineBenchmark: 100, liveBenchmark: 110 })
  assertEquals(down.engine_suggested_status, 'weakening')
})

Deno.test('legacy thesis with no baseline and no rules stays active (no crash)', () => {
  const r = computeThesisStatus({ stance: 'bullish' })
  assertEquals(r.engine_suggested_status, 'active')
  assertEquals(r.needs_user_review, false)
})

Deno.test('asset with no benchmark still computes relative perf from price alone', () => {
  const r = computeThesisStatus({ stance: 'bullish', evidenceCounts: { supports: 2 }, baselinePrice: 100, livePrice: 140 })
  assertEquals(r.engine_suggested_status, 'strengthening')
  assert(typeof r.status_reason.price_vs_benchmark === 'number')
})

Deno.test('overdue review suggests needs_review', () => {
  const r = computeThesisStatus({ stance: 'neutral', nextReviewAt: '2020-01-01T00:00:00Z' })
  assertEquals(r.engine_suggested_status, 'needs_review')
})

// ── quality score ───────────────────────────────────────────
Deno.test('quality flags missing invalidation rule, vague bear case, and price-only metric alignment', () => {
  const q = scoreThesisQuality({
    thesis: { bull_thesis: 'FOO will win because adoption and usage will grow as users flock to it over the next cycle.', watched_metrics: ['price'], time_horizon: 'months' },
    scenarios: [{ kind: 'bull' }],
    rules: [],
    evidence: [],
  })
  assert(q.missing.some((m) => /invalidation/i.test(m)))
  assert(q.missing.some((m) => /bear case/i.test(m)))
  assert(q.missing.some((m) => /adoption/i.test(m)))
  assert(q.score < 70, `score=${q.score}`)
})

Deno.test('a complete thesis scores high with no critical gaps', () => {
  const q = scoreThesisQuality({
    thesis: {
      bull_thesis: 'FOO captures DeFi share as fees and TVL compound; revenue accrues to the token via the fee switch over the next two quarters.',
      bear_thesis: 'If TVL stalls while competitors grow and the fee switch is delayed, FOO underperforms its benchmark and the thesis fails.',
      time_horizon: 'months',
      key_risks: ['unlock dilution', 'competitor TVL growth'],
      watched_metrics: ['fees', 'tvl', 'active users'],
    },
    scenarios: [{ kind: 'bull' }, { kind: 'base' }, { kind: 'bear' }],
    rules: [
      { rule_kind: 'invalidation', metric: 'tvl_change', threshold: -20, comparator: 'lt' },
      { rule_kind: 'confirmation', metric: 'usage_metric', threshold: 25, comparator: 'gt' },
    ],
    evidence: [{}, {}, {}],
  })
  assert(q.score >= 80, `score=${q.score}`)
  assertEquals(q.missing.length, 0)
})
