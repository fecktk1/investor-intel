import React from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, CartesianGrid } from 'recharts'
import { formatUsd as fmtUsd } from '../lib/market-format'

const COLORS = ['#d4a72c', '#60a5fa', '#34d399', '#f472b6', '#a78bfa', '#fbbf24', '#22d3ee', '#fb7185']

// Holdings composition for a watched wallet (top holdings by USD value).
export default function WalletHoldingsChart({ holdings, loading }) {
  const { t } = useTranslation('intel')
  if (loading) return <div className="card p-10 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
  if (!holdings?.length) return <div className="card p-8 text-center text-[13px] text-[var(--fg-4)]">{t('chart.no_holdings_data', { defaultValue: 'No holdings data available for this wallet/chain.' })}</div>
  const data = holdings.slice(0, 12).map((h) => ({ symbol: h.symbol || '?', value: Number(h.valueUsd) || 0 }))

  return (
    <div className="card p-3">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis dataKey="symbol" tick={{ fill: 'var(--fg-4)', fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={50} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={fmtUsd} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} width={56} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12 }} formatter={(v) => [fmtUsd(v), t('chart.value', { defaultValue: 'Value' })]} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
          <Bar dataKey="value" radius={[4, 4, 0, 0]}>{data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
