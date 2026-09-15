import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Network } from 'lucide-react'
import { IntelPageHeader, IntelPageShell } from '../components/IntelPrimitives'
import RankMap from '../components/RankMap'
import RwaUniverse from '../components/RwaUniverse'
import IndexConstituents from '../components/IndexConstituents'
import LiquidationHeat from '../components/LiquidationHeat'

// /intel/structure — the four figures the CMC capture tables support on their
// own: where the top names sit week to week, what the tokenized universe is made
// of, how concentrated the published indexes are, and where leverage was
// liquidated.
//
// Each figure owns its own read, so one undeployed view degrades to its own
// stated reason instead of blanking the page. The one thing shared across
// figures is the top-of-market selection: the rank map already resolves the
// largest assets by market cap, so its latest week seeds the liquidation ids
// rather than a hardcoded id list.
const TOP_ASSETS = 5

// Latest captured week, rank 1 first. A series with no points is not a rank.
function topProviderIds(payload, max = TOP_ASSETS) {
  const rows = (Array.isArray(payload?.series) ? payload.series : [])
    .map(row => {
      const points = (Array.isArray(row?.points) ? row.points : [])
        .map(point => ({ at: Date.parse(point?.date), rank: Number(point?.rank) }))
        .filter(point => Number.isFinite(point.at) && Number.isFinite(point.rank))
        .sort((a, b) => a.at - b.at)
      return { providerId: row?.providerId ?? null, rank: points.at(-1)?.rank ?? null }
    })
    .filter(row => row.providerId != null && row.rank != null)
    .sort((a, b) => a.rank - b.rank)
  return rows.slice(0, max).map(row => row.providerId)
}

export default function MarketStructurePage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [liquidationIds, setLiquidationIds] = useState([])

  const seed = payload => {
    const next = topProviderIds(payload)
    setLiquidationIds(prev => (prev.join(',') === next.join(',') ? prev : next))
  }

  return (
    <IntelPageShell>
      <IntelPageHeader
        icon={Network}
        eyebrow={t('structure.eyebrow', { defaultValue: 'Market structure' })}
        title={t('structure.title', { defaultValue: 'Structure figures' })}
        subtitle={t('structure.subtitle', { defaultValue: 'Rank history, the tokenized real-world asset universe, published index concentration and liquidation heat — read straight from the capture tables. Every figure states its own coverage and says why it is unavailable rather than drawing an empty chart.' })}
      />
      <RankMap onLoad={seed} />
      <RwaUniverse />
      <IndexConstituents />
      <LiquidationHeat ids={liquidationIds} />
    </IntelPageShell>
  )
}
