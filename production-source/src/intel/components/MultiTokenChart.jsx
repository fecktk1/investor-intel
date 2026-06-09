import React from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts'

const COLORS = ['#d4a72c', '#60a5fa', '#34d399', '#f472b6']

// Overlays N tokens on one chart, each normalized to % change from the start of
// the window, so assets at different prices are directly comparable.
export default function MultiTokenChart({ series, loading }) {
  const { t } = useTranslation('intel')
  if (loading) return <div className="card p-10 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
  const valid = (series || []).filter((s) => s.candles?.length > 1)
  if (valid.length === 0) return <div className="card p-8 text-center text-[13px] text-[var(--fg-4)]">{t('chart.no_compare_data', { defaultValue: 'No chart data to compare yet.' })}</div>

  const minLen = Math.min(...valid.map((s) => s.candles.length))
  const bases = valid.map((s) => s.candles[s.candles.length - minLen].c || s.candles[0].c)
  const data = []
  for (let i = 0; i < minLen; i++) {
    const row = { t: valid[0].candles[valid[0].candles.length - minLen + i].t }
    valid.forEach((s, j) => {
      const c = s.candles[s.candles.length - minLen + i].c
      row[s.label] = bases[j] ? ((c - bases[j]) / bases[j]) * 100 : 0
    })
    data.push(row)
  }
  const fmtT = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}` }

  return (
    <div className="card p-3">
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis dataKey="t" tickFormatter={fmtT} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} minTickGap={40} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} width={50} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12 }} labelFormatter={(ts) => new Date(ts).toLocaleDateString()} formatter={(v, n) => [`${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`, n]} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {valid.map((s, j) => <Line key={s.label} type="monotone" dataKey={s.label} stroke={COLORS[j % COLORS.length]} strokeWidth={1.5} dot={false} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
