import React from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'

// Price chart for the token intelligence page. Close-price area chart with a
// gradient fill, colored by net direction over the window.
export default function TokenChart({ candles, loading }) {
  const { t } = useTranslation('intel')
  if (loading) return <div className="card p-10 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
  if (!candles?.length) return <div className="card p-8 text-center text-[13px] text-[var(--fg-4)]">{t('chart.no_token_data', { defaultValue: 'No chart data available for this asset/chain yet.' })}</div>

  const data = candles.map((c) => ({ t: c.t, price: c.c }))
  const up = data.length > 1 && data[data.length - 1].price >= data[0].price
  const color = up ? '#34d399' : '#f87171'
  const fmt = (p) => p == null ? '' : p < 1 ? `$${Number(p).toPrecision(3)}` : `$${Number(p).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  const fmtT = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}` }

  return (
    <div className="card p-3">
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="tcprice" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis dataKey="t" tickFormatter={fmtT} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} minTickGap={40} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={fmt} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} domain={['auto', 'auto']} width={64} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12 }}
            labelFormatter={(ts) => new Date(ts).toLocaleString()} formatter={(v) => [fmt(v), t('chart.price', { defaultValue: 'Price' })]}
          />
          <Area type="monotone" dataKey="price" stroke={color} strokeWidth={1.5} fill="url(#tcprice)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
