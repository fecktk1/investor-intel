// What the asset chart says about a series built from STORED prices
// (supabase/functions/_shared/intel/stored-candles.ts, `storedSeries`).
//
// Pure: returns the sentences as translation keys with English defaults and
// their values, so the chart renders them in the reader's language and a test
// can read them without an i18n instance. Every sentence states a fact the
// series carries; none is decoration.

import { chartProviderLabel, chartProvidersLabel } from './chart-source-label'

const WIDTHS = {
  '1M': '1 minute', '5M': '5 minutes', '15M': '15 minutes', '30M': '30 minutes',
  '1H': '1 hour', '4H': '4 hours', '1D': '1 day', '1W': '1 week',
}

/** A width key as words, in the reader's language. */
export function storedWidthWords(t, width) {
  return t(`chart.width_${width}`, { defaultValue: WIDTHS[width] || width })
}

/** "2 min", "6 h", "1 d": the typical spacing between stored prices. */
export function storedSpacingWords(t, seconds) {
  const s = Number(seconds)
  if (!(s > 0)) return null
  if (s < 3600) return t('chart.spacing_minutes', { count: Math.max(1, Math.round(s / 60)), defaultValue: '{{count}} min' })
  if (s < 86400) return t('chart.spacing_hours', { count: Math.round(s / 3600), defaultValue: '{{count}} h' })
  return t('chart.spacing_days', { count: Math.round(s / 86400), defaultValue: '{{count}} d' })
}

/**
 * The caption lines for one stored series, or [] for anything else.
 *   t       i18next t (or a test double that returns the default).
 *   series  the response's storedSeries.
 *   now     for "stored prices begin <date>".
 */
export function storedSeriesCaption(t, series, { formatDate = d => d.toLocaleDateString() } = {}) {
  if (!series || series.version !== 1) return []
  const lines = []
  const provider = chartProviderLabel(series.quoteProvider) || series.quoteProvider
  const width = storedWidthWords(t, series.interval)
  if (series.mode === 'quotes') {
    const spacing = storedSpacingWords(t, series.spacingSeconds)
    lines.push(spacing
      ? t('chart.stored_quotes', { width, provider, count: series.prices, spacing, defaultValue: 'Each candle covers {{width}} and is built from stored {{provider}} quotes, about one every {{spacing}} ({{count}} in this chart).' })
      : t('chart.stored_quotes_few', { width, provider, count: series.prices, defaultValue: 'Each candle covers {{width}} and is built from stored {{provider}} quotes ({{count}} in this chart).' }))
    lines.push(t('chart.stored_high_low', { defaultValue: 'Highs and lows are those of the stored quotes, not of every trade.' }))
    if (series.singles > 0) lines.push(t('chart.stored_singles', { count: series.singles, total: series.bars, defaultValue: 'Candles built from a single stored price are drawn flat: {{count}} of {{total}}.' }))
  } else {
    const days = series.days || {}
    if (days.archive > 0) lines.push(t('chart.stored_daily_archive', { count: days.archive, providers: chartProvidersLabel((days.archiveProviders || []).join('+')) || '', defaultValue: 'Daily candles from the stored archive ({{providers}}): {{count}}.' }))
    if (days.backfill > 0) lines.push(t('chart.stored_daily_backfill', { count: days.backfill, defaultValue: 'Daily closes from the CoinMarketCap OHLCV backfill: {{count}}.' }))
    if (days.quotes > 0) {
      lines.push(t('chart.stored_daily_quotes', { count: days.quotes, provider, defaultValue: 'Days built from stored {{provider}} quotes: {{count}}.' }))
      lines.push(t('chart.stored_high_low', { defaultValue: 'Highs and lows are those of the stored quotes, not of every trade.' }))
    }
    if (series.mode === 'weekly') lines.push(t('chart.stored_weekly', { defaultValue: 'Each candle is one complete week of those days.' }))
    if (series.closesOnly > 0) lines.push(t('chart.stored_line', { defaultValue: 'Some days hold a close only, so the chart draws a line of closes.' }))
  }
  if (series.substituted) {
    if (series.reason === 'daily_reaches_further') lines.push(t('chart.stored_daily_further', { defaultValue: 'Stored intraday prices begin late in this period, so it is drawn from daily rows that reach further back.' }))
    else if (series.reason === 'bar_ceiling') lines.push(t('chart.stored_ceiling', { requested: storedWidthWords(t, series.requestedInterval), width, defaultValue: 'Candles of {{requested}} would be too many for this period, so each candle here covers {{width}}.' }))
    else lines.push(t('chart.stored_coarser', { requested: storedWidthWords(t, series.requestedInterval), width, defaultValue: 'Candles of {{requested}} would hold less than one stored price each, so each candle here covers {{width}}.' }))
  }
  if (!series.reachesStart && series.firstAt) {
    const first = new Date(series.firstAt)
    if (!Number.isNaN(first.getTime())) lines.push(t('chart.stored_reach', { date: formatDate(first), defaultValue: 'Stored prices begin {{date}}, inside this period.' }))
  }
  lines.push(t('chart.stored_gaps', { defaultValue: 'A period with nothing stored is left empty. Read from stored data; no provider was asked.' }))
  return lines
}
