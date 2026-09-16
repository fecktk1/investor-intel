// Thesis Journal — evidence engine (pure, unit-tested).
//
// Reuse-first: this NEVER fetches a new market-events corpus. It normalizes the
// already-assembled Asset Evidence Pack (assembleAssetEvidencePack) into evidence
// cards, classifies new events against a thesis, computes a deterministic status
// SUGGESTION (never the user's conclusion), scores thesis quality, and applies the
// partnership-materiality rubric. All deterministic; the AI coach only drafts/
// critiques on top of these structured outputs.

import { h32, norm } from '../core-intel/hashing.ts'
import { materialityVerdict } from '../core-intel/materiality.ts'
import type { MetricAgreement } from './metric-agreement.ts'

// ── Types ───────────────────────────────────────────────────
export type EvidenceSection =
  | 'what_changed' | 'news' | 'developments' | 'partnerships' | 'tokenomics_unlocks'
  | 'usage_fundamentals' | 'price_liquidity' | 'risks' | 'competitors' | 'catalysts'

export type Sentiment = 'bullish' | 'bearish' | 'neutral' | 'mixed'
export type Impact = 'supports' | 'weakens' | 'confirms' | 'invalidates' | 'no_effect'

export interface ThesisEvidenceCard {
  section: EvidenceSection
  source_table: string
  source_ref: string
  event_type: string
  title: string
  summary: string | null
  source: string | null
  date: string | null
  materiality: 'high' | 'medium' | 'low'
  sentiment: Sentiment | null
  suggested_thesis_impact: Impact
  watch_metric: string | null
  url: string | null
  source_quality: 'high' | 'medium' | 'low'
  coverage: 'complete' | 'partial' | 'thin'
  event_status: string | null
}

export interface ScenarioLike { kind?: string; probability?: number | null }
export interface RuleLike {
  id?: string; rule_kind?: string; status?: string; metric?: string | null
  comparator?: string | null; threshold?: number | null
}
export interface ThesisLike {
  stance?: string | null; scenarios?: ScenarioLike[]; rules?: RuleLike[]
  watched_metrics?: unknown; bear_thesis?: string | null
  time_horizon?: string | null
}

// deno-lint-ignore no-explicit-any
type Any = any
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const numOrNull = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null }

// ── Sentiment / materiality normalization ───────────────────
export function normSentiment(v: unknown): Sentiment | null {
  const s = norm(v)
  if (!s) return null
  if (/bull|positive|up|accumulat/.test(s)) return 'bullish'
  if (/bear|negative|down|dump|sell/.test(s)) return 'bearish'
  if (/mixed|conflict/.test(s)) return 'mixed'
  if (/neutral|flat/.test(s)) return 'neutral'
  return null
}

// final_score / importance_score may be 0..1 or 0..100 — normalize to 0..1.
function band(score: number | null): 'high' | 'medium' | 'low' {
  if (score == null) return 'low'
  const s = score > 1 ? score / 100 : score
  return s >= 0.66 ? 'high' : s >= 0.33 ? 'medium' : 'low'
}

