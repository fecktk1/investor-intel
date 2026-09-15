import React, { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useSupabase } from '../../lib/useSupabase'
import { getChain } from '../lib/chains'
import { timeAgo } from '../lib/market-format'
import TokenAvatar from './TokenAvatar'

// "Recently discovered" — the newest assets on-demand indexing has turned into
// shared records, read from public.intel_recently_discovered (security_invoker,
// SELECT to authenticated).
//
// The strip is a community read, not a personal one. The ledger underneath it
// (market_asset_demand) carries an asset key, its counters and its in-use window
// and has no user, org or session column at all, so there is no per-person
// information here to show or to withhold — the count is how often the product
// has been asked about an asset by anyone.
//
// Visual language matches the rest of the Markets page: an eyebrow, hairline
// rows, no pills and no cards.

export const DISCOVERED_COLUMNS =
  'asset_key, provider, provider_id, symbol, name, image_url, cached_image_url, first_demanded_at, last_demanded_at, demand_count, in_use_until'

// The view already caps at the newest 50 demands; the strip shows the newest 12.
export const DISCOVERED_LIMIT = 12

// A contract demand's provider_id is already '<chain>:<address>'.
const contractParts = providerId => {
  const separator = providerId.indexOf(':')
  return separator === -1
    ? { chain: '', address: providerId }
    : { chain: providerId.slice(0, separator), address: providerId.slice(separator + 1) }
}

// The route format is the resolver's own assetRoute(): a CoinMarketCap identity
// opens by its provider id, a contract identity by '<chain>:<address>'. The
// symbol is the path label only, so a row indexing has not named yet still
// routes — by id or address, never by a guessed ticker.
export function discoveredRoute(row) {
  const providerId = row?.provider_id == null ? '' : String(row.provider_id)
  if (!providerId) return null
  if (row.provider === 'coinmarketcap') {
    return `/intel/markets/${encodeURIComponent(row.symbol || providerId)}?provider=coinmarketcap&id=${encodeURIComponent(providerId)}`
  }
  const { address } = contractParts(providerId)
  return `/intel/markets/${encodeURIComponent(row.symbol || address)}?provider=contract&id=${encodeURIComponent(providerId)}`
}

// Secondary text: the indexed name when there is one, otherwise the chain a
// contract lives on, named the way chains.js names it.
export function discoveredSubtitle(row) {
  if (row?.name) return row.name
  if (!row || row.provider === 'coinmarketcap') return ''
  const { chain } = contractParts(String(row.provider_id || ''))
  if (!chain) return ''
  return getChain(chain)?.label || chain
}

export function discoveredLabel(row) {
  if (row?.symbol) return row.symbol
  const providerId = row?.provider_id == null ? '' : String(row.provider_id)
  if (!providerId) return '—'
  return row.provider === 'coinmarketcap' ? providerId : contractParts(providerId).address || providerId
}

const inUse = (value, now) => {
  if (!value) return false
  const until = new Date(value).getTime()
  return Number.isFinite(until) && until > now
}

function DiscoveredRow({ row, now }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const location = useLocation()
  const route = discoveredRoute(row)
  const subtitle = discoveredSubtitle(row)
  // A zero count is a real count: it is rendered, never hidden or blanked.
  const count = Number.isFinite(Number(row?.demand_count)) ? Number(row.demand_count) : '—'
  const body = (
    <>
      <TokenAvatar src={row?.cached_image_url} fallbackSrc={row?.image_url} symbol={row?.symbol} name={row?.name} size="sm" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-[13px] font-medium text-[var(--fg-1)]">{discoveredLabel(row)}</span>
        {subtitle ? <span className="ml-2 text-[12px] text-[var(--fg-4)]">{subtitle}</span> : null}
      </span>
      {inUse(row?.in_use_until, now)
        ? <span className="intel-event-meta whitespace-nowrap text-[var(--ok)]">{t('discovered.in_use', { defaultValue: 'in use' })}</span>
        : null}
      <span className="intel-event-meta whitespace-nowrap">
        {t('discovered.first_seen', { defaultValue: 'first seen {{when}}', when: timeAgo(row?.first_demanded_at) })}
      </span>
      <span className="intel-number text-[12px] text-[var(--fg-3)]" title={t('discovered.demand_label', { defaultValue: 'Times resolved' })}>{count}</span>
    </>
  )
  return (
    <li className="border-t border-[var(--border-default)]">
      {route
        ? <Link to={route} state={{ from: location.pathname + location.search }} className="flex items-center gap-3 py-2 transition-colors hover:bg-[var(--bg-2)]">{body}</Link>
        : <span className="flex items-center gap-3 py-2">{body}</span>}
    </li>
  )
}

export default function RecentlyDiscovered({ limit = DISCOVERED_LIMIT }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { supabase } = useSupabase()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true); setError(null)
    // Building the query inside the chain: an unusable client is this strip's own
    // named failure, never a thrown effect that takes the Markets screen with it.
    Promise.resolve()
      .then(() => supabase.from('intel_recently_discovered').select(DISCOVERED_COLUMNS).order('last_demanded_at', { ascending: false }).limit(limit))
      .then(result => {
        if (!alive) return
        // A PostgREST error is a named failure on the page, never an empty strip.
        if (result?.error) { setRows(null); setError(result.error.message || 'read_failed'); return }
        setRows(Array.isArray(result?.data) ? result.data : [])
      })
      .catch(readError => { if (alive) { setRows(null); setError(readError?.message || 'read_failed') } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [supabase, limit, retry])

  const heading = t('discovered.heading', { defaultValue: 'Recently discovered' })
  const now = Date.now()

  return (
    <section className="intel-recently-discovered space-y-2 pt-4" aria-label={heading}>
      <div className="eyebrow">{heading}</div>
      <p className="intel-event-meta">
        {t('discovered.subtitle', { defaultValue: 'Assets someone resolved for the first time, now indexed for everyone. These are counts of how often each asset was asked for — who asked is never recorded.' })}
      </p>
      {loading ? (
        <p role="status" className="py-2 text-[12px] text-[var(--fg-4)]">{t('discovered.loading', { defaultValue: 'Loading recent discoveries…' })}</p>
      ) : error ? (
        <p role="alert" className="py-2 text-[12px] text-[var(--fg-3)]">
          {t('discovered.failed', { defaultValue: 'Recent discoveries could not be loaded.' })}{' '}
          <span className="intel-event-meta">{error}</span>{' '}
          <button type="button" className="intel-text-link" onClick={() => setRetry(value => value + 1)}>{t('common.retry', { defaultValue: 'Retry' })}</button>
        </p>
      ) : !rows?.length ? (
        <p className="py-2 text-[12px] text-[var(--fg-4)]">{t('discovered.empty', { defaultValue: 'Nothing discovered yet' })}</p>
      ) : (
        <ul className="intel-discovered-rows">
          {rows.map((row, index) => <DiscoveredRow key={`${row?.asset_key ?? ''}-${index}`} row={row} now={now} />)}
        </ul>
      )}
    </section>
  )
}
