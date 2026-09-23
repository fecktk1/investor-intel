import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import BoardTableHeader from './BoardTableHeader'
import SortableHeader, { StaticHeader } from './SortableHeader'
import TokenAvatar from './TokenAvatar'
import FigureProvenance from './FigureProvenance'
import AsOfTime from './AsOfTime'
import { formatUtcTime } from '../lib/as-of'
import { Scatter } from '../charts'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { useColumnSort, sortRows } from '../lib/useColumnSort'
import { formatUsd, formatPrice } from '../lib/market-format'
import { downloadTableCsv } from '../lib/table-csv'
import { WRAPPER_CSV_COLUMNS, wrapperCsvRows } from '../lib/rwa-wrapper-csv'

// Wrapper premium, discount and dispersion for one tokenised real-world asset.
//
// THE QUESTION THIS BOARD ANSWERS. Gold is wrapped by six tokens from six
// issuers, and those six do not trade at the same price. Which wrapper is dear,
// which is cheap, how far apart are they, and which is the cheapest route you
// could actually reach.
//
// THE ANCHOR IS NAMED ON EVERY ROW, because that is the whole argument. A
// premium measured against the average of the wrappers is circular, so either
// the anchor is the fund's own published net asset value (independent of every
// wrapper) or it is the volume-weighted median of the wrappers that cleared the
// liquidity floor, and the row says which.
//
// Three rules this file may never soften:
//   1. A THIN WRAPPER IS SHOWN. It keeps its premium, it is marked "too thin to
//      anchor", and it is excluded from the anchor only. Hiding it would remove
//      the wrapper a reader most needs warning about.
//   2. AN ACCRUAL IS NOT A PREMIUM. A wrapper that accrues yield inside its
//      price carries an accrual gap in its own column and no premium at all.
//   3. A FIGURE WE COMPUTE SAYS SO, names its inputs and carries its capture
//      time. The provenance drawer names both endpoints behind the board.
//
// House visual language: no pills and no cards. Eyebrows, hairlines and plain
// tables, matching RwaUniverse.jsx and RwaIssuerLegitimacy.jsx.

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const rule = 'border-b border-[var(--border-default)]'
const cell = `${rule} py-2 pr-3 align-top`
const numCell = `${cell} intel-number`

/** Basis points, signed, with an explicit plus so a premium and a discount are
 * never confused at a glance. Exactly 0 prints as 0 bps: the two prices agreed,
 * which is a measurement and not an absence.
 *
 * The unit abbreviation is passed in rather than hardcoded: it differs by locale
 * (Bp in German, pb in the Romance languages) and belongs in the locale file
 * like every other unit on this workspace. */
