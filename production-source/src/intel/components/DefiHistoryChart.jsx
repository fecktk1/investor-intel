import React from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts'

const fmtUsd = (v) => v == null ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Number(v).toFixed(0)}`
const fmtPct = (v) => v == null ? '—' : `${Number(v).toFixed(1)}%`
const fmtT = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}` }
// Kamino reports APY as a fraction (0.12 = 12%); normalize anything <= 2 to a percent.
const toPct = (a) => a == null ? null : Number(a) <= 2 ? Number(a) * 100 : Number(a)

// TVL (area, left axis) + APY (line, right axis) history for a DeFi vault.
// Series accumulates from the intel-defi-snapshot daily cron.
export default function DefiHistoryChart({ history, loading }) {
  const { t } = useTranslation('intel')
  if (loading) return <div className="card p-10 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
  if (!history?.length) return <div className="card p-8 text-center text-[13px] text-[var(--fg-4)]">{t('chart.no_defi_history', { defaultValue: 'TVL / APY history will appear here as daily snapshots accumulate.' })}</div>
  const data = history.map((h) => ({ t: new Date(h.snapshot_at).getTime(), tvl: h.tvl_usd == null ? null : Number(h.tvl_usd), apy: toPct(h.apy) }))

  return (
    <div className="card p-3">
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="dhtvl" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.30} />
              <stop offset="100%" stopColor="#60a5fa" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis dataKey="t" tickFormatter={fmtT} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} minTickGap={40} axisLine={false} tickLine={false} />
          <YAxis yAxisId="tvl" tickFormatter={fmtUsd} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} width={60} axisLine={false} tickLine={false} />
          <YAxis yAxisId="apy" orientation="right" tickFormatter={fmtPct} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} width={48} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12 }} labelFormatter={(t) => new Date(t).toLocaleDateString()} formatter={(v, n) => n === 'TVL' ? [fmtUsd(v), 'TVL'] : [fmtPct(v), 'APY']} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Area yAxisId="tvl" type="monotone" dataKey="tvl" name="TVL" stroke="#60a5fa" strokeWidth={1.5} fill="url(#dhtvl)" connectNulls />
          <Line yAxisId="apy" type="monotone" dataKey="apy" name="APY" stroke="#34d399" strokeWidth={1.5} dot={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
