// Investor Intel: which wrapper of one tokenised asset to name, and why.
//
// THE QUESTION. The wrapper board already says how far apart the wrappers of one
// asset trade. A reader who has decided to hold the asset then asks a narrower
// question: WHICH wrapper. There are three honest answers and they are not the
// same wrapper, so all three are named and none is called "best":
//
//   cheapest     the lowest premium among the wrappers that anchor the
//                reference (state 'liquid'). The same rule the capture lane uses
//                for `cheapest_crypto_id`, so the two can never name different
//                wrappers except on an exact tie, which is broken here by volume
//                and then by id and is flagged when it differs.
//
//   closest      the smallest ABSOLUTE premium among the same liquid wrappers:
//                the wrapper whose price sits nearest the anchor. When the anchor
//                is the liquid-wrapper median, the wrapper that SET the median
//                sits exactly on it by construction, so its zero is circular. It
//                is still named, flagged `circular`, and the nearest wrapper that
//                did not set the anchor is named beside it.
//
//   mostLiquid   the highest reported 24 hour volume among the wrappers that
//                carry a premium at all (priced, unit established, not accruing).
//                A thin wrapper can win this only when every wrapper is thin.
//
// Everything else is EXCLUDED from all three, named, and given its state and its
// reason. Nothing is dropped: a wrapper missing from the picks is in `excluded`.
//
// Pure: no database, no clock, no provider. The read view attaches the result to
// each asset row and the MCP tool serves the same object, so the page and an
// agent can never disagree about which wrapper was picked.

/** The fields of one wrapper this module reads. The read view's `wrapperRow`
 * shape, which is a superset. */
export interface PickToken {
  cryptoId: string | null
  symbol?: string | null
  name?: string | null
  issuerName?: string | null
  normalisedPrice?: number | null
  volume24h?: number | null
  unitState?: string | null
  state?: string | null
  premiumBps?: number | null
  inAnchor?: boolean | null
  reason?: string | null
}

/** The fields of one asset this module reads. The read view's `wrapperAssetRow`
 * shape, which is a superset. */
export interface PickAsset {
  anchorKind?: string | null
  anchorPrice?: number | null
  anchorReason?: string | null
  cheapestCryptoId?: string | null
  tokens: PickToken[]
}

export interface PickedWrapper {
  available: true
  cryptoId: string
  symbol: string | null
  name: string | null
  issuerName: string | null
  premiumBps: number
  absPremiumBps: number
  volume24h: number | null
  state: string
}

export interface Unavailable { available: false; reason: string }

export interface ClosestPick extends PickedWrapper {
  /** True when this wrapper set the liquid-wrapper median it is measured
   * against, so its distance to the anchor is zero by construction. */
  circular: boolean
  /** The nearest wrapper that did NOT set the anchor. Null when `circular` is
   * false, or when no other liquid wrapper carries a premium. */
  closestOther: PickedWrapper | null
}

export interface ExcludedWrapper {
  cryptoId: string
  symbol: string | null
  name: string | null
  state: string
  reason: string
}

export interface WrapperPicks {
  anchorKind: string
  cheapest: PickedWrapper | Unavailable
  closest: ClosestPick | Unavailable
  mostLiquid: PickedWrapper | Unavailable
  /** Whether `cheapest` names the same wrapper the capture lane stored as the
   * cheapest liquid route. Null when either side has none. False only on an
   * exact premium tie, which the capture broke by input order and this module
   * breaks by volume and then id. */
  cheapestMatchesCaptured: boolean | null
  excluded: ExcludedWrapper[]
}

/** The rules, in words, carried on every payload that serves picks. */
export const PICK_RULES = {
  cheapest: 'Lowest premium to the anchor among the wrappers that anchor the reference (cleared the volume floor, unit established, not accruing).',
  closest: 'Smallest absolute premium among the same wrappers. Where the anchor is the liquid-wrapper median, the wrapper that set the median sits on it by construction; it is flagged circular and the nearest other wrapper is named beside it.',
  mostLiquid: 'Highest reported 24 hour volume among the wrappers that carry a premium: priced, unit established and not accruing.',
  ties: 'Ties are broken by higher reported 24 hour volume, then by lower CoinMarketCap id.',
  excluded: 'Every wrapper eligible for none of the three is listed with its state and the reason.',
} as const

const num = (v: unknown): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const idOf = (v: unknown): string | null => (/^[1-9][0-9]{0,11}$/.test(String(v ?? '').trim()) ? String(v).trim() : null)

/** Ties: higher volume first (an absent volume ranks below any reported one),
 * then the lower CoinMarketCap id, compared as a number. */
function tieBreak(a: PickToken, b: PickToken): number {
  const va = num(a.volume24h) ?? -1
  const vb = num(b.volume24h) ?? -1
  if (va !== vb) return vb - va
  return Number(a.cryptoId) - Number(b.cryptoId)
}