// ── Event-type taxonomy classifier (deterministic keywords) ──
const TYPE_RULES: Array<[RegExp, string]> = [
  [/\b(hack|exploit|breach|vulnerab|drained?|rug|attack|compromis)/i, 'security'],
  [/\b(sec\b|regulat|lawsuit|court|subpoena|sue[ds]?|ban\b|sanction|compliance|cftc|fined?)/i, 'regulatory'],
  [/\bdelist/i, 'delisting'],
  [/\b(listing|listings|lists\b|gets? listed|now trading on|trading begins)/i, 'listing'],
  [/\b(partner|partnership|collaborat|teams? up|joins forces|strategic alliance)/i, 'partnership'],
  [/\b(integrat|adds support|now supports|support for|deployed on|live on)/i, 'integration'],
  [/\b(unlock|vesting|cliff|token release)/i, 'unlock'],
  [/\b(tokenomic|emission|buyback|burn|fee switch|fee model|staking reward|supply cap)/i, 'tokenomics'],
  [/\b(governance|proposal|\bvote|\bdao\b|on-chain vote)/i, 'governance'],
  [/\b(mainnet|testnet|devnet|hard fork|upgrade|\bv2\b|\bv3\b|roadmap|release|ship(s|ped)?)/i, 'roadmap'],
  [/\b(raise[ds]?|funding|series [a-d]|seed round|raised \$|investment round)/i, 'development'],
  [/\b(developer|github|commit|sdk|open-source|codebase)/i, 'development'],
  [/\b(grant|hackathon|ecosystem fund|incubat)/i, 'ecosystem'],
  [/\b(competitor|rival|outperform|market share)/i, 'competitor'],
]
export function classifyEventType(text: unknown): string {
  const t = String(text || '')
  for (const [re, type] of TYPE_RULES) if (re.test(t)) return type
  return 'news'
}

const SECTION_FOR_TYPE: Record<string, EvidenceSection> = {
  partnership: 'partnerships', integration: 'partnerships',
  development: 'developments', roadmap: 'developments', governance: 'developments', listing: 'developments',
  tokenomics: 'tokenomics_unlocks', unlock: 'tokenomics_unlocks',
  security: 'risks', regulatory: 'risks', delisting: 'risks',
  ecosystem: 'competitors', competitor: 'competitors',
  on_chain: 'usage_fundamentals', fundamental: 'usage_fundamentals',
  technical: 'price_liquidity',
  news: 'news',
}
export function sectionForEventType(type: string): EvidenceSection {
  return SECTION_FOR_TYPE[type] || 'news'
}

// Stable source_ref: url hash > content+date hash. Manual evidence gets a uuid at
// the DB layer; engine cards always derive a deterministic ref so re-runs upsert.
function stableRef(prefix: string, opts: { url?: unknown; title?: unknown; date?: unknown; id?: unknown }): string {
  if (str(opts.id)) return `${prefix}:${str(opts.id)}`
  const url = str(opts.url)
  if (url) return `${prefix}:u${h32(norm(url))}`
  return `${prefix}:c${h32(`${norm(opts.title)}|${norm(opts.date)}`)}`
}

function impactFromSentiment(sentiment: Sentiment | null, stance: string | null): Impact {
  if (!sentiment || sentiment === 'neutral' || sentiment === 'mixed') return 'no_effect'
  const st = norm(stance)
  if (!st || st === 'neutral' || st === 'market_neutral') return 'no_effect'
  const bullishThesis = st === 'bullish'
  if (sentiment === 'bullish') return bullishThesis ? 'supports' : 'weakens'
  return bullishThesis ? 'weakens' : 'supports'   // bearish news
}

