import React from 'react'
import { useTranslation } from 'react-i18next'

// Retail-friendly market-signal chip. Bullish/Bearish/Caution/Neutral only —
// never advice. Caution introduces a new amber state (no chip--warn class exists,
// so we use the amber utility used elsewhere in Intel, e.g. RegimeBanner).
const MAP = {
  bullish: { cls: 'chip--ok', def: 'Bullish' },
  bearish: { cls: 'chip--err', def: 'Bearish' },
  caution: { cls: 'text-amber-400', def: 'Caution' },
  neutral: { cls: '', def: 'Neutral' },
}

export default function MarketSignalBadge({ direction, size }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const key = MAP[direction] ? direction : 'neutral'
  const m = MAP[key]
  const sz = size === 'sm' ? 'text-[9px]' : 'text-[10px]'
  return <span className={`chip ${sz} ${m.cls}`}>{t(`market.signal.${key}`, { defaultValue: m.def })}</span>
}