export function bpsLabel(value, unit = 'bps') {
  const n = num(value)
  if (n == null) return null
  const rounded = Math.round(n * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`
}

/** A range is never signed: it is a width. */
export function widthLabel(value, unit = 'bps') {
  const n = num(value)
  return n == null ? null : `${(Math.round(n * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`
}

/** What each sortable column of the asset board reads.
 *
 * The accessor reads what the CELL SHOWS, not whichever stored field is nearest
 * to it: dispersion is printed unsigned, so it sorts unsigned, and the cheapest
 * route is a token name whose figure is its premium, so it sorts by that premium
 * rather than alphabetically by a ticker nobody is ranking. A column whose cell
 * is a stated reason rather than a figure reads null, and `sortRows` parks a null
 * LAST in both directions: flipping a column never floats "no anchor" to the top.
 *
 * The board arrives ranked by widest dispersion, and 'dispersion' descending is
 * exactly that ranking, so the default order is the server's order and ties keep
 * the server's own tie-break (volume, then rank) through the stable sort. */
export const ASSET_SORTS = {
  asset: row => row?.name || row?.symbol || row?.rwaId || null,
  wrappers: row => num(row?.wrapperCount),
  anchor: row => num(row?.anchorPrice),
  premium: row => num(row?.widestPremiumBps),
  discount: row => num(row?.widestDiscountBps),
  dispersion: row => { const n = num(row?.dispersionBps); return n == null ? null : Math.abs(n) },
  volume: row => num(row?.tokenizedVolume24h),
  cheapest: row => (row?.cheapestCryptoId ? num(row?.cheapestPremiumBps) : null),
}
/** Wrapper columns of the expanded per-asset table. A wrapper that carries an
 * accrual gap rather than a premium reads null here on purpose: an accrual is
 * not a premium and must not be ranked against one. */
export const TOKEN_SORTS = {
  token: token => token?.name || token?.symbol || token?.cryptoId || null,
  issuer: token => token?.issuerName || null,
  price: token => num(token?.normalisedPrice) ?? num(token?.price),
  premium: token => num(token?.premiumBps),
  // The measured gap to the listed share, including one inside the feed's band:
  // the cell says "not distinguishable" for those, and the order still follows
  // the measured figure so the column reads top to bottom without jumps.
  vs_stock: token => num(token?.underlyingRefBps),
  token_volume: token => num(token?.volume24h),
}
/** Columns whose first click should read low-to-high. A name reads A to Z first;
 * every ranked money column reads largest first, which is what the reader came
 * for. */
export const ASCENDING_FIRST = new Set(['asset', 'token', 'issuer'])

export const ASSET_DEFAULT_SORT = 'dispersion'
/** The wrappers arrive dearest first, which is 'premium' descending. */
export const TOKEN_DEFAULT_SORT = 'premium'

/** A robust band for the premium axis of the scatter.
 *
 * WHY THE AXIS IS NOT THE DATA'S RANGE. One wrapper priced in the wrong unit, or
 * one genuinely broken wrapper, sits at -1,300 bps. Letting it set the range
 * pushes every other wrapper onto the anchor line, and the figure then says
 * "every wrapper trades at its anchor", which is the opposite of what it
 * measured. The axis is bounded by the 5th and 95th percentile of the plotted
 * premiums, padded by a tenth of that width, and never narrower than the stated
 * half width so a capture where every wrapper agrees does not magnify noise.
 *
 * NOTHING IS DROPPED. A wrapper outside the band is drawn on the edge of the plot
 * and counted, and the count is printed under the chart in words. Its exact
 * premium is in the table below the chart. */
export function premiumBand(values, minHalfWidth = 100) {
  const sorted = values.map(num).filter(v => v != null).sort((a, b) => a - b)
  if (!sorted.length) return { low: -minHalfWidth, high: minHalfWidth, outside: 0 }
  const quantile = q => {
    const index = (sorted.length - 1) * q
    const lo = Math.floor(index), hi = Math.ceil(index)
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo)
  }
  const p5 = quantile(0.05), p95 = quantile(0.95)
  const pad = Math.max((p95 - p5) * 0.1, 1)
  const low = Math.min(p5 - pad, -minHalfWidth)
  const high = Math.max(p95 + pad, minHalfWidth)
  return { low, high, outside: sorted.filter(v => v < low || v > high).length }
}

/** A ratio between the two endpoints, to three decimals so a 0.995 reads as a
 * near-agreement rather than rounding to 1. */
export function ratioLabel(value) {
  const n = num(value)
  return n == null ? null : n.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 })
}

/** A volume on the log axis and in the chart's table twin: compact, with no
 * forced decimals, so the powers-of-ten gridlines read $10M and $1B rather than
 * $10.0M and $1.00B. */
const VOLUME_TICK = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 })
export const volumeTick = value => {
  const n = num(value)
  return n == null ? '—' : VOLUME_TICK.format(n)
}

/** A capture or observation instant as a readable UTC minute. */
export const utcMinute = value => {
  const text = String(value || '')
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? `${text.slice(0, 10)} ${text.slice(11, 16)} UTC` : null
}

/** The catalogue link for a wrapper. The RWA id is not a catalogue id, so only a
 * wrapper's own crypto id opens a market page; an asset row links to the RWA
 * investigation instead. */
export function wrapperHref(token) {
  if (!/^[1-9][0-9]{0,11}$/.test(String(token?.cryptoId ?? ''))) return null
  const label = token.symbol || token.name || String(token.cryptoId)
  return `/intel/markets/${encodeURIComponent(label)}?provider=coinmarketcap&id=${token.cryptoId}`
}

export function assetHref(row) {
  if (!/^[1-9][0-9]{0,11}$/.test(String(row?.rwaId ?? ''))) return null
  return `/intel/investigate?asset=rwa%3Acoinmarketcap%3A${row.rwaId}&lens=sessions`
}

/** Every machine reason this board can render, in words. Anything the lane adds
 * later falls back to the code itself rather than being swallowed by a generic
 * sentence, so a new state is visible instead of silent. */
const REASONS = {
  not_enough_liquid_wrappers: 'Fewer than two wrappers cleared the volume floor, so a median of them would be one wrapper priced against itself.',
  no_liquid_wrapper: 'No wrapper cleared the volume floor, so there is nothing deep enough to anchor against.',
  no_wrappers_reported: 'The provider reported no tokens for this asset.',
  no_nav_feed_mapped: 'No published net asset value is mapped to this asset, so the wrappers themselves are the reference.',
  nav_not_captured: 'The mapped net asset value feed has not been captured yet.',
  nav_not_validated: 'The mapped feed could not be proved on chain, so its figure was not used.',
  nav_stale: 'The mapped net asset value is older than its own published heartbeat, so the wrappers are the reference instead.',
  nav_feed_mismatch: 'The captured feed is not the one recorded for this asset.',
  nav_currency_not_usd: 'The net asset value is not in US dollars and the wrapper prices are, so the two were not subtracted.',
  asset_name_mismatch: 'The provider now reports a different name for this asset, so the recorded net asset value was not applied to it.',
  asset_symbol_mismatch: 'The provider now reports a different symbol for this asset, so the recorded net asset value was not applied to it.',
  no_nav: 'The feed carried no usable net asset value.',
  price_not_reported: 'The provider listed this wrapper without a price.',
  below_volume_floor: 'Too thin to anchor: its reported 24 hour volume is below the floor, so it is shown but excluded from the anchor.',
  volume_not_reported: 'The provider reported no 24 hour volume for this wrapper, so it is excluded from the anchor.',
  accrues_in_price: 'This wrapper accrues its yield inside the token price, so its gap to the anchor is an accrual and not a premium.',
  derivative_not_a_wrapper: 'The provider lists this derivative price among the asset\'s tokens. It is not a token anyone holds or redeems, so it is shown for comparison and never enters the anchor, the widest premium or discount, or the picks.',
  accrual_name_mismatch: 'This wrapper is recorded as accruing under a different name, so the accrual exemption was not applied and its gap is reported as a premium.',
  price_matches_no_known_weight_unit: 'Unit not established: the price matches neither the asset\'s unit nor a troy ounce to gram conversion, so no premium is reported.',
  price_far_from_peers: 'Unit not established: the price sits too far from the other wrappers of this asset to be the same unit, so no premium is reported.',
  list_value_not_reported: 'The list endpoint reported no value for this asset in the capture being compared.',
  no_wrapper_reported_a_value: 'No wrapper reported a market value, so there is nothing to sum against the list endpoint.',
  list_endpoint_reports_zero: 'The list endpoint prices this asset at zero while its own tokens report a value.',
  both_endpoints_report_zero: 'Both endpoints report zero, which is agreement rather than a measurement.',
  outside_band: 'The two endpoints are outside the stated band.',
  ratio_not_computable: 'The ratio between the two endpoints could not be computed.',
}

export function reasonText(t, code) {
  const key = String(code ?? '').trim()
  if (!key) return null
  const known = REASONS[key]
  return known ? t(`rwa_wrappers.reason_${key}`, { defaultValue: known }) : key
}

/** The same page with `?asset=<rwa id>` set, every other parameter kept, so
 * the history panel below the board (RwaWrapperHistory, read from that
 * parameter) opens on this asset. Null for anything but a numeric RWA id. */
export function overTimeHref(location, rwaId) {
  if (!/^[1-9][0-9]{0,11}$/.test(String(rwaId ?? ''))) return null
  const params = new URLSearchParams(location?.search || '')
  params.set('asset', String(rwaId))
  return `${location?.pathname || ''}?${params.toString()}`
}

/** Market coverage per wrapper (capture-rwa-wrappers-read.ts, marketCoverage). */
const COVERAGE_LABELS = {
  tradeable: 'Tradeable',
  priced_not_traded: 'Priced, not traded',
  listed_only: 'Listed only',
  no_tracked_market: 'No tracked market',
}
/** Only the coverage reasons the State column does not already say. A missing
 * price or volume is stated there, once. */
const COVERAGE_REASONS = {
  not_in_catalogue: 'Not in the market catalogue, so no market count of ours confirms it. The provider\'s own volume is shown beside it.',
  not_in_current_catalogue: 'Not in the market catalogue\'s current refresh, so no current market count of ours confirms it. The provider\'s own volume is shown beside it.',
  no_market_pairs: 'The market catalogue counts no market pairs for this wrapper.',
  pair_count_not_reported: 'The market catalogue has not reported a pair count for this wrapper.',
  volume_reported_zero: 'The provider reports zero 24 hour volume.',
  catalogue_unavailable: 'The market catalogue could not be read, so market coverage was not assessed.',
}
/** Why a pick could not be named, where the board's own reasons do not say it. */
const PICK_REASONS = {
  no_priced_wrapper: 'No wrapper carries both a premium and a reported volume.',
  no_anchor: 'There is no anchor to measure a premium against.',
}
const PICK_LABELS = {
  cheapest: 'Cheapest to its anchor',
  closest: 'Closest to its anchor',
  mostLiquid: 'Most traded',
}

const ANCHOR_LABELS = {
  published_nav: 'Published NAV',
  liquid_wrapper_median: 'Liquid wrapper median',
  none: 'No anchor',
}
const STATE_LABELS = {
  liquid: 'Anchors the reference',
  too_thin_to_anchor: 'Too thin to anchor',
  volume_not_reported: 'No volume reported',
  no_price: 'No price reported',
  unit_not_established: 'Unit not established',
  accrues_in_price: 'Accrues in price',
  derivative_reference: 'Derivative price, not a wrapper',
}
const UNIT_LABELS = {
  consistent: 'Same unit as its peers',
  normalised_troy_ounce: 'Priced per gram, restated per troy ounce',
  normalised_gram: 'Priced per troy ounce, restated per gram',
  not_established: 'Unit not established',
  not_assessed: 'Unit not assessed',
}

// ── The underlying stock reference ──────────────────────────────────────────
// BESIDE the anchor, never instead of it: the listed share's own price from a
// Chainlink on-chain feed, read at the moment the wrapper prices were observed
// (underlying-reference.ts). The feed only writes a new price after a move of
// its stated band, so a gap inside that band is said to be not distinguishable
// rather than printed as a premium.

/** The US session at the moment the prices were compared. */
const SESSION_LABELS = {
  regular: 'regular session',
  pre_market: 'pre-market',
  after_hours: 'after-hours',
  closed: 'market closed',
  weekend: 'weekend, market closed',
  holiday: 'NYSE holiday, market closed',
  unknown: 'session not known',
}
/** Why a stock reference was not used, in words. */
const REFERENCE_REASONS = {
  feed_read_failed: 'The feed could not be read over its public RPC.',
  feed_identity_not_proved: 'The feed did not prove its identity on chain, so its price was not used.',
  feed_round_unusable: 'The feed returned no usable price.',
  round_at_observation_not_read: 'The feed price in effect when the wrapper prices were observed could not be read.',
  wrapper_observation_time_unknown: 'The provider gave no time for the wrapper prices, so there is no moment to read the stock at.',
  stale_in_session: 'The feed had not updated within its heartbeat while the market was open, so it was not used.',
  stale_off_session: 'The feed\'s last update is older than any scheduled market closure explains, so it was not used.',
}

/** How long before the comparison the feed last moved, in the largest whole unit. */
export function referenceAge(t, seconds) {
  const s = num(seconds)
  if (s == null || s < 0) return null
  if (s < 5400) return t('underlying_ref.age_minutes', { value: Math.max(1, Math.round(s / 60)), defaultValue: '{{value}} min' })
  if (s < 172800) return t('underlying_ref.age_hours', { value: Math.round(s / 3600), defaultValue: '{{value}} h' })
  return t('underlying_ref.age_days', { value: Math.round(s / 86400), defaultValue: '{{value}} d' })
}

/** A feed's deviation band as a percent figure, e.g. 0.5 or 0.3. */
export const bandLabel = value => {
  const n = num(value)
  return n == null ? null : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function sessionLabel(t, session) {
  const key = String(session || 'unknown')
  return t(`underlying_ref.session_${key}`, { defaultValue: SESSION_LABELS[key] || key })
}

/** The one line under an asset's name on the board. Null for an asset the
 * reference does not apply to (a commodity) or a capture from before it existed. */
export function referenceShort(t, ref) {
  if (!ref || typeof ref !== 'object') return null
  if (ref.state === 'observed') {
    return t('underlying_ref.short', { ticker: ref.ticker, price: formatPrice(ref.price), defaultValue: 'Underlying {{ticker}}: {{price}}' })
  }
  if (ref.state === 'no_reference') return t('underlying_ref.none', { defaultValue: 'No stock reference for this ticker yet.' })
  if (ref.state === 'mapping_refused') return t('underlying_ref.refused_short', { defaultValue: 'No stock reference: the ticker could not be confirmed as the US listing.' })
  return t('underlying_ref.unavailable_short', { defaultValue: 'Stock reference unavailable in this capture.' })
}

/** The full statement for an opened asset: the price, the feed, its age and
 * session, its band, and the anchor against it. Plain text, no chips. */
export function UnderlyingReferenceNote({ reference: ref, t, bps = 'bps' }) {
  if (!ref || typeof ref !== 'object') return null
  const muted = 'text-[11px] text-[var(--fg-4)] max-w-[80ch] mt-1'
  if (ref.state === 'no_reference') return <p className={muted}>{t('underlying_ref.none', { defaultValue: 'No stock reference for this ticker yet.' })}</p>
  if (ref.state === 'mapping_refused') {
    return <p className={muted}>{t('underlying_ref.refused', { defaultValue: 'No stock reference: the provider\'s ticker for this asset could not be confirmed as the company\'s US listing, so no stock price is compared.' })}</p>
  }
  if (ref.state !== 'observed') {
    const why = REFERENCE_REASONS[ref.reason] ? t(`underlying_ref.reason_${ref.reason}`, { defaultValue: REFERENCE_REASONS[ref.reason] }) : (ref.reason || '')
    return <p className={muted}>{t('underlying_ref.unavailable', { reason: why, defaultValue: 'Stock reference unavailable in this capture. {{reason}} No gap to the stock is reported.' })}</p>
  }
  const band = bandLabel(ref.deviationPct)
  const outsideRegular = ref.session && ref.session !== 'regular'
  const extended = ref.hours === 'us_equities_24_5'
  const extendedSession = ['pre_market', 'after_hours', 'closed'].includes(ref.session)
  return (
    <p className={muted}>
      {t('underlying_ref.line', {
        ticker: ref.ticker,
        price: formatPrice(ref.price),
        feed: ref.feed || '',
        network: ref.networkLabel || ref.network || '',
        age: referenceAge(t, ref.ageSeconds) || '—',
        at: utcMinute(ref.comparedAt) || '—',
        session: sessionLabel(t, ref.session),
        defaultValue: 'Underlying {{ticker}}: {{price}}, Chainlink {{feed}} on {{network}}, updated {{age}} before the wrapper prices were observed at {{at}}, {{session}}.',
      })}
      {band != null && ` ${t('underlying_ref.band', {
        band,
        band_bps: widthLabel(num(ref.deviationPct) * 100, bps),
        defaultValue: 'The feed updates on a {{band}}% move, so gaps under {{band_bps}} are not distinguishable.',
      })}`}
      {extended && ` ${t('underlying_ref.note_24_5', { defaultValue: 'This feed also follows extended and overnight trading on weekdays.' })}`}
      {outsideRegular && !(extended && extendedSession) && ` ${t('underlying_ref.note_last_session', { defaultValue: 'Outside the regular session this is the feed\'s last update from when the market was open, not a live price.' })}`}
      {num(ref.anchorBps) != null && ` ${ref.anchorWithinBand === true
        ? t('underlying_ref.anchor_within', { band, defaultValue: 'The anchor is within the feed\'s {{band}}% update band of the stock, so the two are not distinguishable.' })
        : t('underlying_ref.anchor_gap', { value: bpsLabel(ref.anchorBps, bps), defaultValue: 'The anchor sits {{value}} against the stock.' })}`}
      {` ${t('underlying_ref.caveat', { defaultValue: 'A gap to the stock compares one token with one share. It does not adjust for dividends a wrapper may have reinvested, and it is not a tradable arbitrage.' })}`}
    </p>
  )
}

/** One wrapper against the stock. Inside the feed's band the figure is not a
 * premium, so the words lead and the measured gap follows in small type. */
export function VsStockCell({ token, band, t, bps = 'bps' }) {
  const value = num(token?.underlyingRefBps)
  if (value == null) return '—'
  if (token.underlyingRefWithinBand === true) {
    return (
      <span>
        {t('underlying_ref.within_band', { band, defaultValue: 'Within the feed\'s {{band}}% update band, not distinguishable' })}
        <span className="block text-[11px] text-[var(--fg-4)]">{t('underlying_ref.measured', { value: bpsLabel(value, bps), defaultValue: 'Measured {{value}}' })}</span>
      </span>
    )
  }
  return bpsLabel(value, bps)
}

/** `showHeading` is false when a PAGE already carries the eyebrow, the title and
 * the intro in its own header (RwaWrapperPage does), so the reader is not shown
 * the same three things twice. It stays true by default: embedded in a section of
 * another page, the figure has to name itself. */
export default function RwaWrapperSpread({ showHeading = true }) {
  const { t, i18n } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's own
  // authenticated client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })
  // Expanded rows are keyed by the ASSET, not by a position in the list, so a
  // reader who opens Gold and then re-sorts the board still has Gold open.
  const [open, setOpen] = useState(() => new Set())
  // Two orders, both client side over the rows already read: one for the asset
  // board and one shared by every expanded wrapper table, so the per-wrapper
  // columns mean the same thing in every open row.
  const [assetOrder, setAssetOrder] = useState({ sort: ASSET_DEFAULT_SORT, dir: 'desc' })
  const [tokenOrder, setTokenOrder] = useState({ sort: TOKEN_DEFAULT_SORT, dir: 'desc' })
  const location = useLocation()
  const assetSort = useColumnSort({
    sort: assetOrder.sort, dir: assetOrder.dir, setSort: setAssetOrder,
    defaultSort: ASSET_DEFAULT_SORT, initialDir: key => (ASCENDING_FIRST.has(key) ? 'asc' : 'desc'),
  })
  const tokenSort = useColumnSort({
    sort: tokenOrder.sort, dir: tokenOrder.dir, setSort: setTokenOrder,
    defaultSort: TOKEN_DEFAULT_SORT, initialDir: key => (ASCENDING_FIRST.has(key) ? 'asc' : 'desc'),
  })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('rwa_wrappers', {}, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase])

  const payload = read.payload || {}
  const rows = useMemo(() => (Array.isArray(payload.rows) ? payload.rows : []), [payload])
  const points = useMemo(() => (Array.isArray(payload.points) ? payload.points : []), [payload])
  const reconciliation = useMemo(() => (Array.isArray(payload.reconciliation) ? payload.reconciliation : []), [payload])
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {}
  const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {}
  const captureTime = payload.schedule?.rwa_wrappers?.utc || '02:47, 08:47, 14:47, 20:47'
  const bps = t('rwa_wrappers.bps_unit', { defaultValue: 'bps' })
  const floor = num(settings.volumeFloorUsd) ?? 250000
  const bandLow = num(settings.reconcileBandLow) ?? 0.85
  const bandHigh = num(settings.reconcileBandHigh) ?? 1.15

  // The dots, and the band the premium axis is drawn in. Both derive from the
  // same list in one place so the axis, the pinned dots and the count under the
  // chart can never describe different sets.
  const chartPoints = useMemo(() => points.map(point => ({
    key: point.key,
    label: `${point.assetSymbol || point.assetName || ''} · ${point.symbol || point.name || point.cryptoId}`,
    x: num(point.x) ?? 0,
    y: num(point.y) ?? 0,
    // Colour carries the one distinction the corner labels used to spell out:
    // does this wrapper count toward its asset's anchor or not.
    tone: point.inAnchor === true ? 'accent' : 'muted',
  })), [points])
  const band = useMemo(() => premiumBand(chartPoints.map(point => point.y)), [chartPoints])

  // The board in the reader's chosen order. The chart and every count above read
  // `rows`, which is order independent, so re-sorting the table moves nothing
  // else on the page.
  const orderedRows = useMemo(
    () => sortRows(rows, { key: assetSort.sort, dir: assetSort.dir, accessor: row => ASSET_SORTS[assetSort.sort]?.(row) ?? null }),
    [rows, assetSort.sort, assetSort.dir],
  )
  const orderTokens = tokens => sortRows(tokens, {
    key: tokenSort.sort, dir: tokenSort.dir, accessor: token => TOKEN_SORTS[tokenSort.sort]?.(token) ?? null,
  })

  const toggle = id => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const anchorLabel = kind => t(`rwa_wrappers.anchor_${kind}`, { defaultValue: ANCHOR_LABELS[kind] || kind })
  const stateLabel = state => t(`rwa_wrappers.state_${state}`, { defaultValue: STATE_LABELS[state] || state })
  const unitLabel = unit => t(`rwa_wrappers.unit_${unit}`, { defaultValue: UNIT_LABELS[unit] || unit })
  const coverageLabel = state => (state
    ? t(`rwa_wrapper_coverage.state_${state}`, { defaultValue: COVERAGE_LABELS[state] || state })
    : t('rwa_wrapper_coverage.state_unassessed', { defaultValue: 'Not assessed' }))
  const coverageReason = code => (COVERAGE_REASONS[code]
    ? t(`rwa_wrapper_coverage.reason_${code}`, { defaultValue: COVERAGE_REASONS[code] })
    : null)
  const pickReason = code => (PICK_REASONS[code]
    ? t(`rwa_wrapper_picks.reason_${code}`, { defaultValue: PICK_REASONS[code] })
    : reasonText(t, code))

  // The CSV is the board as the reader has it ordered: assets in the board's
  // order, and inside each one the wrappers in the expanded tables' order. The
  // licence flag comes from the read itself and fails closed.
  const downloadCsv = () => downloadTableCsv({
    view: 'rwa_wrappers',
    asOf: payload.asOf || null,
    columns: WRAPPER_CSV_COLUMNS,
    rows: wrapperCsvRows(orderedRows, { asOf: payload.asOf || null, orderTokens }),
    exportAllowed: payload.sourcePolicy?.exportAllowed === true,
  })

  // The provenance envelope for the whole board. `stored`, because every figure
  // here is read back from rows a scheduled lane already wrote: opening the page
  // makes no provider call, and the clock is the capture's, not this read's.
  const envelope = payload.asOf
    ? { kind: 'stored', source: 'coinmarketcap', freshness: 'cached', fetchedAt: payload.asOf, scope: payload.scope || null }
    : null

  const columns = [
    { key: 'asset', align: 'left', label: t('rwa_wrappers.col_asset', { defaultValue: 'Underlying asset' }) },
    { key: 'wrappers', align: 'right', label: t('rwa_wrappers.col_wrappers', { defaultValue: 'Wrappers' }) },
    { key: 'anchor', align: 'right', label: t('rwa_wrappers.col_anchor', { defaultValue: 'Anchor' }) },
    { key: 'premium', align: 'right', label: t('rwa_wrappers.col_premium', { defaultValue: 'Widest premium' }) },
    { key: 'discount', align: 'right', label: t('rwa_wrappers.col_discount', { defaultValue: 'Widest discount' }) },
    { key: 'dispersion', align: 'right', label: t('rwa_wrappers.col_dispersion', { defaultValue: 'Dispersion' }) },
    // Volume before the route: the numeric columns then run together and the one
    // wide text column is last, so the table degrades by scrolling the named
    // route out of view rather than by clipping a figure in the middle of it.
    { key: 'volume', align: 'right', label: t('rwa_wrappers.col_volume', { defaultValue: '24h tokenised volume' }) },
    // The route's own figure is its premium, which is what the cell prints under
    // the token name, so that is what the header sorts on.
    { key: 'cheapest', align: 'left', label: t('rwa_wrappers.col_cheapest', { defaultValue: 'Cheapest liquid route' }), title: t('rwa_wrappers.col_cheapest_sort', { defaultValue: 'Cheapest liquid route, ordered by its premium in basis points' }) },
  ]
  const tokenColumns = [
    { key: 'token', align: 'left', label: t('rwa_wrappers.col_token', { defaultValue: 'Wrapper' }) },
    { key: 'issuer', align: 'left', label: t('rwa_wrappers.col_issuer', { defaultValue: 'Issuer' }) },
    { key: 'price', align: 'right', label: t('rwa_wrappers.col_price', { defaultValue: 'Price' }) },
    { key: 'premium', align: 'right', label: t('rwa_wrappers.col_premium_bps', { defaultValue: 'Premium' }) },
    { key: 'token_volume', align: 'right', label: t('rwa_wrappers.col_token_volume', { defaultValue: '24h volume' }) },
    // A reading, not a figure, so not sortable, like the State column.
    { key: null, id: 'coverage', align: 'left', label: t('rwa_wrapper_coverage.col', { defaultValue: 'Coverage' }) },
    { key: null, id: 'state', align: 'left', label: t('rwa_wrappers.col_note', { defaultValue: 'State' }) },
  ]
  // The gap to the listed share sits right after the premium to the anchor, and
  // only on an asset whose stock reference was observed in this capture.
  const vsStockColumn = { key: 'vs_stock', align: 'right', label: t('underlying_ref.col_vs_stock', { defaultValue: 'vs stock' }) }
  const hasReference = row => row?.underlyingReference?.state === 'observed'
  const tokenColumnsFor = row => (hasReference(row) ? [...tokenColumns.slice(0, 4), vsStockColumn, ...tokenColumns.slice(4)] : tokenColumns)

  return (
    <section className="intel-rwa-wrappers space-y-6" aria-label={t('rwa_wrappers.title', { defaultValue: 'Wrapper premium and dispersion' })}>
      {showHeading && (
        <div>
          <div className="eyebrow">{t('rwa_wrappers.eyebrow', { defaultValue: 'Our calculation' })}</div>
          <h3 className="text-lg font-medium mt-1">{t('rwa_wrappers.title', { defaultValue: 'Wrapper premium and dispersion' })}</h3>
          <p className="text-[11px] leading-relaxed text-[var(--fg-4)] mt-1 max-w-[80ch]">
            {t('rwa_wrappers.intro', {
              floor: formatUsd(floor),
              defaultValue: 'One real-world asset is often wrapped by several tokens from several issuers, at several prices. Each premium or discount below is our own calculation against the anchor named on that row. Today that anchor is always the volume-weighted median of the wrappers that cleared a {{floor}} floor on reported 24 hour volume: no asset here is mapped to a fund\'s own published net asset value yet, and one that is will be measured against that value instead. A wrapper under that floor is still shown, marked as too thin to anchor, and left out of the anchor. A premium is not a tradable arbitrage.',
            })}
          </p>
        </div>
      )}

      {read.status === 'loading' && <p role="status">{t('rwa_wrappers.loading', { defaultValue: 'Reading the captured wrapper prices…' })}</p>}

      {read.status === 'unavailable' && (
        <p role="alert">
          {t('rwa_wrappers.unavailable', {
            reason: captureReasonText(t, read.reason),
            defaultValue: 'The wrapper board could not be read. {{reason}} No premium is asserted for any wrapper.',
          })}
        </p>
      )}

      {read.status === 'ready' && (
        <>
          {/* The board's own data time, stated like every section's: the capture
              every row below was read from, in UTC with its age. */}
          {payload.asOf && (
            <p className="text-[12px] text-[var(--fg-3)]" data-testid="rwa-wrappers-as-of">
              CoinMarketCap · {t('rwa_wrappers.as_of_label', { defaultValue: 'Wrapper capture' })} · <AsOfTime value={payload.asOf} />
              {/* The quotes' own last_updated. CoinMarketCap refreshes RWA quotes
                  less often than the lane runs, so a capture can hold older prices. */}
              {payload.pricesObservedAt && payload.pricesObservedAt !== payload.asOf && (
                <> · {t('rwa_wrappers.prices_observed_label', { defaultValue: 'Prices last updated by CoinMarketCap' })} · <AsOfTime value={payload.pricesObservedAt} /></>
              )}
            </p>
          )}

          {payload.reason && (
            <p role="status" className="text-[12px]">
              {t('rwa_wrappers.partial', { reason: payload.reason, defaultValue: 'Part of this read did not answer ({{reason}}). What did load is shown, and nothing was replaced with a zero.' })}
            </p>
          )}

          {!payload.asOf && (
            <p role="status" className="text-[12px]">
              {t('rwa_wrappers.not_captured', { times: captureTime, defaultValue: 'No wrapper capture has been stored yet. The capture runs four times a day at {{times}}.' })}
            </p>
          )}

          {payload.asOf && rows.length === 0 && (
            <p role="status" className="text-[12px]">
              {t('rwa_wrappers.no_multi_wrapper', { defaultValue: 'The last capture found no tokenised asset carrying two or more wrappers, so there is nothing to compare. Assets with a single wrapper are covered by the RWA universe figure.' })}
            </p>
          )}

          {rows.length > 0 && (
            <>
              <p className="text-[12px]">
                {t('rwa_wrappers.summary', {
                  assets: num(summary.assets) ?? rows.length,
                  wrappers: num(summary.wrappers) ?? 0,
                  thin: num(summary.thin) ?? 0,
                  normalised: num(summary.unitNormalised) ?? 0,
                  accruing: num(summary.accruing) ?? 0,
                  // Written as labelled counts rather than a sentence with
                  // plural nouns: "1 assets" is wrong in English and the
                  // agreement rules differ again in every other locale.
                  defaultValue: 'Assets: {{assets}}. Wrappers: {{wrappers}}. Too thin to anchor: {{thin}}. Price unit restated: {{normalised}}. Accruing inside the token price, so carrying an accrual gap rather than a premium: {{accruing}}.',
                })}
              </p>

              {/* One dot per wrapper: how deep it trades against how far it sits
                  from its asset's anchor. The premium axis is linear because it
                  is signed and a log scale cannot carry a discount. Volume is
                  never negative and spans five orders of magnitude, so it is
                  logarithmic: on a linear axis nearly every wrapper sat in a
                  sliver at zero and the floor line could not be seen. The
                  horizontal divider at zero IS the anchor.
                  `wide`, because this figure spans the whole page: the 440 box
                  would be magnified to fill it and its labels with it. */}
              <Scatter
                wide
                title={t('rwa_wrappers.chart_title', { defaultValue: 'Premium against depth, one dot per wrapper' })}
                description={`${t('rwa_wrappers.chart_sub', {
                  floor: formatUsd(floor),
                  low: widthLabel(band.low, bps),
                  high: widthLabel(band.high, bps),
                  defaultValue: 'Each dot is one wrapper of one asset. The horizontal line is its asset\'s anchor; above it the wrapper is dearer than the anchor, below it cheaper. The vertical line is the {{floor}} volume floor: dots left of it are shown but do not anchor anything. The premium axis is bounded at {{low}} and {{high}}, the padded 5th to 95th percentile of the plotted premiums, so one broken wrapper cannot flatten every other one onto the anchor line.',
                })} ${t('rwa_wrappers.chart_log_note', { defaultValue: 'Volume is on a log scale: each gridline is ten times the one before. A wrapper with no reported volume sits on the left edge.' })}`}
                points={chartPoints}
                logX
                logY={false}
                yDomain={[band.low, band.high]}
                xLabel={t('rwa_wrappers.chart_x_log', { defaultValue: 'Reported 24h volume (USD, log scale)' })}
                yLabel={t('rwa_wrappers.chart_y', { unit: bps, defaultValue: 'Premium to anchor ({{unit}})' })}
                /* The dividers stay; their meaning moved into the key below, so
                   no label is drawn on top of the dots it describes. */
                quadrants={{ x: floor, y: 0 }}
                legend={[
                  { key: 'anchor', tone: 'accent', label: t('rwa_wrappers.legend_anchor', { defaultValue: 'Anchors the reference: its volume clears the floor' }) },
                  { key: 'thin', tone: 'muted', label: t('rwa_wrappers.legend_thin', { defaultValue: 'Too thin to anchor: shown, left out of the anchor' }) },
                ]}
                formatX={volumeTick}
                formatY={value => (num(value) == null ? '—' : Math.round(num(value)).toLocaleString())}
                state={points.length ? 'ready' : 'error'}
                kind="no_data"
                reason={t('rwa_wrappers.chart_empty', { defaultValue: 'No wrapper in this capture carries both a premium and a reported volume, so there is nothing to plot.' })}
              />
              {/* Never a silent truncation: a wrapper the axis cannot hold is
                  drawn on the edge and said out loud, with its exact premium a
                  row away in the table below. Written as a labelled count rather
                  than a sentence with a plural noun, like the summary above. */}
              {band.outside > 0 && (
                <p className="text-[12px]">
                  {t('rwa_wrappers.chart_outside', {
                    count: band.outside,
                    defaultValue: 'Wrappers whose premium sits beyond that range, drawn on the edge of the chart: {{count}}. Each one is in the table below, with its own premium.',
                  })}
                </p>
              )}

              <div className="intel-table-scroll">
                <table className="intel-rwa-wrapper-table w-full text-[12px]">
                  <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
                    {t('rwa_wrappers.table_caption', {
                      at: formatUtcTime(payload.asOf, i18n?.language) || '—',
                      defaultValue: 'Widest dispersion first, from the capture of {{at}}. Open a row to read its wrappers.',
                    })}
                    {' '}
                    <button type="button" className="intel-text-link" onClick={downloadCsv}>
                      {t('rwa_wrapper_picks.download_csv', { defaultValue: 'Download CSV' })}
                    </button>
                  </caption>
                  <thead>
                    <tr>
                      {/* The two alignments are written out rather than passed
                          through a variable, so this header row stays readable
                          to check-intel-table-alignment.mjs, which is a text
                          scan and cannot follow `align={column.align}`. */}
                      {columns.map(column => (column.align === 'right'
                        ? <SortableHeader key={column.key} sortKey={column.key} label={column.label} title={column.title} sort={assetSort.sort} dir={assetSort.dir} onToggle={assetSort.toggle} align="right" />
                        : <SortableHeader key={column.key} sortKey={column.key} label={column.label} title={column.title} sort={assetSort.sort} dir={assetSort.dir} onToggle={assetSort.toggle} align="left" />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orderedRows.map(row => {
                      const href = assetHref(row)
                      const expanded = open.has(row.rwaId)
                      const cheapest = row.tokens.find(token => token.cryptoId === row.cheapestCryptoId) || null
                      return (
                        <React.Fragment key={row.rwaId}>
                          <tr>
                            <th scope="row" className={`${cell} text-left font-normal`}>
                              <span className="flex items-center gap-2">
                                <TokenAvatar src={row.logoUrl} symbol={row.symbol} name={row.name} size="sm" />
                                <span>
                                  {href
                                    ? <Link className="intel-text-link" to={href}>{row.name || row.symbol || row.rwaId}</Link>
                                    : <span>{row.name || row.symbol || row.rwaId}</span>}
                                  <span className="block text-[11px] text-[var(--fg-4)]">
                                    {[row.symbol, row.assetType ? String(row.assetType).replaceAll('_', ' ') : null].filter(Boolean).join(' · ')}
                                  </span>
                                  {referenceShort(t, row.underlyingReference) && (
                                    <span className="block text-[11px] text-[var(--fg-4)]">{referenceShort(t, row.underlyingReference)}</span>
                                  )}
                                </span>
                              </span>
                            </th>
                            <td className={numCell}>
                              {row.wrapperCount}
                              <button
                                type="button"
                                className="intel-text-link block text-[11px] ml-auto"
                                aria-expanded={expanded}
                                onClick={() => toggle(row.rwaId)}
                              >
                                {expanded
                                  ? t('rwa_wrappers.collapse', { defaultValue: 'Hide wrappers' })
                                  : t('rwa_wrappers.expand', { defaultValue: 'Show wrappers' })}
                              </button>
                            </td>
                            <td className={numCell}>
                              {row.anchorPrice == null ? '—' : formatPrice(row.anchorPrice)}
                              <span className="block text-[11px] text-[var(--fg-4)]">{anchorLabel(row.anchorKind)}</span>
                            </td>
                            <td className={numCell}>{bpsLabel(row.widestPremiumBps, bps) || '—'}</td>
                            <td className={numCell}>{bpsLabel(row.widestDiscountBps, bps) || '—'}</td>
                            <td className={numCell}>
                              {widthLabel(row.dispersionBps, bps) || '—'}
                              {row.weightedSpreadBps != null && (
                                <span className="block text-[11px] text-[var(--fg-4)]">
                                  {t('rwa_wrappers.weighted', { value: widthLabel(row.weightedSpreadBps, bps), defaultValue: 'Volume weighted {{value}}' })}
                                </span>
                              )}
                            </td>
                            <td className={numCell}>{row.tokenizedVolume24h == null ? '—' : formatUsd(row.tokenizedVolume24h)}</td>
                            <td className={cell}>
                              {cheapest
                                ? <span className="flex items-center gap-2">
                                    {/* The route is a TOKEN, so it carries the token's own
                                        catalogue logo, not the underlying asset's. */}
                                    <TokenAvatar src={cheapest.logoUrl} fallbackSrc={cheapest.fallbackLogoUrl} symbol={cheapest.symbol} name={cheapest.name} size="sm" />
                                    <span>
                                      {wrapperHref(cheapest)
                                        ? <Link className="intel-text-link" to={wrapperHref(cheapest)}>{cheapest.symbol || cheapest.name}</Link>
                                        : <span>{cheapest.symbol || cheapest.name}</span>}
                                      <span className="block text-[11px] text-[var(--fg-4)]">{bpsLabel(row.cheapestPremiumBps, bps)}</span>
                                    </span>
                                  </span>
                                : <span className="text-[11px] text-[var(--fg-4)]">{reasonText(t, row.anchorReason) || t('rwa_wrappers.no_route', { defaultValue: 'No liquid wrapper to name as a route.' })}</span>}
                            </td>
                          </tr>
                          {expanded && (
                            <tr>
                              <td colSpan={columns.length} className={`${rule} py-3 pr-3`}>
                                <p className="text-[11px] text-[var(--fg-4)] max-w-[80ch]">
                                  {row.anchorMeaning}
                                  {row.anchorReason ? ` ${reasonText(t, row.anchorReason)}` : ''}
                                </p>
                                <UnderlyingReferenceNote reference={row.underlyingReference} t={t} bps={bps} />
                                {overTimeHref(location, row.rwaId) && (
                                  <p className="text-[11px] mt-1">
                                    <Link className="intel-text-link" to={overTimeHref(location, row.rwaId)}>
                                      {t('rwa_wrapper_picks.over_time', { defaultValue: 'Over time' })}
                                    </Link>
                                  </p>
                                )}
                                {/* The provider's wrapper rows carry no chain, so
                                    the chain is not a column here: a column of
                                    "not reported" would be a wall of dashes. The
                                    wrapper link opens its asset page, which does
                                    carry the chain. */}
                                <p className="text-[11px] text-[var(--fg-4)] mt-1">
                                  {t('rwa_wrappers.no_chain', { defaultValue: 'The provider reports no chain on a wrapper row. Open a wrapper to read its network on its asset page.' })}
                                </p>
                                <div className="intel-table-scroll mt-2">
                                  <table className="w-full text-[12px]">
                                    <thead>
                                      <tr>
                                        {tokenColumnsFor(row).map(column => (!column.key
                                          ? <StaticHeader key={column.id} label={column.label} align="left" />
                                          : column.align === 'right'
                                            ? <SortableHeader key={column.key} sortKey={column.key} label={column.label} sort={tokenSort.sort} dir={tokenSort.dir} onToggle={tokenSort.toggle} align="right" />
                                            : <SortableHeader key={column.key} sortKey={column.key} label={column.label} sort={tokenSort.sort} dir={tokenSort.dir} onToggle={tokenSort.toggle} align="left" />
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {orderTokens(row.tokens).map(token => (
                                        <tr key={token.cryptoId}>
                                          <th scope="row" className={`${cell} text-left font-normal`}>
                                            <span className="flex items-center gap-2">
                                              <TokenAvatar src={token.logoUrl} fallbackSrc={token.fallbackLogoUrl} symbol={token.symbol} name={token.name} size="xs" />
                                              <span>
                                                {wrapperHref(token)
                                                  ? <Link className="intel-text-link" to={wrapperHref(token)}>{token.name || token.symbol}</Link>
                                                  : <span>{token.name || token.symbol}</span>}
                                                <span className="block text-[11px] text-[var(--fg-4)]">{token.symbol}</span>
                                              </span>
                                            </span>
                                          </th>
                                          <td className={cell}>{token.issuerName || t('rwa_wrappers.issuer_unreported', { defaultValue: 'Issuer not reported' })}</td>
                                          <td className={numCell}>
                                            {token.price == null ? '—' : formatPrice(token.price)}
                                            {token.normalisedPrice != null && token.unitState !== 'consistent' && token.unitState !== 'not_assessed' && (
                                              <span className="block text-[11px] text-[var(--fg-4)]">
                                                {t('rwa_wrappers.restated', { value: formatPrice(token.normalisedPrice), defaultValue: 'Restated {{value}}' })}
                                              </span>
                                            )}
                                          </td>
                                          <td className={numCell}>
                                            {token.premiumBps != null
                                              ? bpsLabel(token.premiumBps, bps)
                                              : token.accrualGapBps != null
                                                ? <span>{t('rwa_wrappers.accrual', { value: bpsLabel(token.accrualGapBps, bps), defaultValue: '{{value}} accrual' })}</span>
                                                : '—'}
                                          </td>
                                          {hasReference(row) && (
                                            <td className={numCell}>
                                              <VsStockCell token={token} band={bandLabel(row.underlyingReference.deviationPct)} t={t} bps={bps} />
                                            </td>
                                          )}
                                          <td className={numCell}>{token.volume24h == null ? '—' : formatUsd(token.volume24h)}</td>
                                          <td className={cell}>
                                            {coverageLabel(token.coverageState)}
                                            {num(token.marketPairs) != null && (
                                              <span className="block text-[11px] text-[var(--fg-4)]">
                                                {t('rwa_wrapper_coverage.pairs', { count: num(token.marketPairs), defaultValue: 'Market pairs: {{count}}' })}
                                              </span>
                                            )}
                                            {coverageReason(token.coverageReason) && (
                                              <span className="block text-[11px] text-[var(--fg-4)]">{coverageReason(token.coverageReason)}</span>
                                            )}
                                          </td>
                                          <td className={cell}>
                                            {stateLabel(token.state)}
                                            {token.unitState !== 'consistent' && (
                                              <span className="block text-[11px] text-[var(--fg-4)]">{unitLabel(token.unitState)}</span>
                                            )}
                                            {token.reason && (
                                              <span className="block text-[11px] text-[var(--fg-4)]">{reasonText(t, token.reason)}</span>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                {row.picks && <WrapperPicks picks={row.picks} tokens={row.tokens} t={t} bps={bps} stateLabel={stateLabel} pickReason={pickReason} />}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* The two endpoints behind every figure above, and the capture
                  time they were read at. */}
              <FigureProvenance envelope={envelope} />
              <p className="text-[11px] text-[var(--fg-4)] max-w-[80ch]">
                {t('rwa_wrappers.provenance', {
                  quotes: '/v5/real-world-assets/quotes/latest',
                  list: '/v5/real-world-assets/assets/list',
                  at: formatUtcTime(payload.asOf, i18n?.language) || '—',
                  defaultValue: 'Wrapper prices, volumes and issuers come from {{quotes}}. Each asset\'s own reported value comes from {{list}}. Both were read in the capture of {{at}}; the premium, the anchor and the dispersion are our calculation over those two reads.',
                })}
              </p>

              {/* ── Two-endpoint reconciliation ── */}
              <div className="pt-4 border-t border-[var(--border-default)]">
                <div className="eyebrow">{t('rwa_wrappers.recon_eyebrow', { defaultValue: 'Two endpoints' })}</div>
                <h4 className="text-base font-medium mt-1">{t('rwa_wrappers.recon_title', { defaultValue: 'Where the two endpoints disagree' })}</h4>
                <p className="text-[11px] leading-relaxed text-[var(--fg-4)] mt-1 max-w-[80ch]">
                  {t('rwa_wrappers.recon_intro', {
                    low: bandLow.toFixed(2),
                    high: bandHigh.toFixed(2),
                    defaultValue: 'Two endpoints describe the same asset. The list endpoint reports one value for the asset as a whole; the quotes endpoint reports a value for each of its tokens, which we add up. The two should be close, and usually are. Where the ratio of the token sum to the asset value falls outside {{low}} to {{high}}, the row is flagged below with both numbers and both read times. This is a finding about the data, not a claim that either figure is wrong: it says the two endpoints disagree, and it is worth knowing before either number is used on its own.',
                  })}
                </p>
                {reconciliation.length === 0 ? (
                  <p className="text-[12px] mt-2">
                    {t('rwa_wrappers.recon_none', { defaultValue: 'No asset in this capture could be compared across both endpoints: each one was missing a value on one side, which is stated on its row above.' })}
                  </p>
                ) : (
                  <div className="intel-table-scroll mt-2">
                    <table className="w-full text-[12px]">
                      <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
                        {t('rwa_wrappers.recon_caption', {
                          outside: num(summary.reconcileOutside) ?? 0,
                          total: reconciliation.length,
                          defaultValue: '{{outside}} of {{total}} comparable assets fall outside the band. Largest money gap first.',
                        })}
                      </caption>
                      <thead>
                        <BoardTableHeader
                          columns={[
                            t('rwa_wrappers.recon_col_asset', { defaultValue: 'Asset' }),
                            t('rwa_wrappers.recon_col_list', { defaultValue: 'Asset value, list endpoint' }),
                            t('rwa_wrappers.recon_col_tokens', { defaultValue: 'Sum of token values, quotes endpoint' }),
                            t('rwa_wrappers.recon_col_ratio', { defaultValue: 'Ratio' }),
                            t('rwa_wrappers.recon_col_state', { defaultValue: 'Verdict' }),
                          ]}
                          numeric={[1, 2, 3]}
                        />
                      </thead>
                      <tbody>
                        {reconciliation.map(row => (
                          <tr key={row.rwaId}>
                            <th scope="row" className={`${cell} text-left font-normal`}>
                              <span className="flex items-center gap-2">
                                <TokenAvatar src={row.logoUrl} symbol={row.symbol} name={row.name} size="sm" />
                                <span>
                                  {row.name || row.symbol || row.rwaId}
                                  <span className="block text-[11px] text-[var(--fg-4)]">{row.symbol}</span>
                                </span>
                              </span>
                            </th>
                            <td className={numCell}>
                              {row.listTokenizedMarketCap == null ? '—' : formatUsd(row.listTokenizedMarketCap)}
                              <span className="block text-[11px] text-[var(--fg-4)]">{utcMinute(row.listObservedAt) || utcMinute(row.listCapturedAt) || '—'}</span>
                            </td>
                            <td className={numCell}>
                              {row.tokenMarketCapSum == null ? '—' : formatUsd(row.tokenMarketCapSum)}
                              <span className="block text-[11px] text-[var(--fg-4)]">{utcMinute(row.quotesObservedAt) || utcMinute(row.quotesCapturedAt) || '—'}</span>
                            </td>
                            <td className={numCell}>{ratioLabel(row.ratio) || '—'}</td>
                            <td className={cell}>
                              {t(`rwa_wrappers.recon_state_${row.state}`, {
                                defaultValue: row.state === 'agree' ? 'The two endpoints agree' : row.state === 'outside_band' ? 'The two endpoints disagree' : 'Not comparable',
                              })}
                              {row.reason && <span className="block text-[11px] text-[var(--fg-4)]">{reasonText(t, row.reason)}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Attribution, plain text, always rendered once the read succeeded. */}
          <p className="text-[11px] text-[var(--fg-4)]">{t('rwa_wrappers.source', { defaultValue: 'Data: CoinMarketCap' })}</p>
          {rows.some(hasReference) && (
            <p className="text-[11px] text-[var(--fg-4)]">{t('underlying_ref.source', { defaultValue: 'Stock reference: Chainlink on-chain price feeds, read through public RPCs.' })}</p>
          )}
        </>
      )}
    </section>
  )
}

/** Which wrapper to name for one asset, three ways, from the picks the read
 * attached to the row (rwa-wrapper-picks.ts). Three rows in a fixed order, then
 * one line naming every wrapper that was eligible for none of them and why.
 * Nothing here is ranked or computed again: the page and the MCP tool read the
 * same object. */
export function WrapperPicks({ picks, tokens = [], t, bps = 'bps', stateLabel = state => state, pickReason = code => code }) {
  const byId = new Map((Array.isArray(tokens) ? tokens : []).map(token => [token.cryptoId, token]))
  const wrapperCell = pick => {
    const token = byId.get(pick.cryptoId) || pick
    const href = wrapperHref(token)
    const label = pick.symbol || pick.name || pick.cryptoId
    return href ? <Link className="intel-text-link" to={href}>{label}</Link> : <span>{label}</span>
  }
  const rows = ['cheapest', 'closest', 'mostLiquid'].map(key => ({ key, pick: picks?.[key] || { available: false, reason: null } }))
  const excluded = Array.isArray(picks?.excluded) ? picks.excluded : []
  return (
    <div className="mt-3">
      <div className="eyebrow">{t('rwa_wrapper_picks.eyebrow', { defaultValue: 'Picks' })}</div>
      <div className="intel-table-scroll mt-1">
        <table className="intel-rwa-wrapper-picks w-full text-[12px]">
          <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
            {t('rwa_wrapper_picks.caption', { defaultValue: 'Three different questions, three answers from the same capture. Cheapest and closest only consider wrappers that cleared the volume floor. Ties go to the higher volume, then the lower id. Not a recommendation.' })}
          </caption>
          <thead>
            <BoardTableHeader
              columns={[
                t('rwa_wrapper_picks.col_pick', { defaultValue: 'Question' }),
                t('rwa_wrapper_picks.col_wrapper', { defaultValue: 'Wrapper' }),
                t('rwa_wrapper_picks.col_premium', { defaultValue: 'Premium' }),
                t('rwa_wrapper_picks.col_volume', { defaultValue: '24h volume' }),
                t('rwa_wrapper_picks.col_note', { defaultValue: 'Note' }),
              ]}
              numeric={[2, 3]}
            />
          </thead>
          <tbody>
            {rows.map(({ key, pick }) => (
              <tr key={key}>
                <th scope="row" className={`${cell} text-left font-normal`}>
                  {t(`rwa_wrapper_picks.pick_${key}`, { defaultValue: PICK_LABELS[key] })}
                </th>
                {pick.available ? (
                  <>
                    <td className={cell}>{wrapperCell(pick)}</td>
                    <td className={numCell}>{bpsLabel(pick.premiumBps, bps) || '—'}</td>
                    <td className={numCell}>{pick.volume24h == null ? '—' : formatUsd(pick.volume24h)}</td>
                    <td className={`${cell} text-[11px] text-[var(--fg-4)]`}>
                      {key === 'closest' && pick.circular && (
                        <span className="block">
                          {pick.closestOther
                            ? t('rwa_wrapper_picks.circular_other', {
                                other: pick.closestOther.symbol || pick.closestOther.name || pick.closestOther.cryptoId,
                                premium: bpsLabel(pick.closestOther.premiumBps, bps),
                                defaultValue: 'This wrapper set the median it is measured against, so its distance is zero by construction. Nearest other wrapper: {{other}} at {{premium}}.',
                              })
                            : t('rwa_wrapper_picks.circular_alone', { defaultValue: 'This wrapper set the median it is measured against, so its distance is zero by construction. No other liquid wrapper carries a premium.' })}
                        </span>
                      )}
                      {key === 'cheapest' && picks.cheapestMatchesCaptured === false && (
                        <span className="block">
                          {t('rwa_wrapper_picks.tie_note', { defaultValue: 'Tied on premium with the route named on the board; the tie is broken here by volume, then id.' })}
                        </span>
                      )}
                    </td>
                  </>
                ) : (
                  <>
                    <td className={cell}>—</td>
                    <td className={numCell}>—</td>
                    <td className={numCell}>—</td>
                    <td className={`${cell} text-[11px] text-[var(--fg-4)]`}>
                      {pickReason(pick.reason) || t('rwa_wrapper_picks.unavailable', { defaultValue: 'No wrapper qualifies.' })}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-[var(--fg-4)] mt-1 max-w-[80ch]">
        {excluded.length
          ? t('rwa_wrapper_picks.excluded', {
              list: excluded.map(row => `${row.symbol || row.name || row.cryptoId} (${stateLabel(row.state)}: ${pickReason(row.reason)})`).join('; '),
              defaultValue: 'Excluded from picks: {{list}}.',
            })
          : t('rwa_wrapper_picks.excluded_none', { defaultValue: 'Excluded from picks: none. Every wrapper was eligible for at least one question.' })}
      </p>
    </div>
  )
}