// ── Partnership materiality rubric (expanded) ───────────────
export interface PartnershipMateriality {
  partnership_status: 'rumored' | 'announced' | 'signed' | 'integrated' | 'live' | 'measurable_usage' | 'discontinued'
  value_accrual: 'token_direct' | 'protocol_revenue' | 'ecosystem_usage' | 'brand_only' | 'unclear'
  impact_metric: 'active_users' | 'volume' | 'fees' | 'tvl' | 'transactions' | 'liquidity' | 'developer_activity' | 'none_yet'
  materiality_score: number
  critique_hint: string
}
export function partnershipMateriality(card: Pick<ThesisEvidenceCard, 'title' | 'summary' | 'event_type'>): PartnershipMateriality {
  const t = `${card.title || ''} ${card.summary || ''}`.toLowerCase()
  let status: PartnershipMateriality['partnership_status'] = 'announced'
  if (/discontinu|ended|terminat|wind down/.test(t)) status = 'discontinued'
  else if (/measurable|driving (volume|users|fees)|\d+%? (increase|growth)|now processing/.test(t)) status = 'measurable_usage'
  else if (/\b(live|launched|now live|in production)\b/.test(t)) status = 'live'
  else if (/\bintegrated\b|integration (is )?(now )?live|completed integration|now integrated|deployed on/.test(t)) status = 'integrated'
  else if (/\bsigned|agreement|mou\b|deal\b/.test(t)) status = 'signed'
  else if (/rumor|reportedly|in talks|exploring|considering/.test(t)) status = 'rumored'

  let accrual: PartnershipMateriality['value_accrual'] = 'unclear'
  if (/buyback|burn|fee (switch|share)|revenue to (token|holders)|staking reward/.test(t)) accrual = 'token_direct'
  else if (/revenue|fees\b/.test(t)) accrual = 'protocol_revenue'
  else if (/usage|users|adoption|tvl|liquidity|volume/.test(t)) accrual = 'ecosystem_usage'
  else if (/brand|awareness|marketing|logo/.test(t)) accrual = 'brand_only'

  let metric: PartnershipMateriality['impact_metric'] = 'none_yet'
  if (/active (users|addresses)|daily users|maus?\b/.test(t)) metric = 'active_users'
  else if (/volume/.test(t)) metric = 'volume'
  else if (/fees/.test(t)) metric = 'fees'
  else if (/tvl/.test(t)) metric = 'tvl'
  else if (/transactions|txns/.test(t)) metric = 'transactions'
  else if (/liquidity/.test(t)) metric = 'liquidity'
  else if (/developer|github/.test(t)) metric = 'developer_activity'

  const statusScore = { rumored: 0.1, announced: 0.3, signed: 0.45, integrated: 0.6, live: 0.75, measurable_usage: 1, discontinued: 0.05 }[status]
  const accrualScore = { token_direct: 1, protocol_revenue: 0.7, ecosystem_usage: 0.5, brand_only: 0.2, unclear: 0.3 }[accrual]
  const materiality_score = Math.round((statusScore * 0.6 + accrualScore * 0.4) * 100) / 100

  let critique_hint: string
  if (status === 'measurable_usage') critique_hint = 'Measurable usage present — safe to treat as a confirmed driver if your rule tracks it.'
  else if (metric === 'none_yet') critique_hint = `${status === 'rumored' ? 'Rumored' : 'Announced'} but not yet measurable. Suggested confirmation: track fees, active users, transactions, or volume before treating as confirmed.`
  else critique_hint = `Not yet showing measurable impact. Track ${metric.replace('_', ' ')} to confirm value actually accrues.`

  return { partnership_status: status, value_accrual: accrual, impact_metric: metric, materiality_score, critique_hint }
}

