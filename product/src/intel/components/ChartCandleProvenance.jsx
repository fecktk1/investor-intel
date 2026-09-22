import React from 'react'
import { useTranslation } from 'react-i18next'
import { chartSnapshotProvenance } from '../lib/source-receipt'
import FigureProvenance from './FigureProvenance'

/** Play 1 and 7 for the chart: what answered the candles the chart is drawing.
 *
 * The chart swaps its candles whenever the period changes, so a receipt from the
 * page's first load would describe candles that are no longer on screen. This
 * reads the receipts and envelope of the SNAPSHOT the chart is drawing, and names
 * the period that snapshot was read for, so a receipt can never be taken for
 * another period's candles. While a period with no snapshot yet is loading, the
 * chart passes no snapshot and nothing is drawn. */
export default function ChartCandleProvenance({ snapshot }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const read = chartSnapshotProvenance(snapshot)
  if (!read || (!read.envelope && !read.receipts.length)) return null
  const range = snapshot.range ? (snapshot.range === 'ALL' ? t('chart.range_all', { defaultValue: 'All' }) : snapshot.range) : null
  return (
    <div className="intel-chart-candle-provenance" data-range={snapshot.range || ''}>
      <p className="intel-event-meta">
        {range
          ? t('receipt_state.chart_candles_for', { range, defaultValue: 'Source of the {{range}} candles shown' })
          : t('receipt_state.chart_candles', { defaultValue: 'Source of the candles shown' })}
      </p>
      <FigureProvenance envelope={read.envelope} receipts={read.receipts} />
    </div>
  )
}
