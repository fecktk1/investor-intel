const finite = (value: unknown): number | null => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
export function evaluateAlertThreshold(trigger: string, config: Record<string, unknown>, overview: { liquidity?: unknown; price_change_24h_pct?: unknown; volume_change_24h_pct?: unknown }) {
  const liquidity = trigger === 'liquidity_drop'
  const threshold = finite(liquidity ? config.min_liquidity_usd : config.threshold_pct)
  const metric = liquidity ? 'liquidity_usd' : trigger === 'volume_spike' ? 'volume_change_24h_pct' : 'price_change_24h_pct'
  const value = finite(liquidity ? overview.liquidity : trigger === 'volume_spike' ? overview.volume_change_24h_pct : overview.price_change_24h_pct)
  if (!['price_move', 'volume_spike', 'liquidity_drop'].includes(trigger) || threshold == null || threshold <= 0 || value == null) return null
  const qualifies = liquidity ? value >= 0 && value < threshold : trigger === 'volume_spike' ? value >= threshold : Math.abs(value) >= threshold
  return qualifies ? { metric, value, threshold, unit: liquidity ? 'usd' : 'percent' } : null
}