// ── cardsFromAssetPack ──────────────────────────────────────
export function cardsFromAssetPack(pack: Any, stance: string | null = null): ThesisEvidenceCard[] {
  if (!pack || typeof pack !== 'object') return []
  const cards: ThesisEvidenceCard[] = []
  const seen = new Set<string>()
  const push = (c: ThesisEvidenceCard) => {
    const k = `${c.source_table}|${c.source_ref}`
    if (seen.has(k)) return
    seen.add(k); cards.push(c)
  }
  const coverageOf = (title: unknown, summary: unknown, date: unknown, url: unknown): ThesisEvidenceCard['coverage'] => {
    const has = [str(summary), str(date), str(url)].filter(Boolean).length
    return has >= 2 ? 'complete' : has === 1 ? 'partial' : 'thin'
  }

  // 1) AI-curated news clusters (richest source: what_happened/why/impact/signal/score)
  const curated: Any[] = Array.isArray(pack?.catalyst_state?.curated_news) ? pack.catalyst_state.curated_news : []
  for (const c of curated) {
    const title = str(c.title); if (!title) continue
    const blob = `${title} ${str(c.summary) || ''} ${str(c.why_it_matters) || ''} ${str(c.crypto_impact) || ''}`
    // Classify on the headline first (the event); fall back to the body only when
    // the title is generic — so "announces partnership … could drive listings"
    // stays a partnership, not a listing.
    const tType = classifyEventType(title)
    const event_type = tType !== 'news' ? tType : classifyEventType(blob)
    const sentiment = normSentiment(c.signal) ?? normSentiment(c.crypto_impact)
    const card: ThesisEvidenceCard = {
      section: sectionForEventType(event_type),
      source_table: 'intel_curated_news',
      source_ref: stableRef('cn', { url: c.url, title, date: c.published_at }),
      event_type,
      title,
      summary: str(c.why_it_matters) || str(c.summary),
      source: null,
      date: str(c.published_at),
      materiality: band(numOrNull(c.final_score)),
      sentiment,
      suggested_thesis_impact: impactFromSentiment(sentiment, stance),
      watch_metric: str(c.watch_next),
      url: str(c.url),
      source_quality: (numOrNull(c.source_count) || 0) >= 3 ? 'high' : (numOrNull(c.source_count) || 0) >= 1 ? 'medium' : 'low',
      coverage: coverageOf(title, c.why_it_matters || c.summary, c.published_at, c.url),
      event_status: null,
    }
    if (event_type === 'partnership' || event_type === 'integration') {
      card.event_status = partnershipMateriality(card).partnership_status
    }
    push(card)
  }

  // 2) Global news stories
  const stories: Any[] = Array.isArray(pack?.news_state?.stories) ? pack.news_state.stories : []
  for (const s of stories) {
    const title = str(s.title); if (!title) continue
    const tType = classifyEventType(title)
    const event_type = tType !== 'news' ? tType : classifyEventType(`${title} ${str(s.summary) || ''}`)
    const sentiment = normSentiment(s.sentiment)
    push({
      section: sectionForEventType(event_type),
      source_table: 'intel_global_news',
      source_ref: stableRef('gn', { url: s.url, title, date: s.published_at }),
      event_type, title,
      summary: str(s.summary),
      source: str(s.source_name),
      date: str(s.published_at),
      materiality: band(numOrNull(s.relevance)),
      sentiment,
      suggested_thesis_impact: impactFromSentiment(sentiment, stance),
      watch_metric: null,
      url: str(s.url),
      source_quality: str(s.source_name) ? 'medium' : 'low',
      coverage: coverageOf(title, s.summary, s.published_at, s.url),
      event_status: null,
    })
  }

  // 3) The driving signal → "what changed recently"
  const sig = pack?.narrative_state?.intel_signal
  if (sig && (str(sig.why_it_matters) || str(sig.direction))) {
    const sentiment = normSentiment(sig.direction)
    push({
      section: 'what_changed',
      source_table: 'intel_signal_state',
      source_ref: stableRef('sig', { id: sig.signal_key, title: sig.display_symbol, date: sig.generated_at }),
      event_type: 'technical',
      title: str(sig.why_it_matters)?.slice(0, 140) || `Signal: ${sig.direction}`,
      summary: str(sig.what_to_watch_next) || str(sig.why_it_matters),
      source: 'Intel Signal',
      date: str(sig.generated_at),
      materiality: band(numOrNull(sig.global_score)),
      sentiment,
      suggested_thesis_impact: impactFromSentiment(sentiment, stance),
      watch_metric: str(sig.what_to_watch_next),
      url: null,
      source_quality: (numOrNull(sig.source_count) || 0) >= 3 ? 'high' : 'medium',
      coverage: 'partial',
      event_status: null,
    })
  }

  // 4) Ecosystem / competitor narrative signals
  const ecoSignals: Any[] = Array.isArray(pack?.ecosystem_narrative_state?.signals) ? pack.ecosystem_narrative_state.signals : []
  for (const e of ecoSignals.slice(0, 6)) {
    const title = str(e.title) || str(e.narrative) || str(e.label); if (!title) continue
    const sentiment = normSentiment(e.direction) ?? normSentiment(e.signal_class)
    push({
      section: 'competitors',
      source_table: 'narrative_signals',
      source_ref: stableRef('narr', { id: e.signal_key || e.narrative_id, title, date: e.observed_at || e.scored_at }),
      event_type: 'ecosystem', title,
      summary: str(e.why_it_matters) || str(e.summary),
      source: 'Narrative Radar',
      date: str(e.observed_at) || str(e.scored_at),
      materiality: band(numOrNull(e.global_priority_score) ?? numOrNull(e.score)),
      sentiment,
      suggested_thesis_impact: impactFromSentiment(sentiment, stance),
      watch_metric: null, url: null,
      source_quality: 'medium', coverage: 'partial', event_status: null,
    })
  }

  // 5) Token unlock (dilution catalyst → tokenomics + risk)
  const nextUnlock = pack?.unlock_state?.next_unlock
  if (nextUnlock && (numOrNull(nextUnlock.pct_supply) != null || str(nextUnlock.unlock_date))) {
    const pct = numOrNull(nextUnlock.pct_supply)
    push({
      section: 'tokenomics_unlocks',
      source_table: 'token_unlocks',
      source_ref: stableRef('unlock', { title: 'unlock', date: nextUnlock.unlock_date }),
      event_type: 'unlock',
      title: `Token unlock${pct != null ? ` (${pct}% of supply)` : ''} on ${str(nextUnlock.unlock_date) || 'upcoming date'}`,
      summary: `Forward dilution catalyst${nextUnlock.days_until != null ? ` in ${nextUnlock.days_until}d` : ''}.`,
      source: 'Unlock calendar',
      date: str(nextUnlock.unlock_date),
      materiality: pct != null ? (pct >= 5 ? 'high' : pct >= 1 ? 'medium' : 'low') : 'medium',
      sentiment: 'bearish',
      suggested_thesis_impact: impactFromSentiment('bearish', stance),
      watch_metric: 'circulating supply, sell pressure post-unlock',
      url: null, source_quality: 'high', coverage: 'complete', event_status: 'live',
    })
  }

  // 6) Retained protocol context. Chain membership does not establish a token
  // fundamental, ownership relation, fee share or holder value accrual.
  const protoTvl: Any[] = Array.isArray(pack?.protocol_state?.protocol_tvl) ? pack.protocol_state.protocol_tvl : []
  for (const p of protoTvl.slice(0, 3)) {
    const tvl = numOrNull(p.tvl_usd); if (tvl == null) continue
    push({
      section: 'usage_fundamentals',
      source_table: 'protocol_tvl_snapshots',
      source_ref: stableRef('tvl', { id: p.protocol_slug, title: p.protocol_name, date: p.ts }),
      event_type: 'fundamental',
      title: `${str(p.protocol_name) || str(p.protocol_slug) || 'Protocol'} TVL: $${Math.round(tvl).toLocaleString()} · chain context`,
      summary: `Reported protocol total value locked${str(p.chain||pack?.protocol_state?.context_chain)?`, included in ${str(p.chain||pack?.protocol_state?.context_chain)} chain context`:''}; not a verified fundamental of ${str(pack?.asset?.symbol)||'the selected asset'}. A chain-specific allocation and token, issuer or holder relationships are unverified.`,
      source: str(p.provider) || 'DeFiLlama',
      date: str(p.ts),
      materiality: 'medium',
      sentiment: null,
      suggested_thesis_impact: 'no_effect',
      watch_metric: 'Protocol TVL trend (chain context)',
      url: null, source_quality: 'high', coverage: 'partial', event_status: 'live',
    })
  }

  return cards
}

