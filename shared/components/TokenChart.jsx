import React, { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceDot, ReferenceLine, ReferenceArea } from 'recharts'
import { epochMs, normalizeCandles, markerWindow, markerGroup, clusterMarkers, projectMarkerLayers } from '../lib/chart-history'
import ChartReplayControls from './ChartReplayControls'
import ResponsiveChartTools from './ResponsiveChartTools'
import EvidenceMarkerContext from './EvidenceMarkerContext'
import {useChartAlertHistory} from '../lib/useChartAlertHistory'
import {chartReplay,replayStops} from '../lib/chart-replay'
import { normalizeBars, regularBarGrid } from '../../../supabase/functions/_shared/intel/chart-analysis'
const PriceWorkstation = lazy(() => import('./PriceWorkstation'))
class WorkstationBoundary extends React.Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { this.props.onFailure() }
  render() { return this.state.failed ? null : this.props.children }
}

const RANGES = ['1H', '12H', '24H', '3D', '7D', '1M', '3M', '6M', '1Y']
export const CHART_RANGE_MS = { '1H': 3600000, '12H': 43200000, '24H': 86400000, '3D': 259200000, '7D': 604800000, '1M': 2592000000, '3M': 7776000000, '6M': 15552000000, '1Y': 31536000000 }
const LAYERS = [['thesis', 'Thesis'], ['trade', 'Journal trades'], ['portfolio', 'Portfolio'], ['rules', 'Rules'], ['news', 'News'], ['partnerships', 'Partnerships'], ['unlocks', 'Unlocks']]
const COLORS = { thesis: '#DFA647', trade: '#B4A0DC', portfolio: '#6CC6A2', news: '#A7AFBC', partnerships: '#82ABD2', unlocks: '#E3AEBC' }
const textLabel = key => key.replaceAll('_', ' ')
const renderWords = words => typeof words === 'string' ? words : Object.entries(words || {}).map(([key,value]) => value != null && <p key={key}><span className="intel-event-meta">{textLabel(key)}: </span>{typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : JSON.stringify(value)}</p>)
const date = t => t == null ? 'Time not recorded' : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' })
const number = n => n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 })
const changeText = value => value == null || value === '' ? '—' : Array.isArray(value) ? value.length ? value.map(changeText).join(', ') : '—' : typeof value === 'object' ? Object.entries(value).map(([key,child])=>`${textLabel(key)}: ${changeText(child)}`).join('\n') || '—' : String(value)
const changeValue = value => value && typeof value === 'object' && ('before' in value || 'after' in value) ? `${changeText(value.before)} → ${changeText(value.after)}` : changeText(value)
const eventOrder = event => (event.eventKind || event.event_kind || event.type) === 'thesis_created' || event.label === 'Thesis created' ? 0 : 1

function RecordedChanges({ changes, t }) {
  const entries=Object.entries(changes||{}).filter(([,value])=>!(value&&typeof value==='object'&&changeText(value.before)==='—'&&changeText(value.after)==='—'))
  if(!entries.length)return null
  return <details className="intel-event-changes"><summary>{t('chart.recorded_changes',{count:entries.length,defaultValue:'Recorded changes ({{count}})'})}</summary><dl className="intel-event-facts">{entries.map(([key,value])=><React.Fragment key={key}><dt>{textLabel(key)}</dt><dd className="whitespace-pre-wrap break-words">{changeValue(value)}</dd></React.Fragment>)}</dl></details>
}

function LinkedResearch({ record, t }) {
  const snapshot=record.changes?.exit_snapshot?.after
  return <section className="border-t border-[var(--border-default)] mt-3 pt-3" aria-label={record.label||'Linked research'}>
    <p className="intel-event-meta">{record.label} · {date(epochMs(record.t))}</p>
    <blockquote className="whitespace-pre-wrap break-words">{renderWords(record.textSnapshot || record.note)}</blockquote>
    {snapshot&&<dl className="intel-event-facts">
      {snapshot.exit_fraction!=null&&<><dt>{t('chart.journal_exit_fraction',{defaultValue:'Original journal position exited'})}</dt><dd>{number(snapshot.exit_fraction*100)}%</dd></>}
      {snapshot.realized_pnl_usd!=null&&<><dt>{t('chart.journal_exit_result',{defaultValue:'Journal result for this exit'})}</dt><dd>${number(snapshot.realized_pnl_usd)}</dd></>}
    </dl>}
    <RecordedChanges changes={record.changes} t={t}/>
  </section>
}

