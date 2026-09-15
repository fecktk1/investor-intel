import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { RadialBars } from '../charts'
import { ChartFrame, ChartTable, markProps, useChartText } from '../charts/frame'
import { TONES, gridStroke, axisText, useReducedMotion } from '../charts/theme'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { useUrlState } from '../lib/useUrlState'
import { formatUsd, fmtNum } from '../lib/market-format'

// Airdrop calendar (CMC plan proposal 27). One row per recorded airdrop, drawn
// from its start date to its end date across a ninety-day window, plus a ring of
// what is still ahead.
//
// Contract: `airdrops` takes { status: ongoing|upcoming|all, days, providerIds }
// and answers { rows, lanes, heldProviderIds, asOf, coverage, reason }. Each row
// carries a `lane` of 'past' | 'live' | 'upcoming' — or null when the provider
// reported neither date nor a status the read recognises. A null lane is kept as
// null: an airdrop with no calendar position is listed, never placed.
// `held` is present on a row ONLY when it is true, so an absent flag is false.
//
// The capture is a daily 05:30 UTC read of the CoinMarketCap airdrop list; until
// it has run at least once the table is empty and the read says so.
//
// HOLDINGS. The read accepts an optional `providerIds` list and marks the rows a
// workspace holds. Intel has no cheap already-loaded source of the org's CMC ids
// (the watchlist and portfolio contexts publish lists, not member ids, and
// resolving them would be a second round trip per render), so this component
// does NOT send `providerIds` by default: it renders the `held` flag the capture
// returns and nothing more. Pass `providerIds` explicitly once a caller has them.

const MS_DAY = 86_400_000
const WINDOW_DAYS = 90
const STATUSES = ['all', 'ongoing', 'upcoming']
const DEFAULT_STATUS = 'all'
const RING_MAX = 8
// Hoisted so useUrlState's memo/callback identities stay stable across renders.
const URL_DEFAULTS = { a_status: DEFAULT_STATUS }

const W = 760, LABEL = 150, PAD = 4, ROW_H = 18, ROW_GAP = 10, AXIS_H = 26

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const time = value => {
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

// Provider dates are CALENDAR dates (a YYYY-MM-DD, or midnight UTC). Rendering
// them in the viewer's zone moves 2026-08-01 to "Jul 31" for anyone west of
// Greenwich, which is a different day, so every date here is read in UTC.
const dayLabel = value => {
  const at = time(value)
  return at == null ? '—' : new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// The same date with its year, for a list that turns out to be years stale.
const calendarDate = value => {
  const at = time(value)
  return at == null ? '—' : new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const LANE_TONES = { live: TONES.green, upcoming: TONES.accent, past: TONES.muted }

/** Every recorded airdrop in one shape, earliest start first and the ones with
 *  no start date last. `lane` stays null when the read could not place the
 *  airdrop on a calendar at all. */
export function airdropRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => {
      const from = time(row?.startDate)
      const to = time(row?.endDate)
      return {
        key: row?.airdropId ?? row?.slug ?? `${row?.projectName ?? 'airdrop'}-${index}`,
        name: row?.projectName || row?.symbol || String(row?.airdropId ?? '—'),
        symbol: row?.symbol || null,
        lane: LANE_TONES[row?.lane] ? row.lane : null,
        // `held` is only present when true; anything else is a workspace that
        // does not hold it, not an unknown.
        held: row?.held === true,
        from,
        to: to != null && from != null && to >= from ? to : from,
        startDate: row?.startDate ?? null,
        endDate: row?.endDate ?? null,
        totalPrize: num(row?.totalPrize),
        winnerCount: num(row?.winnerCount),
      }
    })
    .sort((a, b) => (a.from ?? Infinity) - (b.from ?? Infinity))
}

/** The rows that can actually be drawn. An airdrop with no start date has no
 *  calendar position and is listed in the table only, never pinned to today. */
export function calendarBars(rows = []) {
  return airdropRows(rows).filter(row => row.from != null)
}

/** The window the calendar draws: today through the next ninety days, widened to
 *  hold anything the capture reported outside it. Never narrower than the ninety
 *  days the read asked for, so an empty tail reads as "nothing scheduled" rather
 *  than as a missing axis. */
export function calendarWindow(rows = [], now = Date.now()) {
  const starts = []
  const ends = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const from = time(row?.startDate)
    const to = time(row?.endDate)
    if (from != null) starts.push(from)
    if (to != null) ends.push(to)
    else if (from != null) ends.push(from)
  }
  return {
    from: Math.min(now, ...starts),
    to: Math.max(now + WINDOW_DAYS * MS_DAY, ...ends),
  }
}

/** The upcoming ring. Ranked by prize pool when the capture reports one; when no
 *  upcoming airdrop carries a prize the ring counts them instead of ranking them
 *  by a number nobody published. */
