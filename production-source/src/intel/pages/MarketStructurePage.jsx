import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Network } from 'lucide-react'
import { IntelPageHeader, IntelPageShell } from '../components/IntelPrimitives'
import CaptureReceipts from '../components/CaptureReceipts'
import RankMap from '../components/RankMap'
import RwaUniverse from '../components/RwaUniverse'
import RwaIssuerLegitimacy from '../components/RwaIssuerLegitimacy'
import RwaYieldProvenance from '../components/RwaYieldProvenance'
import IndexConstituents from '../components/IndexConstituents'
import LiquidationHeat from '../components/LiquidationHeat'
import LiquidationClock from '../components/LiquidationClock'
import ExchangeReserves from '../components/ExchangeReserves'
import VenueShare from '../components/VenueShare'

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

// The capture lanes whose newest run the receipt drawer describes.
const CAPTURE_RECEIPT_LANES = ['rank', 'rwa', 'index', 'liquidations', 'exchange_reserves', 'venue_share']

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
        subtitle={t('structure.subtitle', { defaultValue: 'Rank history, the tokenized real-world asset universe, published index concentration and liquidation heat, read straight from the capture tables. Every figure states its own coverage and says why it is unavailable rather than drawing an empty chart.' })}
      />
      <CaptureReceipts lanes={CAPTURE_RECEIPT_LANES} />
      <RankMap onLoad={seed} />
      <RwaUniverse />
      {/* Identity before economics. A yield figure is only interpretable once
          the reader knows whose instrument it is and whether they may hold it,
          so legitimacy is read first and yield provenance second. Both panels
          own their own read, so neither can blank the other. */}
      <RwaIssuerLegitimacy />
      <RwaYieldProvenance />
      <IndexConstituents />
      <LiquidationHeat ids={liquidationIds} />
      <LiquidationClock ids={liquidationIds} />
      <ExchangeReserves />
      <VenueShare />
    </IntelPageShell>
  )
}
