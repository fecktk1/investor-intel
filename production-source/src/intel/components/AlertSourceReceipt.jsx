import React from 'react'
const time=t=>t&&Number.isFinite(Date.parse(t))?new Date(t).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'}):'Not supplied'
export function alertValueLabel(payload){const value=Number(payload.value);if(payload.value==null||!Number.isFinite(value))return 'Unavailable';const unit=payload.unit||(/_usd$/.test(payload.metric||'')?'USD':/_pct$/.test(payload.metric||'')?'%':'');return unit.toUpperCase()==='USD'?`$${value.toLocaleString(undefined,{maximumFractionDigits:8})}`:`${value.toLocaleString(undefined,{maximumFractionDigits:8})}${unit==='%'?'%':unit?` ${unit}`:''}`}
export default function AlertSourceReceipt({payload={}}){
 const c=payload.checkpoint||{},o=c.observation||{},config=payload.config||c.config||{}
 return <details className="intel-alert-source-receipt"><summary>Original condition and source receipt</summary>
  <p>Rule revision {payload.rule_revision??c.rule_revision??'Not recorded'} · {config.condition?.replaceAll?.('_',' ')||payload.trigger_type?.replaceAll('_',' ')||'Recorded condition'}</p>
  <blockquote className="whitespace-pre-wrap break-words">{(config.note??c.condition?.description)||'No original note was recorded.'}</blockquote>
  {(o.sourceMetric||/^(venue|depth|liquidation):/.test(c.condition?.source_metric||''))&&<p className="break-all">Matched source: {o.sourceMetric||'Not recorded in this receipt'}</p>}
  <dl className="intel-event-facts"><dt>Source observed</dt><dd>{time(o.observedAt||payload.source_observed_at)}</dd><dt>Known to Investor Intel</dt><dd>{time(o.recordedAt||payload.known_at)}</dd>{c.calculated_at&&<><dt>Narrative calculated</dt><dd>{time(c.calculated_at)}</dd></>}<dt>Evaluated</dt><dd>{time(c.checkedAt||payload.evaluated_at)}</dd><dt>Source</dt><dd className="break-all">{o.provider||payload.source_system||'Not supplied'} · {o.sourceRef||payload.provider_source_ref||payload.source_ref||'Reference unavailable'}</dd></dl>
  <p className="intel-analysis-caption">{c.comparison_basis} {o.coverage||payload.coverage||c.coverage}</p>
 </details>
}
