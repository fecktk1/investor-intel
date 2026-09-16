import React from 'react'
import { useTranslation } from 'react-i18next'
import { wilsonInterval, percentText } from '../../lib/rate-interval'

// The interval and sample that belong beside a quoted rate. Renders nothing when
// there is no sample: a rate over zero records is not a rate. A reference rate,
// when one exists, is printed with the label the caller gives it, so a neutral
// reference can never be mistaken for a measured base rate.
export default function RateInterval({ successes, n, reference = null, referenceLabel = null, className = 'intel-analysis-caption' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const interval = wilsonInterval(successes, n)
  if (!interval) return null
  const low = percentText(interval.low), high = percentText(interval.high)
  return (
    <span className={className}>
      {t('rates.interval', { low, high, n: interval.n, defaultValue: '95% interval {{low}} to {{high}}, n = {{n}}' })}
      {interval.small ? ` ${t('rates.small_sample', { defaultValue: '(small sample)' })}` : ''}
      {reference != null && referenceLabel ? ` · ${t('rates.reference', { label: referenceLabel, rate: percentText(reference), defaultValue: '{{label}}: {{rate}}' })}` : ''}
    </span>
  )
}