export function MarkerDetails({ events, onClose, t, onMouseEnter, onMouseLeave }) {
  const ordered = [...events].sort((a,b)=>(a.t-b.t)||eventOrder(a)-eventOrder(b)||String(a.id).localeCompare(String(b.id)))
  const [chosen, setChosen] = useState(null)
  const selected = ordered.find(event=>event.id===chosen)||ordered[0]
  return <section onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} className="intel-event-detail" role="region" aria-label={t('chart.event_details', { defaultValue: 'Activity details' })}>
    <button className="intel-event-close" type="button" onClick={onClose} aria-label={t('chart.close_details', { defaultValue: 'Close activity details' })}>×</button>
    {ordered.length>1&&<label className="intel-event-picker">{t('chart.grouped_events',{count:ordered.length,defaultValue:'{{count}} events at this scale'})}<select aria-label={t('chart.choose_event',{defaultValue:'Activity in this group'})} value={selected.id} onChange={event=>setChosen(event.target.value)}>{ordered.map(event=><option key={event.id} value={event.id}>{date(event.t)} · {event.action||event.label||event.eventKind||event.type}</option>)}</select></label>}
    {[selected].filter(Boolean).map(event => {
      const notes = event.textSnapshot && Object.keys(event.textSnapshot).length ? event.textSnapshot : event.notes ?? event.note ?? event.text_snapshot ?? event.event?.notes
      const changes = event.changes && typeof event.changes === 'object' ? Object.entries(event.changes).filter(([,value])=>!(value&&typeof value==='object'&&changeText(value.before)==='—'&&changeText(value.after)==='—')) : []
      return <article key={event.id} className="intel-event-record">
        <div className="intel-event-meta">{date(event.t)} · {event.actorKind === 'system' || event.actorKind === 'engine' ? t('chart.automated', { defaultValue: 'Automated observation' }) : markerGroup(event) === 'portfolio' ? t('chart.portfolio_record', { defaultValue: 'Portfolio activity' }) : t('chart.research_record', { defaultValue: 'Research history' })}</div>
        <h3>{event.action || event.label || event.eventKind || event.type}</h3>
        {event.title && <p>{event.title}</p>}
        {notes ? <blockquote className="whitespace-pre-wrap break-words">{renderWords(notes)}</blockquote> : <p className="text-[var(--fg-4)]">{t('chart.no_note', { defaultValue: 'No original note recorded for this event.' })}</p>}
        <EvidenceMarkerContext snapshot={event.sourceSnapshot} t={t}/>
        {event.historicalCompleteness && event.historicalCompleteness !== 'complete' && <p className="text-[var(--fg-4)]">{t('chart.partial_history', { defaultValue: 'Historical detail is limited to the records available.' })}</p>}
        {event.condition&&<dl className="intel-event-facts"><dt>Saved condition</dt><dd>Crosses {event.condition.direction} ${number(event.condition.level)} · revision {event.condition.revision}</dd>{event.condition.anchor&&<><dt>Selected reference anchor</dt><dd>{date(event.condition.anchor.t)} · ${number(event.condition.anchor.price)}</dd></>}</dl>}
        {event.chartAnchorPrice!=null&&<p>Chart price anchor: {number(event.chartAnchorPrice)}. Written {date(epochMs(event.recordedAt))}.</p>}
        {(event.quantity != null || event.executionPrice != null || event.executionValue != null) && <dl className="intel-event-facts">
          {event.quantity != null && <><dt>{t('chart.quantity', { defaultValue: 'Quantity' })}</dt><dd>{number(event.quantity)} {event.tokenSymbol || ''}{event.direction ? ` · ${event.direction}` : ''}</dd></>}
          {event.executionPrice != null && <><dt>{t('chart.execution_price', { defaultValue: 'Recorded execution price' })}</dt><dd>${number(event.executionPrice)}</dd></>}
          {event.executionValue != null && <><dt>{t('chart.execution_value', { defaultValue: 'Recorded value' })}</dt><dd>${number(event.executionValue)}</dd></>}
        </dl>}
        {event.executionPrice == null && event.recordedExecutionPrice != null && <p>{t('chart.execution_price', { defaultValue: 'Recorded execution price' })}: {number(event.recordedExecutionPrice)} {event.executionCurrency || t('chart.unknown_fee_currency', { defaultValue: 'currency not recorded' })}</p>}
        {event.status && <p>{t('chart.status', { defaultValue: 'Status' })}: {event.status}</p>}
        {changes.filter(([key])=>['status','stance','conviction'].includes(key)).length>0&&<dl className="intel-event-facts">{changes.filter(([key])=>['status','stance','conviction'].includes(key)).map(([key,value])=><React.Fragment key={key}><dt>{textLabel(key)}</dt><dd>{changeValue(value)}</dd></React.Fragment>)}</dl>}
        {changes.length > 0 && <details className="intel-event-changes"><summary>{t('chart.recorded_changes',{count:changes.length,defaultValue:'Recorded changes ({{count}})'})}</summary><dl className="intel-event-facts">{changes.map(([key, value]) => <React.Fragment key={key}><dt>{textLabel(key)}</dt><dd className="whitespace-pre-wrap break-words">{changeValue(value)}</dd></React.Fragment>)}</dl></details>}
        {(event.source || event.transactionRef) && <p className="intel-event-reference break-all">{typeof event.source === 'string' ? event.source : ''}{event.protocol ? ` · ${event.protocol}` : ''}{event.transactionRef ? ` · ${event.transactionRef}` : ''}</p>}
        {(event.fee?.amount != null || event.fee?.usd != null) && <p>{t('chart.fee', { defaultValue: 'Recorded fee' })}: {event.fee.amount != null ? `${number(event.fee.amount)} ${event.fee.asset || t('chart.unknown_fee_currency', { defaultValue: 'currency not recorded' })}` : ''}{event.fee.usd != null ? ` ($${number(event.fee.usd)})` : ''}</p>}
        {event.event?.lineItems?.length > 1 && <ul>{event.event.lineItems.map((leg, index) => <li key={index} className="text-xs">{leg.direction} · {number(leg.amount)} {leg.symbol || leg.canonical_asset_key}</li>)}</ul>}
        {event.event?.lineItemsTruncated && <p>{t('chart.legs_limited', { defaultValue: 'Showing up to 64 legs. Open the underlying portfolio activity for the complete record.' })}</p>}
        {event.linkedResearch?.map(record => <LinkedResearch key={record.id} record={record} t={t}/>)}
        {event.priceSource && <p className="intel-event-meta">{event.priceSource}</p>}
      </article>
    })}
  </section>
}

