// Token risk + holder concentration scoring (v3.1, Batch 6).
//
// Deterministic, versioned, inputs-preserved. Reads Birdeye token_security
// (real Solana field names verified live: freezeAuthority, mutableMetadata,
// nonTransferable, isTrueToken, fakeToken, transferFeeEnable, top10HolderPercent,
// creatorPercentage, jupStrictList) + optional CoinGecko GT cross-check.
// Hard-fail flags cap the score; cross-provider agreement raises confidence.

export const RISK_SCORE_VERSION = 1
export const CONCENTRATION_SCORE_VERSION = 2

export interface SecurityInput {
  freezeAuthority?: string | null
  mutableMetadata?: boolean | null
  nonTransferable?: boolean | null
  isTrueToken?: boolean | null
  fakeToken?: boolean | null
  transferFeeEnable?: boolean | null
  top10HolderPercent?: number | null   // fraction (0..1) or already-pct
  creatorPercentage?: number | null
  jupStrictList?: boolean | null
  // Optional CoinGecko on-chain cross-check
  gtScore?: number | null              // 0..100 (higher = safer)
  gtHoneypot?: string | null           // 'true' | 'false' | 'unknown'
  _hasRawSignal?: boolean              // did the provider actually return security data?
}

export function toPct(v: number | null | undefined): number | null {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return n >= 0 && n <= 1 ? n * 100 : n
}
function clamp(n: number, lo = 0, hi = 100): number { return Math.max(lo, Math.min(hi, n)) }

export interface RiskResult {
  score: number                 // 0..100 (higher = safer)
  rated: boolean                // false = insufficient provider data; caller should NOT surface a score
  hard_fail: boolean
  hard_fail_flags: string[]
  sub_scores: Record<string, number>
  penalties: Record<string, number>
  confidence: number            // 0..1
  cross_provider: boolean
  disagreements: string[]
  score_version: number
}

export function computeTokenRisk(s: SecurityInput): RiskResult {
  const hardFlags: string[] = []
  if (s.nonTransferable === true) hardFlags.push('non_transferable')          // can't sell → honeypot-like
  if (s.fakeToken === true) hardFlags.push('fake_token')
  if (s.isTrueToken === false) hardFlags.push('not_true_token')
  if (s.gtHoneypot === 'true') hardFlags.push('gt_honeypot')

  const top10 = toPct(s.top10HolderPercent)
  const creatorPct = toPct(s.creatorPercentage)

  const penalties: Record<string, number> = {}
  if (s.freezeAuthority) penalties.freeze_authority = 15                       // can freeze wallets
  if (s.mutableMetadata === true) penalties.mutable_metadata = 10
  if (s.transferFeeEnable === true) penalties.transfer_fee = 10
  if (top10 != null) penalties.concentration = Math.min(40, Math.round(top10 * 0.5))
  if (creatorPct != null && creatorPct > 20) penalties.creator_holding = 10
  if (s.jupStrictList === false) penalties.not_jup_verified = 5

  const penaltySum = Object.values(penalties).reduce((a, b) => a + b, 0)
  const hardFail = hardFlags.length > 0
  const score = hardFail ? clamp(20 - penaltySum) : clamp(100 - penaltySum)

  // "Rated" only if a provider actually returned security signal. Otherwise an
  // empty response would score a misleading 100/100 ("safe" == "no data").
  const rated = s._hasRawSignal === true || s.gtScore != null || s.gtHoneypot != null

  // Confidence: two independent sources (Birdeye + CoinGecko GT) => higher.
  const disagreements: string[] = []
  const crossProvider = s.gtScore != null || s.gtHoneypot != null
  if (crossProvider) {
    // GT honeypot vs Birdeye nonTransferable
    if (s.gtHoneypot === 'true' && s.nonTransferable === false) disagreements.push('gt_honeypot_vs_birdeye_transferable')
    if (s.gtHoneypot === 'false' && s.nonTransferable === true) disagreements.push('birdeye_nontransferable_vs_gt_safe')
  }
  const confidence = crossProvider ? (disagreements.length ? 0.6 : 0.9) : 0.7

  return {
    score,
    rated,
    hard_fail: hardFail,
    hard_fail_flags: hardFlags,
    sub_scores: {
      authority: s.freezeAuthority ? 0 : 100,
      mutability: s.mutableMetadata === true ? 0 : 100,
      tax: s.transferFeeEnable === true ? 0 : 100,
      concentration: top10 != null ? clamp(100 - top10) : 50,
      honeypot: hardFail ? 0 : 100,
    },
    penalties,
    confidence,
    cross_provider: crossProvider,
    disagreements,
    score_version: RISK_SCORE_VERSION,
  }
}

