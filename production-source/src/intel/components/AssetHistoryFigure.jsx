import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { useScreenParams } from '../lib/useScreenParams'
import { LineArea, RadialGauge } from '../charts'
import { readAssetHistory } from '../lib/markets-api'
import { formatPct, formatPrice, formatUsd } from '../lib/market-format'

// Price history for one asset, read only when a reader asks for it, and the risk
// measures derived from exactly the points that were loaded.
//
// Nothing here is fetched on mount. One range is one provider sampling, charged
// once against the shared credit budget, so the cost of each range is printed
// beside it and the reader spends it deliberately. The figure then states which
// window it describes: a 90-day drawdown is not the asset's worst drawdown, only
// the worst one inside this window.

// Range → the provider cost of a live refresh of that range, and the window it
// covers. The costs come from the history plan (ceil(points / 100)); a cache hit
// costs nothing, which is why the label says what a refresh costs rather than
// what this click will cost.
export const HISTORY_RANGES = [
  { key: '1y', credits: 4, days: 365 },
  { key: '90d', credits: 1, days: 90 },
  { key: '30d', credits: 8, days: 30 },
  { key: '7d', credits: 2, days: 7 },
  { key: '48h', credits: 6, days: 2 },
]
const RANGE_KEYS = HISTORY_RANGES.map(range => range.key)
// The three gauges share one row until a gauge can no longer be read, then drop
// to two and finally to one column. This row's only layout rule, so it is
// declared here rather than in the shared stylesheet.
const GAUGE_ROW = { display: 'grid', gap: '1rem 2.5rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))', alignItems: 'start' }
const RANGE_LABELS = { '1y': '1 year', '90d': '90 days', '30d': '30 days', '7d': '7 days', '48h': '48 hours' }
const INTERVAL_LABELS = { daily: 'Daily', hourly: 'Hourly', '5m': 'Five-minute' }
const STATE_LABELS = { fresh: 'Fresh', stale: 'Stale', unavailable: 'Unavailable' }

