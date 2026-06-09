import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'

// Portfolio value over time (from daily snapshots). recharts (already a dep) —
// no new chart library. Benchmark comparison lines (BTC/ETH/SOL) render only
// when a real series is provided; they are hidden gracefully otherwise (rev 8) —
// we never draw fabricated benchmark data.
const TF = [
  { key: '1w', days: 7 }, { key: '1m', days: 30 }, { key: '3m', days: 90 }, { key: '1y', days: 365 }, { key: 'all', days: Infinity },
]
const fmtUsd = (p) => p == null ? '' : p >= 1000 ? `$${(p / 1000).toFixed(1)}k` : `$${Math.round(p)}`
const fmtT = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}` }

export default function PortfolioPerformanceChart({ series = [], compare = null, loading = false }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [tf, setTf] = useState('3m')

  const data = useMemo(() => {
    const days = (TF.find((x) => x.key === tf) || {}).days ?? Infinity
    const cutoff = days === Infinity ? 0 : Date.now() - days * 86400000
    return (series || []).filter((p) => p.t >= cutoff && p.value != null).map((p) => ({ t: p.t, value: p.value }))
  }, [series, tf])

  const up = data.length > 1 && data[data.length - 1].value >= data[0].value
  const color = up ? '#34d399' : '#f87171'

  return (
    <div className="card p-3">
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="eyebrow">{t('portfolio.performance', { defaultValue: 'Performance' })}</span>
        <div className="flex gap-1">
          {TF.map((x) => (
            <button key={x.key} onClick={() => setTf(x.key)}
              className={`chip text-[10px] ${tf === x.key ? 'chip--accent' : ''}`}>
              {t(`portfolio.tf.${x.key}`, { defaultValue: x.key.toUpperCase() })}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="h-[240px] grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : data.length < 2 ? (
        <div className="h-[240px] grid place-items-center text-center text-[13px] text-[var(--fg-4)] px-6">
          {t('portfolio.perf_empty', { defaultValue: 'Performance builds from daily snapshots — today\'s value is saved on each sync. The chart appears once you have two or more days of history.' })}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="pfval" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="t" tickFormatter={fmtT} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} minTickGap={40} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={fmtUsd} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} domain={['auto', 'auto']} width={56} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12 }}
              labelFormatter={(ts) => new Date(ts).toLocaleDateString()} formatter={(v) => [fmtUsd(v), t('portfolio.total_value', { defaultValue: 'Total value' })]} />
            <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill="url(#pfval)" />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
