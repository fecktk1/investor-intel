import React from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, ComposedChart, AreaChart, Area, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts'

const fmtUsd = (v) => v == null ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Number(v).toFixed(0)}`
// Inputs are fractions (0.12 = 12%) → plain ×100, no unit-guessing.
const fmtPct = (v) => v == null ? '—' : `${(Number(v) * 100).toFixed(2)}%`
const fmtT = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}` }

// DeFiLlama-style pool history: a TVL (area) + total APY (line) chart, plus an
// APY base-vs-reward stacked area when reward yield is present. `history` rows:
// { snapshot_at, tvl_usd, apy, apyBase, apyReward }, APYs as fractions.
export default function PoolDetailCharts({ history, loading }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (loading) return <div className="card p-10 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
  if (!history?.length) return <div className="card p-8 text-center text-[13px] text-[var(--fg-4)]">{t('defi.no_chart', { defaultValue: 'No historical chart data for this pool yet.' })}</div>

  const data = history.map((h) => ({
    t: new Date(h.snapshot_at).getTime(),
    tvl: h.tvl_usd == null ? null : Number(h.tvl_usd),
    apy: h.apy == null ? null : Number(h.apy) * 100,
    base: h.apyBase == null ? null : Number(h.apyBase) * 100,
    reward: h.apyReward == null ? null : Number(h.apyReward) * 100,
  }))
  // Empty/never-funded vaults return all-zero series — show the empty state
  // rather than a flat line at zero.
  const hasData = data.some((d) => (d.tvl && d.tvl > 0) || (d.apy && d.apy > 0))
  if (!hasData) return <div className="card p-8 text-center text-[13px] text-[var(--fg-4)]">{t('defi.no_chart', { defaultValue: 'No historical chart data for this pool yet.' })}</div>
  const hasReward = data.some((d) => d.reward && d.reward > 0)
  const hasTvl = data.some((d) => d.tvl && d.tvl > 0)
  const axisTick = { fill: 'var(--fg-4)', fontSize: 11 }
  const tipStyle = { background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12 }

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <div className="eyebrow mb-1">{hasTvl ? t('defi.chart_tvl_apy', { defaultValue: 'TVL & APY history' }) : t('defi.chart_apy', { defaultValue: 'APY history' })}</div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="pdtvl" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#60a5fa" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="t" tickFormatter={fmtT} tick={axisTick} minTickGap={48} axisLine={false} tickLine={false} />
            {hasTvl && <YAxis yAxisId="tvl" tickFormatter={fmtUsd} tick={axisTick} width={56} axisLine={false} tickLine={false} />}
            <YAxis yAxisId="apy" orientation={hasTvl ? 'right' : 'left'} tickFormatter={(v) => `${v.toFixed(0)}%`} tick={axisTick} width={hasTvl ? 44 : 48} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={tipStyle} labelFormatter={(t) => new Date(t).toLocaleDateString()} formatter={(v, n) => n === 'TVL' ? [fmtUsd(v), 'TVL'] : [`${Number(v).toFixed(2)}%`, 'APY']} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {hasTvl && <Area yAxisId="tvl" type="monotone" dataKey="tvl" name="TVL" stroke="#60a5fa" strokeWidth={1.5} fill="url(#pdtvl)" connectNulls />}
            <Line yAxisId="apy" type="monotone" dataKey="apy" name="APY" stroke="#34d399" strokeWidth={1.5} dot={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {hasReward && (
        <div className="card p-3">
          <div className="eyebrow mb-1">{t('defi.chart_breakdown', { defaultValue: 'APY breakdown — base vs reward' })}</div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="t" tickFormatter={fmtT} tick={axisTick} minTickGap={48} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => `${v.toFixed(0)}%`} tick={axisTick} width={44} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tipStyle} labelFormatter={(t) => new Date(t).toLocaleDateString()} formatter={(v, n) => [`${Number(v).toFixed(2)}%`, n]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="base" name="Base" stackId="1" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.4} connectNulls />
              <Area type="monotone" dataKey="reward" name="Reward" stackId="1" stroke="#f472b6" fill="#f472b6" fillOpacity={0.4} connectNulls />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
