import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts'

// Portfolio value over time (from daily snapshots). recharts (already a dep) —
// no new chart library. A P&L mode plots realized + unrealized P&L (already on
// each snapshot) as lines around a zero baseline. Benchmark comparison lines
// (BTC/ETH/SOL) render only when a real series is provided; hidden otherwise —
// we never draw fabricated benchmark data.
const TF = [
  { key: '1w', days: 7 }, { key: '1m', days: 30 }, { key: '3m', days: 90 }, { key: '1y', days: 365 }, { key: 'all', days: Infinity },
]
const fmtUsd = (p) => p == null ? '' : p >= 1000 ? `$${(p / 1000).toFixed(1)}k` : `$${Math.round(p)}`
// Signed compact USD for P&L (losses must read as -$…, which fmtUsd never emits).
const fmtSigned = (p) => { if (p == null) return ''; const n = Math.round(p); const s = n < 0 ? '-' : ''; const a = Math.abs(n); return a >= 1000 ? `${s}$${(a / 1000).toFixed(1)}k` : `${s}$${a}` }
const fmtT = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}` }

export default function PortfolioPerformanceChart({ series = [], compare = null, loading = false }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [tf, setTf] = useState('3m')
  const [mode, setMode] = useState('value')   // 'value' | 'pnl'

  // P&L columns ride along on each snapshot (realized = cumulative-to-date,
  // unrealized = current mark-to-market) — the same metrics the Overview shows.
  const hasPnl = useMemo(() => (series || []).some((p) => p.unrealizedPnl != null || p.realizedPnl != null), [series])
  const view = mode === 'pnl' && hasPnl ? 'pnl' : 'value'

  const data = useMemo(() => {
    const days = (TF.find((x) => x.key === tf) || {}).days ?? Infinity
    const cutoff = days === Infinity ? 0 : Date.now() - days * 86400000
    return (series || []).filter((p) => p.t >= cutoff).map((p) => ({ t: p.t, value: p.value, unrealizedPnl: p.unrealizedPnl ?? null, realizedPnl: p.realizedPnl ?? null }))
  }, [series, tf])

  const points = view === 'pnl'
    ? data.filter((p) => p.unrealizedPnl != null || p.realizedPnl != null)
    : data.filter((p) => p.value != null)

  const up = view === 'value' && points.length > 1 && points[points.length - 1].value >= points[0].value
  const color = up ? '#34d399' : '#f87171'

  return (
    <div className="card p-3">
      <div className="flex items-center justify-between mb-2 px-1 gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="eyebrow">{t('portfolio.performance', { defaultValue: 'Performance' })}</span>
          {hasPnl && (
            <div className="flex gap-1">
              <button onClick={() => setMode('value')} className={`chip text-[10px] ${view === 'value' ? 'chip--accent' : ''}`}>{t('portfolio.mode_value', { defaultValue: 'Value' })}</button>
              <button onClick={() => setMode('pnl')} className={`chip text-[10px] ${view === 'pnl' ? 'chip--accent' : ''}`}>{t('portfolio.mode_pnl', { defaultValue: 'P&L' })}</button>
            </div>
          )}
        </div>
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
      ) : points.length < 2 ? (
        <div className="h-[240px] grid place-items-center text-center text-[13px] text-[var(--fg-4)] px-6">
          {view === 'pnl'
            ? t('portfolio.pnl_empty', { defaultValue: 'P&L history builds from daily snapshots once your cost basis is known.' })
            : t('portfolio.perf_empty', { defaultValue: 'Performance builds from daily snapshots — today\'s value is saved on each sync. The chart appears once you have two or more days of history.' })}
        </div>
      ) : view === 'pnl' ? (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="t" tickFormatter={fmtT} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} minTickGap={40} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={fmtSigned} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} domain={['auto', 'auto']} width={56} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12 }}
              labelFormatter={(ts) => new Date(ts).toLocaleDateString()} formatter={(v, n) => [fmtSigned(v), n]} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" strokeDasharray="2 2" />
            <Line type="monotone" dataKey="unrealizedPnl" name={t('portfolio.unrealized_pnl', { defaultValue: 'Unrealized P&L' })} stroke="#60a5fa" strokeWidth={1.5} dot={false} connectNulls />
            <Line type="monotone" dataKey="realizedPnl" name={t('portfolio.realized_pnl', { defaultValue: 'Realized P&L' })} stroke="#34d399" strokeWidth={1.5} dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
