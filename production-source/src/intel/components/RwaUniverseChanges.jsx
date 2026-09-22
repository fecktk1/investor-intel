import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'

// What changed in the tokenised universe between daily snapshots: assets listed,
// removed, that became tradeable, or that were shelved.
//
// Reads the `rwa_universe_changes` capture view. Until two snapshots exist the
// view answers `comparable: false`, and this says so rather than showing an empty
// "no changes" table. An asset the provider did not return on a day never
// produces a removal or a shelving (the lane refuses to), so every row here is an
// observed change.
//
// No pills, no cards: dated hairline tables, one per kind of change.

export const CHANGE_KINDS = ['listed', 'removed', 'became_tradeable', 'shelved']
export const CHANGE_LABELS = {
  listed: 'Listed',
  removed: 'Removed',
  became_tradeable: 'Became tradeable',
  shelved: 'Shelved (no longer trading)',
}
export const COVERAGE_STATE_LABELS = {
  tradeable: 'Reported trading',
  priced_not_traded: 'Priced, no reported trading',
  listed_only: 'Listed, no price',
  no_tokens_reported: 'No tokens reported',
}
const DAY_CHOICES = [7, 30]

const rule = 'border-b border-[var(--border-default)]'
const cell = `${rule} py-2 pr-3 align-top`

export default function RwaUniverseChanges() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [days, setDays] = useState(7)
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('rwa_universe_changes', { days }, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase, days])

  const payload = read.payload || {}
  const groups = payload.groups && typeof payload.groups === 'object' ? payload.groups : {}
  const kindLabel = kind => t(`rwa_changes.kind_${kind}`, { defaultValue: CHANGE_LABELS[kind] || kind })
  const stateLabel = state => (state ? t(`rwa_changes.state_${state}`, { defaultValue: COVERAGE_STATE_LABELS[state] || state }) : '')
  const total = CHANGE_KINDS.reduce((sum, kind) => sum + (Array.isArray(groups[kind]) ? groups[kind].length : 0), 0)

  return (
    <section className="intel-rwa-changes space-y-4" aria-label={t('rwa_changes.title', { defaultValue: 'Changes in the tokenised universe' })}>
      <div>
        <div className="eyebrow">{t('rwa_changes.eyebrow', { defaultValue: 'Recorded daily' })}</div>
        <h3 className="text-lg font-medium mt-1">{t('rwa_changes.title', { defaultValue: 'Changes in the tokenised universe' })}</h3>
        <div className="text-[12px] mt-1" role="group" aria-label={t('rwa_changes.window', { defaultValue: 'Window' })}>
          {DAY_CHOICES.map((choice, index) => (
            <React.Fragment key={choice}>
              {index > 0 && <span className="text-[var(--fg-4)]"> · </span>}
              <button
                type="button"
                className={choice === days ? 'underline underline-offset-4' : 'text-[var(--fg-4)] hover:underline'}
                aria-pressed={choice === days}
                onClick={() => setDays(choice)}
              >
                {t('rwa_changes.days', { count: choice, defaultValue: 'Last {{count}} days' })}
              </button>
            </React.Fragment>
          ))}
        </div>
      </div>

      {read.status === 'loading' && <p role="status">{t('rwa_changes.loading', { defaultValue: 'Reading the recorded changes…' })}</p>}

      {read.status === 'unavailable' && (
        <p role="alert">
          {t('rwa_changes.unavailable', { reason: captureReasonText(t, read.reason), defaultValue: 'Changes could not be read. {{reason}}' })}
        </p>
      )}

      {read.status === 'ready' && payload.reason && (
        <p role="status" className="text-[12px]">
          {t('rwa_changes.partial', { reason: payload.reason, defaultValue: 'Part of this read did not answer ({{reason}}). What did load is shown.' })}
        </p>
      )}

      {read.status === 'ready' && payload.comparable === false && (
        <p role="status" className="text-[12px]">
          {t('rwa_changes.not_comparable', { defaultValue: 'Changes need two daily snapshots to compare. Until the second one is recorded there is nothing to compare, which is not the same as nothing changing.' })}
        </p>
      )}

      {read.status === 'ready' && payload.comparable === true && total === 0 && (
        <p role="status" className="text-[12px]">
          {t('rwa_changes.none', { count: payload.days ?? days, defaultValue: 'No asset was listed, removed, became tradeable or was shelved in the last {{count}} days.' })}
        </p>
      )}

      {read.status === 'ready' && payload.comparable === true && CHANGE_KINDS.map(kind => {
        const rows = Array.isArray(groups[kind]) ? groups[kind] : []
        if (!rows.length) return null
        return (
          <div key={kind}>
            <table className="w-full text-[12px]">
              <caption className="text-left text-[13px] font-medium pb-1">
                {t('rwa_changes.group_caption', { label: kindLabel(kind), count: rows.length, defaultValue: '{{label}}: {{count}}' })}
              </caption>
              <thead>
                <tr className="text-left text-[var(--fg-4)]">
                  <th scope="col" className={cell}>{t('rwa_changes.col_date', { defaultValue: 'Date' })}</th>
                  <th scope="col" className={cell}>{t('rwa_changes.col_asset', { defaultValue: 'Asset' })}</th>
                  <th scope="col" className={cell}>{t('rwa_changes.col_type', { defaultValue: 'Type' })}</th>
                  <th scope="col" className={cell}>{t('rwa_changes.col_from', { defaultValue: 'Before' })}</th>
                  <th scope="col" className={cell}>{t('rwa_changes.col_to', { defaultValue: 'After' })}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={`${row.snapshotDate}:${row.rwaId}:${row.kind}`}>
                    <td className={cell}>{row.snapshotDate}</td>
                    <th scope="row" className={`${cell} font-normal`}>
                      <span className="font-medium">{row.symbol || row.rwaId}</span>
                      {row.name && <span className="text-[var(--fg-4)]"> {row.name}</span>}
                    </th>
                    <td className={cell}>{row.assetType || ''}</td>
                    <td className={cell}>{stateLabel(row.fromState)}</td>
                    <td className={cell}>{stateLabel(row.toState)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}

      {read.status === 'ready' && payload.comparable === true && (
        <p className="text-[11px] text-[var(--fg-4)] max-w-[80ch]">
          {t('rwa_changes.note', { defaultValue: 'Compared day to day from CoinMarketCap RWA quotes. An asset is only called removed when the provider\'s own full asset list stopped carrying it, and an asset the provider did not answer for on a day is never counted as removed or shelved.' })}
        </p>
      )}
    </section>
  )
}