// English source text for every reason the history read can answer with, kept
// beside the component so a reason the backend adds tomorrow still reads as
// something before its translation lands. An unknown code is shown as the code.
const REASON_LABELS = {
  no_coinmarketcap_listing: 'CoinMarketCap does not list this asset, so it has no price history here. For a pasted contract, the price history is the pool chart above.',
  no_history_points: 'The provider returned no observations for this asset in this window.',
  invalid_history_range: 'That is not a range this reader can request.',
  rate_limited: 'The provider rate limit for this window has been reached.',
  budget_exceeded: 'The shared provider budget for this period is spent.',
  insufficient_entitlement: 'The current provider plan does not retain history this far back.',
  credential_unavailable: 'No provider credential is configured for this read.',
  provider_unavailable: 'The provider did not answer this request.',
  refreshing: 'This window is being refreshed. Ask again in a moment.',
  history_unavailable: 'The history read could not be completed.',
  ambiguous_asset: 'This symbol identifies more than one asset, so no single history could be read.',
  identity_unavailable: 'The asset identity could not be resolved for a history read.',
  asset_not_found: 'No catalogue asset matches this identity.',
  invalid_provider: 'That provider cannot serve price history.',
}

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// Intraday ranges carry a clock; daily ranges do not. Formatting a five-minute
// series as bare dates would collapse 576 observations onto two labels.
const pointTime = (value, interval) => {
  const n = num(value)
  if (n == null) return '—'
  const date = new Date(n)
  if (Number.isNaN(date.getTime())) return '—'
  return interval === 'daily'
    ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function AssetHistoryFigure({ sourceProvider, providerId, symbol }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [params, setParams] = useScreenParams('h_', { range: '' })
  const [requested, setRequested] = useState(null)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)

  const selected = RANGE_KEYS.includes(params.range) ? params.range : null
  const plan = HISTORY_RANGES.find(range => range.key === (requested || selected)) || HISTORY_RANGES[1]

  useEffect(() => {
    if (!requested || !org?.id) return undefined
    let alive = true
    const controller = new AbortController()
    setLoading(true)
    ;(async () => {
      const payload = await readAssetHistory(supabase, { orgId: org.id, symbol, sourceProvider, providerId, range: requested, signal: controller.signal })
      if (!alive) return
      setResult(payload)
      setLoading(false)
    })()
    return () => { alive = false; controller.abort() }
  }, [requested, org?.id, supabase, symbol, sourceProvider, providerId])

  const ask = range => { setRequested(range); setParams({ range }) }

  const reasonText = reason => (reason
    ? t(`asset_history.reason_${reason}`, { defaultValue: REASON_LABELS[reason] || reason })
    : t('charts.no_reason', { defaultValue: 'No reason was reported.' }))

  const history = result?.history || null
  const metrics = result?.metrics || null
  const points = Array.isArray(history?.points) ? history.points : []
  const interval = history?.interval || null
  const unavailable = history ? history.state === 'unavailable' : false

  const drawdown = metrics?.maxDrawdown || null
  const fromHigh = metrics?.distanceFromHigh || null
  const volatility = metrics?.volatility30d || null
  const underWater = num(metrics?.timeUnderWaterDays)

  // A measure a reader can see on the chart but not in a gauge needs its own
  // reason: "not enough points" is a different answer from "no history".
  const metricReason = t('asset_history.metric_unavailable', { defaultValue: 'Fewer than three usable points were loaded for this window, so this measure was not computed.' })

  const caption = history && !unavailable
    ? [
      t('asset_history.caption_interval', { defaultValue: 'Interval: {{interval}}', interval: t(`asset_history.interval_${interval}`, { defaultValue: INTERVAL_LABELS[interval] || interval || '—' }) }),
      t('asset_history.caption_observed', { defaultValue: 'Newest point: {{observedAt}}', observedAt: history.observedAt ? new Date(history.observedAt).toLocaleString() : '—' }),
      t('asset_history.caption_state', { defaultValue: 'State: {{state}}', state: t(`asset_history.state_${history.state}`, { defaultValue: STATE_LABELS[history.state] || history.state }) }),
      t('asset_history.caption_source', { defaultValue: 'Source: {{source}}', source: history.source || '—' }),
    ].join(' · ')
    : t('asset_history.figure_sub', { defaultValue: 'Price over the chosen window, with reported volume as the faint band along the bottom. The shaded span is the deepest decline inside this window.' })

  const volatilityMax = Math.max(100, Math.ceil((num(volatility?.pct) ?? 0) / 50) * 50)
  const daysMax = Math.max(1, plan.days)

  return (
    <section className="intel-asset-history space-y-3" aria-label={t('asset_history.heading', { defaultValue: 'Price history and derived risk' })}>
      <div className="eyebrow">{t('asset_history.heading', { defaultValue: 'Price history and derived risk' })}</div>

      <div className="intel-investigation-controls" role="group" aria-label={t('asset_history.range_group', { defaultValue: 'History range' })}>
        {HISTORY_RANGES.map(range => (
          <button
            key={range.key}
            type="button"
            className="intel-text-link"
            aria-pressed={(requested || selected) === range.key}
            onClick={() => ask(range.key)}
          >
            {t(`asset_history.range_${range.key}`, { defaultValue: RANGE_LABELS[range.key] })}
            {' · '}
            {range.credits === 1
              ? t('asset_history.range_cost_one', { defaultValue: '1 credit' })
              : t('asset_history.range_cost', { defaultValue: '{{credits}} credits', credits: range.credits })}
          </button>
        ))}
      </div>

      <p className="intel-analysis-caption" role="status">
        {loading
          ? t('asset_history.loading', { defaultValue: 'Reading price history…' })
          : requested
            ? t('asset_history.budget_note', { defaultValue: 'Each range is sampled once and then shared. The cost beside a range is what a live refresh of that range spends from the shared provider budget; a cached window costs nothing.' })
            : t('asset_history.prompt', { defaultValue: 'Price history is read only when you ask for it. Choose a range above — the cost beside each one is what a live refresh of that range spends from the shared provider budget.' })}
      </p>

      {requested && result ? (
        <>
          <LineArea
            title={t('asset_history.figure_title', { defaultValue: 'Price and volume over the loaded window' })}
            description={caption}
            points={points.map(point => ({ t: num(point?.t), value: num(point?.price), secondary: num(point?.volume) }))}
            spans={drawdown && num(drawdown.peakT) != null && num(drawdown.troughT) != null ? [{
              from: num(drawdown.peakT),
              to: num(drawdown.troughT),
              tone: 'red',
              label: t('asset_history.drawdown_span', { defaultValue: 'Deepest decline in this window: {{pct}}', pct: formatPct(drawdown.pct) }),
            }] : []}
            marks={drawdown && num(drawdown.recoveredT) != null ? [{
              t: num(drawdown.recoveredT),
              tone: 'green',
              label: t('asset_history.recovered_mark', { defaultValue: 'Back at the previous peak' }),
            }] : []}
            valueLabel={t('asset_history.column_price', { defaultValue: 'Price' })}
            secondaryLabel={t('asset_history.column_volume', { defaultValue: 'Volume' })}
            formatValue={formatPrice}
            formatSecondary={formatUsd}
            formatTime={value => pointTime(value, interval)}
            tableColumns={[
              t('asset_history.column_date', { defaultValue: 'Date' }),
              t('asset_history.column_price', { defaultValue: 'Price' }),
              t('asset_history.column_volume', { defaultValue: 'Volume' }),
              t('asset_history.column_market_cap', { defaultValue: 'Market cap' }),
            ]}
            tableRows={points.map(point => [
              pointTime(point?.t, interval),
              formatPrice(point?.price),
              formatUsd(point?.volume),
              formatUsd(point?.marketCap),
            ])}
            state={unavailable ? 'error' : 'ready'}
            reason={unavailable ? reasonText(history?.reason) : undefined}
          />

          {!unavailable && (
            <>
              <div className="intel-asset-history-gauges" style={GAUGE_ROW}>
                <RadialGauge
                  title={t('asset_history.volatility_title', { defaultValue: '30-day realised volatility' })}
                  description={volatility
                    ? t('asset_history.volatility_sub', { defaultValue: 'Annualised standard deviation of log returns over {{windowDays}} days, from {{samples}} returns at this series’ own interval.', windowDays: volatility.windowDays, samples: volatility.samples })
                    : t('asset_history.volatility_sub_empty', { defaultValue: 'Annualised standard deviation of log returns over the loaded window.' })}
                  value={num(volatility?.pct) ?? 0}
                  min={0}
                  max={volatilityMax}
                  zones={[
                    { to: 40, label: t('asset_history.volatility_low', { defaultValue: 'Low' }), tone: 'green' },
                    { to: 80, label: t('asset_history.volatility_elevated', { defaultValue: 'Elevated' }), tone: 'yellow' },
                    { to: volatilityMax, label: t('asset_history.volatility_high', { defaultValue: 'High' }), tone: 'red' },
                  ]}
                  formatValue={value => formatPct(value).replace(/^\+/, '')}
                  state={volatility ? 'ready' : 'error'}
                  reason={volatility ? undefined : metricReason}
                />
                <RadialGauge
                  title={t('asset_history.from_high_title', { defaultValue: 'Drawdown from the window high' })}
                  description={fromHigh
                    ? t('asset_history.from_high_sub', { defaultValue: 'Against the high of this window only: {{high}}. A longer window can contain an older, higher peak.', high: formatPrice(fromHigh.high) })
                    : t('asset_history.from_high_sub_empty', { defaultValue: 'Against the high of this window only.' })}
                  value={num(fromHigh?.pct) ?? 0}
                  min={-100}
                  max={0}
                  zones={[
                    { to: -50, label: t('asset_history.from_high_severe', { defaultValue: 'Severe' }), tone: 'red' },
                    { to: -20, label: t('asset_history.from_high_deep', { defaultValue: 'Deep' }), tone: 'yellow' },
                    { to: 0, label: t('asset_history.from_high_shallow', { defaultValue: 'Shallow' }), tone: 'green' },
                  ]}
                  formatValue={formatPct}
                  state={fromHigh ? 'ready' : 'error'}
                  reason={fromHigh ? undefined : metricReason}
                />
                <RadialGauge
                  title={t('asset_history.days_since_high_title', { defaultValue: 'Days since the window high' })}
                  description={t('asset_history.days_since_high_sub', { defaultValue: 'Counted from the last time this window’s high was reached. An asset sitting at its high is zero days since.' })}
                  value={num(fromHigh?.daysSince) ?? 0}
                  min={0}
                  max={daysMax}
                  zones={[
                    { to: Math.round(daysMax / 3), label: t('asset_history.days_recent', { defaultValue: 'Recent' }), tone: 'green' },
                    { to: Math.round((daysMax * 2) / 3), label: t('asset_history.days_middle', { defaultValue: 'Mid window' }), tone: 'yellow' },
                    { to: daysMax, label: t('asset_history.days_old', { defaultValue: 'Start of window' }), tone: 'muted' },
                  ]}
                  formatValue={value => t('asset_history.days_value', { defaultValue: '{{days}} d', days: Math.round(Number(value) || 0) })}
                  state={fromHigh ? 'ready' : 'error'}
                  reason={fromHigh ? undefined : metricReason}
                />
              </div>

              <dl className="intel-fact intel-asset-history-underwater">
                <dt>{t('asset_history.under_water_title', { defaultValue: 'Time under water in this window' })}</dt>
                <dd className="intel-number">
                  {underWater == null
                    ? metricReason
                    : t('asset_history.under_water_value', { defaultValue: '{{days}} days below a previous peak', days: underWater })}
                </dd>
              </dl>
            </>
          )}
        </>
      ) : null}
    </section>
  )
}