function TokenChartBody({ candles, loading, markers: providedMarkers = [], keyLevels: inputKeyLevels = [], maxDrawdown: inputDrawdown = null, showDensityToggles = false, loadCandles = null, defaultRange = '7D', assetKey = '', onRangeChange, historyLoading: suppliedHistoryLoading = false, historyError: suppliedHistoryError = null, historyHasMore: suppliedHistoryHasMore = false, onLoadMoreHistory: loadSuppliedHistory, timeWindow = null, priceCoverage = null, cursorTime = null, focusMarkerId = null, focusMarkerRequest = null, onCursorChange, onEventSelect, height = 340, workstation = true, rangeExtra = null, persistence = null, requestKey = '', initialLayout = null, readOnly = false, replayCursor = undefined, onReplayChange }) {
  const { t } = useTranslation('intel')
  const conditions=useChartAlertHistory(readOnly?null:persistence,timeWindow?.from,timeWindow?.to,assetKey)
  const inputMarkers=useMemo(()=>[...providedMarkers,...conditions.markers],[providedMarkers,conditions.markers])
  const historyLoading=suppliedHistoryLoading||conditions.loading,historyError=suppliedHistoryError||conditions.error,historyHasMore=suppliedHistoryHasMore||!!conditions.nextCursor
  const onLoadMoreHistory=()=>{if(suppliedHistoryHasMore)loadSuppliedHistory?.();if(conditions.nextCursor)conditions.loadMore()}
  const chartId = useId().replaceAll(':', '')
  const [hiddenGroups, setHiddenGroups] = useState(new Set(['news', 'partnerships', 'unlocks']))
  const layers = useMemo(() => [...LAYERS, ...[...new Set(inputMarkers.map(markerGroup))].filter(group => !LAYERS.some(([known]) => known === group)).map(group => [group, textLabel(group)])], [inputMarkers])
  const groups = useMemo(() => showDensityToggles ? new Set(layers.map(([group]) => group).filter(group => !hiddenGroups.has(group))) : null, [layers, hiddenGroups, showDensityToggles])
  const [range, setRange] = useState(defaultRange)
  const [series, setSeries] = useState(candles || [])
  const [tfLoading, setTfLoading] = useState(false)
  const [chartError, setChartError] = useState(null)
  const [coverage, setCoverage] = useState(priceCoverage)
  const [refreshTick,setRefreshTick]=useState(0)
  const [selection, setSelection] = useState(null)
  const [allHistory, setAllHistory] = useState(false)
  const [viewport,setViewport] = useState(null),[rendererFailed,setRendererFailed] = useState(false)
  const cacheRef = useRef({})
  const previousRequestKey = useRef(requestKey)
  const workspaceDraft = useRef(initialLayout||{})
  const [localReplayAt,setReplayAt]=useState(initialLayout?.replay?.at??null),[knownOnly,setKnownOnly]=useState(initialLayout?.replay?.knownOnly??false)
  const replayAt=replayCursor===undefined?localReplayAt:replayCursor
  const replayBasis=useRef(`${range}:${requestKey}`)
  useEffect(()=>{const next=`${range}:${requestKey}`;if(replayBasis.current!==next){replayBasis.current=next;setReplayAt(null);setSelection(null);onReplayChange?.(null)}},[range,requestKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const setReplayTime=value=>{setReplayAt(value);setSelection(null);pinRef.current=false;onReplayChange?.(value);onCursorChange?.(value)}
  const triggerRef = useRef(null)
  const restoringFocus = useRef(false)
  const pinRef = useRef(false), hoverTimer = useRef(null)
  const closeDetail = () => {
    clearTimeout(hoverTimer.current)
    pinRef.current = false
    setSelection(null)
    restoringFocus.current = true
    try { triggerRef.current?.focus?.() } finally { restoringFocus.current = false }
  }
  const plotRef = useRef(null)
  const [plotWidth, setPlotWidth] = useState(900)
  useEffect(() => { if (!plotRef.current) return; const observer = new ResizeObserver(entries => setPlotWidth(entries[0].contentRect.width)); observer.observe(plotRef.current); return () => observer.disconnect() }, [])
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const loaderRef = useRef(loadCandles)
  loaderRef.current = loadCandles

  useEffect(() => { cacheRef.current = {}; setSeries(candles || []); setCoverage(priceCoverage); setChartError(null); setRange(defaultRange); setSelection(null); pinRef.current = false; setAllHistory(false) }, [assetKey, defaultRange]) // eslint-disable-line
  useEffect(() => { if (candles) { cacheRef.current[defaultRange] = { candles, ...priceCoverage, checkedAt:Date.now() }; if (range === defaultRange) { setSeries(candles); setCoverage(priceCoverage) } } }, [candles, defaultRange, priceCoverage?.coverage, priceCoverage?.state, priceCoverage?.provenance?.fetchedAt]) // eslint-disable-line
  useEffect(() => { if(previousRequestKey.current!==requestKey){cacheRef.current = {};previousRequestKey.current=requestKey} }, [requestKey])
  useEffect(()=>{
    if(!loadCandles||readOnly||replayAt!=null)return
    const refresh=()=>{if(document.visibilityState==='visible')setRefreshTick(value=>value+1)}
    const timer=setInterval(refresh,60000)
    document.addEventListener('visibilitychange',refresh)
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh)}
  },[!!loadCandles,readOnly,replayAt]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!loaderRef.current) return
    let alive = true
    setChartError(null)
    const cached=cacheRef.current[range]
    if (cached && Date.now()-cached.checkedAt<60000) { setSeries(cached.candles); setCoverage(cached); setTfLoading(false); return }
    setTfLoading(!cached); if(!cached)setCoverage(null)
    Promise.resolve(loaderRef.current(range)).then(c => { if (alive) { const snapshot = {...(Array.isArray(c) ? { candles: c } : { ...c, candles: c?.candles || [] }),checkedAt:Date.now()}; cacheRef.current[range] = snapshot; setSeries(snapshot.candles); setCoverage(snapshot) } })
      .catch(() => { if (alive) { const lastGood=cached&&Date.now()-cached.checkedAt<=15*60000;setSeries(lastGood?cached.candles:[]);setCoverage(lastGood?{...cached,state:'stale'}:null);setChartError(lastGood?'Price history could not be refreshed. Showing the last loaded observations.':'Price history is temporarily unavailable. Choose another period or reload to retry.') } })
      .finally(() => { if (alive) setTfLoading(false) })
    return () => { alive = false }
  }, [range, assetKey, requestKey, refreshTick])
  useEffect(() => { onRangeChange?.(range) }, [range, onRangeChange])
  useEffect(() => { setViewport(null);setRendererFailed(false) }, [assetKey,range])
  useEffect(() => {
    const close = e => { if (e.key === 'Escape') closeDetail() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [])

  const allBars = useMemo(() => normalizeBars((loadCandles ? series : candles || []).slice(-10000)).bars.filter(c => !timeWindow || (c.t >= timeWindow.from && c.t <= timeWindow.to)), [loadCandles,series,candles,timeWindow?.from,timeWindow?.to])
  const replay=replayAt!=null,stops=useMemo(()=>replayStops(allBars,knownOnly),[allBars,knownOnly])
  const replayResult=useMemo(()=>replay?chartReplay(allBars,inputMarkers,replayAt,knownOnly):null,[allBars,inputMarkers,replayAt,knownOnly,replay])
  const workstationBars=replayResult?.bars||allBars,markers=replayResult?.events||inputMarkers,keyLevels=replay?[]:inputKeyLevels,maxDrawdown=replay?null:inputDrawdown
  const layerMarkers=useMemo(()=>projectMarkerLayers(markers,groups),[markers,groups])
  const data=useMemo(()=>workstationBars.map(b=>({t:b.t,price:b.c})),[workstationBars])
  const visibleSelection=selection?.flatMap(selected=>layerMarkers.filter(e=>e.id===selected.id))

  const useWorkstation = workstation && !rendererFailed && workstationBars.length > 1 && !!regularBarGrid(workstationBars,coverage?.chartSource?.intervalMs??undefined)
  const knownTimes = markers.map(m => epochMs(m.t ?? m.occurredAt)).filter(n => n != null)
  const first = (useWorkstation && viewport?.from != null ? viewport.from : null) ?? timeWindow?.from ?? data[0]?.t ?? (knownTimes.length ? Math.min(...knownTimes) : Date.now() - CHART_RANGE_MS[range])
  const last = (useWorkstation && viewport?.to != null ? viewport.to : null) ?? timeWindow?.to ?? data.at(-1)?.t ?? (knownTimes.length ? Math.max(...knownTimes) : Date.now())
  const drawdownFrom = epochMs(maxDrawdown?.fromT), drawdownTo = epochMs(maxDrawdown?.toT)
  const window = useMemo(() => markerWindow(layerMarkers, first, last), [layerMarkers, first, last])
  const openedFocus=useRef(null)
  useEffect(()=>{if(!focusMarkerId){openedFocus.current=null;return}const focusKey=JSON.stringify([focusMarkerId,focusMarkerRequest]);if(openedFocus.current===focusKey)return;const found=window.visible.find(marker=>marker.id===focusMarkerId);if(found){clearTimeout(hoverTimer.current);openedFocus.current=focusKey;pinRef.current=true;triggerRef.current=[...(plotRef.current?.parentElement?.querySelectorAll('button[data-marker-ids]')||[])].find(button=>button.dataset.markerIds.split(' ').includes(found.id));setSelection([found]);onCursorChange?.(found.t)}},[focusMarkerId,focusMarkerRequest,window.visible,onCursorChange])
  const clusters = useMemo(() => clusterMarkers(window.visible, first, Math.max(first + 1, last), plotWidth), [window.visible, first, last, plotWidth])
  const open = (events, event, pin = false) => { clearTimeout(hoverTimer.current); if (restoringFocus.current || (pinRef.current && !pin)) return; pinRef.current = pin; triggerRef.current = event?.currentTarget; setSelection(events); if(pin) { onCursorChange?.(events[0]?.t); onEventSelect?.(events) } }
  const leave = () => { clearTimeout(hoverTimer.current); if (!pinRef.current) hoverTimer.current = setTimeout(() => setSelection(null), 180) }
  const fmt = p => p == null ? '—' : Number(p) < 1 ? `$${Number(p).toPrecision(3)}` : `$${Number(p).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  const intraday = ['1H', '12H', '24H'].includes(range)
  const fmtT = ts => new Date(ts).toLocaleString(undefined, intraday ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' })
  const up = data.length > 1 && data.at(-1).price >= data[0].price
  const color = up ? 'var(--signal-green)' : 'var(--signal-red)'
  const priceAt = ts => {
    // Visual chart anchor only. The execution price is shown solely from the ledger.
    let low = 0, high = data.length - 1
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (data[mid].t <= ts) low = mid; else high = mid - 1 }
    return data[low]?.price
  }
  const renderMarker = (cluster,{cx,cy}) => <g key={cluster.events[0].id} tabIndex={0} role="button" style={{pointerEvents:'all'}} aria-label={`${cluster.events.map(e => e.label || e.action || e.type).join(', ')} · ${date(cluster.t)}`} onMouseEnter={e => open(cluster.events,e)} onMouseLeave={leave} onBlur={leave} onFocus={e => open(cluster.events,e)} onClick={e => open(cluster.events,e,true)} onKeyDown={e => { if(e.key==='Enter'||e.key===' '){e.preventDefault();open(cluster.events,e,true)} }} className="intel-chart-marker"><circle cx={cx} cy={cy} r={14} fill="transparent"/><path d={`M ${cx} ${cy-6} L ${cx+6} ${cy} L ${cx} ${cy+6} L ${cx-6} ${cy} Z`} fill={COLORS[markerGroup(cluster.events[0])]||COLORS.thesis} stroke="var(--bg-1)" strokeWidth={2}/>{cluster.events.length>1&&<text x={cx+9} y={cy-7} fill="var(--fg-1)" fontSize={11}>{cluster.events.length}</text>}</g>

  return <section className="intel-chart" aria-label={t('chart.market_history', { defaultValue: 'Price and personal activity history' })}>
    <div className="intel-chart-toolbar">
      {loadCandles && <div className="intel-range-controls" aria-label={t('chart.time_range', { defaultValue: 'Chart time range' })}>{RANGES.map(r => <button key={r} type="button" aria-pressed={r === range} onClick={() => { setRange(r); setSelection(null) }}>{r}</button>)}</div>}
      {rangeExtra}
      {!replay&&<button className="intel-text-link" type="button" disabled={stops.length<2} onClick={()=>setReplayTime(stops[Math.min(stops.length-1,Math.max(0,Math.floor(stops.length/3)))])}>Replay chart</button>}
      {showDensityToggles && markers.length > 0 && <ResponsiveChartTools label={t('chart.layers', { defaultValue: 'Layers' })}><fieldset className="intel-layer-controls"><legend className="sr-only">{t('chart.layers', { defaultValue: 'Chart layers' })}</legend>{layers.map(([group, label]) => <label key={group}><input type="checkbox" checked={!hiddenGroups.has(group)} onChange={() => setHiddenGroups(s => { const next = new Set(s); next.has(group) ? next.delete(group) : next.add(group); return next })}/>{t(`chart.marker_${group}`, { defaultValue: label })}</label>)}</fieldset></ResponsiveChartTools>}
    </div>
    {replay&&<ChartReplayControls stops={stops} at={replayAt} onTime={setReplayTime} knownOnly={knownOnly} onKnownOnly={value=>{setKnownOnly(value);setSelection(null)}} onExit={()=>{setReplayAt(null);setSelection(null);onReplayChange?.(null);onCursorChange?.(null)}} gaps={replayResult}/>}
    {(tfLoading || loading) && <p role="status" className="intel-event-meta">{t('chart.loading', { defaultValue: 'Loading price history…' })}</p>}
    {chartError && <p role="alert" className="text-[var(--signal-red)]">{chartError}</p>}
    {(coverage?.coverage || coverage?.state) && <details className="intel-chart-coverage intel-event-meta"><summary>{['stale', 'unavailable', 'unsupported', 'refreshing'].includes(coverage.state) ? 'Price coverage needs attention' : 'Price coverage and volume method'}</summary><p>
      {coverage.coverage}{coverage.state === 'stale' ? ' · Delayed data' : ['unavailable', 'unsupported', 'refreshing'].includes(coverage.state) ? ' · Price source unavailable for this period' : ''}
      {coverage.provenance?.fetchedAt && <> · Retrieved <time dateTime={coverage.provenance.fetchedAt}>{date(coverage.provenance.fetchedAt)}</time></>}
    </p></details>}
    <div ref={plotRef} className={`intel-chart-plot${!data.length&&!tfLoading&&!loading?" intel-chart-plot-empty":""}`} style={{minHeight:!data.length&&!tfLoading&&!loading?80:height}}>
      {useWorkstation ? <WorkstationBoundary key={assetKey} onFailure={()=>setRendererFailed(true)}><Suspense fallback={<p role="status">Loading chart controls…</p>}><PriceWorkstation bars={workstationBars} viewKey={`${range}:${requestKey}`} timeWindow={timeWindow ? {from:timeWindow.from,to:replay?Math.min(timeWindow.to,replayAt):timeWindow.to}:null} readOnly={readOnly} seriesCapture={coverage?.capture} replay={replay} knownOnly={knownOnly} chartSource={replay&&coverage?.chartSource?{...coverage.chartSource,observedAt:workstationBars.at(-1)?.t??null}:coverage?.chartSource} height={height} cursorTime={replay?replayAt:cursorTime} onCursorChange={replay?setReplayTime:onCursorChange} persistence={persistence} initialState={workspaceDraft.current} onReplayRestore={state=>{setKnownOnly(state?.knownOnly??false);setReplayTime(state?.at??null)}} onWorkspaceChange={state=>{workspaceDraft.current=state}} visibility={Object.fromEntries(layers.map(([group])=>[group,!hiddenGroups.has(group)]))} onVisibilityChange={state=>setHiddenGroups(new Set(Object.entries(state).filter(([,visible])=>!visible).map(([group])=>group)))} onFailure={()=>setRendererFailed(true)} onViewportChange={v=>setViewport(previous=>previous?.from===v.from&&previous?.to===v.to&&previous?.width===v.width?previous:v)} clusters={clusters} renderMarker={renderMarker} keyLevels={keyLevels} drawdown={drawdownFrom!=null&&drawdownTo!=null?{fromT:drawdownFrom,toT:drawdownTo}:null}/></Suspense></WorkstationBoundary> : data.length > 0 ? <ResponsiveContainer width="100%" height={height}>
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
          {clusters.filter(cluster => data.some(c => c.t === cluster.t)).map(cluster => <ReferenceDot key={cluster.events[0].id} x={cluster.t} y={priceAt(cluster.t)} ifOverflow="hidden" shape={({ cx, cy }) => <g tabIndex={0} role="button" aria-label={`${cluster.events.map(e => e.label || e.action || e.type).join(', ')} · ${date(cluster.t)}`} onMouseEnter={e => open(cluster.events, e)} onMouseLeave={leave} onBlur={leave} onFocus={e => open(cluster.events, e)} onClick={e => open(cluster.events, e, true)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(cluster.events, e, true) } }} className="intel-chart-marker"><circle cx={cx} cy={cy} r={14} fill="transparent"/><path d={`M ${cx} ${cy - 6} L ${cx + 6} ${cy} L ${cx} ${cy + 6} L ${cx - 6} ${cy} Z`} fill={COLORS[markerGroup(cluster.events[0])] || COLORS.thesis} stroke="var(--bg-1)" strokeWidth={2}/>{cluster.events.length > 1 && <text x={cx + 9} y={cy - 7} fill="var(--fg-1)" fontSize={11}>{cluster.events.length}</text>}</g>}/>)}
        </AreaChart>
      </ResponsiveContainer> : <div className="intel-chart-empty">{t('chart.price_period_unavailable', { defaultValue: 'Price observations are unavailable for this period. Recorded activity remains on its own timeline.' })}</div>}
      {visibleSelection?.length>0 && <MarkerDetails events={visibleSelection} onClose={closeDetail} t={t} onMouseEnter={() => clearTimeout(hoverTimer.current)} onMouseLeave={leave}/>}
    </div>
    {!data.length&&window.visible.length>0&&<div className="intel-event-period"><time dateTime={new Date(first).toISOString()}>{date(first)}</time><time dateTime={new Date(last).toISOString()}>{date(last)}</time></div>}
    {window.visible.length > 0 && <div className="intel-event-lane" style={useWorkstation&&viewport?.width?{width:viewport.width,margin:0}:undefined} aria-label={t('chart.activity_timeline', { defaultValue: 'Personal activity timeline' })}>{clusters.map(cluster => <button key={cluster.events[0].id} data-marker-ids={cluster.events.map(event=>event.id).join(' ')} type="button" style={{ left: `${(cluster.t - first) / Math.max(1, last - first) * 100}%`, color: COLORS[markerGroup(cluster.events[0])] }} onMouseEnter={e => open(cluster.events, e)} onMouseLeave={leave} onBlur={leave} onFocus={e => open(cluster.events, e)} onClick={e => open(cluster.events, e, true)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open(cluster.events,e,true)}}} aria-label={`${date(cluster.t)} · ${cluster.events.map(e => e.label || e.type).join(', ')}`}>│<span>{cluster.events.length > 1 ? cluster.events.length : '◆'}</span></button>)}</div>}
    {(markers.length > 0 || historyLoading || historyError) && <div className="intel-chart-history">
      <div className="intel-history-heading"><span>{t('chart.history_count', { count: window.visible.length, defaultValue: '{{count}} events in this period' })}</span><button type="button" onClick={() => setAllHistory(v => !v)} aria-expanded={allHistory}>{allHistory ? t('chart.hide_history', { defaultValue: 'Hide event history' }) : t('chart.show_history', { defaultValue: 'Read event history' })}</button></div>
      {(window.outside.length > 0 || window.undated.length > 0) && <p className="intel-event-meta">{window.outside.length} {t('chart.outside_period', { defaultValue: 'outside this period' })} · {window.undated.length} {t('chart.undated', { defaultValue: 'without a recorded time' })}</p>}
      {historyError && <p role="alert">{historyError}</p>}
      {historyLoading && <p role="status">{t('chart.loading_activity', { defaultValue: 'Loading your activity…' })}</p>}
      {allHistory && <ol className="intel-event-list">{[...window.visible, ...window.outside, ...window.undated].sort((a,b) => (b.t || 0) - (a.t || 0)).map(event => <li key={event.id}><button type="button" onClick={e => open([event], e, true)}><time>{date(event.t)}</time><span>{event.action || event.label || event.type}</span><span className="truncate">{event.title || event.notes || event.note || ''}</span></button></li>)}</ol>}
      {historyHasMore && <button type="button" disabled={historyLoading} className="btn btn--quiet" onClick={onLoadMoreHistory}>{t('chart.more_history', { defaultValue: 'Load more activity' })}</button>}
    </div>}
  </section>
}
export default function TokenChart(props) {return <TokenChartBody key={`${props.assetKey||''}:${props.persistence?.userId||''}:${props.persistence?.orgId||''}`} {...props}/>}
