import React from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { formatDataTime } from '../lib/as-of'
import { providerLabel } from '../lib/source-receipt'

// Observation and capture times in the one format (../lib/as-of.js): UTC and its age.
const time = v => formatDataTime(v, { language: i18next.language })

/** The plain, always-visible source line for a section whose figures do not come
 * through a receipt envelope. It is the small twin of FigureProvenance: one
 * sentence naming the source that produced the figures and the clock they carry.
 *
 * `source` is a provider or store id and goes through `providerLabel`, so a
 * provider stays a proper noun and a generic store is described in the reader's
 * language. An unknown or missing source says so in words rather than drawing
 * nothing or guessing a provider: a figure with no stated source is a fact a
 * reader is entitled to.
 *
 * `observedAt` is when the source observed the figure, `capturedAt` when we wrote
 * it down. They are different facts, so both render when both are known. A figure
 * with neither says that too.
 *
 * `scopeKey` optionally appends the `figure_scope.<key>` sentence saying what the
 * figure does NOT mean, the same key space FigureProvenance and SourceCallReceipt
 * already use. */
export default function FigureSourceLine({ source = null, observedAt = null, capturedAt = null, scopeKey = null, ourCalculation = false, inputs = null, className = '' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const cls = `intel-analysis-caption intel-figure-source ${className}`.trim()
  // A figure WE work out is labelled as our calculation and names its inputs and
  // the time it was computed, which is a different claim from a provider reading
  // and must never be dressed as one.
  if (ourCalculation) {
    const computed = time(capturedAt ?? observedAt)
    const parts = [t('figure_source.our_calculation', { inputs: inputs || t('figure_source.recorded_inputs', { defaultValue: 'figures we already recorded' }), defaultValue: 'Our calculation from {{inputs}}' })]
    parts.push(computed
      ? t('figure_source.computed', { date: computed, defaultValue: 'computed {{date}}' })
      : t('figure_source.no_time', { defaultValue: 'no observation time was reported' }))
    return <p className={cls} data-source="our-calculation">{parts.join(' · ')}</p>
  }
  if (!source) {
    return <p className={cls} data-source="unreported">{t('figure_source.unknown', { defaultValue: 'The source of this figure was not reported.' })}</p>
  }
  const observed = time(observedAt)
  const captured = time(capturedAt)
  const parts = [t('figure_source.line', { source: providerLabel(source, t), defaultValue: 'Source: {{source}}' })]
  if (observed) parts.push(t('figure_source.observed', { date: observed, defaultValue: 'observed {{date}}' }))
  if (captured && captured !== observed) parts.push(t('figure_source.captured', { date: captured, defaultValue: 'captured {{date}}' }))
  if (!observed && !captured) parts.push(t('figure_source.no_time', { defaultValue: 'no observation time was reported' }))
  const scope = scopeKey ? t(`figure_scope.${scopeKey}`, { defaultValue: '' }) : null
  return (
    <p className={cls} data-source={source}>
      {parts.join(' · ')}
      {scope ? ` · ${scope}` : ''}
    </p>
  )
}
