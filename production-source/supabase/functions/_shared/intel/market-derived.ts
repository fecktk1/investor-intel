// Investor adapter — Markets derived view flags (pure, deterministic, no I/O).
//
// Cheap per-row derivations over fields intel-markets already assembles from
// CACHED tables. Heavier baseline math (unusual volume, vol-up-price-flat,
// survivability) is precomputed by market_assets_compute_derived() (mig 220) and
// passed through as `derived`. Caution labels are ALWAYS attached for thin
// liquidity / wide spread — a token is never shown as a positive signal without
// its caution. Research context, never advice.

export const THIN_LIQUIDITY_USD = 25_000
export const WEAK_LIQ_VS_MOVE_USD = 50_000
export const PRICE_UP_PCT = 5
export const SMALL_CAP_USD = 20_000_000
export const WIDE_SPREAD_PCT = 1.5

export interface DerivedFlags {
  unusualVolume: boolean
  volumeRatio: number | null
  volUpPriceFlat: boolean
  priceUpLiquidityWeak: boolean
  multiExchangeStrength: boolean
  thinLiquidity: boolean
  spreadCaution: boolean
  cautionFlags: string[]
}

export function computeRowFlags(r: {
  change24hPct?: number | null
  marketCap?: number | null
  // deno-lint-ignore no-explicit-any
  derived?: any
  // deno-lint-ignore no-explicit-any
  cex?: any
  // deno-lint-ignore no-explicit-any
  dex?: any
  enrichmentConfidence?: string | null
  signalDirection?: string | null
}): DerivedFlags {
  const d = r.derived || {}
  const c24 = typeof r.change24hPct === 'number' ? r.change24hPct : null
  const liq = r.dex && typeof r.dex.liquidityUsd === 'number' ? r.dex.liquidityUsd : null
  const availableCount = r.cex ? Number(r.cex.availableCount) || 0 : 0
  const confirming = r.cex?.marketContext?.confirmingProviders
  const confirmingCount = Array.isArray(confirming) ? confirming.length : 0
  const spreadPct = r.cex && typeof r.cex.spreadPct === 'number' ? r.cex.spreadPct : null

  const unusualVolume = d.unusual_volume === true
  const volumeRatio = typeof d.volume_ratio === 'number' ? d.volume_ratio : null
  const volUpPriceFlat = d.vol_up_price_flat === true

  // Price up but on-chain liquidity is thin relative to the move — only when
  // liquidity data EXISTS (absent data → no claim).
  const priceUpLiquidityWeak = c24 != null && c24 > PRICE_UP_PCT && liq != null && liq < WEAK_LIQ_VS_MOVE_USD

  // Confirmed across venues: ≥3 exchanges + bullish + ≥2 confirming providers.
  const multiExchangeStrength = availableCount >= 3 && r.signalDirection === 'bullish' && confirmingCount >= 2

  // Thin liquidity: DEX liquidity under the floor, or ≤1 CEX for a small cap.
  const thinLiquidity = (liq != null && liq < THIN_LIQUIDITY_USD)
    || (availableCount <= 1 && typeof r.marketCap === 'number' && r.marketCap < SMALL_CAP_USD)

  // Spread caution only at HIGH enrichment confidence (spreads render only there).
  const spreadCaution = r.enrichmentConfidence === 'high' && spreadPct != null && spreadPct >= WIDE_SPREAD_PCT

  const cautionFlags: string[] = []
  if (thinLiquidity) cautionFlags.push('thin_liquidity')
  if (priceUpLiquidityWeak) cautionFlags.push('price_up_liquidity_weak')
  if (spreadCaution) cautionFlags.push('wide_spread')

  return { unusualVolume, volumeRatio, volUpPriceFlat, priceUpLiquidityWeak, multiExchangeStrength, thinLiquidity, spreadCaution, cautionFlags }
}

/** Category leaders: top asset per category by a blend of 24h move + size. */
// deno-lint-ignore no-explicit-any
export function categoryLeaders(rows: any[], topCategories = 8): Array<{ category: string; leaders: any[] }> {
  // deno-lint-ignore no-explicit-any
  const byCat = new Map<string, any[]>()
  for (const r of rows) {
    for (const c of (Array.isArray(r.categories) ? r.categories : [])) {
      const a = byCat.get(c) || []; a.push(r); byCat.set(c, a)
    }
  }
  const blend = (r: { change24hPct?: number | null; marketCap?: number | null }) =>
    0.6 * Math.min(Math.abs(r.change24hPct ?? 0) / 25, 1) + 0.4 * Math.min(Math.log10(Math.max(1, r.marketCap ?? 1)) / 12, 1)
  return [...byCat.entries()]
    .filter(([, a]) => a.length >= 3)
    .map(([category, a]) => ({ category, leaders: a.slice().sort((x, y) => blend(y) - blend(x)).slice(0, 3) }))
    .sort((a, b) => blend(b.leaders[0]) - blend(a.leaders[0]))
    .slice(0, topCategories)
}
