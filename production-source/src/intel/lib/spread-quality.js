export function spreadReadState(row, now = Date.now()) {
  const observed = Date.parse(row?.as_of || ''), age = now - observed
  if (!Number.isFinite(observed) || age < -30000 || age > 180000) return 'Recorded observation · current spread unavailable'
  if (Number(row?.confidence_score) < 70 || !Number.isFinite(Number(row?.confidence_score)) ||
    !(Number(row?.lowest_ask_price) > 0) || !(Number(row?.highest_bid_price) > 0) ||
    !row?.buy_provider || !row?.sell_provider || row.buy_provider === row.sell_provider ||
    row?.estimated_net_spread_pct == null || !Number.isFinite(Number(row.estimated_net_spread_pct)) ||
    (Array.isArray(row.caution_flags) ? row.caution_flags : []).some(flag => /stale|depeg|normalization assumed|low liquidity/i.test(String(flag)))) {
    return 'Recorded observation · comparison needs verification'
  }
  return null
}
