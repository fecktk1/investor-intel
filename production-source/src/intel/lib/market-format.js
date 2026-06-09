// Shared formatting helpers for the exchange Markets surfaces.
export const fmtPrice = (p) => p == null ? '—' : p < 1 ? `$${Number(p).toPrecision(3)}` : `$${Number(p).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
export const fmtPct = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`
export const fmtVol = (v) => v == null ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${Math.round(v)}`
export const fmtNum = (v) => v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
export const timeAgo = (iso) => { if (!iso) return ''; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago` }
export const bucketConfidence = (n) => n == null ? 'low' : n >= 67 ? 'high' : n >= 34 ? 'medium' : 'low'
export const pctClass = (v) => (v ?? 0) >= 0 ? 'text-[var(--ok)]' : 'text-red-400'
