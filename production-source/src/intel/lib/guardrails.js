// Investor Intel — frontend safety guardrails.
//
// Mirrors the server validator's intent for the UI layer. The most important
// frontend rule is the NO-ACTION-BUTTONS allowlist: Investor Intel is read-only
// intelligence, so the UI must never render trade-action affordances.

// Labels that must NEVER appear on an Investor Intel button/CTA.
export const BANNED_ACTION_LABELS = [
  'buy', 'sell', 'trade now', 'trade', 'ape', 'enter', 'exit', 'long', 'short',
]

// The allowed, research-framed action vocabulary.
export const ALLOWED_ACTION_LABELS = [
  'check execution quality', 'analyze liquidity', 'estimate price impact',
  'review risk', 'explain route quality', 'add to watchlist', 'save research',
  'compare', 'explain this', 'track wallet', 'track narrative', 'generate brief',
]

export function isBannedActionLabel(label) {
  const l = String(label || '').trim().toLowerCase()
  if (!l) return false
  return BANNED_ACTION_LABELS.some((b) => l === b || l.startsWith(b + ' ') || l.endsWith(' ' + b))
}

export const DISCLAIMER_SHORT = 'Research & education, not financial advice. Verify before acting.'
export const DISCLAIMER_LONG =
  'Investor Intel provides crypto research, education, and risk context — not financial advice. Always verify before acting.'