// ── Classify a new event against a thesis ───────────────────
export function classifyEventForThesis(
  card: ThesisEvidenceCard,
  ctx: ThesisLike,
): { impact: Impact; drivers: string[]; matched_rule_id?: string } {
  const drivers: string[] = []
  // 1) Rule-threshold match → confirm/invalidate
  for (const r of ctx.rules || []) {
    if (!r.metric) continue
    const metricHit =
      (r.metric === 'unlock' && card.event_type === 'unlock') ||
      (r.metric === 'narrative_heat' && (card.section === 'competitors' || card.event_type === 'ecosystem')) ||
      (r.metric === 'usage_metric' && card.section === 'usage_fundamentals') ||
      (card.event_type === r.metric)
    if (metricHit) {
      const impact: Impact = r.rule_kind === 'invalidation' ? 'invalidates' : 'confirms'
      drivers.push(`${r.rule_kind} rule matched on ${r.metric}`)
      return { impact, drivers, matched_rule_id: r.id }
    }
  }
  // 2) Stance vs sentiment
  const impact = impactFromSentiment(card.sentiment, ctx.stance || null)
  if (card.sentiment) drivers.push(`${card.sentiment} ${card.event_type} vs ${ctx.stance || 'neutral'} stance`)
  return { impact, drivers }
}

