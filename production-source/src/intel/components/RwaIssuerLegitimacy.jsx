import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import TokenAvatar from './TokenAvatar'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable } from '../lib/capture-api'
import { formatUsd, formatCompact } from '../lib/market-format'
import DemoNotInSnapshot, { isDemoMissReason } from '../demo/DemoNotInSnapshot'

// RWA issuer legitimacy, admission reality and holder concentration.
//
// A common answer to "can I legally invest in this?" is a hand-curated
// registry. This board answers from primary sources, and its most important
// rows are the ones a curated registry cannot have:
//
//   * ADMISSION DRIFT. Terms that changed and the date they changed by. Probed
//     2026-09-16, one fund moved its minimum investment from 0 to 100,000 and
//     dropped an exemption, then filed again under a different name.
//   * DELIBERATE NON-MAPPINGS. Issuers we looked up and refused to map, with
//     the probe that stopped us. "We do not know" is a publishable answer; a
//     wrong legal entity is not.
//
// Four rules this file may never soften:
//   1. A RISK SIGNAL IS A POINTER. A lapsed registration or a sanctions name
//      match is rendered with its scope string and its source link, never
//      alone, never as a rating and never as advice.
//   2. NOTHING HERE IS A PERSON. Addresses and legal entities only. No name, no
//      owner, no clustering.
//   3. A VALID ZERO IS A ZERO. A top-one share of 0 prints as 0, not as a dash.
//   4. A FAILURE STATES ITS REASON. An unavailable source never renders as an
//      empty list.
//
// House visual language: no pills and no cards. Eyebrows, hairlines and
// underline rails, matching RwaUniverse.jsx and the evidence tables in
// ContractResearchWorkspace.jsx.

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** A share of 0 is a measurement. Only null is unknown. */
export const shareLabel = value => (num(value) == null ? '—' : `${num(value).toFixed(2)}%`)

/** A filing's stated minimum. 0 is a real term and must not print as a dash. */
export const minimumLabel = value => (num(value) == null ? '—' : formatUsd(num(value)))

const rule = 'border-b border-[var(--border-default)]'
const cell = `${rule} py-2 pr-3 align-top`

/** Rows for the drift table, newest change first. */
export function driftRows(subjects = []) {
  return subjects.flatMap(subject =>
    (Array.isArray(subject?.admission?.termDrift) ? subject.admission.termDrift : [])
      .map(drift => ({ ...drift, subjectLabel: subject.subjectLabel, subject: subject.subject })))
    .sort((a, b) => String(b.changedBy ?? '').localeCompare(String(a.changedBy ?? '')))
}

/** The daily capture times (UTC) the read view serves, with the times the
 * migration schedules as a fallback for an older payload. */
export function captureTimes(schedule) {
  return {
    registryTime: schedule?.rwa_issuer_registry?.utc || '02:19',
    concentrationTime: schedule?.rwa_token_concentration?.utc || '02:53',
  }
}

/** Nothing captured for any subject yet. A board that has captured nothing
 * says so and says when it will fill, rather than showing empty sections.
 * Only an explicit `captured: false` from the read view counts, so a payload
 * that predates the field is never mislabelled as empty. */
export function boardNotCaptured(payload) {
  const subjects = Array.isArray(payload?.subjects) ? payload.subjects : []
  return !payload?.asOf && subjects.length > 0 && subjects.every(subject => subject?.captured === false)
}

/** A review instant as a readable UTC minute. */
const utcMinute = value => {
  const text = String(value || '')
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? `${text.slice(0, 10)} ${text.slice(11, 16)} UTC` : text
}

function Scope({ children }) {
  return <p className="text-[11px] leading-relaxed text-[var(--fg-4)] mt-1 max-w-[75ch]">{children}</p>
}