function pickBy(tokens: PickToken[], key: (t: PickToken) => number): PickToken | null {
  let best: PickToken | null = null
  for (const token of tokens) {
    if (best == null) { best = token; continue }
    const diff = key(token) - key(best)
    if (diff < 0 || (diff === 0 && tieBreak(token, best) < 0)) best = token
  }
  return best
}

function picked(token: PickToken): PickedWrapper {
  const premium = num(token.premiumBps)!
  return {
    available: true,
    cryptoId: idOf(token.cryptoId)!,
    symbol: token.symbol ?? null, name: token.name ?? null, issuerName: token.issuerName ?? null,
    premiumBps: premium, absPremiumBps: Math.abs(premium),
    volume24h: num(token.volume24h),
    state: String(token.state ?? 'no_price'),
  }
}

/** Did this wrapper set the liquid-wrapper median? The weighted median returns a
 * member's own price, so the setter's normalised price IS the anchor. Compared
 * with a relative tolerance, because the price went through a numeric column. */
export function setsAnchor(token: PickToken, anchorKind: unknown, anchorPrice: unknown): boolean {
  if (anchorKind !== 'liquid_wrapper_median') return false
  const anchor = num(anchorPrice)
  const price = num(token.normalisedPrice)
  if (anchor == null || price == null || anchor <= 0) return false
  if (token.inAnchor === false) return false
  return Math.abs(price - anchor) <= anchor * 1e-9
}

/** Why a wrapper is eligible for no pick, in the same codes the board already
 * renders as sentences. */
function exclusionReason(token: PickToken, anchorKind: string, anchorReason: string | null): string {
  const state = String(token.state ?? 'no_price')
  if (state === 'no_price') return token.reason || 'price_not_reported'
  if (state === 'unit_not_established') return token.reason || 'unit_not_established'
  if (state === 'accrues_in_price') return 'accrues_in_price'
  if (state === 'volume_not_reported') return 'volume_not_reported'
  if (num(token.premiumBps) == null) return anchorKind === 'none' ? (anchorReason || 'no_anchor') : (token.reason || 'no_premium')
  return token.reason || state
}

/** The three picks and the exclusions for ONE asset. */
export function wrapperPicks(asset: PickAsset): WrapperPicks {
  const anchorKind = String(asset?.anchorKind || 'none')
  const anchorReason = asset?.anchorReason ?? null
  const tokens = (Array.isArray(asset?.tokens) ? asset.tokens : []).filter((t) => idOf(t?.cryptoId))

  // The two candidate sets. `liquid` is a subset of `premiumed` whenever the
  // anchor exists, because a liquid wrapper always carries a volume.
  const liquid = tokens.filter((t) => t.state === 'liquid' && num(t.premiumBps) != null)
  const premiumed = tokens.filter((t) =>
    num(t.premiumBps) != null && num(t.volume24h) != null
    && t.state !== 'accrues_in_price' && t.state !== 'no_price' && t.state !== 'unit_not_established'
    && t.unitState !== 'not_established')

  const noAnchor: Unavailable | null = anchorKind === 'none'
    ? { available: false, reason: anchorReason || 'no_anchor' }
    : null

  const cheapestToken = pickBy(liquid, (t) => num(t.premiumBps)!)
  const cheapest: PickedWrapper | Unavailable = noAnchor
    ?? (cheapestToken ? picked(cheapestToken) : { available: false, reason: 'no_liquid_wrapper' })

  let closest: ClosestPick | Unavailable
  const closestToken = pickBy(liquid, (t) => Math.abs(num(t.premiumBps)!))
  if (noAnchor) closest = noAnchor
  else if (!closestToken) closest = { available: false, reason: 'no_liquid_wrapper' }
  else {
    const circular = setsAnchor(closestToken, anchorKind, asset.anchorPrice)
    const others = circular ? liquid.filter((t) => !setsAnchor(t, anchorKind, asset.anchorPrice)) : []
    const other = circular ? pickBy(others, (t) => Math.abs(num(t.premiumBps)!)) : null
    closest = { ...picked(closestToken), circular, closestOther: other ? picked(other) : null }
  }

  const liquidToken = pickBy(premiumed, (t) => -(num(t.volume24h)!))
  const mostLiquid: PickedWrapper | Unavailable = noAnchor
    ?? (liquidToken ? picked(liquidToken) : { available: false, reason: 'no_priced_wrapper' })

  const captured = idOf(asset?.cheapestCryptoId)
  const cheapestMatchesCaptured = cheapest.available && captured ? cheapest.cryptoId === captured : null

  const eligible = new Set([...liquid, ...premiumed].map((t) => String(t.cryptoId)))
  const excluded: ExcludedWrapper[] = tokens
    .filter((t) => !eligible.has(String(t.cryptoId)))
    .map((t) => ({
      cryptoId: idOf(t.cryptoId)!,
      symbol: t.symbol ?? null, name: t.name ?? null,
      state: String(t.state ?? 'no_price'),
      reason: exclusionReason(t, anchorKind, anchorReason),
    }))

  return { anchorKind, cheapest, closest, mostLiquid, cheapestMatchesCaptured, excluded }
}