// ── Status engine (SUGGESTION only — never the user's conclusion) ──
export interface StatusInput {
  stance?: string | null
  baselinePrice?: number | null
  livePrice?: number | null
  baselineBenchmark?: number | null
  liveBenchmark?: number | null
  evidenceCounts?: { supports?: number; weakens?: number; confirms?: number; invalidates?: number }
  triggeredRules?: { confirmation?: number; invalidation?: number; totalConfirmation?: number }
  lastReviewedAt?: string | null
  nextReviewAt?: string | null
  /** The evidentiary standard's verdict for the market move behind this thesis
   * (see metric-agreement.ts). OMITTED means the caller did not run the test, and
   * every suggestion below is then exactly what it was before the test existed:
   * an absent verdict is never read as a failed one. */
  metricAgreement?: MetricAgreement | null
  now?: Date
}
export type EngineStatus = 'strengthening' | 'weakening' | 'needs_review' | 'confirmed' | 'partially_confirmed' | 'invalidated' | 'active'

export function computeThesisStatus(input: StatusInput): {
  engine_suggested_status: EngineStatus
  status_reason: Record<string, unknown>
  needs_user_review: boolean
} {
  const now = input.now ?? new Date()
  const ev = input.evidenceCounts || {}
  const tr = input.triggeredRules || {}
  const drivers: string[] = []
  // ── Multi-metric concurrence ──
  // An ABSENT verdict means the caller never ran the evidentiary standard, and
  // every suggestion below then behaves exactly as it did before this test
  // existed. A supplied verdict other than 'corroborated' marks the move as a
  // research lead, and a research lead may not be presented as a fully
  // confirmed thesis. Nothing here removes a status: 'partially_confirmed' is
  // the vocabulary this engine already had for "some of it holds".
  const agreement = input.metricAgreement ?? null
  const corroborated = agreement == null || agreement === 'corroborated'
  const say = (perf: number | null) => reason(drivers, ev, perf, now, agreement)

  // price vs benchmark since baseline (benchmark-adjusted)
  let relPerf: number | null = null
  if (input.baselinePrice && input.livePrice && input.baselinePrice > 0) {
    const assetRet = input.livePrice / input.baselinePrice - 1
    let benchRet = 0
    if (input.baselineBenchmark && input.liveBenchmark && input.baselineBenchmark > 0) {
      benchRet = input.liveBenchmark / input.baselineBenchmark - 1
    }
    relPerf = assetRet - benchRet
  }

  // 1) invalidation rule triggered → suggest invalidated (user must confirm)
  if ((tr.invalidation || 0) > 0) {
    drivers.push(`${tr.invalidation} invalidation rule(s) triggered`)
    // Invalidation is NOT gated on corroboration. A thesis that broke should be
    // surfaced on the weaker evidence too: the standard exists to restrain
    // claims of success, not to suppress a warning.
    return { engine_suggested_status: 'invalidated', status_reason: say(relPerf), needs_user_review: true }
  }
  // 2) confirmation rules
  if ((tr.confirmation || 0) > 0) {
    const total = tr.totalConfirmation || tr.confirmation || 0
    const all = total > 0 && (tr.confirmation || 0) >= total
    drivers.push(`${tr.confirmation}/${total || '?'} confirmation rule(s) triggered`)
    if (!corroborated) drivers.push(`market metrics ${agreement}: treated as a research lead`)
    return { engine_suggested_status: all && corroborated ? 'confirmed' : 'partially_confirmed', status_reason: say(relPerf), needs_user_review: true }
  }
  // 3) evidence + price tilt
  const net = (ev.supports || 0) + (ev.confirms || 0) - (ev.weakens || 0) - (ev.invalidates || 0)
  const stanceBull = norm(input.stance) === 'bullish'
  const stanceBear = norm(input.stance) === 'bearish'
  let directional = 0
  if (relPerf != null) directional = stanceBear ? -relPerf : relPerf   // bear thesis wins when relPerf negative
  // A price move whose own metrics point opposite ways is not evidence of
  // direction, so its tilt is withheld from the score. Only that one input is
  // withheld: the reader's evidence counts are untouched and still decide.
  const contradicted = agreement === 'conflicting'
  const score = net + (!contradicted && directional != null ? Math.sign(directional) * (Math.abs(directional) >= 0.1 ? 1 : 0) : 0)
  if (net !== 0) drivers.push(`evidence net ${net > 0 ? '+' : ''}${net}`)
  if (relPerf != null) drivers.push(`vs benchmark ${(relPerf * 100).toFixed(1)}%`)
  if (contradicted && relPerf != null) drivers.push('price tilt withheld: price, market capitalisation and volume disagree')

  if (score >= 2) return { engine_suggested_status: 'strengthening', status_reason: say(relPerf), needs_user_review: (ev.weakens || 0) + (ev.invalidates || 0) > 0 }
  if (score <= -2) return { engine_suggested_status: 'weakening', status_reason: say(relPerf), needs_user_review: true }

  // 4) overdue review
  if (input.nextReviewAt && new Date(input.nextReviewAt).getTime() < now.getTime()) {
    drivers.push('review cadence overdue')
    return { engine_suggested_status: 'needs_review', status_reason: say(relPerf), needs_user_review: true }
  }
  return { engine_suggested_status: 'active', status_reason: say(relPerf), needs_user_review: false }
}

