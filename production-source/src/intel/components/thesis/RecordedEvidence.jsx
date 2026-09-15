import React from 'react'
import { useTranslation } from 'react-i18next'
import SpecialistEvidenceDetails from './SpecialistEvidenceDetails'
const link = value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null } catch { return null } }
export default function RecordedEvidence({ version, fields, specialist, sources = [], omitted = 0 }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!version) return null
  return <details className="text-xs text-[var(--fg-3)]">
    <summary>{t('journal.recordedEvidence', { defaultValue: 'Recorded evidence and sources' })}</summary>
    <p className="break-all">{t('journal.evidenceVersion', { defaultValue: 'Evidence version' })}: {version}</p>
    {fields && <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr>
      <th>{t('journal.metric', { defaultValue: 'Metric' })}</th><th>{t('journal.value', { defaultValue: 'Value' })}</th><th>{t('journal.observed', { defaultValue: 'Observed (UTC)' })}</th><th>{t('journal.source', { defaultValue: 'Source' })}</th>
    </tr></thead><tbody>{Object.entries(fields).map(([key, e]) => <tr key={key}>
      <th scope="row">{key.replaceAll('_', ' ')}</th><td>{e.value ?? '—'} {e.unit}</td>
      <td>{e.as_of || t('journal.unknownTime', { defaultValue: 'Unknown observation time' })}{e.status === 'stale' ? ` · ${t('common.stale', { defaultValue: 'stale' })}` : ''}</td>
      <td>{e.provider || e.source_table || '—'}</td>
    </tr>)}</tbody></table></div>}
    <SpecialistEvidenceDetails specialist={specialist} />
    {!!sources.length && <ol>{sources.map((s, index) => <li key={s.citation_id || `${s.source_table}:${s.source_ref}:${index}`} className="py-2">
      {s.citation_id && <span>[{s.citation_id}] </span>}{link(s.url) ? <a href={link(s.url)} target="_blank" rel="noreferrer">{s.title}</a> : <span>{s.title}</span>}
      <p>{s.summary}</p><p>{s.source_table}: {s.source_ref} · {s.date || t('journal.unknownTime', { defaultValue: 'Unknown observation time' })}</p>
    </li>)}</ol>}
    {omitted > 0 && <p>{omitted} {t('journal.omittedEvidence', { defaultValue: 'records were outside this bounded coach request.' })}</p>}
  </details>
}
