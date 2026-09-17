import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { HeatStrip } from '../charts'
import { ChartFrame, ChartTable, markProps, useChartText } from '../charts/frame'
import { TONES, gridStroke, useReducedMotion } from '../charts/theme'
import { readCaptureView, captureUnavailable } from '../lib/capture-api'
import { formatUsd } from '../lib/market-format'

// Liquidation heat (CMC plan proposal 9). Seven days of hourly liquidation
// totals as a 24-wide strip — one row per day, one cell per hour — plus the
// 24-hour long/short split for the assets in view.
//
// Everything here is a PROVIDER-REPORTED AGGREGATE sampled on the capture
// clock, not an exchange tape: two venues reporting the same cascade differently
// both land in the same cell. The frame says so rather than leaving a reader to
// treat it as a measurement.

const MAX_IDS = 10
const DEFAULT_ASSETS = 5
const HOURS_PER_ROW = 24
const BAR_W = 620, BAR_H = 22, BAR_GAP = 12, BAR_LABEL = 84, BAR_PAD = 4

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const hourLabel = ms => {
  const date = new Date(Number(ms))
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
}

// The Markets screen's current rows, largest market cap first. Rows without a
// provider id cannot be asked for and are skipped rather than sent as nulls.
export function topIdsByMarketCap(rows = [], max = DEFAULT_ASSETS) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row?.providerId != null && row.providerId !== '')
    .sort((a, b) => (num(b?.marketCap) ?? -Infinity) - (num(a?.marketCap) ?? -Infinity))
    .slice(0, Math.max(0, max))
    .map(row => row.providerId)
}

// Latest 24h reading per asset, split into the long and short sides when the
// capture carries them. A row that reports only a combined 24h figure keeps one
// undivided bar rather than being halved into an invented split.
export function assetBars(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const points = (Array.isArray(row?.points) ? row.points : [])
      .map(point => ({ ...point, at: Date.parse(point?.capturedAt) }))
      .filter(point => Number.isFinite(point.at))
      .sort((a, b) => a.at - b.at)
    const last = points.at(-1) || {}
    const long = num(last.long24h)
    const short = num(last.short24h)
    const total = num(last.liq24h) ?? ((long ?? 0) + (short ?? 0))
    return {
      key: row?.providerId ?? row?.symbol ?? index,
      symbol: row?.symbol || String(row?.providerId ?? '—'),
      capturedAt: last.capturedAt ?? null,
      liq1h: num(last.liq1h),
      liq4h: num(last.liq4h),
      liq24h: total,
      long, short,
      split: long != null && short != null,
    }
  })
}