function reason(drivers: string[], ev: Record<string, unknown>, relPerf: number | null, now: Date, metricAgreement: MetricAgreement | null = null) {
  return { drivers, evidence_counts: ev, price_vs_benchmark: relPerf, metric_agreement: metricAgreement, computed_at: now.toISOString() }
}

// Optional: signal-shift dimension via the shared materiality helper.
export function signalShift(baselineSignal: Any, liveSignal: Any): { magnitude: string; drivers: string[] } {
  const toS = (s: Any) => s ? { polarity: norm(s.direction) || null, score: numOrNull(s.global_score) } : null
  const v = materialityVerdict({
    prevEvidenceHash: '', newEvidenceHash: '',
    prevSignal: toS(baselineSignal) || undefined,
    newSignal: toS(liveSignal) || undefined,
  })
  return { magnitude: v.magnitude, drivers: v.drivers || [] }
}

// ── Thesis quality score (8 dimensions) ─────────────────────
export interface QualityResult {
  score: number
  breakdown: Record<string, number>
  missing: string[]
}
export function scoreThesisQuality(input: {
  thesis: Any; scenarios?: Any[]; rules?: Any[]; evidence?: Any[]
}): QualityResult {
  const th = input.thesis || {}
  const scenarios = input.scenarios || []
  const rules = input.rules || []
  const evidence = input.evidence || []
  const missing: string[] = []
  const wm = Array.isArray(th.watched_metrics) ? th.watched_metrics : []

  const has = (v: unknown) => !!str(v) || (Array.isArray(v) && v.length > 0)
  const longEnough = (v: unknown, n = 80) => String(v || '').trim().length >= n

  // 1 specificity — statement substance
  const specificity = longEnough(th.bull_thesis || th.neutral_thesis || th.statement, 60) ? 100 : has(th.bull_thesis || th.statement) ? 55 : 0
  if (specificity < 55) missing.push('Thesis statement is missing or too short — say specifically what you expect and why.')

  // 2 falsifiability — has an invalidation rule
  const invalidations = rules.filter((r) => r.rule_kind === 'invalidation')
  const measurableInval = invalidations.some((r) => r.metric && (r.threshold != null || r.comparator))
  const falsifiability = measurableInval ? 100 : invalidations.length ? 60 : has(th.what_would_invalidate) ? 40 : 0
  if (!measurableInval) missing.push('No measurable invalidation rule — add a metric + threshold that would prove you wrong.')

  // 3 time horizon clarity
  const time_horizon_clarity = has(th.time_horizon) ? 100 : 0
  if (!time_horizon_clarity) missing.push('No time horizon — set how long this thesis is meant to play out.')

  // 4 evidence quality
  const evidence_quality = evidence.length >= 3 ? 100 : evidence.length >= 1 ? 60 : 0
  if (evidence.length === 0) missing.push('No evidence selected from recent developments — attach the items that actually drive your view.')

  // 5 risk completeness
  const risk_completeness = has(th.key_risks) || invalidations.length ? 90 : has(th.what_would_invalidate) ? 50 : 0
  if (risk_completeness < 50) missing.push('Risks are thin — list what could go wrong, not just the bull case.')

  // 6 bear case strength
  const bear_case_strength = longEnough(th.bear_thesis, 80) ? 100 : longEnough(th.bear_thesis, 30) ? 55 : 0
  if (bear_case_strength < 55) missing.push('Bear case is too vague — explain what would make this asset underperform.')

  // 7 metric alignment — if thesis depends on adoption/usage but only tracks price
  const dependsOnUsage = /adopt|usage|users|fees|revenue|tvl|volume|transactions|partnership/i.test(
    `${th.bull_thesis || ''} ${th.statement || ''} ${(scenarios.map((s) => s.narrative).join(' '))}`)
  const tracksUsage = wm.some((m: unknown) => /user|fee|revenue|tvl|volume|transaction|adoption/i.test(String(m))) ||
    rules.some((r) => /usage_metric|tvl_change|volume/i.test(String(r.metric)))
  const onlyPrice = wm.length === 0 || (wm.every((m: unknown) => /price|level/i.test(String(m))) && !tracksUsage)
  const metric_alignment = dependsOnUsage ? (tracksUsage ? 100 : 25) : (wm.length ? 90 : 60)
  if (dependsOnUsage && !tracksUsage) missing.push('Thesis depends on adoption, but your tracked metrics only cover price — add a usage metric (users, fees, volume, TVL).')

  // 8 actionability — scenarios + rules present
  const actionability = (scenarios.length >= 2 ? 60 : scenarios.length ? 30 : 0) + (rules.length ? 40 : 0)
  if (scenarios.length < 2) missing.push('Add structured bull / base / bear scenarios with targets, not just a single view.')

  const breakdown = {
    specificity, falsifiability, time_horizon_clarity, evidence_quality,
    risk_completeness, bear_case_strength, metric_alignment, actionability,
  }
  const score = Math.round(Object.values(breakdown).reduce((a, b) => a + b, 0) / Object.keys(breakdown).length)
  return { score, breakdown, missing }
}
