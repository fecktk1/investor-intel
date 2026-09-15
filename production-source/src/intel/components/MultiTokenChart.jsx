import React, { useEffect, useMemo, useState, useRef } from 'react'
import ResponsiveChartTools from './ResponsiveChartTools'
import TokenAvatar from './TokenAvatar'
import ChartWatermark from './ChartWatermark'
import {assetLogoUrl} from '../lib/asset-identity'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts'
import { comparisonTimeline, comparisonWindow, comparisonPriceDomain, comparisonAssetLink } from '../lib/chart-comparison'
const COLORS = ['var(--accent)', 'var(--signal-blue)', 'var(--signal-green)', 'var(--intel-comparison-fourth)']
const price = v => v == null ? 'No observation' : Number(v).toLocaleString(undefined, { maximumSignificantDigits: 8 })
const pct = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
export default function MultiTokenChart({ series, loading, view = {}, onViewChange = () => {}, controls, actions, asOf, onObservationChange, eventTime, timeWindow }) {
  const model = useMemo(() => comparisonTimeline(series,asOf), [series,asOf])
  const rows = useMemo(() => comparisonWindow(model, view.range), [model, view.range])
  const axisRange=view.range||timeWindow||(rows.length?{from:rows[0].t,to:rows.at(-1).t}:null)
  const [cursor, setCursor] = useState(null)
  const plots=useRef(null)
  const movePlot=delta=>{const el=plots.current;if(el)el.scrollBy({left:delta*((el.firstElementChild?.getBoundingClientRect().width||el.clientWidth)+24),behavior:'auto'})}
  const arrangement = ['overlay', '2x2', '1x4'].includes(view.arrangement) ? view.arrangement : 'overlay'
  const returns = arrangement === 'overlay' || view.priceScale === 'returns'
  const currencies = new Set(model.series.map(s => s.chartSource?.currency).filter(Boolean))
  const commonCurrency = currencies.size === 1 && model.series.every(s => s.chartSource?.currency)
  const independent = !returns && (view.priceScale !== 'shared' || !commonCurrency)
  const timezone = view.timezone || 'UTC'
  const time = t => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone })
  const focused = rows.find(r => r.t === cursor) || rows.at(-1)
  useEffect(()=>{onObservationChange?.(focused?{t:focused.t,prices:Object.fromEntries(model.series.map(s=>[s.asset,focused[s.key]??null]))}:null)},[focused,model.series,onObservationChange])
  const keys = model.series.map(s => s.key + (returns ? '_return' : ''))
  const domain = comparisonPriceDomain(rows, keys)
  const update = patch => onViewChange({ ...view, ...patch })
  const sliceRange = (side, value) => {
    const index = Number(value), start = model.times.indexOf(rows[0]?.t), end = model.times.indexOf(rows.at(-1)?.t)
    const from = side === 'from' ? Math.min(index, Math.max(0, end - 1)) : Math.max(0, start)
    const to = side === 'to' ? Math.max(index, from + 1) : Math.max(from + 1, end)
    update({ range: { from: model.times[from], to: model.times[to] } })
  }
  const plot = (members, index) => <div className="intel-compare-plot" key={index}>
    {arrangement !== 'overlay' && <h3><a className="intel-compare-asset-name" href={members[0].asset ? comparisonAssetLink(members[0].asset) : undefined}><TokenAvatar src={members[0].logo||assetLogoUrl(members[0].asset)} symbol={members[0].label} size="sm"/>{members[0].label}</a><span>{returns ? 'Return' : members[0].chartSource?.currency || 'Currency unavailable'}</span></h3>}
    {members.length===1&&!members[0].data.length?<p className="intel-compare-gap" role="status">{members[0].error||'Price history is unavailable for this asset.'}</p>:returns&&model.baseline==null?<p className="intel-compare-gap" role="status">A return comparison needs matching observations for every selected asset. Choose independent prices to inspect available histories.</p>:<div className="intel-compare-plot-surface"><ChartWatermark/><ResponsiveContainer width="100%" height={arrangement === 'overlay' ? 330 : 230}>
      <LineChart data={rows} margin={{ top: 12, right: 12, bottom: 0, left: 0 }} onMouseMove={event => { if (rows.some(r => r.t === Number(event?.activeLabel))) setCursor(Number(event.activeLabel)) }}>
        <CartesianGrid stroke="var(--border-default)" vertical={false} strokeDasharray="2 6" />
        <XAxis dataKey="t" type="number" scale="time" domain={axisRange ? [axisRange.from,axisRange.to] : ['dataMin', 'dataMax']} allowDataOverflow tickFormatter={t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: timezone })} tick={{ fill: 'var(--fg-4)', fontSize: 10 }} minTickGap={55} axisLine={false} tickLine={false} />
        <YAxis domain={independent ? comparisonPriceDomain(rows, members.map(s => s.key)) : domain} tickFormatter={v => returns ? `${Number(v).toFixed(1)}%` : Number(v).toLocaleString(undefined, { notation: 'compact', maximumSignificantDigits: 4 })} tick={{ fill: 'var(--fg-4)', fontSize: 10 }} width={70} axisLine={false} tickLine={false} />
        <Tooltip content={() => null} cursor={false} />
        {focused && <ReferenceLine x={focused.t} stroke="var(--accent)" strokeDasharray="3 3" />}
        {Number.isFinite(eventTime)&&axisRange&&eventTime>=axisRange.from&&eventTime<=axisRange.to&&<ReferenceLine x={eventTime} stroke="var(--signal-blue)" strokeDasharray="6 3" />}
        {members.map(s => <Line key={s.key} name={s.label} type="linear" dataKey={s.key + (returns ? '_return' : '')} stroke={COLORS[model.series.indexOf(s)]} strokeWidth={1.6} dot={false} activeDot={false} connectNulls={false} isAnimationActive={false} />)}
      </LineChart>
    </ResponsiveContainer></div>}
  </div>
  return <section className="intel-compare-workspace" aria-label="Linked asset charts" aria-busy={loading}>
    <ResponsiveChartTools label={`Chart controls · ${arrangement === 'overlay' ? 'Return overlay' : arrangement === '2x2' ? '2 × 2 charts' : '1 × 4 charts'}`}>
    <div className="intel-workstation-toolbar">{controls}
      <label>Arrangement<select value={arrangement} onChange={e => update({ arrangement: e.target.value })}><option value="overlay">Return overlay</option><option value="2x2">2 × 2 charts</option><option value="1x4">1 × 4 charts</option></select></label>
      <label>Price scales<select disabled={arrangement === 'overlay'} title={arrangement === 'overlay' ? 'Return overlays use aligned returns.' : undefined} value={arrangement === 'overlay' ? 'returns' : view.priceScale || 'independent'} onChange={e => update({ priceScale: e.target.value })}><option value="independent">Independent prices</option><option value="shared" disabled={!commonCurrency}>Shared prices</option><option value="returns">Aligned returns</option></select></label>
      <label>Timezone<select value={timezone} onChange={e => update({ timezone: e.target.value })}>{[...new Set(['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, timezone])].map(z => <option key={z}>{z}</option>)}</select></label>
      <button type="button" onClick={() => update({ range: null })}>Reset range</button>{actions}
    </div>
    </ResponsiveChartTools>
    {loading ? <div className="intel-compare-loading" role="status">Loading comparison history…</div> : <>
    {Number.isFinite(eventTime)&&<p className="intel-analysis-caption">Selected activity: {time(eventTime)} · {timezone}. The blue time guide identifies the event; recorded prices below retain their own observation time.</p>}
    <p className="intel-analysis-caption">{returns ? model.baseline == null ? 'Aligned returns require at least two matching observations for every selected asset. Use independent prices to inspect partial coverage.' : `Returns start at ${time(model.baseline)} · ${model.sharedCount} shared observation times.` : `${independent ? 'Independent price scales.' : 'One shared price scale.'} Use aligned returns to compare relative movement.`} Recorded close times share one cursor. Missing prices stay blank. {!commonCurrency && 'Quote currencies differ or are unknown; a shared price scale is unavailable.'} {model.limited && 'Showing up to four assets and the latest 4,000 observations per asset.'}</p>
    {!model.times.length ? <p>No price history is available. Coverage for each selected asset is shown below.</p> : !rows.length ? <p>This saved range is outside the loaded period. Change the history period or reset the range.</p> : <>
      <div className="intel-compare-legend">{model.series.map((s,i)=><span key={s.key} style={{color:COLORS[i]}}>{s.label} <b>{pct(focused?.[`${s.key}_return`])}</b></span>)}</div>
      {arrangement!=='overlay'&&<div className="intel-compare-mobile-navigation"><span>Browse charts · one shared cursor</span><button type="button" onClick={()=>movePlot(-1)}>Previous chart</button><button type="button" onClick={()=>movePlot(1)}>Next chart</button></div>}
      <div ref={plots} tabIndex={0} role="region" className={`intel-compare-plots intel-compare-plots--${arrangement}`} aria-label="Synchronized price charts">{arrangement === 'overlay' ? plot(model.series, 0) : model.series.map((s, i) => plot([s], i))}</div>
      {model.times.length > 1 && <div className="intel-compare-range"><label>Range start<input type="range" aria-label="Comparison range start" min={0} max={model.times.length - 2} value={model.times.indexOf(rows[0].t)} onChange={e => sliceRange('from', e.target.value)} /></label><label>Range end<input type="range" aria-label="Comparison range end" min={1} max={model.times.length - 1} value={model.times.indexOf(rows.at(-1).t)} onChange={e => sliceRange('to', e.target.value)} /></label><span>{time(rows[0].t)} – {time(rows.at(-1).t)}</span></div>}
      <div className="intel-compare-cursor"><label>Shared cursor<input type="range" aria-label="Comparison observation time" aria-valuetext={`${time(focused.t)} ${timezone}`} min={0} max={rows.length - 1} value={rows.indexOf(focused)} onChange={e => setCursor(rows[Number(e.target.value)].t)} /></label><button type="button" disabled={focused === rows[0]} onClick={() => setCursor(rows[Math.max(0, rows.indexOf(focused) - 1)].t)}>Previous observation</button><button type="button" disabled={focused === rows.at(-1)} onClick={() => setCursor(rows[Math.min(rows.length - 1, rows.indexOf(focused) + 1)].t)}>Next observation</button></div>
    </>}
    <div className="intel-compare-readings" tabIndex={0} role="region" aria-label="Comparison observations and coverage"><table><caption>{focused ? `${time(focused.t)} · ${timezone}` : 'Selected asset coverage'}</caption><thead><tr><th scope="col">Asset</th><th scope="col">Close</th><th scope="col">Return</th><th scope="col">Source and coverage</th></tr></thead><tbody>{model.series.map((s, i) => <tr key={s.key}><th scope="row"><span style={{ color: COLORS[i] }}>― </span>{s.asset ? <a className="intel-compare-asset-name" href={comparisonAssetLink(s.asset)}><TokenAvatar src={s.logo||assetLogoUrl(s.asset)} symbol={s.label} size="sm"/>{s.label}</a> : s.label}<small>{s.asset}</small></th><td>{price(focused?.[s.key])}{focused?.[s.key] != null ? ` ${s.chartSource?.currency || 'Currency unavailable'}` : ''}</td><td>{pct(focused?.[`${s.key}_return`])}</td><td>{s.error || <>{s.chartSource?.provider === 'coinmarketcap' ? 'CoinMarketCap' : s.chartSource?.provider === 'coingecko' ? 'CoinGecko' : s.chartSource?.provider || 'Source unavailable'}{s.state && s.state !== 'fresh' ? ` · ${s.state}` : ''} · {s.data.length} observations{s.chartSource?.intervalMs ? ` · ${s.chartSource.intervalMs / 60000} min bars` : ''}{s.data.length > 0 && <small>Latest {time(s.data.at(-1).t)} · {s.chartSource?.timestampMeaning === 'open' ? 'recorded bar close times' : s.chartSource?.timestampMeaning === 'close' ? 'bar close times' : 'source observation times'}</small>}</>}</td></tr>)}</tbody></table></div>
    </>}
  </section>
}
