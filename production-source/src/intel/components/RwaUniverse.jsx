import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import BoardTableHeader from './BoardTableHeader'
import TokenAvatar from './TokenAvatar'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { Sunburst, Sparkline } from '../charts'
import { readCaptureView, captureUnavailable } from '../lib/capture-api'
import { formatUsd, formatCompact, formatPct } from '../lib/market-format'

// RWA universe (CMC plan proposal 5). Inner ring: tokenized asset types by total
// market value. Outer ring: the assets that carry each type.
//
// The outer ring is a TOP list, not the whole type, so a "rest of type"
// remainder closes each inner arc back onto its reported total. Without it the
// inner ring would silently shrink to whatever the top list happened to cover,
// and every share on the figure would be wrong.

const TYPE_ORDER = ['stock', 'commodity', 'currency', 'government_security', 'etf', 'real_estate']
const TYPE_LABELS = {
  stock: 'Stocks',
  commodity: 'Commodities',
  currency: 'Currencies',
  government_security: 'Government securities',
  etf: 'ETFs',
  real_estate: 'Real estate',
}

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// Why a 24 hour change cell has no number. Each reason is a stated fact about our
// own capture history, never a silent dash.
const CHANGE_REASONS = {
  no_comparable_capture_24h_earlier: 'No capture about 24 hours earlier',
  no_value_captured: 'No value captured',
  previous_value_zero: 'Previous value was zero',
}

// A type the provider reports as holding nothing. `asset_count` is the provider's
// own `total_size` for the type, so a 0 here is CoinMarketCap saying it lists no
// assets of this type, not a read that failed. The row says that in words: a
// blank row invites the reader to think the capture broke.
export function rwaTypeEmpty(entry) {
  return num(entry?.assetCount) === 0
}

// The top assets of the whole universe, for the legend beside the ring.
//
// RWA underlyings are gold bars and listed companies, not catalogue tokens: the
// list endpoint gives an `rwa_id` in its own namespace and no crypto id, so there
// is no image to look up and no ticker may ever be turned into one. TokenAvatar
// therefore draws its deterministic monogram here, which is the correct and
// honest picture for an underlying that is not a listed token.
export function rwaLegend(latest = {}, max = 8) {
  const top = Array.isArray(latest?.all?.topAssets) ? latest.all.topAssets : []
  return top
    .map(asset => ({
      key: String(asset?.rwaId ?? asset?.rwa_id ?? asset?.symbol ?? asset?.name ?? ''),
      symbol: asset?.symbol || null,
      name: asset?.name || null,
      value: num(asset?.value),
    }))
    .filter(asset => asset.key && (asset.symbol || asset.name))
    .slice(0, max)
}

// Reported asset types in a fixed reading order, with anything unexpected the
// capture returns appended rather than dropped. 'all' is the aggregate row and
// never becomes an arc — it would double every share on the figure.
export function rwaTypes(latest = {}) {
  const keys = Object.keys(latest || {}).filter(key => key !== 'all')
  const ordered = TYPE_ORDER.filter(type => keys.includes(type))
  return [...ordered, ...keys.filter(type => !TYPE_ORDER.includes(type))]
}

// Two-ring tree. A type whose top assets do not add up to its reported total
// carries the difference as a remainder child; a type with no top assets is a
// leaf holding its own total.
export function rwaRoot(latest = {}, { rootName = 'Real-world assets', otherName = 'Rest of type', label = type => type } = {}) {
  return {
    name: rootName,
    children: rwaTypes(latest).map(type => {
      const entry = latest?.[type] || {}
      const total = num(entry.totalMarketValueUsd) ?? 0
      const top = (Array.isArray(entry.topAssets) ? entry.topAssets : [])
        .map(asset => ({ name: asset?.symbol || asset?.name || String(asset?.rwaId ?? '—'), value: num(asset?.value) ?? 0 }))
      if (!top.length) return { name: label(type), value: total }
      const covered = top.reduce((sum, asset) => sum + asset.value, 0)
      const rest = total - covered
      return { name: label(type), children: rest > 0 ? [...top, { name: otherName, value: rest }] : top }
    }),
  }
}

