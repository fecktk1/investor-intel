import React, { useEffect, useState } from 'react'
import { InvestigationTable, value } from './InvestigationTable'
import { patternDrawing } from '../../../supabase/functions/_shared/intel/chart-patterns'

export default function ChartPatternPanel({ result, view, source, timezone = 'UTC', onKeep, onInspect, readOnly }) {
  const [selectedId, setSelectedId] = useState(null), [notice, setNotice] = useState(null)
  useEffect(() => { setSelectedId(null); setNotice(null) }, [view])
  useEffect(() => { if(result&&!result.patterns.some(row=>row.id===selectedId))setSelectedId(null) }, [result]) // eslint-disable-line react-hooks/exhaustive-deps
  const selected = result?.patterns.find(row => row.id === selectedId)
  const time = t => t == null ? 'Unavailable' : new Date(t).toLocaleString(undefined, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'medium' })
  if (!result) return null
  const save = drawing => { try { if (onKeep?.(drawing) === false) throw Error('The annotation could not be added. Check the drawing limit and retry.'); setNotice('Annotation added. Save the layout to keep this read across visits.') } catch (e) { setNotice(e.message) } }
  const writable = !readOnly && !!onKeep
  const { impulse, profile, week } = result
  const keepReference = (label, price, t, definition) => save({ id: crypto.randomUUID(), tool: 'text', anchors: [{ t, price }], text: `${label}. ${result.version}. Source: ${String(source).slice(0, 120)}. ${definition}`, color: '#DFA647', width: 1 })
  return <section aria-label="Pattern and distribution read">
    <p className="intel-analysis-caption">{result.bars} completed bars · heuristic observations</p>
    {view === 'patterns' && <>
      {!result.patterns.length ? <p>No shape meets the declared pattern criteria in these bars.</p> : <InvestigationTable rows={[...result.patterns].reverse()} pageSize={6} columns={[
        ['Candidate', row => <button type="button" className="intel-text-link" aria-pressed={selectedId === row.id} onClick={() => { setSelectedId(row.id); setNotice(null); onInspect?.(row) }}>{row.label}</button>], ['Confirmed', row => time(row.confirmedAt)], ['Reference price', row => value(row.price)],
      ]} />}
      {selected && <div className="intel-structure-evidence" aria-label="Selected pattern evidence"><h4>{selected.label}</h4><p>{selected.definition}</p><p>Inputs captured by {time(selected.knownAt)}. A reference line is not an execution price.</p><InvestigationTable caption="Confirmed pattern pivots" rows={selected.members} pageSize={6} columns={[
        ['Pivot', row => row.kind], ['Price', row => value(row.price)], ['Source bar', row => time(row.t)], ['Confirmed', row => time(row.confirmedAt)],
      ]} />{writable && <button type="button" className="btn" onClick={() => { try { save(patternDrawing(selected, crypto.randomUUID(), source)) } catch (e) { setNotice(e.message) } }}>Keep pattern annotation</button>}</div>}
    </>}
    {view === 'impulse' && (!impulse ? <p>No confirmed opposing swing pair spans at least 2 × current ATR(14). More history or a different pivot window may be needed.</p> : <>
      <p>{impulse.direction} reference swing · confirmed {time(impulse.confirmedAt)} · inputs captured by {time(impulse.knownAt)}.</p><p>{impulse.definition}</p>
      <InvestigationTable rows={impulse.levels} pageSize={10} columns={[
        ['Retracement ratio', row => value(row.ratio)], ['Price', row => <button type="button" className="intel-text-link" onClick={() => onInspect?.({ price: row.price, confirmedAt: impulse.confirmedAt, label: `Swing reference ${row.ratio}` })}>{value(row.price)}</button>],
      ]} />
      {writable && <button type="button" className="btn" onClick={() => save({ id: crypto.randomUUID(), tool: 'fibonacci', anchors: impulse.anchors, ratios: impulse.levels.map(row => row.ratio), text: `${result.version}. ${impulse.direction} reference swing. Confirmed ${new Date(impulse.confirmedAt).toISOString()}. Source: ${String(source).slice(0, 120)}. ${impulse.definition}`, color: '#DFA647', width: 1 })}>Keep Fibonacci drawing</button>}
    </>)}
    {view === 'profile' && <>
      <p>{profile.method}</p>{profile.reason ? <p>{profile.reason}</p> : <>
        <p>Period volume: {value(profile.total)} {profile.unit === 'USD' ? 'USD' : 'asset units'} · largest bin {value(profile.poc.low)}–{value(profile.poc.high)} · contiguous value area {value(profile.valueArea.low)}–{value(profile.valueArea.high)} ({value(profile.valueArea.fraction * 100)}%).</p>
        <div className="intel-volume-profile" role="img" aria-label="Approximate volume by price range; exact values follow in the table">{[...profile.bins].reverse().map(bin => <div key={bin.id}><span>{value(bin.low)}–{value(bin.high)}</span><i style={{ width: `${bin.volume / profile.poc.volume * 100}%` }} /><span>{value(bin.fraction * 100)}%</span></div>)}</div>
        <details className="intel-chart-readings"><summary>Inspect all volume bins</summary><InvestigationTable caption="Approximate period volume by price" rows={profile.bins} pageSize={10} columns={[
          ['Price range', row => `${value(row.low)}–${value(row.high)}`], ['Allocated volume', row => value(row.volume)], ['Share', row => `${value(row.fraction * 100)}%`],
        ]} /></details>
        {writable && week && <button type="button" className="btn" onClick={() => keepReference('Approximate volume profile', profile.poc.price, week.to, `POC bin ${profile.poc.low}–${profile.poc.high}; value area ${profile.valueArea.low}–${profile.valueArea.high}; ${profile.total} ${profile.unit} period volume across ${result.bars} loaded bars. ${profile.method}`)}>Keep profile annotation</button>}
      </>}
    </>}
    {view === 'week' && (!week ? <p>No completed OHLC bars are available for a weekly description.</p> : <>
      <p>{week.partial ? 'Partial current week' : 'Current week to date'} · through {week.day} UTC · {week.bars} loaded bars.</p><p>{week.definition}</p>
      <dl className="intel-week-read"><div><dt>Observed period</dt><dd>{time(week.from)}–{time(week.to)}</dd></div><div><dt>Open-to-close change</dt><dd>{value(week.bodyPct)}%</dd></div><div><dt>Combined wick / range</dt><dd>{week.wickFraction == null ? 'Unavailable for a flat range' : `${value(week.wickFraction * 100)}%`}</dd></div><div><dt>Inputs captured by</dt><dd>{time(week.knownAt)}</dd></div></dl>
      {writable && <button type="button" className="btn" onClick={() => keepReference('Weekly candle description', week.price, week.to, `${week.partial ? 'Partial week' : 'Week to date'} from ${new Date(week.from).toISOString()} through ${new Date(week.to).toISOString()}. Open-to-close ${week.bodyPct}%; wick/range ${week.wickFraction ?? 'unavailable'}. ${week.definition}`)}>Keep weekly annotation</button>}
    </>)}
    <details className="intel-chart-readings"><summary>Pattern and distribution method</summary><p>{result.version} · {result.reason}</p></details>
    {notice && <p role="status">{notice}</p>}
  </section>
}
