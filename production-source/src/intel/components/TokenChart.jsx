import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceDot, ReferenceLine, ReferenceArea } from 'recharts'

// Price chart for the token intelligence / market pages. Close-price area chart
// with a gradient fill, colored by net direction over the window.
//
// Timeframe cycling (opt-in): pass `loadCandles(range) => Promise<candles>` and the
// chart renders a 1H…1Y selector, fetching + caching candles per range. Without it,
// the static `candles` prop is used (existing behavior, no selector).
//
// Thesis Journal overlays (all optional, per-user): markers, keyLevels, maxDrawdown.
const RANGES = ['1H', '12H', '24H', '3D', '7D', '1M', '3M', '6M', '1Y']
const MARKER_STYLE = {
  thesis: { color: '#a78bfa', group: 'thesis' }, review: { color: '#60a5fa', group: 'thesis' },
  confirm: { color: '#34d399', group: 'thesis' }, invalidate: { color: '#f87171', group: 'thesis' },
  entry: { color: '#34d399', group: 'trade' }, exit: { color: '#fbbf24', group: 'trade' },
  buy: { color: '#22d3ee', group: 'portfolio' }, sell: { color: '#fb923c', group: 'portfolio' },
  news: { color: '#94a3b8', group: 'news' }, partnership: { color: '#c084fc', group: 'partnerships' }, unlock: { color: '#f472b6', group: 'unlocks' },
}
const DENSITY_GROUPS = [['thesis', 'Thesis'], ['trade', 'Trades'], ['portfolio', 'Portfolio'], ['news', 'News'], ['partnerships', 'Partnerships'], ['unlocks', 'Unlocks']]
const toMs = (t) => (typeof t === 'number' && t < 1e12) ? t * 1000 : t

export default function TokenChart({ candles, loading, markers = [], keyLevels = [], maxDrawdown = null, showDensityToggles = false, loadCandles = null, defaultRange = '7D' }) {
  const { t } = useTranslation('intel')
  const [groups, setGroups] = useState(new Set(['thesis', 'trade', 'portfolio']))
  const [range, setRange] = useState(defaultRange)
  const [series, setSeries] = useState(candles || null)
  const [tfLoading, setTfLoading] = useState(false)
  const cacheRef = useRef({})

  // Seed the cache with the initial static candles for the default range.
  useEffect(() => { if (loadCandles && candles && !cacheRef.current[defaultRange]) { cacheRef.current[defaultRange] = candles; setSeries(candles) } }, [candles]) // eslint-disable-line

  // Fetch (cached) candles when the range changes — only when cycling is enabled.
  useEffect(() => {
    if (!loadCandles) return
    let alive = true
    if (cacheRef.current[range]) { setSeries(cacheRef.current[range]); return }
    setTfLoading(true)
    Promise.resolve(loadCandles(range)).then((c) => { if (!alive) return; cacheRef.current[range] = c || []; setSeries(c || []) })
      .catch(() => { if (alive) setSeries([]) })
      .finally(() => { if (alive) setTfLoading(false) })
    return () => { alive = false }
  }, [range, loadCandles])

  const raw = loadCandles ? series : candles
  const data = useMemo(() => (raw || []).map((c) => ({ t: toMs(c.t), price: c.c })).filter((d) => d.price != null), [raw])
  const priceAt = useMemo(() => (ts) => { if (!data.length) return null; let best = data[0], bd = Math.abs(data[0].t - ts); for (const d of data) { const dd = Math.abs(d.t - ts); if (dd < bd) { bd = dd; best = d } } return best.price }, [data])

  const busy = loading || tfLoading
  const selector = loadCandles ? (
    <div className="flex items-center gap-1 flex-wrap">
      {RANGES.map((r) => (
        <button key={r} onClick={() => setRange(r)} className={`chip text-[10px] ${range === r ? 'bg-[var(--accent)] text-black' : 'text-[var(--fg-4)]'}`}>{r}</button>
      ))}
    </div>
  ) : null

  const shell = (inner) => (
    <div className="card p-3 space-y-2">
      {(selector || (showDensityToggles && markers.length > 0)) && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          {selector}
          {showDensityToggles && markers.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {DENSITY_GROUPS.map(([g, label]) => (
                <button key={g} onClick={() => setGroups((s) => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n })}
                  className={`chip text-[10px] ${groups.has(g) ? 'chip--info' : 'text-[var(--fg-5)]'}`}>{t(`chart.marker_${g}`, { defaultValue: label })}</button>
              ))}
            </div>
          )}
        </div>
      )}
      {inner}
    </div>
  )

  if (busy && !data.length) return shell(<div className="h-[280px] grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>)
  if (!data.length) return shell(<div className="h-[200px] grid place-items-center text-center text-[13px] text-[var(--fg-4)]">{t('chart.no_token_data', { defaultValue: 'No chart data available for this asset/chain yet.' })}</div>)

  const up = data.length > 1 && data[data.length - 1].price >= data[0].price
  const color = up ? '#34d399' : '#f87171'
  const fmt = (p) => p == null ? '' : p < 1 ? `$${Number(p).toPrecision(3)}` : `$${Number(p).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  const intraday = ['1H', '12H', '24H'].includes(range)
  const fmtT = (ts) => { const d = new Date(ts); return intraday ? `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` : `${d.getMonth() + 1}/${d.getDate()}` }

  const firstT = data[0]?.t, lastT = data[data.length - 1]?.t
  const clampT = (ts) => (firstT == null || lastT == null) ? ts : Math.max(firstT, Math.min(lastT, ts))
  const shown = (markers || []).filter((m) => m && m.t != null && groups.has(MARKER_STYLE[m.type]?.group || 'thesis'))
  const enhanced = shown.length > 0 || (keyLevels || []).length > 0 || !!maxDrawdown
  const xAxisProps = enhanced ? { type: 'number', domain: ['dataMin', 'dataMax'], scale: 'time' } : {}

  return shell(
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="tcprice" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
        <XAxis dataKey="t" {...xAxisProps} tickFormatter={fmtT} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} minTickGap={40} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={fmt} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} domain={['auto', 'auto']} width={64} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12 }}
          labelFormatter={(ts) => new Date(ts).toLocaleString()} formatter={(v) => [fmt(v), t('chart.price', { defaultValue: 'Price' })]} />
        {maxDrawdown?.fromT != null && maxDrawdown?.toT != null && <ReferenceArea x1={maxDrawdown.fromT} x2={maxDrawdown.toT} fill="#f87171" fillOpacity={0.07} />}
        {(keyLevels || []).map((lv, i) => lv?.price != null && (
          <ReferenceLine key={`kl${i}`} y={lv.price} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" label={{ value: lv.label || fmt(lv.price), fill: 'var(--fg-4)', fontSize: 10, position: 'insideTopLeft' }} />
        ))}
        <Area type="monotone" dataKey="price" stroke={color} strokeWidth={1.5} fill="url(#tcprice)" />
        {shown.map((m, i) => {
          const x = clampT(m.t), y = priceAt(x)
          if (y == null) return null
          const st = MARKER_STYLE[m.type] || MARKER_STYLE.thesis
          return <ReferenceDot key={`m${i}`} x={x} y={y} r={4} fill={st.color} stroke="var(--bg-1)" strokeWidth={1.5} ifOverflow="extendDomain" label={{ value: m.label || m.type, fill: st.color, fontSize: 9, position: 'top' }} />
        })}
      </AreaChart>
    </ResponsiveContainer>,
  )
}
