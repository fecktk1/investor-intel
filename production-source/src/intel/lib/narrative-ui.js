// Narrative Radar — presentational helpers (labels + colors). Pure, no React.

// Lifecycle stages → label + chip class. Matches the 8 deterministic stages.
export const STAGE_META = {
  early: { label: 'Early', cls: 'chip--info' },
  heating_up: { label: 'Heating up', cls: 'chip--ok' },
  confirmed: { label: 'Confirmed', cls: 'chip--ok' },
  crowded: { label: 'Crowded', cls: 'text-amber-400' },
  cooling: { label: 'Cooling', cls: 'text-amber-400' },
  fading: { label: 'Fading', cls: 'chip--err' },
  re_accelerating: { label: 'Re-accelerating', cls: 'chip--ok' },
  hype_only_high_risk: { label: 'Hype · high risk', cls: 'chip--err' },
}
export function stageMeta(stage) { return STAGE_META[stage] || { label: stage || '—', cls: '' } }

// The 5 CUSTOMER-FACING display statuses (internal 8-stage maps to these in the backend).
export const DISPLAY_STATUS_META = {
  early: { label: 'Early', cls: 'chip--info' },
  heating_up: { label: 'Heating up', cls: 'chip--ok' },
  crowded: { label: 'Crowded', cls: 'text-amber-400' },
  cooling: { label: 'Cooling', cls: 'text-amber-400' },
  dormant: { label: 'Dormant', cls: 'text-[var(--fg-4)]' },
}
// Fallback map if display_status is absent (older rows).
const STAGE_TO_DISPLAY = {
  early: 'early', heating_up: 'heating_up', confirmed: 'heating_up', re_accelerating: 'heating_up',
  crowded: 'crowded', hype_only_high_risk: 'crowded', cooling: 'cooling', fading: 'dormant',
}
export function displayStatus(n) { return n?.display_status || STAGE_TO_DISPLAY[n?.lifecycle_stage] || 'cooling' }
export function displayStatusMeta(s) { return DISPLAY_STATUS_META[s] || { label: s || '—', cls: '' } }

// Confirmation indicator (market / on-chain): honest label + dot.
export function confirmationMeta(score) {
  if (score == null) return { label: 'Unconfirmed', dot: 'bg-[var(--fg-5,#555)]', text: 'text-[var(--fg-4)]' }
  if (score >= 66) return { label: 'Confirmed', dot: 'bg-emerald-400', text: 'text-emerald-400' }
  if (score >= 45) return { label: 'Partial', dot: 'bg-amber-400', text: 'text-amber-400' }
  return { label: 'Weak', dot: 'bg-red-400', text: 'text-red-400' }
}

// Signal class → label + chip class.
export const SIGNAL_META = {
  bullish: { label: 'Bullish', cls: 'chip--ok' },
  bearish: { label: 'Bearish', cls: 'chip--err' },
  mixed: { label: 'Mixed', cls: 'chip--info' },
  neutral: { label: 'Neutral', cls: '' },
}
export function signalMeta(sig) { return SIGNAL_META[sig] || { label: sig || '—', cls: '' } }

