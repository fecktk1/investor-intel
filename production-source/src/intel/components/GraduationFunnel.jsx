import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import BoardTableHeader, { BOARD_CELL_CLASS } from './BoardTableHeader'
import { Histogram, RadialBars } from '../charts'
import { ChartFrame } from '../charts/frame'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { useUrlState } from '../lib/useUrlState'
import { useColumnSort } from '../lib/useColumnSort'
import { GRADUATION_NEAR_PCT, HISTORY_CAPTURES, LAUNCHPADS, PAD_CHAINS, PAD_LABELS, padOptionLabel } from '../lib/launchpads'
import { formatUsd, fmtNum } from '../lib/market-format'
import RateInterval from './thesis/RateInterval'
import LaunchpadBoard, { BOARD_DEFAULT_SORT, BOARD_SORT_KEYS } from './LaunchpadBoard'
import GraduationStageLists from './GraduationStageLists'
import {
  AssetName, ContractCell, MEME_CHAINS, chainCaip, chainLabel, num, padLabel, stamp,
} from './GraduationCells'

// Meme graduation lifecycle. The hourly launch-stage capture read as a funnel, a
// per-launchpad board, three stage lists, a cohort graduation rate, a
// time-to-graduate distribution and a retention table.
//
// THREE CAPTURE LANES WRITE THE SAME TWO TABLES. `launchpad_stages` reads real
// launchpads on Solana, BNB Chain, Base and Robinhood Chain through CoinGecko's
// onchain API; `sunpump_stages` reads SunPump's launch log straight off TRON
// through TronGrid, because SunPump has no dex id for the CoinGecko lane to ask
// for; `meme_stages` reads the CoinMarketCap DEX launch lists. Every row carries
// the lane that first wrote it, so `sources[]` can say which of them the window
// actually holds instead of leaving a reader to assume.
//
// Contract: `meme_graduation` takes { days: 1|7|30, chain?, launchpad? } —
// `chain` is a CAIP chain and `launchpad` a launchpad id (a dex id for the two
// registry lanes, a bare pad id for a chain-log one), each omitted for "all" —
// and answers { funnel, graduationRate, cohort, timeToGraduate, retention,
// recent, launchpads, chains, sources, captures, attribution, asOf, coverage,
// reason }. BOTH filters are applied in the DATABASE, so a filtered window is
// the newest rows OF THAT FILTER and every figure below narrows with it.
//
// WHAT THE NUMBERS MEAN, because they mean nothing without it:
//
//   funnel          the stage board of the NEWEST capture only, never a sum over
//                   the window. `contracts` is a bounded sample of the stage, not
//                   the stage.
//   graduationRate  a COHORT rate: of the contracts FIRST SEEN inside the window,
//                   how many reached the graduates list inside the same window.
//                   Null when nothing was first seen — an unmeasurable rate is
//                   never drawn as a zero.
//   timeToGraduate  hours between OUR first sighting and the graduation
//                   transition. Neither provider publishes a clock for a
//                   discovery list, so `captured_at` is our capture hour: every
//                   hour figure here is time since we first saw the contract, not
//                   since it was deployed.
//   retention       `eligible` counts only the contracts that have HAD H hours
//                   since their own first sighting, so a contract first seen
//                   twenty minutes ago cannot fail a 24-hour test.
//   captures        how many distinct capture HOURS the window holds. A
//                   transition, a rate and a distribution are all MOVEMENT
//                   between captures, so a one-capture window has none of them by
//                   construction. The page reads well with one capture — the
//                   funnel, the board's stage counts and the three lists are all
//                   facts of a single observation — and says plainly where a
//                   figure is waiting on history rather than drawing a zero.
//
// THE TWO HONEST EMPTY STATES, which are not the same sentence.
//   * A capture exists (`asOf` is a time) and the lanes reported empty lists for
//     this filter. That is a successful read: "the capture ran and reported no
//     launches for this filter".
//   * NOTHING has ever been captured (`asOf` is null): the lane has not run yet,
//     or the provider has been refusing it. Then the page says only that no
//     capture is stored and points at the capture receipts above, which carry the
//     last attempt, its time and the status the provider gave it. It never claims
//     anything was "reported", because nothing was.
// Neither state is an error, and neither fabricates a funnel; the headings, the
// controls, the receipts, the board and every table stay on the page in both.
//
// ATTRIBUTION IS NOT OPTIONAL. CoinGecko's paid terms require a visible "Powered
// by CoinGecko" notice, font size at least 10, wherever this data is shown. It
// travels on the read payload and is rendered as plain text at the foot of this
// section: always visible, never inside a details element, never behind a state.