// Holder concentration (0..100; HIGHER = more concentrated = riskier).
export interface ConcentrationResult {
  score: number
  top10_pct: number | null
  top1_pct: number | null // Share of supplied top-holder sample, NOT total token supply.
  gini: number | null // Gini within supplied positive sample balances.
  band: 'low' | 'medium' | 'high' | 'extreme'
  score_version: number
}

// deno-lint-ignore no-explicit-any
export function computeConcentration(top10Pct: number | null, topHolders?: Array<any> | null): ConcentrationResult {
  const t10 = toPct(top10Pct)
  // Gini over the provided top-holder ui_amounts (approximate — top-N only).
  let gini: number | null = null
  let top1_pct: number | null = null
  if (topHolders && topHolders.length) {
    const amts = topHolders.map((h) => Number(h.ui_amount) || 0).filter((n) => n > 0).sort((a, b) => a - b)
    const total = amts.reduce((a, b) => a + b, 0)
    if (total > 0) {
      top1_pct = Math.round((Math.max(...amts) / total) * 1000) / 10
      let cum = 0
      for (let i = 0; i < amts.length; i++) cum += (i + 1) * amts[i]
      gini = Math.round(((2 * cum) / (amts.length * total) - (amts.length + 1) / amts.length) * 1000) / 1000
    }
  }
  const score = t10 != null ? clamp(Math.round(t10)) : 0
  const band: ConcentrationResult['band'] = score >= 70 ? 'extreme' : score >= 45 ? 'high' : score >= 25 ? 'medium' : 'low'
  return { score, top10_pct: t10, top1_pct, gini, band, score_version: CONCENTRATION_SCORE_VERSION }
}

// Keys Birdeye returns when it actually has security data for a token. If none
// are present, the response was empty (chain unsupported / token unknown) and
// the token must be treated as UNRATED, not "100/100 safe".
const SECURITY_SIGNAL_KEYS = [
  'freezeAuthority', 'mutableMetadata', 'nonTransferable', 'isTrueToken', 'fakeToken',
  'transferFeeEnable', 'top10HolderPercent', 'creatorPercentage', 'jupStrictList',
  'mintable', 'ownerAddress', 'creatorAddress', 'metaplexUpdateAuthority', 'totalSupply', 'top10HolderBalance',
]
// deno-lint-ignore no-explicit-any
export function hasSecuritySignal(raw: any): boolean {
  if (!raw || typeof raw !== 'object') return false
  return SECURITY_SIGNAL_KEYS.some((k) => raw[k] !== undefined && raw[k] !== null)
}

// Extract a SecurityInput from a stored Birdeye token_security raw_response.
// deno-lint-ignore no-explicit-any
export function securityInputFromRaw(raw: any, gt?: { gtScore?: number | null; gtHoneypot?: string | null }): SecurityInput {
  return {
    _hasRawSignal: hasSecuritySignal(raw),
    freezeAuthority: raw?.freezeAuthority ?? null,
    mutableMetadata: typeof raw?.mutableMetadata === 'boolean' ? raw.mutableMetadata : null,
    nonTransferable: typeof raw?.nonTransferable === 'boolean' ? raw.nonTransferable : null,
    isTrueToken: typeof raw?.isTrueToken === 'boolean' ? raw.isTrueToken : null,
    fakeToken: typeof raw?.fakeToken === 'boolean' ? raw.fakeToken : null,
    transferFeeEnable: typeof raw?.transferFeeEnable === 'boolean' ? raw.transferFeeEnable : null,
    top10HolderPercent: raw?.top10HolderPercent ?? null,
    creatorPercentage: raw?.creatorPercentage ?? null,
    jupStrictList: typeof raw?.jupStrictList === 'boolean' ? raw.jupStrictList : null,
    gtScore: gt?.gtScore ?? null,
    gtHoneypot: gt?.gtHoneypot ?? null,
  }
}

// One-line human summary for the RAG fact + the risk badge tooltip.
export function riskSummary(symbol: string | null, risk: RiskResult, conc: ConcentrationResult): string {
  const label = risk.hard_fail ? 'HIGH RISK' : risk.score >= 75 ? 'low risk' : risk.score >= 50 ? 'moderate risk' : 'elevated risk'
  const bits: string[] = [`${symbol || 'token'}: ${label} (${risk.score}/100)`]
  if (risk.hard_fail_flags.length) bits.push(`flags: ${risk.hard_fail_flags.join(', ')}`)
  if (conc.top10_pct != null) bits.push(`top-10 hold ${conc.top10_pct}% (${conc.band})`)
  const p = Object.keys(risk.penalties)
  if (p.length) bits.push(`concerns: ${p.join(', ')}`)
  return bits.join('; ')
}
