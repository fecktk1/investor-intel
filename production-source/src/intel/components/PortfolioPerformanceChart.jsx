import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts'
import { portfolioChartSeries } from '../lib/portfolio-series'
import {portfolioAxisFormatter,portfolioDateTicks,portfolioTooltipUsd} from '../lib/portfolio-chart-labels'

// Portfolio value over time (from daily snapshots). recharts (already a dep) —
// no new chart library. A P&L mode plots realized + unrealized P&L (already on
// each snapshot) as lines around a zero baseline. Benchmark comparison lines
// (BTC/ETH/SOL) render only when a real series is provided; hidden otherwise —
// we never draw fabricated benchmark data.
const TF = [
  { key: '1w', days: 7 }, { key: '1m', days: 30 }, { key: '3m', days: 90 }, { key: '1y', days: 365 }, { key: 'all', days: Infinity },
]
const fmtT = (t) => { const d = new Date(t); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}` }
const snapshotDate = timestamp => new Date(timestamp).toLocaleDateString(undefined, { timeZone: 'UTC' })
const fmtPctSigned = (v) => v == null ? '' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`
const pctCls = (v) => v == null ? 'text-[var(--fg-4)]' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-[var(--fg-3)]'

export default function PortfolioPerformanceChart({ series = [], compare = null, loading = false, hasEarlier = false, loadingEarlier = false, onLoadEarlier }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [tf, setTf] = useState('3m')
  const [mode, setMode] = useState('value')   // 'value' | 'pnl'
  const quality = useMemo(() => portfolioChartSeries(series), [series])

  // P&L columns ride along on each snapshot (realized = cumulative-to-date,
  // unrealized = current mark-to-market) — the same metrics the Overview shows.
  const hasPnl = useMemo(() => (series || []).some((p) => p.unrealizedPnl != null || p.realizedPnl != null), [series])
  const view = mode === 'pnl' && hasPnl ? 'pnl' : 'value'

  const data = useMemo(() => {
    const days = (TF.find((x) => x.key === tf) || {}).days ?? Infinity
    const cutoff = days === Infinity ? 0 : Date.now() - days * 86400000
    return quality.rows.filter((p) => p.t >= cutoff)
  }, [quality, tf])

  const points = view === 'pnl'
    ? data.filter((p) => p.unrealizedPnl != null || p.realizedPnl != null)
    : data.filter((p) => p.value != null)
  const axisFormatter=portfolioAxisFormatter(view==='pnl'?points.flatMap(p=>[p.unrealizedPnl,p.realizedPnl]):points.map(p=>p.value))
  const dateTicks=portfolioDateTicks(data)

  const up = view === 'value' && points.length > 1 && points[points.length - 1].value >= points[0].value
  const color = up ? 'var(--signal-green)' : 'var(--signal-red)'

  const balanceChange = data.length >= 2 && data.every(p=>p.value!=null) && data[0].value>0
    ? (data.at(-1).value/data[0].value-1)*100 : null

  return (
    <div className="py-3">
      <div className="flex items-center justify-between mb-2 px-1 gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="eyebrow">{t('portfolio.performance', { defaultValue: 'Performance' })}</span>
          {hasPnl && (
            <div className="intel-range-controls" aria-label="Portfolio chart measure">
              <button aria-pressed={view === 'value'} onClick={() => setMode('value')}>{t('portfolio.mode_value', { defaultValue: 'Value' })}</button>
              <button aria-pressed={view === 'pnl'} onClick={() => setMode('pnl')}>{t('portfolio.mode_pnl', { defaultValue: 'P&L' })}</button>
            </div>
          )}
        </div>
        <div className="intel-range-controls" aria-label="Portfolio chart period">
          {TF.map((x) => (
            <button key={x.key} onClick={() => setTf(x.key)} aria-pressed={tf === x.key}>
              {t(`portfolio.tf.${x.key}`, { defaultValue: x.key.toUpperCase() })}
            </button>
          ))}
        </div>
      </div>
      <p className="intel-event-meta mb-2">{t('portfolio.snapshot_dates', { defaultValue: 'Daily snapshots · UTC dates' })}</p>
      {view==='value'&&balanceChange!=null&&<p className="text-xs mb-2">{t('portfolio.balance_change',{defaultValue:'Portfolio value change, including transfers'})} <span className={pctCls(balanceChange)}>{fmtPctSigned(balanceChange)}</span> · {snapshotDate(data[0].t)} – {snapshotDate(data.at(-1).t)}</p>}
      {view==='value'&&compare?.status==='error'&&<p role="alert" className="text-xs mb-2">{t('portfolio.market_context_failed',{defaultValue:'Market context could not be loaded. Reload the portfolio to retry.'})}</p>}
      {view==='value'&&compare?.status==='empty'&&<p className="text-xs mb-2">{t('portfolio.market_context_empty',{defaultValue:'No recorded 30-day market context is available.'})}</p>}
      {view==='value'&&!!compare?.rows?.length&&<details className="text-xs mb-3"><summary>{t('portfolio.market_context_30d',{defaultValue:'30-day market context'})}</summary>
        <p>{t('portfolio.market_context_independent',{defaultValue:'These periods are independent of the portfolio snapshots above. They do not measure portfolio outperformance or a return adjusted for deposits and withdrawals.'})}</p>
        <div className="intel-table-scroll"><table><thead><tr><th>{t('portfolio.asset_column',{defaultValue:'Asset'})}</th><th>{t('portfolio.market_change',{defaultValue:'30-day move'})}</th><th>{t('portfolio.source_observation',{defaultValue:'Source observation'})}</th></tr></thead><tbody>{compare.rows.map(r=><tr key={r.symbol}><td>{r.symbol}</td><td className={pctCls(r.changePercent)}>{fmtPctSigned(r.changePercent)}</td><td>{r.observedAt?<time dateTime={r.observedAt}>{new Date(r.observedAt).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'})}</time>:t('portfolio.observation_missing',{defaultValue:'Observation time not recorded'})}</td></tr>)}</tbody></table></div>
        {!!compare.missing?.length&&<p>{t('portfolio.market_context_missing',{defaultValue:'Unavailable assets'})}: {compare.missing.join(', ')}</p>}
      </details>}
      {quality.issues.length > 0 && <details className="intel-snapshot-quality"><summary>{t('portfolio.snapshot_quality', { defaultValue: '{{count}} recorded values need review and are left as chart gaps.', count: quality.issues.length })}</summary>
        <p>Some stored values are negative portfolio totals, non-finite, or exceed the chart's safe monetary precision. Source records are retained.</p>
        <div className="intel-table-scroll"><table><thead><tr><th>Date (UTC)</th><th>Field</th><th>Recorded value</th></tr></thead><tbody>{quality.issues.map((issue, i) => <tr key={i}><td>{snapshotDate(issue.t)}</td><td>{issue.field}</td><td>{issue.recordedValue}</td></tr>)}</tbody></table></div>
      </details>}
      {loading ? (
        <div className="h-[240px] grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : points.length < 2 ? (
        <div className="py-4 text-[13px] text-[var(--fg-4)]">
          {view === 'pnl'
            ? t('portfolio.pnl_empty', { defaultValue: 'P&L history builds from daily snapshots once your cost basis is known.' })
            : t('portfolio.perf_empty', { defaultValue: 'Performance builds from daily snapshots — today\'s value is saved on each sync. The chart appears once you have two or more days of history.' })}
        </div>
      ) : view === 'pnl' ? (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" vertical={false} />
            <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} ticks={dateTicks} tickFormatter={fmtT} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} minTickGap={40} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={axisFormatter} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} domain={['auto', 'auto']} width={92} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 0, fontSize: 12 }}
              labelFormatter={snapshotDate} formatter={(v, n) => [portfolioTooltipUsd(v), n]} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" strokeDasharray="2 2" />
            <Line type="monotone" dataKey="unrealizedPnl" name={t('portfolio.unrealized_pnl', { defaultValue: 'Unrealized P&L' })} stroke="var(--signal-blue)" strokeWidth={1.5} dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="realizedPnl" name={t('portfolio.realized_pnl', { defaultValue: 'Realized P&L' })} stroke="var(--signal-green)" strokeWidth={1.5} dot={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="pfval" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" vertical={false} />
            <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} ticks={dateTicks} tickFormatter={fmtT} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} minTickGap={40} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={axisFormatter} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} domain={['auto', 'auto']} width={92} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 0, fontSize: 12 }}
              labelFormatter={snapshotDate} formatter={(v) => [portfolioTooltipUsd(v), t('portfolio.total_value', { defaultValue: 'Total value' })]} />
            <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill="url(#pfval)" />
          </AreaChart>
        </ResponsiveContainer>
      )}
      {hasEarlier && onLoadEarlier && <button className="btn btn--ghost btn--sm" disabled={loadingEarlier} onClick={() => { setTf('all'); onLoadEarlier() }}>{loadingEarlier ? 'Loading earlier history…' : 'Load earlier history'}</button>}
    </div>
  )
}
