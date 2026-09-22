import React, { useEffect, useState } from 'react'
import { InvestigationTable, value } from './InvestigationTable'
import { chartReadDrawing, explainChartLevel } from '../../../supabase/functions/_shared/intel/chart-read'

const displayCondition=text=>String(text||'').replace(/-?\d+\.\d{5,}/g,raw=>Number(raw).toLocaleString(undefined,{maximumSignificantDigits:12}))
export default function ChartReadPanel({ result, readingMode, onReadingModeChange, source = 'Source unavailable', timezone = 'UTC', onInspect, onKeep, readOnly }) {
  const [localMode,setLocalMode] = useState('neutral'), [studyId, setStudyId] = useState(null), [levelId, setLevelId] = useState(null), [notice, setNotice] = useState(null)
  const mode=readingMode??localMode,setMode=onReadingModeChange??setLocalMode
  useEffect(() => { if(!result)return;if(!result.studies.some(s=>s.id===studyId))setStudyId(null);if(!result.levels.some(l=>l.id===levelId))setLevelId(null) }, [result]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!result) return null
  const time = t => t == null ? 'Unavailable' : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone })
  const selected = result.studies.find(s => s.id === studyId), level = result.levels.find(l => l.id === levelId), scenario = result.scenarios.find(s => s.id === mode)
  const save = () => { try { if (onKeep?.(chartReadDrawing(result, crypto.randomUUID(), mode, source)) === false) throw Error('The annotation could not be added. Check the drawing limit and retry.'); setNotice('Chart read added. Save the layout or include this selected note in a permitted snapshot.') } catch (error) { setNotice(error.message) } }
  return <section aria-label="Annotated chart research">
    <div className="intel-investigation-analysis-heading"><label>Reading<select value={mode} onChange={e => { setMode(e.target.value); setNotice(null) }}><option value="neutral">Neutral overview</option><option value="bull">Bull case</option><option value="base">Range case</option><option value="bear">Bear case</option></select></label>{result.last && <p>Completed {time(result.last.closedAt)} · close {value(result.last.c)}</p>}</div>
    <p className="intel-analysis-caption">{result.version} · {result.reason}</p>
    {scenario && <div className="intel-structure-evidence" aria-label="Selected chart scenario"><h4>{scenario.label}</h4><p title={scenario.criterion}>{displayCondition(scenario.criterion)}</p><p title={scenario.invalidationText}><strong>Condition ends:</strong> {displayCondition(scenario.invalidationText)}</p><p className="intel-analysis-caption">{scenario.caveat}</p></div>}
    {result.levels.length > 0 && <div className="intel-read-evidence-links" role="group" aria-label="Scenario source levels">{result.levels.map(row => <button type="button" className="intel-text-link" key={row.id} aria-pressed={levelId === row.id} onClick={() => { setLevelId(row.id); setStudyId(null); onInspect?.(row) }}>{row.label} {value(row.lower)}–{value(row.upper)} · explain level</button>)}</div>}
    {level && result.last && <div className="intel-structure-evidence" aria-label="Level explanation"><h4>{level.label}</h4><p>{explainChartLevel(level, result.last, source)}</p><p>Inputs captured by {time(level.knownAt)}.</p><InvestigationTable rows={level.confirmations} pageSize={5} columns={[
      ['Source pivot', row => time(row.t)], ['Price', row => value(row.price)], ['Confirmed', row => time(row.confirmedAt)], ['Window', row => `${row.window} bars each side`],
    ]} /></div>}
    <InvestigationTable rows={result.studies} pageSize={7} caption="Indicator evidence at the completed close" columns={[
      ['Indicator', row => <button type="button" className="intel-text-link" aria-pressed={studyId === row.id} onClick={() => { setStudyId(row.id); setLevelId(null); onInspect?.(null) }}>{row.label}</button>],
      ['Reading', row => row.readings.map(r => `${r.label}: ${value(r.value)}`).join(' · ') || 'Unavailable'], ['Coverage', row => row.reason || `${row.bars} continuous bars; warmup ${row.warmup}`],
    ]} />
    {selected && <div className="intel-structure-evidence" aria-label="Indicator method evidence"><h4>{selected.label}</h4><p>{selected.definition}</p><p>{selected.warmup} observations needed. {selected.reason || 'Values use the completed bars at this read time.'}</p><details className="intel-chart-readings"><summary>Inspect recent calculated values</summary>{selected.readings.map(row => <InvestigationTable key={row.label} caption={row.label} rows={row.points.map(p => ({ ...p, id: String(p.t) }))} pageSize={10} columns={[
      ['Source bar', r => time(r.t)], ['Calculated value', r => value(r.value)],
    ]} />)}</details></div>}
    <p className="intel-analysis-caption">Source: {source} · inputs captured by {time(result.knownAt)}. Level explanations are generated from the displayed formula and source evidence; they make no language-model or provider request.</p>
    {!readOnly && onKeep && result.last && (mode === 'neutral' || scenario?.available) && <button type="button" className="btn" onClick={save}>Keep annotated read</button>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
