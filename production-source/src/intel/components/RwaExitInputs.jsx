import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_HAIRCUT_PCT, DEFAULT_PARTICIPATION_PCT, DEFAULT_POSITION_USD, PARTICIPATION_PRESETS, daysLabel, parseInput,
} from '../lib/rwa-exit-capacity'

// The exit simulator's input bar, shared by the depth board and the asset page's
// tokenised-asset block. Inputs are kept as the TEXT the reader typed and parsed
// on use, so clearing a field reads as "no input" and never as zero.
//
// House visual language: labelled inline fields (`intel-inline-field` with
// `input` / `select`, as in RwaTerms.jsx). No pills, chips or segmented buttons:
// the participation presets are a select with a "Custom" entry.

export const initialExitForm = () => ({
  position: String(DEFAULT_POSITION_USD), preset: String(DEFAULT_PARTICIPATION_PCT), custom: '', haircut: String(DEFAULT_HAIRCUT_PCT),
})

/** The form, as the numbers `rowExitScenarios` takes (percent as typed). An
 * empty haircut is no haircut; an empty position or participation stays null
 * and the estimate says so. */
export function exitInputs(form) {
  return {
    positionUsd: parseInput(form?.position),
    participationPct: form?.preset === 'custom' ? parseInput(form?.custom) : parseInput(form?.preset),
    haircutPct: parseInput(form?.haircut) ?? 0,
  }
}

const STATE_REASONS = {
  state_no_pool_on_read_chains: ['rwa_exit.reason_state_no_pool', 'No pool on the chains read'],
  state_issuer_redemption_only: ['rwa_exit.reason_state_redemption', 'Issuer redemption only'],
  state_chain_not_covered: ['rwa_exit.reason_state_not_covered', 'Chain not covered'],
  state_no_deployment_known: ['rwa_exit.reason_state_no_deployment', 'No contract resolved'],
  state_provider_unavailable: ['rwa_exit.reason_state_unavailable', 'Pool read failed'],
  state_budget_deferred: ['rwa_exit.reason_state_pending', 'Not read yet'],
}

const REASONS = {
  invalid_position: ['rwa_exit.reason_invalid_position', 'Enter a position above zero'],
  invalid_participation: ['rwa_exit.reason_invalid_participation', 'Participation must be above 0 and at most 100%'],
  invalid_haircut: ['rwa_exit.reason_invalid_haircut', 'The haircut must be from 0 to below 100%'],
  volume_not_reported: ['rwa_exit.reason_volume_not_reported', 'No 24-hour volume reported'],
  no_reported_trading: ['rwa_exit.reason_no_reported_trading', 'No trading reported in 24 hours'],
  counter_legs_unclassified: ['rwa_exit.reason_unclassified', 'Captured before pool sides were recorded'],
  only_unrecognised_pools: ['rwa_exit.reason_only_unrecognised', 'Only pools we cannot value'],
  no_recognised_pool_size: ['rwa_exit.reason_no_pool_size', 'No recognised pool reported a size'],
  // Why the all-venue volume join found nothing for a token.
  no_provider_id: ['rwa_exit.reason_no_provider_id', 'No CoinMarketCap id'],
  not_in_recent_wrapper_capture: ['rwa_exit.reason_not_in_capture', 'Not in the last 48 hours of RWA quotes'],
  wrapper_read_failed: ['rwa_exit.reason_volume_read_failed', 'The volume read failed'],
}

/** A reason code as words. Unknown depth states keep their code visible. */
export function exitReasonText(reason, t) {
  if (!reason) return null
  const known = REASONS[reason] || STATE_REASONS[reason]
  if (known) return t(known[0], { defaultValue: known[1] })
  if (String(reason).startsWith('state_')) {
    return t('rwa_exit.reason_state_other', { state: String(reason).slice(6), defaultValue: 'No pool reading ({{state}})' })
  }
  return String(reason)
}

/** "12.3 days", or the reason there is no figure. Never "0 days". */
export function daysText(estimate, t, reasonOverride = null) {
  if (estimate?.days != null && !estimate.unavailable) {
    return t('rwa_exit.days_value', { days: daysLabel(estimate.days), defaultValue: '{{days}} days' })
  }
  return exitReasonText(reasonOverride || estimate?.unavailable, t)
}

export default function RwaExitInputs({ form, onChange, idPrefix = 'rwa-exit' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const set = (key, value) => onChange({ ...form, [key]: value })
  return (
    <div className="flex flex-wrap items-end gap-4 text-[12px]" role="group" aria-label={t('rwa_exit.inputs_label', { defaultValue: 'Exit simulator inputs' })}>
      <label className="intel-inline-field" htmlFor={`${idPrefix}-position`}>
        {t('rwa_exit.position_label', { defaultValue: 'Position (USD)' })}
        <input id={`${idPrefix}-position`} className="input" type="number" min="0" step="any" inputMode="decimal"
          value={form.position} onChange={e => set('position', e.target.value)} />
      </label>
      <label className="intel-inline-field" htmlFor={`${idPrefix}-participation`}>
        {t('rwa_exit.participation_label', { defaultValue: 'Share of daily volume' })}
        <select id={`${idPrefix}-participation`} className="select" value={form.preset} onChange={e => set('preset', e.target.value)}>
          {PARTICIPATION_PRESETS.map(pct => (
            <option key={pct} value={String(pct)}>{t('rwa_exit.participation_option', { pct, defaultValue: '{{pct}}%' })}</option>
          ))}
          <option value="custom">{t('rwa_exit.participation_custom', { defaultValue: 'Custom' })}</option>
        </select>
      </label>
      {form.preset === 'custom' && (
        <label className="intel-inline-field" htmlFor={`${idPrefix}-custom`}>
          {t('rwa_exit.participation_custom_label', { defaultValue: 'Custom share (%)' })}
          <input id={`${idPrefix}-custom`} className="input" type="number" min="0" max="100" step="any" inputMode="decimal"
            value={form.custom} onChange={e => set('custom', e.target.value)} />
        </label>
      )}
      <label className="intel-inline-field" htmlFor={`${idPrefix}-haircut`}>
        {t('rwa_exit.haircut_label', { defaultValue: 'Stress haircut on volume and pools (%)' })}
        <input id={`${idPrefix}-haircut`} className="input" type="number" min="0" max="99" step="any" inputMode="decimal"
          value={form.haircut} onChange={e => set('haircut', e.target.value)} />
      </label>
    </div>
  )
}