// Per-asset 24h bars. Two-tone where the split is reported; the whole row is one
// keyboard mark so the long and short lengths are read together.
function AssetBars({ bars, title, description, state, reason }) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const [active, setActive] = useState(null)
  const max = Math.max(0, ...bars.map(bar => bar.liq24h ?? 0))
  const height = BAR_PAD * 2 + Math.max(1, bars.length) * (BAR_H + BAR_GAP)
  const width = value => (max > 0 ? ((value ?? 0) / max) * (BAR_W - BAR_LABEL) : 0)
  const focused = bars.find(bar => bar.key === active) || null
  const readout = focused
    ? (focused.split
        ? t('structure.liq_readout_split', { symbol: focused.symbol, long: formatUsd(focused.long), short: formatUsd(focused.short), defaultValue: '{{symbol}} · {{long}} long · {{short}} short' })
        : t('structure.liq_readout', { symbol: focused.symbol, total: formatUsd(focused.liq24h), defaultValue: '{{symbol}} · {{total}} liquidated, side not reported' }))
    : ''

  return (
    <ChartFrame
      t={t} title={title} description={description} state={state} reason={reason}
      readout={<p className="intel-chart-kit-readout" aria-live="polite">{readout}</p>}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[
            t('structure.liq_col_asset', { defaultValue: 'Asset' }),
            t('structure.liq_col_1h', { defaultValue: '1h' }),
            t('structure.liq_col_4h', { defaultValue: '4h' }),
            t('structure.liq_col_24h', { defaultValue: '24h' }),
            t('structure.liq_col_long', { defaultValue: 'Long 24h' }),
            t('structure.liq_col_short', { defaultValue: 'Short 24h' }),
          ]}
          rows={bars.map(bar => [bar.symbol, formatUsd(bar.liq1h), formatUsd(bar.liq4h), formatUsd(bar.liq24h), formatUsd(bar.long), formatUsd(bar.short)])}
        />
      }
    >
      <svg viewBox={`0 0 ${BAR_W} ${height}`} role="img"
        aria-label={`${title}. ${bars.length}. ${t('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
        {bars.map((bar, i) => {
          const y = BAR_PAD + i * (BAR_H + BAR_GAP)
          const longW = bar.split ? width(bar.long) : 0
          const shortW = bar.split ? width(bar.short) : 0
          return (
            <g key={bar.key}
              {...markProps({ label: `${bar.symbol} ${formatUsd(bar.liq24h)}`, onActivate: () => setActive(bar.key), reduced })}
              onMouseEnter={() => setActive(bar.key)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(bar.key)}
              onBlur={() => setActive(null)}
              opacity={active != null && active !== bar.key ? 0.45 : 1}
            >
              <title>
                {bar.split
                  ? `${bar.symbol} · ${formatUsd(bar.long)} / ${formatUsd(bar.short)}`
                  : `${bar.symbol} · ${formatUsd(bar.liq24h)}`}
              </title>
              <text x="0" y={y + BAR_H - 6} className="intel-chart-strong">{bar.symbol}</text>
              {bar.split ? (
                <>
                  <rect x={BAR_LABEL} y={y} width={longW} height={BAR_H} fill={TONES.green} fillOpacity="0.8" stroke={gridStroke} />
                  <rect x={BAR_LABEL + longW} y={y} width={shortW} height={BAR_H} fill={TONES.red} fillOpacity="0.8" stroke={gridStroke} />
                </>
              ) : (
                <rect x={BAR_LABEL} y={y} width={width(bar.liq24h)} height={BAR_H} fill={TONES.accent} fillOpacity="0.8" stroke={gridStroke} />
              )}
              <text className="intel-chart-value" x={BAR_LABEL + Math.max(width(bar.liq24h), 0) + 8} y={y + BAR_H - 6}>{formatUsd(bar.liq24h)}</text>
            </g>
          )
        })}
      </svg>
    </ChartFrame>
  )
}

export default function LiquidationHeat({ ids = [], rows = [] }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's authenticated
  // client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null

  // The parent's current Markets rows win; an explicit `ids` prop is the
  // fallback, and both are capped at what the read accepts.
  const fromRows = topIdsByMarketCap(rows, DEFAULT_ASSETS)
  const requested = (fromRows.length ? fromRows : (Array.isArray(ids) ? ids : []))
    .filter(id => id != null && id !== '')
    .slice(0, MAX_IDS)
  // The joined key only decides WHEN to re-read. The ids themselves are sent
  // from the ref, so a numeric CMC id reaches the function as a number rather
  // than as the string a split() would hand back.
  const idKey = requested.join(',')
  const requestedRef = useRef(requested)
  requestedRef.current = requested

  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  // The read takes `providerIds` (capture-read.ts readLiquidations); the
  // seven-day strip sums the first three requested assets, and with none
  // selected the function answers `no_asset_selected`, which renders as the
  // empty state rather than a market-wide strip nobody captured.
  useEffect(() => {
    const list = requestedRef.current
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('liquidations', { providerIds: list }, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, idKey, supabase])

  const cells = useMemo(() => (Array.isArray(read.payload?.series) ? read.payload.series : [])
    .map(point => {
      const at = Date.parse(point?.hour)
      return { t: at, value: num(point?.total) ?? 0, label: hourLabel(at) }
    })
    .filter(cell => Number.isFinite(cell.t)), [read.payload])

  const bars = useMemo(() => assetBars(read.payload?.rows), [read.payload])

  const failed = read.status === 'unavailable'
  const heatState = failed ? 'error' : (read.status === 'ready' && cells.length) ? 'ready' : 'empty'
  const barState = failed ? 'error' : (read.status === 'ready' && bars.length) ? 'ready' : 'empty'
  const caption = t('structure.liq_caption', { defaultValue: 'Provider-reported aggregate sampled on the five-minute capture clock, not an exchange tape.' })

  return (
    <section className="intel-structure-liq space-y-3" aria-label={t('structure.liq_title', { defaultValue: 'Liquidation heat' })}>
      <HeatStrip
        title={t('structure.liq_title', { defaultValue: 'Liquidation heat' })}
        description={`${t('structure.liq_sub', { defaultValue: 'Hourly liquidation totals over the last seven days: one row per day, one cell per hour.' })} ${caption}`}
        cells={cells}
        columns={HOURS_PER_ROW}
        formatValue={formatUsd}
        state={heatState}
        reason={read.reason}
      />
      <AssetBars
        bars={bars}
        title={t('structure.liq_assets_title', { defaultValue: 'Long and short liquidations, last 24h' })}
        description={requested.length
          ? `${t('structure.liq_assets_sub', { defaultValue: 'Latest 24h liquidations per asset, split into the long and short sides where the capture reports them.' })} ${caption}`
          : t('structure.liq_no_assets', { defaultValue: 'No assets were selected, so no per-asset liquidations were requested.' })}
        state={requested.length ? barState : 'empty'}
        reason={read.reason}
      />
    </section>
  )
}
