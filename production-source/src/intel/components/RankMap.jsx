import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { Bump } from '../charts'
import { readCaptureView, captureUnavailable } from '../lib/capture-api'
import { useUrlState } from '../lib/useUrlState'

// Rank map (CMC plan proposal 2). Twelve weekly market-cap rank readings for the
// top N assets, rank 1 at the top. The two things a rank history is actually
// read for — who entered the top N this week and who left it — are stated in
// words under the figure rather than left to be inferred from where a path
// starts or stops.
//
// The capture table is empty until a second week exists; that is an empty
// reading, not a failure, and it says so.

const LIMITS = [10, 25, 50]
const DEFAULT_LIMIT = 25
// Hoisted so useUrlState's memo/callback identities stay stable across renders.
const URL_DEFAULTS = { rm_limit: String(DEFAULT_LIMIT) }

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const weekLabel = ms => {
  const date = new Date(Number(ms))
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const dayLabel = iso => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? String(iso ?? '—') : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Rank 1 first so the movers list reads top-down like the chart.
const byRank = (a, b) => (num(a?.rank) ?? Infinity) - (num(b?.rank) ?? Infinity)

// Weekly points keyed by epoch ms so the Bump chart shares one time axis across
// every series. A point without a parsable date or a finite rank is dropped
// rather than pinned to week zero.
export function rankLines(series = []) {
  return (Array.isArray(series) ? series : []).map((row, index) => ({
    key: row?.providerId ?? row?.symbol ?? index,
    label: row?.symbol || String(row?.providerId ?? '—'),
    providerId: row?.providerId ?? null,
    points: (Array.isArray(row?.points) ? row.points : [])
      .map(point => ({ t: Date.parse(point?.date), rank: num(point?.rank) }))
      .filter(point => Number.isFinite(point.t) && point.rank != null)
      .sort((a, b) => a.t - b.t),
  }))
}

export default function RankMap({ onLoad }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // The capture tables are service-role only, so the read must travel on the
  // reader's authenticated client rather than the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS)
  const limit = LIMITS.includes(Number(urlState.rm_limit)) ? Number(urlState.rm_limit) : DEFAULT_LIMIT
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })
  const [hover, setHover] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('rank_map', { limit }, { orgId, signal: controller.signal, supabase })
      .then(payload => {
        if (!alive) return
        setRead({ status: 'ready', payload, reason: null })
        // Deliberately outside the dependency list: the page uses this to seed
        // the liquidation ids, and a fresh callback identity must not re-read.
        if (typeof onLoad === 'function') onLoad(payload)
      })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, limit, supabase])

  const payload = read.payload
  const lines = useMemo(() => rankLines(payload?.series), [payload])
  const entries = Array.isArray(payload?.entries) ? [...payload.entries].sort(byRank) : []
  const exits = Array.isArray(payload?.exits) ? [...payload.exits].sort(byRank) : []
  const drawn = lines.some(line => line.points.length)

  const state = read.status === 'unavailable' ? 'error' : (read.status === 'ready' && drawn) ? 'ready' : 'empty'
  const reason = read.reason

  const movers = rows => (rows.length
    ? rows.map(row => `${row?.symbol || row?.providerId || '—'} #${num(row?.rank) ?? '—'}`).join(' · ')
    : t('structure.rank_none', { defaultValue: 'None' }))

  return (
    <section className="intel-structure-rank space-y-3" aria-label={t('structure.rank_title', { defaultValue: 'Rank map' })}>
      <Bump
        title={t('structure.rank_title', { defaultValue: 'Rank map' })}
        description={t('structure.rank_sub', { limit, defaultValue: 'Weekly market-cap rank over twelve captured weeks for the top {{limit}} assets. Rank 1 is at the top; hover or focus a path to read its symbol and current rank.' })}
        series={lines}
        maxRank={limit}
        formatTime={weekLabel}
        state={state}
        reason={reason}
        onHover={line => setHover(line ? `${line.label} · #${line.points.at(-1)?.rank ?? '—'}` : '')}
      />
      <p role="status" className="text-[12px] text-[var(--fg-3)] min-h-[1.2em]">{hover}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={t('structure.rank_limit', { defaultValue: 'Ranks shown' })}>
        <span className="text-[var(--fg-4)]">{t('structure.rank_limit', { defaultValue: 'Ranks shown' })}</span>
        {LIMITS.map(value => (
          <button
            key={value}
            type="button"
            aria-pressed={value === limit}
            onClick={() => setUrlState({ rm_limit: String(value) })}
            className={value === limit
              ? 'text-[var(--fg-1)] underline underline-offset-4'
              : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
          >
            {t('structure.rank_limit_option', { limit: value, defaultValue: 'Top {{limit}}' })}
          </button>
        ))}
      </div>
      {state === 'ready' ? (
        <div className="space-y-1 text-[12px]">
          <p>
            <span className="text-[var(--fg-4)]">{t('structure.rank_entries', { defaultValue: 'Entered the top N' })}</span>{' '}
            <span className="text-[var(--fg-2)]">{movers(entries)}</span>
          </p>
          <p>
            <span className="text-[var(--fg-4)]">{t('structure.rank_exits', { defaultValue: 'Left the top N' })}</span>{' '}
            <span className="text-[var(--fg-2)]">{movers(exits)}</span>
          </p>
          <p className="text-[var(--fg-4)]">
            {payload?.previousDate
              ? t('structure.rank_compared', { date: dayLabel(payload.previousDate), defaultValue: 'Compared with the week captured on {{date}}.' })
              : t('structure.rank_no_previous', { defaultValue: 'Only one week has been captured, so there is nothing to compare against yet.' })}
          </p>
        </div>
      ) : null}
    </section>
  )
}