const DAYS = [1, 7, 30]
const DEFAULT_DAYS = 7
export const STAGES = ['newCreations', 'aboutGraduates', 'graduates']
export { MEME_CHAINS, chainCaip, chainLabel }
const DEFAULT_CHAIN = 'all'
const DEFAULT_PAD = 'all'
const RECENT_MAX = 25
const PAD_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/
/** The capture lanes that write these two tables. A lane absent from `sources`
 *  wrote nothing into the window, and that is a fact worth printing. */
const LANES = ['coingecko', 'trongrid', 'coinmarketcap']
// Hoisted so useUrlState's memo/callback identities stay stable across renders.
const URL_DEFAULTS = {
  g_days: String(DEFAULT_DAYS), g_chain: DEFAULT_CHAIN, g_pad: DEFAULT_PAD,
  g_sort: BOARD_DEFAULT_SORT, g_dir: 'desc',
}

const optionOf = (options, raw, fallback) => (options.includes(Number(raw)) ? Number(raw) : fallback)

/** The three stages in launch order, whatever order the read returned them in
 *  and whichever of them the newest capture happened to hold. `max` is the
 *  LARGEST stage count, so the outer ring is the widest stage and the rings below
 *  it are read as shares of it. A stage the capture did not report is a zero on a
 *  board that has other stages — not a missing ring. */
export function funnelSeries(funnel = []) {
  const rows = Array.isArray(funnel) ? funnel.filter(row => row && row.stage) : []
  if (!rows.length) return []
  const counts = new Map(rows.map(row => [row.stage, num(row.count) ?? 0]))
  const ceiling = Math.max(1, ...STAGES.map(stage => counts.get(stage) ?? 0))
  return STAGES.map(stage => ({
    key: stage,
    stage,
    label: stage,
    value: counts.get(stage) ?? 0,
    max: ceiling,
  }))
}

/** The time-to-graduate histogram in the chart kit's bin shape. The read owns
 *  the edges — fixed hour buckets with the last one open-ended — and they are
 *  passed straight through: re-deriving bins here would quietly disagree with the
 *  source that published them. An empty bucket stays in the answer as a zero
 *  rather than closing the gap and implying a denser distribution. */
export function histogramBins(timeToGraduate) {
  const bins = Array.isArray(timeToGraduate?.histogram) ? timeToGraduate.histogram : []
  return bins.map(bin => {
    const from = num(bin?.fromHours) ?? 0
    // A null upper edge is the open-ended last bucket, not a zero.
    const to = num(bin?.toHours)
    return { key: `${from}-${to ?? 'open'}`, from, to, count: num(bin?.count) ?? 0 }
  })
}

