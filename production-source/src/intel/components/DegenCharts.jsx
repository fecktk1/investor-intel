import React from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { RadialBars, PolarClock, Scatter } from '../charts'
import { formatUsd, formatCompact } from '../lib/market-format'

// The three pictures a Degen reader actually needs before reading rows: where
// the surviving tokens live, whether their market caps are supported by any
// liquidity, and how much of the table launched this week. Each mark is a
// filter — clicking a chain filters the table to that chain — so the charts are
// controls, not decoration.
//
// Everything is drawn from the SAME gated snapshot the table pages through, and
// the line underneath says exactly what the gate removed. A screener that
// silently drops a third of its rows is not trustworthy; one that says "1,204
// excluded: 812 stablecoins…" is.

const CHAIN_TONES = { solana: 'accent', ethereum: 'blue', base: 'green', bsc: 'yellow', bnb: 'yellow' }
const CHAIN_LABELS = { solana: 'Solana', ethereum: 'Ethereum', base: 'Base', bsc: 'BNB Chain', bnb: 'BNB Chain' }

const QUADRANT_LIQUIDITY = 100_000
const QUADRANT_CAP = 10_000_000

export default function DegenCharts({ data, onFilter }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const navigate = useNavigate()
  const snapshot = data?.snapshot || null
  const missing = !data || !snapshot
  const reason = missing ? t('degen.charts_unavailable', { defaultValue: 'The Degen screener returned no observations for this view.' }) : undefined
  const state = missing ? 'error' : 'ready'
  const filter = (patch) => { if (typeof onFilter === 'function') onFilter(patch) }

  const chainCounts = Array.isArray(snapshot?.chainCounts) ? snapshot.chainCounts : []
  const chainMax = chainCounts.reduce((m, c) => Math.max(m, Number(c?.count) || 0), 0) || 1
  const chainSeries = chainCounts.map((entry) => ({
    key: entry.chain,
    label: CHAIN_LABELS[entry.chain] || entry.chain,
    value: Number(entry.count) || 0,
    max: chainMax,
    tone: CHAIN_TONES[entry.chain] || 'fourth',
  }))

  const scatterPoints = (Array.isArray(snapshot?.scatter) ? snapshot.scatter : []).map((point, i) => ({
    key: point.chain && point.tokenAddress ? `${point.chain}:${point.tokenAddress}` : `point-${i}`,
    label: point.symbol || point.tokenAddress || '—',
    x: point.liquidityUsd,
    y: point.marketCap,
    detail: point,
  }))

  const buckets = Array.isArray(snapshot?.ageBuckets) ? snapshot.ageBuckets : []
  const excluded = data?.excluded || null
  const showExcluded = data?.showExcluded === true

  return (
    <div className="space-y-2">
      <div className="grid gap-x-8 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
        <RadialBars
          title={t('degen.chart_chains_title', { defaultValue: 'Chain share' })}
          description={t('degen.chart_chains_description', { defaultValue: 'Verified memecoins per chain after exclusions. Pick a chain to filter the table.' })}
          series={chainSeries}
          formatValue={(v) => formatCompact(v)}
          state={state} reason={reason}
          onSelect={(series) => filter({ chain: series?.key })}
        />
        <Scatter
          title={t('degen.chart_liquidity_title', { defaultValue: 'Liquidity vs market cap' })}
          description={t('degen.chart_liquidity_description', { defaultValue: 'A market cap with no liquidity underneath it is a number, not a price. Open a token to see its pairs.' })}
          points={scatterPoints}
          xLabel={t('degen.column_liquidity', { defaultValue: 'Liquidity' })}
          yLabel={t('degen.column_market_cap', { defaultValue: 'Market cap' })}
          formatX={formatUsd} formatY={formatUsd}
          quadrants={{
            x: QUADRANT_LIQUIDITY,
            y: QUADRANT_CAP,
            // [topLeft, topRight, bottomLeft, bottomRight] — high cap is up,
            // deep liquidity is right, so each name sits in the corner it
            // describes.
            labels: [
              t('degen.quadrant_thin_large', { defaultValue: 'Thin & large' }),
              t('degen.quadrant_deep_large', { defaultValue: 'Deep & large' }),
              t('degen.quadrant_thin_small', { defaultValue: 'Thin & small' }),
              t('degen.quadrant_deep_small', { defaultValue: 'Deep & small' }),
            ],
          }}
          state={state} reason={reason}
          onSelect={(point) => { const href = point?.detail?.detailHref; if (href) navigate(href) }}
        />
        <PolarClock
          title={t('degen.chart_age_title', { defaultValue: 'Launch age' })}
          description={t('degen.chart_age_description', { defaultValue: 'Verified launches by day over the last week. Pick a day to see new launches.' })}
          period="7d"
          buckets={buckets}
          formatValue={(v) => formatCompact(v)}
          state={state} reason={reason}
          onSelect={() => filter({ bucket: 'new' })}
        />
      </div>
      {excluded ? (
        <p className="text-[11px] text-[var(--fg-4)]">
          {t('degen.excluded_line', {
            total: excluded.total ?? 0,
            stablecoin: excluded.stablecoin ?? 0,
            major: excluded.major ?? 0,
            wrapped: excluded.wrapped_or_staked ?? 0,
            impersonation: excluded.impersonation ?? 0,
            implausible: excluded.implausible_cap ?? 0,
            defaultValue: '{{total}} excluded: {{stablecoin}} stablecoins, {{major}} majors, {{wrapped}} wrapped or staked, {{impersonation}} impersonations, {{implausible}} implausible caps',
          })}{' '}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => filter({ showExcluded: !showExcluded })}>
            {showExcluded
              ? t('degen.hide_excluded', { defaultValue: 'Hide excluded' })
              : t('degen.show_excluded', { defaultValue: 'Show excluded' })}
          </button>
        </p>
      ) : null}
    </div>
  )
}