// On-chain status → HONEST label + dot color. Never a fake green.
export const ONCHAIN_META = {
  strong: { label: 'Strong on-chain', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  partial: { label: 'Partial on-chain', dot: 'bg-amber-400', text: 'text-amber-400' },
  weak: { label: 'Weak on-chain', dot: 'bg-red-400', text: 'text-red-400' },
  stale: { label: 'On-chain stale', dot: 'bg-[var(--fg-4)]', text: 'text-[var(--fg-4)]' },
  not_checked: { label: 'Not checked', dot: 'bg-[var(--fg-5,#555)]', text: 'text-[var(--fg-4)]' },
  unsupported: { label: 'Limited coverage', dot: 'bg-[var(--fg-5,#555)]', text: 'text-[var(--fg-4)]' },
}
export function onchainMeta(st) { return ONCHAIN_META[st] || ONCHAIN_META.not_checked }

// ── Derived clarity labels (deterministic, stored with the snapshot) ─────────
// Global labels come from narrative_state.clarity_labels ([{key,severity}]);
// relevance labels (text[]) are per-user, computed at read time in narrative_feed.
export const CLARITY_META = {
  early_unconfirmed:      { label: 'Early but unconfirmed',     cls: 'chip--info', why: 'Fresh attention is building but price/volume/on-chain have not confirmed it yet.' },
  heating_confirmed:      { label: 'Heating with confirmation', cls: 'chip--ok',   why: 'Attention is rising AND market data (price/volume) confirms it.' },
  crowded_risky:          { label: 'Crowded & risky',           cls: 'chip--err',  why: 'Attention is crowded and risk indicators are elevated.' },
  cooling_strong_onchain: { label: 'Cooling, strong on-chain',  cls: 'chip--info', why: 'Social attention is cooling but on-chain activity remains strong.' },
  mostly_social_hype:     { label: 'Mostly social hype',        cls: 'chip--err',  why: 'High chatter with little market or on-chain confirmation.' },
  needs_more_evidence:    { label: 'Needs more evidence',       cls: '',           why: 'Low confidence, few sources, or unverified on-chain — treat as a watch item.' },
  portfolio_relevant:     { label: 'Portfolio relevant',        cls: 'chip--accent', why: 'Includes assets you hold.' },
  watchlist_relevant:     { label: 'Watchlist relevant',        cls: 'chip--accent', why: 'Includes assets on your watchlist.' },
  chain_relevant:         { label: 'Your chain',                cls: 'chip--accent', why: 'On a chain you selected in onboarding.' },
}
const CLARITY_SEV_ORDER = { warn: 0, ok: 1, info: 2, neutral: 3 }
export function clarityMeta(key) { return CLARITY_META[key] || { label: key, cls: '' } }
// Merge stored global labels + per-user relevance labels; dedupe, severity-sort, cap.
export function mergeLabels(n, cap = 3) {
  const global = Array.isArray(n?.clarity_labels) ? n.clarity_labels : []
  const rel = Array.isArray(n?.relevance_labels) ? n.relevance_labels.map((k) => ({ key: k, severity: 'rel' })) : []
  const seen = new Set()
  const all = [...rel, ...global].filter((l) => l?.key && !seen.has(l.key) && seen.add(l.key))
  all.sort((a, b) => (a.severity === 'rel' ? -1 : CLARITY_SEV_ORDER[a.severity] ?? 9) - (b.severity === 'rel' ? -1 : CLARITY_SEV_ORDER[b.severity] ?? 9))
  return all.slice(0, cap)
}

// 0–100 score → color (red→amber→emerald). For mini-bars.
export function scoreColor(v) {
  const n = typeof v === 'number' ? v : 0
  if (n >= 66) return 'bg-emerald-400'
  if (n >= 40) return 'bg-amber-400'
  return 'bg-red-400'
}
// Risk is inverted (high = bad).
export function riskColor(v) {
  const n = typeof v === 'number' ? v : 0
  if (n >= 66) return 'bg-red-400'
  if (n >= 40) return 'bg-amber-400'
  return 'bg-emerald-400'
}

export const SCORE_FIELDS = [
  { key: 'momentum_score', label: 'Momentum' },
  { key: 'chatter_score', label: 'Chatter' },
  { key: 'price_confirmation_score', label: 'Price confirm' },
  { key: 'volume_confirmation_score', label: 'Volume confirm' },
  { key: 'breadth_score', label: 'Breadth' },
  { key: 'freshness_score', label: 'Freshness' },
  { key: 'confidence_score', label: 'Confidence' },
  { key: 'crowding_score', label: 'Crowding', invert: true },
  { key: 'risk_score', label: 'Risk', invert: true },
]

// Filter/tab definitions for the dashboard.
export const NARRATIVE_TABS = [
  { key: 'all', label: 'All' },
  { key: 'heating_up', label: 'Heating Up' },
  { key: 'early', label: 'Early' },
  { key: 'crowded', label: 'Crowded' },
  { key: 'cooling', label: 'Cooling' },
  { key: 'dormant', label: 'Dormant' },
  { key: 'bullish', label: 'Bullish' },
  { key: 'bearish', label: 'Bearish' },
  { key: 'mine', label: 'My Interests' },
  { key: 'portfolio', label: 'Portfolio relevant' },
  { key: 'watchlist', label: 'Watchlist relevant' },
  { key: 'followed', label: 'Followed' },
  { key: 'custom', label: 'Custom' },
]

// Apply a tab filter to a feed row (stage tabs match the 5 display statuses).
export function matchesTab(n, tab) {
  switch (tab) {
    case 'all': return true
    case 'bullish': return n.signal_class === 'bullish'
    case 'bearish': return n.signal_class === 'bearish'
    case 'mine': return !!(n.is_followed || n.from_user_source || (n.relevance_score || 0) > 0)
    case 'portfolio': return Array.isArray(n.relevance_labels) && n.relevance_labels.includes('portfolio_relevant')
    case 'watchlist': return Array.isArray(n.relevance_labels) && n.relevance_labels.includes('watchlist_relevant')
    case 'followed': return !!n.is_followed
    default: return displayStatus(n) === tab
  }
}
