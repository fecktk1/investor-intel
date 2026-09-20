import React, { useMemo } from 'react'
import SortableHeader, { StaticHeader } from './SortableHeader'
import { BOARD_CELL_CLASS } from './BoardTableHeader'
import { sortRows } from '../lib/useColumnSort'
import { HISTORY_CAPTURES } from '../lib/launchpads'
import { chainLabel, hoursText, num, stamp } from './GraduationCells'
import { fmtNum } from '../lib/market-format'

// One plain table, one row per launchpad that wrote into the window.
//
// It exists because Pump.fun and Four.meme have nothing to do with each other.
// A single graduation rate over both of them is not a fact about either, so the
// read groups the same three numbers per pad and this board prints them side by
// side instead of averaging them into one meaningless figure.
//
// WHAT NEEDS HISTORY, AND WHY IT SAYS SO. A graduation is MOVEMENT between two
// hourly captures. A window holding one capture cannot contain one, so a pad
// with no graduates and fewer than HISTORY_CAPTURES captures has not measured a
// zero — it has not measured anything yet, and the cell says that rather than
// printing a 0% a reader would take for a finding. Above that line an absent
// graduate IS a measurement and prints as the zero it is.

export const BOARD_SORT_KEYS = ['newCreations', 'aboutGraduates', 'graduates', 'rate', 'medianHours', 'latest']
export const BOARD_DEFAULT_SORT = 'newCreations'

const stageCount = (row, stage) => {
  const funnel = Array.isArray(row?.funnel) ? row.funnel : []
  return num(funnel.find(entry => entry?.stage === stage)?.count) ?? 0
}

/** Every column this board sorts on, read off the row the same way the cell
 *  under the header reads it, so a header and its column can never disagree. */
export function boardValue(row, key) {
  if (key === 'newCreations' || key === 'aboutGraduates' || key === 'graduates') return stageCount(row, key)
  if (key === 'rate') return num(row?.graduationRate)
  if (key === 'medianHours') return num(row?.timeToGraduate?.median)
  if (key === 'latest') return row?.latestCapturedAt || null
  return null
}

/** True when an absent graduation is an absence of history rather than a
 *  measured zero. Exported so the test asserts the rule, not the sentence. */
export function needsHistory(row, minCaptures = HISTORY_CAPTURES) {
  const graduated = num(row?.cohort?.graduatedInWindow) ?? 0
  if (graduated > 0) return false
  return (num(row?.captures) ?? 0) < minCaptures
}

export default function LaunchpadBoard({ rows = [], pad = 'all', onPad, sort, dir, onSort, emptyNote = null, t }) {
  const ordered = useMemo(
    () => sortRows(rows, { key: sort, dir, accessor: boardValue, tieBreak: row => String(row?.label ?? row?.key ?? '') }),
    [rows, sort, dir],
  )

  const caption = t('graduation.board_caption', {
    captures: HISTORY_CAPTURES,
    defaultValue: 'One row per launchpad that wrote into this window. The three stage counts are the NEWEST capture only; the cohort rate is of the contracts first seen inside the window, how many reached the graduates list inside it. A pad with no graduate yet and fewer than {{captures}} stored captures cannot have measured a rate, so it says so instead of showing a zero. Selecting a launchpad name filters every figure on this page to it.',
  })

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]" data-testid="graduation-launchpads">
        <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">{caption}</caption>
        <thead>
          <tr>
            <StaticHeader label={t('graduation.col_launchpad', { defaultValue: 'Launchpad' })} align="left" />
            <StaticHeader label={t('graduation.col_chain', { defaultValue: 'Chain' })} align="left" />
            <SortableHeader sortKey="newCreations" label={t('graduation.stage_new', { defaultValue: 'New creations' })} sort={sort} dir={dir} onToggle={onSort} align="right" />
            <SortableHeader sortKey="aboutGraduates" label={t('graduation.stage_about', { defaultValue: 'About to graduate' })} sort={sort} dir={dir} onToggle={onSort} align="right" />
            <SortableHeader sortKey="graduates" label={t('graduation.stage_graduates', { defaultValue: 'Graduates' })} sort={sort} dir={dir} onToggle={onSort} align="right" />
            <SortableHeader sortKey="rate" label={t('graduation.col_rate', { defaultValue: 'Cohort graduation rate' })} sort={sort} dir={dir} onToggle={onSort} align="right" />
            <SortableHeader sortKey="medianHours" label={t('graduation.col_median_hours', { defaultValue: 'Median hours to graduate' })} sort={sort} dir={dir} onToggle={onSort} align="right" />
            <SortableHeader sortKey="latest" label={t('graduation.col_latest', { defaultValue: 'Latest capture (UTC)' })} sort={sort} dir={dir} onToggle={onSort} align="left" />
          </tr>
        </thead>
        <tbody>
          {ordered.length ? ordered.map(row => {
            const key = String(row?.key ?? '')
            const rate = num(row?.graduationRate)
            const pending = needsHistory(row)
            const median = num(row?.timeToGraduate?.median)
            return (
              <tr key={key} data-pad={key} data-selected={key === pad ? 'true' : undefined}>
                <th scope="row" className={`text-left font-normal text-[var(--fg-2)] ${BOARD_CELL_CLASS}`}>
                  <button
                    type="button"
                    className={key === pad ? 'text-[var(--fg-1)] underline underline-offset-4' : 'intel-text-link'}
                    aria-pressed={key === pad}
                    onClick={() => { if (typeof onPad === 'function') onPad(key) }}
                  >
                    {row?.label || key}
                  </button>
                </th>
                <td className={BOARD_CELL_CLASS}>{chainLabel(row?.chain)}</td>
                <td className={`intel-number ${BOARD_CELL_CLASS}`}>{fmtNum(stageCount(row, 'newCreations'))}</td>
                <td className={`intel-number ${BOARD_CELL_CLASS}`}>{fmtNum(stageCount(row, 'aboutGraduates'))}</td>
                <td className={`intel-number ${BOARD_CELL_CLASS}`}>{fmtNum(stageCount(row, 'graduates'))}</td>
                <td className={`intel-number ${BOARD_CELL_CLASS}`}>
                  {pending
                    ? <span data-rate title={t('graduation.needs_history_title', { captures: HISTORY_CAPTURES, defaultValue: 'No graduate yet and fewer than {{captures}} captures stored for this launchpad. A graduation is movement between two hourly captures, so there is nothing to measure here yet.' })}>
                      {t('graduation.needs_history', { defaultValue: 'Needs history' })}
                    </span>
                    : <span data-rate>{rate == null ? '—' : `${(rate * 100).toFixed(1)}%`}</span>}
                </td>
                <td className={`intel-number ${BOARD_CELL_CLASS}`}>{median == null ? '—' : hoursText(median)}</td>
                <td className={BOARD_CELL_CLASS}>{stamp(row?.latestCapturedAt)}</td>
              </tr>
            )
          }) : (
            <tr>
              <td colSpan={8} className="py-2 text-[var(--fg-4)]">
                {emptyNote || t('graduation.board_empty', { defaultValue: 'No launchpad wrote a row inside this window.' })}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