export function upcomingRing(rows = []) {
  const upcoming = (Array.isArray(rows) ? rows : []).filter(row => row?.lane === 'upcoming')
  const priced = upcoming.filter(row => (num(row?.totalPrize) ?? 0) > 0)
  const label = row => row?.projectName || row?.symbol || String(row?.airdropId ?? '—')
  if (!priced.length) {
    return {
      mode: 'count',
      series: upcoming.slice(0, RING_MAX).map((row, index) => ({
        key: row?.airdropId ?? row?.slug ?? index,
        label: label(row),
        value: 1, max: 1,
        tone: row?.held === true ? 'green' : 'accent',
      })),
    }
  }
  const ceiling = Math.max(...priced.map(row => num(row.totalPrize) ?? 0))
  return {
    mode: 'prize',
    series: priced
      .slice()
      .sort((a, b) => (num(b?.totalPrize) ?? 0) - (num(a?.totalPrize) ?? 0))
      .slice(0, RING_MAX)
      .map((row, index) => ({
        key: row?.airdropId ?? row?.slug ?? index,
        label: label(row),
        value: num(row.totalPrize) ?? 0,
        max: ceiling,
        tone: row?.held === true ? 'green' : 'accent',
      })),
  }
}

// The calendar lane itself: native SVG in the chart kit's frame, one row per
// placed airdrop, five date ticks and a today line. The table twin lists every
// recorded airdrop, including the ones that could not be placed.
function CalendarLane({ bars, listed, window: range, now, unplaced, lanes, recordedLine, emptyNote, state, reason, laneName }) {
  const text = useChartText()
  const reduced = useReducedMotion()
  const [active, setActive] = useState(null)
  const span = Math.max(1, range.to - range.from)
  const plot = W - LABEL - PAD
  const x = at => LABEL + ((Math.min(Math.max(at, range.from), range.to) - range.from) / span) * plot
  const height = PAD * 2 + Math.max(1, bars.length) * (ROW_H + ROW_GAP) + AXIS_H
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(share => range.from + share * span)

  const focused = bars.find(bar => bar.key === active) || null
  const readout = focused
    ? text('airdrops.lane_readout', {
        name: focused.name,
        lane: laneName(focused.lane),
        from: dayLabel(focused.startDate),
        to: focused.endDate ? dayLabel(focused.endDate) : text('airdrops.lane_open', { defaultValue: 'no end date reported' }),
        defaultValue: '{{name}} · {{lane}} · {{from}} → {{to}}',
      })
    : ''

  const title = text('airdrops.lane_title', { defaultValue: 'Airdrop calendar' })
  // ChartFrame prints its empty line through the `t` it is handed, so a figure
  // that knows WHY it is empty answers that one key with its own sentence. The
  // shared kit is not touched, and every other key still resolves normally.
  const frameText = (key, options) => (key === 'charts.empty' && emptyNote ? emptyNote : text(key, options))
  const counts = lanes
    ? ` ${text('airdrops.lane_counts', {
        live: lanes.live ?? 0, upcoming: lanes.upcoming ?? 0, past: lanes.past ?? 0,
        defaultValue: '{{live}} live, {{upcoming}} still ahead, {{past}} closed.',
      })}`
    : ''

  return (
    <ChartFrame
      t={frameText}
      title={title}
      description={`${text('airdrops.lane_sub', {
        days: WINDOW_DAYS,
        defaultValue: 'Every recorded airdrop over the next {{days}} days, one row per airdrop, drawn from its start date to its end date. Green is live, gold is still ahead, grey has closed. A filled dot marks an airdrop this workspace holds.',
      })} ${text('airdrops.lane_clock', { defaultValue: 'The airdrop list is captured once a day at 05:30 UTC.' })}${counts}${recordedLine ? ` ${recordedLine}` : ''}${unplaced
        ? ` ${text('airdrops.lane_unplaced', { count: unplaced, defaultValue: '{{count}} recorded airdrops report no start date and are listed in the table only.' })}`
        : ''}`}
      state={state}
      reason={reason}
      readout={<p className="intel-chart-kit-readout" aria-live="polite">{readout}</p>}
      table={
        <ChartTable
          t={text}
          caption={title}
          columns={[
            text('airdrops.col_project', { defaultValue: 'Project' }),
            text('airdrops.col_lane', { defaultValue: 'Lane' }),
            text('airdrops.col_start', { defaultValue: 'Start' }),
            text('airdrops.col_end', { defaultValue: 'End' }),
            text('airdrops.col_prize', { defaultValue: 'Prize pool' }),
            text('airdrops.col_winners', { defaultValue: 'Winners' }),
            text('airdrops.col_held', { defaultValue: 'Held' }),
          ]}
          rows={listed.map(row => [
            row.name,
            laneName(row.lane),
            dayLabel(row.startDate),
            row.endDate ? dayLabel(row.endDate) : '—',
            row.totalPrize == null ? '—' : formatUsd(row.totalPrize),
            fmtNum(row.winnerCount),
            row.held ? text('airdrops.held_yes', { defaultValue: 'Held' }) : '—',
          ])}
        />
      }
    >
      <svg viewBox={`0 0 ${W} ${height}`} role="img"
        aria-label={`${title}. ${bars.length}. ${text('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
        {ticks.map((at, i) => (
          <g key={at}>
            <line x1={x(at)} x2={x(at)} y1={PAD} y2={height - AXIS_H} stroke={gridStroke} strokeDasharray="2 6" />
            <text x={x(at)} y={height - 8} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'} fill={axisText}>
              {dayLabel(new Date(at).toISOString())}
            </text>
          </g>
        ))}
        {/* Today, so "ahead" and "behind" are read off the figure, not inferred. */}
        <line x1={x(now)} x2={x(now)} y1={PAD} y2={height - AXIS_H} stroke="var(--fg-1)" strokeWidth="1.5" />
        {bars.map((bar, i) => {
          const y = PAD + i * (ROW_H + ROW_GAP)
          const x0 = x(bar.from)
          const x1 = x(bar.to)
          const width = Math.max(2, x1 - x0)
          return (
            <g key={bar.key}
              {...markProps({
                label: `${bar.name} ${dayLabel(bar.startDate)} ${laneName(bar.lane)}${bar.held ? ` ${text('airdrops.held_yes', { defaultValue: 'Held' })}` : ''}`,
                onActivate: () => setActive(bar.key), reduced,
              })}
              onMouseEnter={() => setActive(bar.key)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(bar.key)}
              onBlur={() => setActive(null)}
              data-lane={bar.lane || 'unplaced'}
              data-held={bar.held ? 'true' : 'false'}
              opacity={active != null && active !== bar.key ? 0.45 : 1}
            >
              <title>{`${bar.name} · ${dayLabel(bar.startDate)} → ${bar.endDate ? dayLabel(bar.endDate) : '—'}`}</title>
              <text x="0" y={y + ROW_H - 4} className="intel-chart-strong">{bar.name}</text>
              <rect x={x0} y={y} width={width} height={ROW_H} fill={LANE_TONES[bar.lane] || TONES.muted} fillOpacity="0.8" stroke={gridStroke} />
              {bar.held ? <circle cx={x0} cy={y + ROW_H / 2} r="4" fill="var(--fg-1)" /> : null}
            </g>
          )
        })}
      </svg>
    </ChartFrame>
  )
}

export default function AirdropCalendar({ providerIds, now = Date.now() }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's authenticated
  // client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS)
  const status = STATUSES.includes(urlState.a_status) ? urlState.a_status : DEFAULT_STATUS
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  const idKey = Array.isArray(providerIds) ? providerIds.filter(id => id != null && id !== '').join(',') : ''

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    const params = { status, days: WINDOW_DAYS }
    // Omitted unless a caller actually supplied ids: an empty list would be a
    // claim that the workspace holds nothing, which is not what we know.
    if (idKey) params.providerIds = idKey.split(',')
    readCaptureView('airdrops', params, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, status, idKey, supabase])

  const payload = read.payload
  const rows = useMemo(() => (Array.isArray(payload?.rows) ? payload.rows : []), [payload])
  const listed = useMemo(() => airdropRows(rows), [rows])
  const bars = useMemo(() => listed.filter(row => row.from != null), [listed])
  const range = useMemo(() => calendarWindow(rows, now), [rows, now])
  const ring = useMemo(() => upcomingRing(rows), [rows])
  const unplaced = listed.length - bars.length

  // `recorded` counts what the provider's list holds WHATEVER its dates, so an
  // empty window can be told apart from an empty list. The live CoinMarketCap
  // airdrop list answers an ongoing/upcoming request with campaigns that ended
  // years ago; every one of them falls outside the ninety days and the read is
  // empty. "No observations are available" would be true and useless — the
  // figure says what was recorded and how far out of date it is instead.
  const recorded = payload?.recorded && typeof payload.recorded === 'object' ? payload.recorded : null
  const recordedTotal = num(recorded?.total)
  const outsideWindow = num(recorded?.outsideWindow)
  const newestEndDate = recorded?.newestEndDate || null

  // An empty airdrop table answers with no rows and NO reason — an empty
  // reading. A reason on a successful read is a failed query behind it.
  const stated = read.status === 'unavailable' ? read.reason : (read.status === 'ready' ? (payload?.reason || null) : null)
  const reason = stated ? captureReasonText(t, stated) : undefined
  const laneState = stated ? 'error' : (read.status === 'ready' && bars.length) ? 'ready' : 'empty'
  const ringState = stated ? 'error' : (read.status === 'ready' && ring.series.length) ? 'ready' : 'empty'

  // Nothing recorded at all keeps the kit's own wording: "empty" is then the
  // whole truth. Rows recorded but none in the window is a different reading.
  const emptyNote = (!stated && read.status === 'ready' && !listed.length && (recordedTotal ?? 0) > 0)
    ? (newestEndDate
        ? t('airdrops.lane_stale', {
            total: fmtNum(recordedTotal), days: WINDOW_DAYS, date: calendarDate(newestEndDate),
            defaultValue: "The provider's airdrop list holds {{total}} entries, none inside the next {{days}} days; the newest ended on {{date}}.",
          })
        : t('airdrops.lane_stale_undated', {
            total: fmtNum(recordedTotal), days: WINDOW_DAYS,
            defaultValue: "The provider's airdrop list holds {{total}} entries, none inside the next {{days}} days, and none reports an end date.",
          }))
    : null

  // Said on the figure whenever the list is wider than what is drawn, so a short
  // calendar is never mistaken for a short list.
  const recordedLine = (recordedTotal != null && recordedTotal !== listed.length)
    ? t('airdrops.lane_recorded', {
        total: fmtNum(recordedTotal), outside: fmtNum(outsideWindow ?? Math.max(0, recordedTotal - listed.length)),
        defaultValue: 'Recorded: {{total}} airdrops, {{outside}} outside this window.',
      })
    : ''

  const ringText = (key, options) => (key === 'charts.empty' && emptyNote ? emptyNote : t(key, options))
  const ringTitle = t('airdrops.ring_title', { defaultValue: 'Still ahead' })
  // A ring with no arcs is not "no prize pools were reported" — it is nothing
  // ahead at all, and says that rather than borrowing the count-mode sentence.
  const ringDescription = !ring.series.length
    ? t('airdrops.ring_sub_none', { defaultValue: 'Nothing the capture recorded starts inside this window.' })
    : ring.mode === 'prize'
      ? t('airdrops.ring_sub_prize', { defaultValue: 'Upcoming airdrops ranked by the prize pool the capture reported, largest on the outer ring. Airdrops with no reported pool are not ranked here and stay in the calendar table.' })
      : t('airdrops.ring_sub_count', { defaultValue: 'No upcoming airdrop carries a reported prize pool, so the ring counts them instead of ranking them: one equal arc per airdrop still ahead.' })

  const laneName = lane => (lane === 'live'
    ? t('airdrops.lane_live', { defaultValue: 'Live' })
    : lane === 'past'
      ? t('airdrops.lane_past', { defaultValue: 'Closed' })
      : lane === 'upcoming'
        ? t('airdrops.lane_upcoming', { defaultValue: 'Upcoming' })
        : t('airdrops.lane_unknown', { defaultValue: 'Not placed' }))

  return (
    <section className="intel-airdrop-calendar space-y-3" aria-label={t('airdrops.lane_title', { defaultValue: 'Airdrop calendar' })}>
      <CalendarLane
        bars={bars}
        listed={listed}
        window={range}
        now={now}
        unplaced={unplaced > 0 ? unplaced : 0}
        lanes={payload?.lanes || null}
        recordedLine={recordedLine}
        emptyNote={emptyNote}
        state={laneState}
        reason={reason}
        laneName={laneName}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={t('airdrops.status', { defaultValue: 'Airdrops read' })}>
        <span className="text-[var(--fg-4)]">{t('airdrops.status', { defaultValue: 'Airdrops read' })}</span>
        {STATUSES.map(value => (
          <button
            key={value}
            type="button"
            aria-pressed={value === status}
            onClick={() => setUrlState({ a_status: value })}
            className={value === status
              ? 'text-[var(--fg-1)] underline underline-offset-4'
              : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
          >
            {value === 'all'
              ? t('airdrops.status_all', { defaultValue: 'All' })
              : value === 'ongoing'
                ? t('airdrops.status_ongoing', { defaultValue: 'Ongoing' })
                : t('airdrops.status_upcoming', { defaultValue: 'Upcoming' })}
          </button>
        ))}
      </div>

      {/* A ring with nothing to draw renders the SAME frame RadialBars would —
          ChartFrame draws only its state line when it is not ready — but through
          a `t` that answers the empty key with the reason this window is empty.
          The shared chart kit is not modified to do it. */}
      {ringState === 'ready' ? (
        <RadialBars
          title={ringTitle}
          description={ringDescription}
          series={ring.series}
          formatValue={ring.mode === 'prize' ? formatUsd : fmtNum}
          state="ready"
        />
      ) : (
        <ChartFrame t={ringText} title={ringTitle} description={ringDescription} state={ringState} reason={reason} />
      )}
    </section>
  )
}
