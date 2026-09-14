// A JavaScript chart cannot reliably represent cents beyond this range. Keep
// those source records available for review without plotting a fabricated value.
export const MAX_CHART_USD = Number.MAX_SAFE_INTEGER / 100
export function portfolioChartSeries(series) {
  const issues = []
  const rows = (series || []).filter(row => Number.isFinite(row.t)).map(row => {
    const clean = { ...row }
    for (const field of ['value', 'unrealizedPnl', 'realizedPnl']) {
      const raw = row[field]
      if (raw == null || raw === '') { clean[field] = null; continue }
      const value = Number(raw)
      if (!Number.isFinite(value) || Math.abs(value) > MAX_CHART_USD || (field === 'value' && value < 0)) {
        issues.push({ t: row.t, field, recordedValue: String(raw) })
        clean[field] = null
      } else clean[field] = value
    }
    return clean
  }).sort((a, b) => a.t - b.t)
  return { rows, issues }
}
