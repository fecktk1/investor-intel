import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { StackedShare } from '../charts'
import { readCaptureView, captureUnavailable } from '../lib/capture-api'
import { formatPct } from '../lib/market-format'

// Index constituents (CMC plan proposal 7). CMC100 and CMC20 side by side as one
// 100% stacked share, so a constituent's weight in the broad index can be read
// against its weight in the concentrated one without a second chart.
//
// The two "times" on the share axis are the two indexes, not two clocks: the
// question this figure answers is "how much more of CMC20 is this name", and
// that is a comparison across indexes at one capture.

const NAMED = 15
const CMC100 = 0
const CMC20 = 1
const INDEX_CODES = ['cmc100', 'cmc20']
const INDEX_LABELS = { cmc100: 'CMC100', cmc20: 'CMC20' }

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// Weights arrive as percentages from one source and as fractions from another,
// so both sides are rescaled to fractions of their own total before they are
// compared. Returns null when nothing usable was supplied — an active share
// against an invented denominator is worse than no number at all.
export function normalizeWeights(input) {
  const raw = {}
  const add = (symbol, weight) => {
    const key = String(symbol ?? '').trim().toUpperCase()
    const value = num(weight)
    if (!key || value == null) return
    raw[key] = (raw[key] || 0) + value
  }
  if (Array.isArray(input)) {
    for (const row of input) add(row?.symbol ?? row?.asset ?? row?.name, row?.weight ?? row?.weightPct ?? row?.value)
  } else if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) add(key, value)
  }
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(total) || total <= 0) return null
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value / total]))
}

// activeShare = ½ Σ |w_portfolio − w_index|, over the union of both holdings
// lists (a name held in one and not the other counts at its full weight).
// Returns a fraction in [0, 1], or null when either side has no weights.
export function activeShare(portfolioWeights, indexWeights) {
  const portfolio = normalizeWeights(portfolioWeights)
  const index = normalizeWeights(indexWeights)
  if (!portfolio || !index) return null
  const keys = new Set([...Object.keys(portfolio), ...Object.keys(index)])
  let sum = 0
  for (const key of keys) sum += Math.abs((portfolio[key] || 0) - (index[key] || 0))
  return sum / 2
}

// One row per constituent with its weight in each index, ordered by the larger
// of the two so the concentrated index cannot be hidden by the broad one.
// Everything past the first `named` rows collapses into a single counted rest.
export function constituentBands(latest = {}, { named = NAMED, otherLabel = count => `Other ${count}` } = {}) {
  const merged = new Map()
  for (const code of INDEX_CODES) {
    for (const row of (Array.isArray(latest?.[code]?.constituents) ? latest[code].constituents : [])) {
      const symbol = String(row?.symbol ?? row?.name ?? row?.id ?? '').trim().toUpperCase()
      if (!symbol) continue
      const current = merged.get(symbol) || { symbol, cmc100: 0, cmc20: 0 }
      current[code] += num(row?.weight) ?? 0
      merged.set(symbol, current)
    }
  }
  const rows = [...merged.values()].sort((a, b) => Math.max(b.cmc100, b.cmc20) - Math.max(a.cmc100, a.cmc20))
  const head = rows.slice(0, named)
  const rest = rows.slice(named)
  const bands = head.map(row => ({
    key: row.symbol,
    label: row.symbol,
    points: [{ t: CMC100, value: row.cmc100 }, { t: CMC20, value: row.cmc20 }],
  }))
  if (rest.length) {
    bands.push({
      key: '__other',
      label: otherLabel(rest.length),
      tone: 'muted',
      points: [
        { t: CMC100, value: rest.reduce((sum, row) => sum + row.cmc100, 0) },
        { t: CMC20, value: rest.reduce((sum, row) => sum + row.cmc20, 0) },
      ],
    })
  }
  return bands
}

export default function IndexConstituents({ weights = null }) {
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
    readCaptureView('index_constituents', {}, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase])

  const latest = read.payload?.latest && typeof read.payload.latest === 'object' ? read.payload.latest : {}
  const bands = constituentBands(latest, {
    otherLabel: count => t('structure.index_other', { count, defaultValue: 'Other {{count}}' }),
  })
  const drawn = bands.some(band => band.points.some(point => (num(point.value) ?? 0) > 0))
  const state = read.status === 'unavailable' ? 'error' : (read.status === 'ready' && drawn) ? 'ready' : 'empty'

  const indexWeights = Object.fromEntries(
    (Array.isArray(latest?.cmc100?.constituents) ? latest.cmc100.constituents : [])
      .map(row => [String(row?.symbol ?? row?.name ?? '').trim().toUpperCase(), num(row?.weight) ?? 0])
      .filter(([symbol]) => symbol),
  )
  const supplied = normalizeWeights(weights)
  const share = supplied ? activeShare(supplied, indexWeights) : null

  return (
    <section className="intel-structure-index space-y-3" aria-label={t('structure.index_title', { defaultValue: 'Index constituents' })}>
      <StackedShare
        title={t('structure.index_title', { defaultValue: 'Index constituents' })}
        description={t('structure.index_sub', { named: NAMED, defaultValue: 'Constituent weight in CMC100 against CMC20 at the latest capture. The {{named}} largest names are labelled; everything else is grouped and counted.' })}
        series={bands}
        formatTime={value => (Number(value) === CMC20 ? INDEX_LABELS.cmc20 : INDEX_LABELS.cmc100)}
        state={state}
        reason={read.reason}
      />
      {state === 'ready' ? (
        <ul className="space-y-1 text-[12px]" aria-label={t('structure.index_values', { defaultValue: 'Index values' })}>
          {INDEX_CODES.filter(code => latest?.[code]).map(code => (
            <li key={code}>
              <span className="text-[var(--fg-4)]">{INDEX_LABELS[code]}</span>{' '}
              <span className="intel-number text-[var(--fg-1)]">{num(latest[code].value) == null ? '—' : Number(latest[code].value).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>{' '}
              <span className="intel-number text-[var(--fg-3)]">{formatPct(num(latest[code].change24hPct))}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-[12px]">
        <span className="text-[var(--fg-4)]">{t('structure.active_share', { defaultValue: 'Active share vs CMC100' })}</span>{' '}
        {share == null ? (
          <span className="text-[var(--fg-3)]">
            {supplied
              ? t('structure.active_share_no_index', { defaultValue: 'The latest capture did not report CMC100 constituent weights.' })
              : t('structure.active_share_none', { defaultValue: 'No portfolio weights available.' })}
          </span>
        ) : (
          <span className="intel-number text-[var(--fg-1)]">{`${(share * 100).toFixed(1)}%`}</span>
        )}
      </p>
    </section>
  )
}