export default function RwaUniverse() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's authenticated
  // client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('rwa_universe', {}, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase])

  const label = type => t(`structure.rwa_type_${type}`, { defaultValue: TYPE_LABELS[type] || type })
  const latest = useMemo(
    () => (read.payload?.latest && typeof read.payload.latest === 'object' ? read.payload.latest : {}),
    [read.payload],
  )
  const types = rwaTypes(latest)
  const root = rwaRoot(latest, {
    rootName: t('structure.rwa_root', { defaultValue: 'Real-world assets' }),
    otherName: t('structure.rwa_rest', { defaultValue: 'Rest of type' }),
    label,
  })

  // A 30-day value trace per type, keyed off the same asset type as the ring.
  const traces = useMemo(() => {
    const out = {}
    for (const row of (Array.isArray(read.payload?.series) ? read.payload.series : [])) {
      const key = row?.assetType
      if (!key) continue
      out[key] = (Array.isArray(row.points) ? row.points : [])
        .map(point => num(point?.totalMarketValueUsd))
        .filter(value => value != null)
    }
    return out
  }, [read.payload])

  const state = read.status === 'unavailable' ? 'error' : (read.status === 'ready' && types.length) ? 'ready' : 'empty'
  const total = latest?.all ? num(latest.all.totalMarketValueUsd) : null

  const legend = rwaLegend(latest)

  // The issuer column is gone and the token column stands in its place. The list
  // endpoint publishes no issuer field of any kind, so that column could only ever
  // read 0, on every type, forever. `has_tokens` is a real per-row provider
  // boolean, so the count of assets that actually carry a token is a figure this
  // payload can honestly support.
  const columns = [
    t('structure.rwa_col_type', { defaultValue: 'Type' }),
    t('structure.rwa_col_assets', { defaultValue: 'Assets' }),
    t('structure.rwa_col_with_tokens', { defaultValue: 'Assets with tokens' }),
    t('structure.rwa_col_value', { defaultValue: 'Value' }),
    t('structure.rwa_col_volume', { defaultValue: '24h volume' }),
    t('structure.rwa_col_change', { defaultValue: '24h change' }),
    t('structure.rwa_col_trend', { defaultValue: '30d' }),
  ]
  const cell = 'border-b border-[var(--border-default)] py-2 pr-3'
  const note = 'block text-[11px] text-[var(--fg-4)]'

  return (
    <section className="intel-structure-rwa space-y-3" aria-label={t('structure.rwa_title', { defaultValue: 'RWA universe' })}>
      <div className="grid gap-x-8 gap-y-3 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] items-start">
        <Sunburst
          title={t('structure.rwa_title', { defaultValue: 'RWA universe' })}
          description={t('structure.rwa_sub', { defaultValue: 'Tokenized asset types by total market value, with the assets that carry each type on the outer ring. Select an arc to read its value.' })}
          root={root}
          depth={2}
          formatValue={formatUsd}
          state={state}
          reason={read.reason}
        />
        {/* A read that succeeded with no capture yet is a stated state with its
            schedule (the hourly intel-capture batch at minute 7), not a blank. */}
        {read.status === 'ready' && state === 'empty' ? (
          <p role="status" className="text-[12px] text-[var(--fg-4)]">
            {t('structure.rwa_not_captured', { defaultValue: 'No RWA universe capture has been stored yet. The capture is scheduled every hour at 7 minutes past the hour (UTC).' })}
          </p>
        ) : null}
        {state === 'ready' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
                {total == null
                  ? t('structure.rwa_table_caption', { defaultValue: 'Latest capture per tokenized asset type.' })
                  : t('structure.rwa_table_caption_total', { total: formatUsd(total), defaultValue: 'Latest capture per tokenized asset type. Reported total: {{total}}.' })}
              </caption>
              <thead>
                <BoardTableHeader columns={columns} numeric={[1, 2, 3, 4, 5]} />
              </thead>
              <tbody>
                {types.map(type => {
                  const entry = latest[type] || {}
                  const values = traces[type] || []
                  // A type the provider lists nothing for says so, across the row.
                  // Six dashes read as a broken capture; these words do not.
                  if (rwaTypeEmpty(entry)) {
                    return (
                      <tr key={type}>
                        <th scope="row" className={`text-left font-normal text-[var(--fg-2)] ${cell}`}>{label(type)}</th>
                        <td className={cell} colSpan={6}>
                          <span className="text-[var(--fg-4)]">{t('structure.rwa_type_none', { defaultValue: 'CoinMarketCap lists no assets of this type yet.' })}</span>
                        </td>
                      </tr>
                    )
                  }
                  const assetCount = num(entry.assetCount)
                  const scanned = num(entry.assetsScanned)
                  const withTokens = num(entry.assetsWithTokens)
                  const change = num(entry.change24hPct)
                  return (
                    <tr key={type}>
                      <th scope="row" className={`text-left font-normal text-[var(--fg-2)] ${cell}`}>{label(type)}</th>
                      <td className={`intel-number ${cell}`}>{formatCompact(assetCount)}</td>
                      <td className={`intel-number ${cell}`}>
                        {withTokens == null
                          ? <span className="text-[var(--fg-4)]">{t('structure.rwa_tokens_unrecorded', { defaultValue: 'Not recorded in this capture' })}</span>
                          : (
                            <>
                              {formatCompact(withTokens)}
                              {/* The provider caps a page at 250 rows and paginates,
                                  so a wide type is counted within the rows read.
                                  Saying which is the difference between a count and
                                  a claim about the whole type. */}
                              {scanned != null && assetCount != null && scanned < assetCount && (
                                <span className={note}>{t('structure.rwa_tokens_scanned', { scanned: formatCompact(scanned), defaultValue: 'within the {{scanned}} rows read' })}</span>
                              )}
                            </>
                          )}
                      </td>
                      <td className={`intel-number ${cell}`}>{formatUsd(num(entry.totalMarketValueUsd))}</td>
                      <td className={`intel-number ${cell}`}>{formatUsd(num(entry.volume24hUsd))}</td>
                      <td className={`intel-number ${cell}`}>
                        {change == null
                          ? <span className="text-[var(--fg-4)]">{t(`structure.rwa_change_${entry.change24hReason || 'unavailable'}`, { defaultValue: CHANGE_REASONS[entry.change24hReason] || 'Not available' })}</span>
                          : (
                            <>
                              {formatPct(change)}
                              {/* The provider publishes no 24h change on this
                                  endpoint, so where the figure is ours the row says
                                  so rather than letting it pass as CoinMarketCap's. */}
                              {entry.change24hSource === 'our_snapshots' && (
                                <span className={note}>{t('structure.rwa_change_ours', { defaultValue: 'our calculation, from our own captures' })}</span>
                              )}
                            </>
                          )}
                      </td>
                      <td className={cell}>
                        {values.length
                          ? <Sparkline values={values} ariaLabel={t('structure.rwa_trend_label', { type: label(type), count: values.length, defaultValue: '{{type}} value over the last {{count}} captures' })} />
                          : <span className="text-[var(--fg-4)]">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      {/* This figure is the hourly capture: one dated row per asset type. The
          per-asset workspace behind it, with the type filter, the issuer list
          and the evidence drawer, used to need a Starter plan and no longer
          does, so the section says where to find it. A plain link, because
          public-facing Intel sections carry no pills or chips. */}
      <p className="text-[12px]">
        <Link className="intel-text-link" to="/intel/rwa">
          {t('structure.rwa_open_workspace', { defaultValue: 'Open the full RWA workspace' })}
        </Link>
      </p>

      {/* The outer ring names the largest underlyings; this legend puts a face
          beside each one. RWA underlyings carry no catalogue image, so these are
          monograms by design. */}
      {state === 'ready' && legend.length > 0 ? (
        <div>
          <div className="eyebrow">{t('structure.rwa_legend', { defaultValue: 'Largest tokenized underlyings' })}</div>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 pt-2 text-[12px]">
            {legend.map(asset => (
              <li key={asset.key} className="flex items-center gap-2">
                <TokenAvatar symbol={asset.symbol} name={asset.name} size="sm" />
                <span>
                  {asset.name || asset.symbol}
                  {asset.value != null && <span className="text-[var(--fg-4)]"> {formatUsd(asset.value)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* One quiet source line for the section. Plain text, no link furniture. */}
      {state === 'ready' ? (
        <p className="text-[11px] text-[var(--fg-4)]">
          {t('structure.rwa_attribution', { defaultValue: 'Tokenized asset data from CoinMarketCap. The 24 hour change of tokenized value is our own calculation from consecutive captures, because CoinMarketCap publishes no 24 hour change for these assets.' })}
        </p>
      ) : null}
    </section>
  )
}
