import React from 'react'
import {stressSensitivity} from '../../../supabase/functions/_shared/intel/investigation-calculations'
import {value} from './InvestigationTable'
export default function StressSensitivity({row}) {
  const curve=row&&stressSensitivity(row)
  if(!curve)return null
  const x=v=>90+(v-curve.from)/(curve.to-curve.from)*490
  return <figure className="intel-stress-sensitivity"><figcaption>Threshold sensitivity · {row.rule.label||row.rule.metric}</figcaption><p className="intel-analysis-caption">Each point tests one hypothetical {curve.unit} value against your condition. This is not a forecast or probability. Select another condition above to inspect it.</p><svg viewBox="0 0 640 175" role="img" aria-label={`Condition ${row.rule.comparator} ${row.rule.threshold} ${curve.unit}; current ${row.current??'unknown'}, scenario ${row.hypothetical??'unknown'}`}><text x="4" y="44">Met</text><text x="4" y="109">Not met</text><line x1="90" x2="580" y1="140" y2="140"/><line x1={x(curve.threshold)} x2={x(curve.threshold)} y1="20" y2="140" strokeDasharray="3 3"/>{curve.points.map((p,i)=><circle key={i} cx={x(p.value)} cy={p.met?40:105} r="3" fill={p.met?'var(--signal-green)':'var(--fg-4)'}><title>{value(p.value)} {curve.unit}: {p.met?'Met':'Not met'}</title></circle>)}<text x="90" y="162">{value(curve.from)} {curve.unit}</text><text x="580" y="162" textAnchor="end">{value(curve.to)} {curve.unit}</text><text x={x(curve.threshold)} y="14" textAnchor="middle">Threshold {value(curve.threshold)}</text>{row.hypothetical!=null&&<circle cx={x(row.hypothetical)} cy={row.scenarioMet?40:105} r="7" fill="none" stroke="var(--accent)" strokeWidth="2"/>}</svg></figure>
}
