import React from 'react'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceDot, ReferenceLine, ReferenceArea } from 'recharts'
import { markerGroup } from '../lib/chart-history'

// Loaded only for sparse observations, an explicit legacy view, or a failed
// native renderer. The research lane and detail panel remain owned by TokenChart.
export default function TokenChartFallback({data,height,onCursorChange,chartId,color,first,last,fmtT,fmt,date,t,drawdownFrom,drawdownTo,keyLevels,cursorTime,clusters,priceAt,open,leave,colors}) {
  return (<ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 24, right: 18, bottom: 0, left: 0 }} onClick={state => { if(state?.activeLabel!=null && Number.isFinite(Number(state.activeLabel))) onCursorChange?.(Number(state.activeLabel)) }}>
          <defs><linearGradient id={chartId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.12}/><stop offset="100%" stopColor={color} stopOpacity={0}/></linearGradient></defs>
          <CartesianGrid strokeDasharray="2 6" stroke="var(--border-default)" vertical={false}/>
          <XAxis dataKey="t" type="number" domain={[first, Math.max(first + 1, last)]} scale="time" tickFormatter={fmtT} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} minTickGap={45} axisLine={false} tickLine={false}/>
          <YAxis tickFormatter={fmt} domain={['auto', 'auto']} tick={{ fill: 'var(--fg-4)', fontSize: 11 }} width={72} axisLine={false} tickLine={false}/>
          <Tooltip contentStyle={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 2, fontSize: 12 }} labelFormatter={date} formatter={v => [fmt(v), t('chart.price', { defaultValue: 'Price' })]}/>
          {drawdownFrom != null && drawdownTo != null && drawdownTo >= first && drawdownFrom <= last && <ReferenceArea x1={Math.max(first, drawdownFrom)} x2={Math.min(last, drawdownTo)} fill="var(--signal-red)" fillOpacity={0.07}/>}
          {keyLevels.map((lv, i) => lv?.price != null && <ReferenceLine key={i} y={lv.price} stroke="var(--fg-4)" strokeDasharray="4 4" label={{ value: lv.label || fmt(lv.price), fill: 'var(--fg-4)', fontSize: 10, position: 'insideTopLeft' }}/>)}
          <Area type="linear" dataKey="price" stroke={color} strokeWidth={1.75} fill={`url(#${chartId})`} isAnimationActive={false}/>
          {Number.isFinite(cursorTime) && cursorTime >= first && cursorTime <= last && <ReferenceLine x={cursorTime} stroke="var(--accent)" strokeDasharray="3 3"/>}
          {clusters.filter(cluster => data.some(c => c.t === cluster.t)).map(cluster => <ReferenceDot key={cluster.events[0].id} x={cluster.t} y={priceAt(cluster.t)} ifOverflow="hidden" shape={({ cx, cy }) => <g tabIndex={0} role="button" aria-label={`${cluster.events.map(e => e.label || e.action || e.type).join(', ')} · ${date(cluster.t)}`} onMouseEnter={e => open(cluster.events, e)} onMouseLeave={leave} onBlur={leave} onFocus={e => open(cluster.events, e)} onClick={e => open(cluster.events, e, true)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(cluster.events, e, true) } }} className="intel-chart-marker"><circle cx={cx} cy={cy} r={14} fill="transparent"/><path d={`M ${cx} ${cy - 6} L ${cx + 6} ${cy} L ${cx} ${cy + 6} L ${cx - 6} ${cy} Z`} fill={colors[markerGroup(cluster.events[0])] || colors.thesis} stroke="var(--bg-1)" strokeWidth={2}/>{cluster.events.length > 1 && <text x={cx + 9} y={cy - 7} fill="var(--fg-1)" fontSize={11}>{cluster.events.length}</text>}</g>}/>)}
        </AreaChart>
      </ResponsiveContainer>)
}
