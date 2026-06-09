import React from 'react'
import { useTranslation } from 'react-i18next'

const MAP = {
  high: { key: 'confidence.high', def: 'High confidence', cls: 'chip--ok' },
  medium: { key: 'confidence.medium', def: 'Medium confidence', cls: 'chip--info' },
  low: { key: 'confidence.low', def: 'Low confidence', cls: 'chip--err' },
}

export default function ConfidenceChip({ value }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const m = MAP[value] || MAP.low
  return <span className={`chip ${m.cls}`}>{t(m.key, { defaultValue: m.def })}</span>
}