export default function RwaIssuerLegitimacy() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's own
  // authenticated client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('rwa_issuer_legitimacy', {}, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase])

  const payload = read.payload || {}
  const subjects = useMemo(() => (Array.isArray(payload.subjects) ? payload.subjects : []), [payload])
  const unmapped = Array.isArray(payload.unmapped) ? payload.unmapped : []
  const drift = useMemo(() => driftRows(subjects), [subjects])
  // When the capture lanes run, as the read view reports them. An empty board
  // says when it fills instead of rendering as blank.
  const times = captureTimes(payload.schedule)
  const nothingCaptured = boardNotCaptured(payload)

  return (
    <section className="intel-rwa-issuer space-y-6" aria-label={t('rwa_issuer.title', { defaultValue: 'Issuer legitimacy and admission reality' })}>
      <div>
        <div className="eyebrow">{t('rwa_issuer.eyebrow', { defaultValue: 'Primary sources' })}</div>
        <h3 className="text-lg font-medium mt-1">{t('rwa_issuer.title', { defaultValue: 'Issuer legitimacy and admission reality' })}</h3>
        <Scope>{t('rwa_issuer.intro', { defaultValue: 'Read from public registers rather than a curated list: the Global LEI Foundation, SEC EDGAR filings, the OFAC sanctions publication, verified contract source and a block explorer. Each figure keeps its own source link and the date it was read. Nothing here establishes your eligibility to invest, and nothing here is advice.' })}</Scope>
      </div>

      {read.status === 'loading' && <p role="status">{t('rwa_issuer.loading', { defaultValue: 'Reading primary sources…' })}</p>}

      {read.status === 'unavailable' && (
        isDemoMissReason(read.reason) ? <p role="status"><DemoNotInSnapshot /></p> : <p role="alert">{t('rwa_issuer.unavailable', { reason: read.reason || 'unknown', defaultValue: 'The issuer legitimacy board could not be read ({{reason}}). Nothing is asserted about any issuer.' })}</p>
      )}

      {read.status === 'ready' && (
        <>
          {payload.reason && (
            <p role="status" className="text-[12px]">
              {t('rwa_issuer.partial', { reason: payload.reason, defaultValue: 'Some sources did not answer ({{reason}}). What did load is shown; nothing was replaced with a zero.' })}
            </p>
          )}

          {payload.review?.lapsed && (
            <p role="status" className="text-[12px]">{t('rwa_issuer.review_expired', { defaultValue: 'An identity assertion on this board was explicitly withdrawn. It is shown as recorded and is not used to claim a current identity.' })}</p>
          )}

          {nothingCaptured && (
            <p role="status" className="text-[12px]">
              {t('rwa_issuer.not_captured', { ...times, defaultValue: 'Nothing has been captured from the primary sources yet. Filings and register records are read daily at {{registryTime}} UTC, and holder concentration and contract restrictions daily at {{concentrationTime}} UTC. The identities and refusals below come from the dated alias map and do not wait for a capture.' })}
            </p>
          )}

          {/* Admission drift: the row a curated registry structurally cannot hold. */}
          <div>
            <div className="eyebrow">{t('rwa_issuer.drift_eyebrow', { defaultValue: 'Admission drift' })}</div>
            <Scope>{t('rwa_issuer.drift_intro', { defaultValue: 'Terms that changed between two filings by the same filer, and the date of the later filing. The change happened at or before that date, not necessarily on it. A change in how much has been sold is reported separately and is not an admission term.' })}</Scope>
            {drift.length === 0 ? (
              <p className="text-[12px] mt-2">{t('rwa_issuer.drift_none', { defaultValue: 'No admission term change has been recorded across the filings read so far.' })}</p>
            ) : (
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr>
                      <th scope="col" className={`${rule} text-left font-normal py-2 pr-3`}>{t('rwa_issuer.col_token', { defaultValue: 'Token' })}</th>
                      <th scope="col" className={`${rule} text-left font-normal py-2 pr-3`}>{t('rwa_issuer.col_term', { defaultValue: 'Term' })}</th>
                      <th scope="col" className={`${rule} text-left font-normal py-2 pr-3`}>{t('rwa_issuer.col_from', { defaultValue: 'Was' })}</th>
                      <th scope="col" className={`${rule} text-left font-normal py-2 pr-3`}>{t('rwa_issuer.col_to', { defaultValue: 'Became' })}</th>
                      {/* "Changed on or before", never "changed by whom". The date
                          is the LATER filing's, and the change happened at or
                          before it. The earlier "Changed by" label could be read
                          as naming an agent in English, while every translation
                          read it as a deadline, so the key now states which
                          meaning is intended and the ambiguity cannot recur. */}
                      <th scope="col" className={`${rule} text-left font-normal py-2 pr-3`}>{t('rwa_issuer.col_changed_on_or_before', { defaultValue: 'Changed on or before' })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drift.map(row => (
                      <tr key={`${row.subject}:${row.fromAccession}:${row.field}`}>
                        <th scope="row" className={`${cell} text-left font-normal`}>{row.subjectLabel}</th>
                        <td className={cell}>{t(`rwa_issuer.field_${row.field}`, { defaultValue: row.field })}</td>
                        <td className={cell}>{row.from}</td>
                        <td className={cell}>{row.to}</td>
                        <td className={cell}>{row.changedBy || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* One block per mapped subject. */}
          {subjects.map(subject => (
            <div key={subject.subject} className="pt-4 border-t border-[var(--border-default)]">
              {/* The picture is matched on this subject's own contract address,
                  carried down by the read. Never on the symbol: these are exactly
                  the tickers that collide, so a symbol match would put another
                  asset's logo on an issuer identity. */}
              <div className="eyebrow flex items-center gap-2">
                <TokenAvatar src={subject.imageUrl} fallbackSrc={subject.imageSourceUrl} symbol={subject.subjectLabel} size="sm" />
                <span>{subject.subjectLabel}</span>
              </div>
              {subject.legalFactsWithheld ? (
                // THE GUARD: an explicitly withdrawn assertion shows no fact
                // about a legal person until a new review restates it. Time
                // alone never puts a subject in this branch.
                <p role="status" className="text-[13px] mt-1">
                  {t('rwa_issuer.identity_withheld', { lapsedAt: utcMinute(subject.identity?.lapsedAt), defaultValue: 'This identity assertion was withdrawn on {{lapsedAt}}. Until a new review restates it, no legal name, jurisdiction, registration status, sanctions comparison or admission terms are shown for it.' })}
                </p>
              ) : (
                <p className="text-[13px] mt-1">{subject.identity?.legalName}</p>
              )}
              {!nothingCaptured && subject.captured === false && (
                <p role="status" className="text-[12px] mt-1">
                  {t('rwa_issuer.subject_not_captured', { ...times, defaultValue: 'Not captured yet. Filings and the register record are read daily at {{registryTime}} UTC, holders and the contract daily at {{concentrationTime}} UTC.' })}
                </p>
              )}
              <Scope>
                {t('rwa_issuer.identity_basis', {
                  basis: t(`rwa_issuer.basis_${subject.identity?.basis}`, { defaultValue: subject.identity?.basis || 'unrecorded' }),
                  assertedAt: String(subject.identity?.assertedAt || '').slice(0, 10),
                  defaultValue: 'Identity asserted on {{assertedAt}} by comparing {{basis}}. An issuer is mapped only by an explicit dated assertion, never by name similarity.',
                })}
                {subject.identity?.sourceUrl && (
                  <> <a className="intel-text-link" href={subject.identity.sourceUrl} target="_blank" rel="noreferrer">{t('rwa_issuer.open_register', { defaultValue: 'Open the register' })}</a></>
                )}
              </Scope>

              {/* Current admission terms. A stated zero minimum stays zero. */}
              {subject.admission?.current && (
                <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-4 text-[12px] mt-3">
                  <div className={`${rule} py-2`}>
                    <dt className="text-[var(--fg-4)]">{t('rwa_issuer.minimum', { defaultValue: 'Minimum investment' })}</dt>
                    <dd className="intel-number">{minimumLabel(subject.admission.current.minimumInvestmentAccepted)}</dd>
                  </div>
                  <div className={`${rule} py-2`}>
                    <dt className="text-[var(--fg-4)]">{t('rwa_issuer.exemptions', { defaultValue: 'Claimed exemptions' })}</dt>
                    <dd>{(subject.admission.current.federalExemptions || []).join(', ') || '—'}</dd>
                  </div>
                  <div className={`${rule} py-2`}>
                    <dt className="text-[var(--fg-4)]">{t('rwa_issuer.non_accredited', { defaultValue: 'Non-accredited accepted' })}</dt>
                    <dd>{subject.admission.current.hasNonAccreditedInvestors == null ? '—' : subject.admission.current.hasNonAccreditedInvestors ? t('rwa_issuer.yes', { defaultValue: 'Yes' }) : t('rwa_issuer.no', { defaultValue: 'No' })}</dd>
                  </div>
                  <div className={`${rule} py-2`}>
                    <dt className="text-[var(--fg-4)]">{t('rwa_issuer.jurisdiction', { defaultValue: 'Jurisdiction' })}</dt>
                    <dd>{subject.admission.current.jurisdictionOfInc || subject.identity?.jurisdiction || '—'}</dd>
                  </div>
                </dl>
              )}
              {subject.admission?.current && (
                <Scope>{t('rwa_issuer.admission_scope', { filingDate: subject.admission.current.filingDate || '—', defaultValue: 'These are the terms of the most recent filing read, dated {{filingDate}}. They describe what the filer stated, not whether you may invest, and they may already have changed.' })}</Scope>
              )}

              {/* Holder concentration. A zero share renders as zero. */}
              {subject.concentration && (
                <div className="mt-3">
                  <div className="eyebrow">{t('rwa_issuer.concentration_eyebrow', { defaultValue: 'Holder concentration' })}</div>
                  <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-4 text-[12px] mt-1">
                    <div className={`${rule} py-2`}>
                      <dt className="text-[var(--fg-4)]">{t('rwa_issuer.holders', { defaultValue: 'Holder addresses' })}</dt>
                      <dd className="intel-number">{subject.concentration.holdersCount == null ? '—' : formatCompact(subject.concentration.holdersCount)}</dd>
                    </div>
                    {(subject.concentration.tiers || []).map(tier => (
                      <div key={tier.topN} className={`${rule} py-2`}>
                        <dt className="text-[var(--fg-4)]">{t('rwa_issuer.top_n', { count: tier.topN, defaultValue: 'Top {{count}} share' })}</dt>
                        <dd className="intel-number">{shareLabel(tier.share)}</dd>
                      </div>
                    ))}
                  </dl>
                  <Scope>{subject.concentration.scope}</Scope>
                </div>
              )}

              {/* Transfer restrictions read from verified contract source. */}
              {subject.restrictions && (
                <div className="mt-3">
                  <div className="eyebrow">{t('rwa_issuer.restrictions_eyebrow', { defaultValue: 'Transfer restrictions in the contract source' })}</div>
                  <p className="text-[12px] mt-1">
                    {t(`rwa_issuer.restriction_state_${subject.restrictions.state}`, { defaultValue: subject.restrictions.state })}
                    {subject.restrictions.state === 'restricted' && (
                      <>
                        {': '}
                        {[
                          subject.restrictions.kycGated && t('rwa_issuer.kyc_gated', { defaultValue: 'requires an identity registry' }),
                          subject.restrictions.pausable && t('rwa_issuer.pausable', { defaultValue: 'transfers can be paused' }),
                          subject.restrictions.freezable && t('rwa_issuer.freezable', { defaultValue: 'a holder can be frozen' }),
                        ].filter(Boolean).join(', ')}
                      </>
                    )}
                  </p>
                  {subject.restrictions.matchedMembers?.length > 0 && (
                    <p className="text-[11px] text-[var(--fg-4)] mt-1 font-mono break-all">{subject.restrictions.matchedMembers.join(' · ')}</p>
                  )}
                  <Scope>{subject.restrictions.scope}</Scope>
                </div>
              )}

              {/* Risk signals. Never rendered without their scope and source. */}
              {(subject.signals || []).length > 0 && (
                <div className="mt-3">
                  <div className="eyebrow">{t('rwa_issuer.signals_eyebrow', { defaultValue: 'Register pointers' })}</div>
                  {subject.signals.map(signal => (
                    <div key={signal.type} className={`${rule} py-2`}>
                      <p className="text-[12px]">
                        {t(`rwa_issuer.signal_${signal.type}`, { defaultValue: signal.type })}
                        {': '}
                        <strong className="font-normal">{t(`rwa_issuer.level_${signal.level}`, { defaultValue: signal.level })}</strong>
                        {signal.status ? ` (${signal.status})` : ''}
                        {' '}
                        <a className="intel-text-link" href={signal.sourceUrl} target="_blank" rel="noreferrer">{t('rwa_issuer.open_source', { defaultValue: 'Open the source' })}</a>
                      </p>
                      <Scope>{signal.scope}</Scope>
                    </div>
                  ))}
                </div>
              )}

              {/* Name collisions: surfaced for review, never joined to a token. */}
              {(subject.collisions || []).map(collision => (
                <div key={collision.stem} className="mt-3">
                  <div className="eyebrow">{t('rwa_issuer.collision_eyebrow', { defaultValue: 'Similar names needing review' })}</div>
                  <ul className="text-[12px] mt-1">
                    {collision.entities.map(entity => (
                      <li key={entity.lei} className={`${rule} py-2`}>
                        <a className="intel-text-link" href={entity.sourceUrl} target="_blank" rel="noreferrer">{entity.legalName}</a>
                        {' · '}{entity.jurisdiction}
                        {' · '}{t(`rwa_issuer.registration_${String(entity.registrationStatus || '').toLowerCase()}`, { defaultValue: entity.registrationStatus || '—' })}
                      </li>
                    ))}
                  </ul>
                  <Scope>{collision.note}</Scope>
                </div>
              ))}
            </div>
          ))}

          {/* Deliberate non-mappings. A finding, not an absence. */}
          <div className="pt-4 border-t border-[var(--border-default)]">
            <div className="eyebrow">{t('rwa_issuer.unmapped_eyebrow', { defaultValue: 'Issuers we refused to map' })}</div>
            <Scope>{t('rwa_issuer.unmapped_intro', { defaultValue: 'Each of these was looked up in a public register and deliberately left unmapped, because the sources did not support an identity. The probe that stopped the mapping is recorded so it can be re-run. An unmapped issuer is not a missing feature; a wrong legal entity would be a defect.' })}</Scope>
            {unmapped.length === 0 ? (
              <p className="text-[12px] mt-2">{t('rwa_issuer.unmapped_none', { defaultValue: 'No deliberate non-mapping has been recorded.' })}</p>
            ) : (
              <ul className="mt-2">
                {unmapped.map(record => (
                  <li key={record.subject} className={`${rule} py-2`}>
                    <p className="text-[12px]">
                      <strong className="font-normal">{record.subjectLabel}</strong>
                      {' · '}
                      {t(`rwa_issuer.unmapped_${record.reason}`, { defaultValue: record.reason })}
                    </p>
                    <Scope>{record.evidence}</Scope>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* The figures come from the primary registers named in the intro. The
              only other source on this board is the token picture, so it gets its
              own quiet line rather than being folded into the register scope. */}
          <p className="text-[11px] text-[var(--fg-4)]">
            {t('rwa_issuer.image_attribution', { defaultValue: 'Token images from our CoinGecko-sourced catalogue, matched on the contract address. A subject with no catalogue row is drawn as initials.' })}
          </p>
        </>
      )}
    </section>
  )
}