const hours = value => (num(value) == null ? '—' : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`)

export default function GraduationFunnel({ onSources }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's authenticated
  // client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS)
  const days = optionOf(DAYS, urlState.g_days, DEFAULT_DAYS)
  // A chain this page names is carried as the app id it shows; one it was handed
  // by the read and does not name is carried as the CAIP it already is. Anything
  // that resolves to neither is not forwarded to the read at all.
  const chain = urlState.g_chain === 'all' ? 'all' : (chainCaip(urlState.g_chain) ? urlState.g_chain : DEFAULT_CHAIN)
  const caip = chainCaip(chain)
  const pad = urlState.g_pad !== 'all' && PAD_SHAPE.test(String(urlState.g_pad ?? '')) ? urlState.g_pad : DEFAULT_PAD
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    // `chain` and `launchpad` are omitted, never sent as null: an explicit null
    // is a filter the read would have to interpret, and "all" is the absence of
    // one.
    const params = { days, ...(caip ? { chain: caip } : {}), ...(pad !== 'all' ? { launchpad: pad } : {}) }
    readCaptureView('meme_graduation', params, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, days, caip, pad, supabase])

  const payload = read.payload
  const funnelRows = useMemo(() => (Array.isArray(payload?.funnel) ? payload.funnel : []), [payload])
  const funnel = useMemo(() => funnelSeries(payload?.funnel), [payload])
  const bins = useMemo(() => histogramBins(payload?.timeToGraduate), [payload])
  const retention = useMemo(() => (Array.isArray(payload?.retention) ? payload.retention : []), [payload])
  const recent = useMemo(() => (Array.isArray(payload?.recent) ? payload.recent.slice(0, RECENT_MAX) : []), [payload])
  const pads = useMemo(() => (Array.isArray(payload?.launchpads) ? payload.launchpads : []), [payload])
  const sources = useMemo(() => (Array.isArray(payload?.sources) ? payload.sources : []), [payload])
  const cohort = payload?.cohort && typeof payload.cohort === 'object' ? payload.cohort : null
  const ttg = payload?.timeToGraduate && typeof payload.timeToGraduate === 'object' ? payload.timeToGraduate : null
  const captures = num(payload?.captures) ?? 0

  // A chain or a launchpad the read named once stays on its control afterwards.
  // A FILTERED read names only the group it was filtered to, so a control rebuilt
  // from each answer would drop every other option the moment a reader used one
  // and leave no way back out.
  const [seenChains, setSeenChains] = useState({})
  const [seenPads, setSeenPads] = useState({})
  useEffect(() => {
    const groups = Array.isArray(payload?.chains) ? payload.chains : []
    if (!groups.length) return
    setSeenChains(prev => {
      let changed = false
      const next = { ...prev }
      for (const group of groups) {
        if (!group?.key || next[group.key]) continue
        next[group.key] = group.label || group.key
        changed = true
      }
      return changed ? next : prev
    })
  }, [payload])
  useEffect(() => {
    if (!pads.length) return
    setSeenPads(prev => {
      let changed = false
      const next = { ...prev }
      for (const group of pads) {
        if (!group?.key || next[group.key]) continue
        next[group.key] = { label: group.label || group.key, chain: group.chain || null }
        changed = true
      }
      return changed ? next : prev
    })
  }, [pads])

  const chainOptions = useMemo(() => {
    const options = MEME_CHAINS.map(value => ({
      value,
      caip: chainCaip(value),
      label: value === 'all' ? t('graduation.chain_all', { defaultValue: 'All chains' }) : chainLabel(chainCaip(value)),
    }))
    const known = new Set(options.map(option => option.caip).filter(Boolean))
    for (const [key, label] of Object.entries(seenChains)) {
      if (known.has(key)) continue
      known.add(key)
      options.push({ value: key, caip: key, label: label || chainLabel(key) })
    }
    return options
  }, [seenChains, t])

  const padOptions = useMemo(() => {
    const list = []
    const seen = new Set()
    for (const entry of LAUNCHPADS) {
      if (caip && entry.chain !== caip) continue
      list.push(entry)
      seen.add(entry.key)
    }
    for (const [key, entry] of Object.entries(seenPads)) {
      if (seen.has(key)) continue
      if (caip && entry?.chain && entry.chain !== caip) continue
      seen.add(key)
      list.push({ key, label: entry?.label || key, chain: entry?.chain || null })
    }
    // The pad a reader is currently filtered to is always on its own control,
    // whatever chain is selected, so the filter can always be lifted again.
    if (pad !== 'all' && !seen.has(pad)) list.push({ key: pad, label: PAD_LABELS[pad] || pad, chain: PAD_CHAINS[pad] || null })
    return list
  }, [caip, seenPads, pad])

  const { sort, dir, toggle } = useColumnSort({
    sort: BOARD_SORT_KEYS.includes(urlState.g_sort) ? urlState.g_sort : null,
    dir: BOARD_SORT_KEYS.includes(urlState.g_sort) ? urlState.g_dir : null,
    setSort: next => setUrlState({ g_sort: next.sort, g_dir: next.dir }),
    defaultSort: BOARD_DEFAULT_SORT, defaultDir: 'desc',
  })

  // An empty capture answers with an empty funnel and NO reason — that is an
  // empty reading. A reason on a successful read is a failed query behind it.
  const stated = read.status === 'unavailable' ? read.reason : (read.status === 'ready' ? (payload?.reason || null) : null)
  const reason = stated ? captureReasonText(t, stated) : undefined
  const ready = !stated && read.status === 'ready'
  const funnelState = stated ? 'error' : (ready && funnel.length) ? 'ready' : 'empty'
  const binState = stated ? 'error' : (ready && bins.length) ? 'ready' : 'empty'

  // Two different empty states, and they must not borrow each other's sentence.
  // `asOf` is the newest stored capture: with one, the lanes answering EMPTY for
  // this filter is a successful read and the line says so. With NONE, nothing has
  // ever been captured — the lane has not run yet, or the provider has been
  // refusing it — and claiming anything was "reported" would state something we
  // were never told. The receipts drawer above carries the last attempt, its time
  // and the status it received, so the line points at it rather than guessing.
  const captured = ready && payload?.asOf != null
  const emptyNote = (ready && !funnel.length)
    ? (captured
      ? t('graduation.empty_provider', {
          defaultValue: 'The hourly capture ran and reported no launches for this chain and launchpad at the last capture.',
        })
      : t('graduation.empty_never', {
          defaultValue: 'No launch stage capture is stored yet. Capture receipts above shows when the hourly capture last ran and how the provider answered it.',
        }))
    : null
  const frameText = (key, options) => (key === 'charts.empty' && emptyNote ? emptyNote : t(key, options))

  const clock = t('graduation.clock', {
    defaultValue: 'The launch lists are captured once an hour, by the CoinGecko onchain lane across Solana, BNB Chain, Base and Robinhood Chain, by the SunPump lane reading TRON directly, and by the CoinMarketCap lane on its own DEX platforms. No provider publishes a clock for a discovery list, so the capture hour is OURS and every hour figure here is time since WE first saw the contract, not since it was deployed.',
  })
  const historyNote = t('graduation.history_note', {
    captures: HISTORY_CAPTURES,
    defaultValue: 'Stage counts, the lists and the launchpad board read from a single capture. A transition, a graduation rate and a time to graduate are all movement BETWEEN captures, so they appear only once several hourly captures are stored, and until then they are named as waiting on history rather than drawn as a zero.',
  })

  const stageLabel = stage => (stage === 'newCreations'
    ? t('graduation.stage_new', { defaultValue: 'New creations' })
    : stage === 'aboutGraduates'
      ? t('graduation.stage_about', { defaultValue: 'About to graduate' })
      : stage === 'graduates'
        ? t('graduation.stage_graduates', { defaultValue: 'Graduates' })
        : stage || '—')

  const sourceLabel = name => (name === 'coingecko'
    ? t('graduation.source_coingecko', { defaultValue: 'CoinGecko onchain' })
    : name === 'coinmarketcap'
      ? t('graduation.source_coinmarketcap', { defaultValue: 'CoinMarketCap' })
      // The stored source is the API the lane calls; the reader is told which
      // launchpad and which chain that lane is, because "trongrid" is the name
      // of a gateway and not of anything a reader is looking for.
      : name === 'trongrid'
        ? t('graduation.source_trongrid', { defaultValue: 'SunPump on TRON' })
        : String(name || '—'))

  // Every lane that COULD have written, not only the ones that did: a lane
  // absent from `sources` wrote nothing into this window, and saying so is the
  // difference between a quiet lane and a lane nobody looked at.
  const sourceLines = useMemo(() => {
    const named = sources.map(row => row?.source).filter(Boolean)
    const order = [...new Set([...LANES, ...named])]
    return order.map(lane => {
      const row = sources.find(entry => entry?.source === lane)
      return {
        source: lane,
        text: row
          ? t('graduation.source_line', {
              source: sourceLabel(lane), rows: fmtNum(num(row.rows) ?? 0), at: stamp(row.latestCapturedAt),
              defaultValue: '{{source}}: {{rows}} rows in this window, latest capture {{at}}.',
            })
          : t('graduation.source_none', { source: sourceLabel(lane), defaultValue: '{{source}}: no row inside this window.' }),
      }
    })
  }, [sources, t])

  // The page owns the receipts drawer above this figure, so it is handed the
  // lines this read already produced rather than reading the capture tables a
  // second time to say the same thing.
  useEffect(() => { if (typeof onSources === 'function') onSources(sourceLines) }, [onSources, sourceLines])

  const rate = num(payload?.graduationRate)
  const rateLine = !ready
    ? ''
    : rate == null
      ? (captured
        // A window with stage counts but too few captures has not measured a
        // zero, it has not measured anything yet. A window with NO stage counts
        // at all is the empty reading below and keeps its own sentence.
        ? (funnel.length && captures < HISTORY_CAPTURES
          ? t('graduation.rate_pending', {
              captures: fmtNum(captures),
              defaultValue: 'No graduation rate yet: this window holds {{captures}} stored captures, and a graduation is movement between two of them. The stage counts and the lists below are from the newest capture and are complete as they stand.',
            })
          : t('graduation.rate_none', {
              defaultValue: 'No graduation rate: no cohort completed the window, so there is no denominator to measure against.',
            }))
        // Nothing captured is not "no cohort completed the window": there was no
        // window to complete. The same honest line stands in for the rate.
        : emptyNote)
      : t('graduation.rate_line', {
          rate: `${(rate * 100).toFixed(1)}%`,
          graduated: fmtNum(num(cohort?.graduatedInWindow) ?? 0),
          seen: fmtNum(num(cohort?.firstSeenInWindow) ?? 0),
          defaultValue: '{{graduated}} of the {{seen}} contracts first seen inside this window reached the graduates list inside it: {{rate}}.',
        })

  const control = (label, options, current, apply, format) => (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={label}>
      <span className="text-[var(--fg-4)]">{label}</span>
      {options.map(value => (
        <button
          key={value}
          type="button"
          aria-pressed={value === current}
          onClick={() => apply(value)}
          className={value === current
            ? 'text-[var(--fg-1)] underline underline-offset-4'
            : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
        >
          {format(value)}
        </button>
      ))}
    </div>
  )

  // Selecting a chain drops a launchpad that does not live on it. Keeping it
  // would ask the read for a pad on the wrong chain and be answered, correctly
  // and uselessly, with nothing.
  const applyChain = value => {
    const next = chainCaip(value)
    const padChain = pad === 'all' ? null : (PAD_CHAINS[pad] || seenPads[pad]?.chain || null)
    const keep = !next || !padChain || padChain === next
    setUrlState({ g_chain: value, ...(keep ? {} : { g_pad: DEFAULT_PAD }) })
  }

  const funnelTitle = t('graduation.funnel_title', { defaultValue: 'Launch stage funnel' })
  const funnelDescription = `${t('graduation.funnel_sub', {
    defaultValue: 'The stage board of the NEWEST capture only, from new creations through about-to-graduate to graduates. The outer ring is the largest stage; the rings inside it are read as a share of it. This is a snapshot of one hour, never a sum over the window.',
  })} ${clock} ${historyNote}`

  const binTitle = t('graduation.hist_title', { defaultValue: 'Time to graduate' })
  const binDescription = `${t('graduation.hist_sub', {
    defaultValue: 'How long the graduations recorded in this window took, counted from our first sighting of the contract. Fixed hour buckets, the last one open-ended; an empty bucket stays a zero rather than closing the gap.',
  })}${ttg
    ? ` ${t('graduation.hist_percentiles', {
        median: hours(ttg.median), p25: hours(ttg.p25), p75: hours(ttg.p75), sample: fmtNum(num(ttg.sample) ?? 0),
        defaultValue: 'Median {{median}}, 25th percentile {{p25}}, 75th percentile {{p75}}, over {{sample}} recorded graduations.',
      })}`
    : ` ${t('graduation.hist_none', { defaultValue: 'No graduation transition is retained in this window, so there is no distribution to draw.' })}`}`

  const attribution = payload?.attribution && typeof payload.attribution === 'object' ? payload.attribution : null

  return (
    <section className="intel-graduation-funnel space-y-3" aria-label={funnelTitle}>
      {funnelState === 'ready' ? (
        <RadialBars
          title={funnelTitle}
          description={funnelDescription}
          series={funnel.map(row => ({ ...row, label: stageLabel(row.stage) }))}
          formatValue={value => fmtNum(value)}
          state="ready"
        />
      ) : (
        <ChartFrame t={frameText} title={funnelTitle} description={funnelDescription} state={funnelState} reason={reason} />
      )}

      <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
        {control(
          t('graduation.window', { defaultValue: 'Window' }),
          DAYS,
          days,
          value => setUrlState({ g_days: String(value) }),
          value => t('graduation.window_option', { days: value, defaultValue: '{{days}}d' }),
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={t('graduation.chain', { defaultValue: 'Chain' })}>
          <span className="text-[var(--fg-4)]">{t('graduation.chain', { defaultValue: 'Chain' })}</span>
          {chainOptions.map(option => (
            <button
              key={option.value}
              type="button"
              aria-pressed={option.value === chain}
              onClick={() => applyChain(option.value)}
              className={option.value === chain
                ? 'text-[var(--fg-1)] underline underline-offset-4'
                : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={t('graduation.launchpad', { defaultValue: 'Launchpad' })}>
          <span className="text-[var(--fg-4)]">{t('graduation.launchpad', { defaultValue: 'Launchpad' })}</span>
          <button
            type="button"
            aria-pressed={pad === 'all'}
            onClick={() => setUrlState({ g_pad: DEFAULT_PAD })}
            className={pad === 'all'
              ? 'text-[var(--fg-1)] underline underline-offset-4'
              : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
          >
            {t('graduation.launchpad_all', { defaultValue: 'All launchpads' })}
          </button>
          {padOptions.map(option => (
            <button
              key={option.key}
              type="button"
              aria-pressed={option.key === pad}
              onClick={() => setUrlState({ g_pad: option.key })}
              className={option.key === pad
                ? 'text-[var(--fg-1)] underline underline-offset-4'
                : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
            >
              {padOptionLabel(option, padOptions)}
            </button>
          ))}
        </div>
      </div>

      {rateLine ? <p className="intel-analysis-caption" data-testid="graduation-rate">{rateLine}</p> : null}
      {/* A cohort rate is quoted with its Wilson 95% interval and cohort size, so
          2 of 8 never reads as certain as 200 of 800. No cohort, no interval. */}
      {ready && rate != null ? <p className="intel-analysis-caption" data-testid="graduation-rate-interval"><RateInterval successes={num(cohort?.graduatedInWindow)} n={num(cohort?.firstSeenInWindow)} className="" /></p> : null}

      <div className="space-y-1" data-testid="graduation-sources">
        <div className="eyebrow">{t('graduation.sources_title', { defaultValue: 'Capture lanes in this window' })}</div>
        {sourceLines.map(line => <p key={line.source} className="intel-analysis-caption">{line.text}</p>)}
      </div>

      <h2 className="intel-section-title">{t('graduation.board_title', { defaultValue: 'Launchpads' })}</h2>
      <LaunchpadBoard
        rows={pads}
        pad={pad}
        onPad={key => setUrlState({ g_pad: key })}
        sort={sort}
        dir={dir}
        onSort={toggle}
        emptyNote={emptyNote}
        t={t}
      />

      <h2 className="intel-section-title">{t('graduation.stages_title', { defaultValue: 'Stage lists' })}</h2>
      <GraduationStageLists funnel={funnelRows} stageLabel={stageLabel} emptyNote={emptyNote} near={GRADUATION_NEAR_PCT} t={t} />

      {binState === 'ready' ? (
        <Histogram
          title={binTitle}
          description={binDescription}
          bins={bins}
          formatValue={value => `${fmtNum(value)}h`}
          formatCount={value => fmtNum(value)}
          state="ready"
        />
      ) : (
        <ChartFrame t={frameText} title={binTitle} description={binDescription} state={binState} reason={reason} />
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]" data-testid="graduation-retention">
          <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
            {t('graduation.retention_caption', {
              defaultValue: 'Of the contracts first seen inside this window, how many were still on a stage list at least that long after their OWN first sighting. A contract that has not yet had that long since we first saw it is not eligible and is not counted against the test.',
            })}
          </caption>
          <thead>
            <BoardTableHeader
              columns={[
                t('graduation.col_hours', { defaultValue: 'Hours since first seen' }),
                t('graduation.col_still', { defaultValue: 'Still listed' }),
                t('graduation.col_eligible', { defaultValue: 'Eligible' }),
                t('graduation.col_share', { defaultValue: 'Share' }),
              ]}
              numeric={[1, 2, 3]}
            />
          </thead>
          <tbody>
            {retention.length ? retention.map(row => {
              const eligible = num(row?.eligible) ?? 0
              const still = num(row?.stillListed) ?? 0
              return (
                <tr key={row?.hoursSinceFirstSeen}>
                  <th scope="row" className={`text-left font-normal text-[var(--fg-2)] ${BOARD_CELL_CLASS}`}>{`${fmtNum(num(row?.hoursSinceFirstSeen))}h`}</th>
                  <td className={`intel-number ${BOARD_CELL_CLASS}`}>{fmtNum(still)}</td>
                  <td className={`intel-number ${BOARD_CELL_CLASS}`}>{fmtNum(eligible)}</td>
                  {/* No eligible contracts is not a zero share: it is no reading. */}
                  <td className={`intel-number ${BOARD_CELL_CLASS}`}>
                    <span data-share>{eligible > 0 ? `${((still / eligible) * 100).toFixed(1)}%` : '—'}</span>
                    {eligible > 0 ? <span className="block text-[11px] text-[var(--fg-4)]" data-testid="graduation-retention-interval"><RateInterval successes={still} n={eligible} className="" /></span> : null}
                  </td>
                </tr>
              )
            }) : (
              <tr><td colSpan={4} className="py-2 text-[var(--fg-4)]">{emptyNote || t('graduation.retention_empty', { defaultValue: 'No cohort was first seen inside this window, so there is nothing to retain.' })}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]" data-testid="graduation-recent">
          <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
            {t('graduation.recent_caption', {
              count: recent.length,
              defaultValue: 'The {{count}} most recently captured contracts, newest sighting first. The stage is the one the last capture recorded, and the market cap is the provider’s at that capture.',
            })}
          </caption>
          <thead>
            <BoardTableHeader
              columns={[
                t('graduation.col_symbol', { defaultValue: 'Symbol' }),
                t('graduation.col_name', { defaultValue: 'Name' }),
                t('graduation.col_launchpad', { defaultValue: 'Launchpad' }),
                t('graduation.col_chain', { defaultValue: 'Chain' }),
                t('graduation.col_contract', { defaultValue: 'Contract' }),
                t('graduation.col_stage', { defaultValue: 'Stage' }),
                t('graduation.col_first_seen', { defaultValue: 'First seen (UTC)' }),
                t('graduation.col_captured', { defaultValue: 'Captured (UTC)' }),
                t('graduation.col_market_cap', { defaultValue: 'Market cap' }),
              ]}
              numeric={[8]}
            />
          </thead>
          <tbody>
            {recent.length ? recent.map((row, index) => (
              <tr key={`${row?.chain}-${row?.contractAddress}-${index}`}>
                <th scope="row" className={`text-left font-normal text-[var(--fg-2)] ${BOARD_CELL_CLASS}`}><AssetName row={row} t={t} /></th>
                <td className={BOARD_CELL_CLASS}>{row?.name || '—'}</td>
                <td className={BOARD_CELL_CLASS}>{padLabel(row) || '—'}</td>
                <td className={BOARD_CELL_CLASS}>{chainLabel(row?.chain)}</td>
                <td className={BOARD_CELL_CLASS}><ContractCell row={row} t={t} /></td>
                <td className={BOARD_CELL_CLASS}>{stageLabel(row?.stage)}</td>
                <td className={BOARD_CELL_CLASS}>{stamp(row?.firstSeenAt)}</td>
                <td className={BOARD_CELL_CLASS}>{stamp(row?.capturedAt)}</td>
                <td className={`intel-number ${BOARD_CELL_CLASS}`}>{num(row?.marketCap) == null ? '—' : formatUsd(row.marketCap)}</td>
              </tr>
            )) : (
              <tr><td colSpan={9} className="py-2 text-[var(--fg-4)]">{emptyNote || t('graduation.recent_empty', { defaultValue: 'No contract was captured inside this window.' })}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* CoinGecko's paid terms require this notice, visible and at least 10px,
          wherever the data is shown. It is a licence condition, so it is plain
          text at the foot of the section: not a state, not a details element,
          not conditional on a figure having rendered. */}
      {attribution?.text ? (
        <p className="text-[11px] text-[var(--fg-4)]" data-testid="graduation-attribution">
          {attribution.url
            ? <a href={attribution.url} target="_blank" rel="noopener noreferrer" className="intel-text-link">{attribution.text}</a>
            : attribution.text}
        </p>
      ) : null}
    </section>
  )
}
