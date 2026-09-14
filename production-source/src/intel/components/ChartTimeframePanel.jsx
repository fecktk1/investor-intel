import React, { useEffect, useRef, useState } from 'react'
import { InvestigationTable, value } from './InvestigationTable'

export default function ChartTimeframePanel({ result, timezone = 'UTC', source, onKeep, readOnly }) {
  const [selectedId, setSelectedId] = useState(null), [notice, setNotice] = useState(null)
  const previousAt=useRef(null)
  useEffect(() => { if(!result)return;const at=Math.max(...result.rows.map(row=>row.at??-Infinity));if(at<previousAt.current||!result.rows.some(row=>row.id===selectedId))setSelectedId(null);previousAt.current=at }, [result]) // eslint-disable-line react-hooks/exhaustive-deps
  const selected = result?.rows.find(row => row.id === selectedId)
  const time = t => t == null ? 'Unavailable' : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone })
  const keep = () => {
    try {
      const text = `${result.version} · ${selected.label} · ${selected.state}. Completed ${new Date(selected.at).toISOString()}. Close ${selected.lastClose??'unavailable'}; DEMA(43) ${selected.dema??'unavailable'}; RSI(14) ${selected.rsi??'unavailable'}; ATR(14) ${selected.atr??'unavailable'}; UTC VWAP ${selected.vwap??'unavailable'}. Inputs captured ${selected.knownAt==null?'unknown':new Date(selected.knownAt).toISOString()}. Source: ${String(source).slice(0,120)}. ${selected.criteria} ${selected.gaps.join(' ').slice(0,300)}`
      if (onKeep({ id: crypto.randomUUID(), tool: 'text', anchors: [{ t: selected.sourceTime, price: selected.lastClose }], text, color: '#DFA647', width: 1 }) === false) throw Error('The annotation could not be added. Check the drawing limit and retry.')
      setNotice('Annotation added. Save the layout to keep this timeframe read.')
    } catch (error) { setNotice(error.message) }
  }
  if (!result) return null
  return <section aria-label="Timeframe alignment" className="intel-timeframe-alignment">
    <p>{result.agreement} · {result.covered} of {result.rows.length} timeframes have enough history for both trend and momentum.</p>
    <InvestigationTable rows={result.rows} pageSize={4} columns={[
      ['Timeframe', r => <button className="intel-text-link" aria-pressed={selectedId === r.id} onClick={() => { setSelectedId(r.id); setNotice(null) }}>{r.label}</button>],
      ['Last completed', r => time(r.at)], ['Trend', r => r.trend], ['RSI (14)', r => value(r.rsi)], ['Stretch / ATR', r => value(r.stretchAtr)], ['Alignment', r => r.state],
    ]} />
    {selected && <div className="intel-structure-evidence" aria-label="Selected timeframe evidence">
      <h4>{selected.label} · {selected.state}</h4><details><summary>Agreement criteria</summary><p>{selected.criteria}</p></details>
      <dl>{[['Completed bars', selected.bars], ['Last close', value(selected.lastClose)], ['DEMA (43)', value(selected.dema)], ['UTC-session VWAP', value(selected.vwap)], ['VWAP state', selected.vwapState], ['ATR (14)', value(selected.atr)], ['Inputs captured by', time(selected.knownAt)]].map(([label, reading]) => <div key={label}><dt>{label}</dt><dd>{reading}</dd></div>)}</dl>
      {selected.gaps.length > 0 && <ul>{selected.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
      {!readOnly && onKeep && selected.lastClose != null && selected.sourceTime != null && <button type="button" className="btn" onClick={keep}>Keep timeframe annotation</button>}
    </div>}
    <details className="intel-chart-readings"><summary>Alignment method</summary><p>{result.version} · {result.reason}</p></details>
    {notice && <p role="status">{notice}</p>}
  </section>
}
