import { useCallback, useMemo } from 'react'

// Shared column-sort primitive for Investor Intel tables.
//
// The hook is deliberately CONTROLLED: `sort` and `dir` are owned by the caller
// (in practice the prefixed URL params read through useScreenParams, e.g.
// `m_sort`/`m_dir` for markets and `d_sort`/`d_dir` for degen), and `setSort`
// writes them back. Nothing is stored here, so a shared or restored URL always
// reproduces the exact order a reader was looking at.
//
// The cycle never returns to "none". A table is always rendered in some order,
// so a third click that dropped the sort would silently reorder every row to a
// server default that the header no longer describes. Picking an inactive
// column therefore starts at the first cycle step ('desc', the useful default
// for ranked financial columns) and re-picking the active column advances and
// wraps: inactive -> desc -> asc -> desc.

export const SORT_CYCLE = ['desc', 'asc']

const DIRECTIONS = new Set(['asc', 'desc'])

function cycleSteps(cycle) {
  const steps = (Array.isArray(cycle) ? cycle : []).filter(step => DIRECTIONS.has(step))
  return steps.length ? [...new Set(steps)] : SORT_CYCLE
}

export function useColumnSort({ sort = null, dir = null, setSort, defaultSort = null, defaultDir = 'desc', cycle = SORT_CYCLE } = {}) {
  const steps = useMemo(() => cycleSteps(cycle), [Array.isArray(cycle) ? cycle.join('|') : String(cycle)])
  const activeSort = sort || defaultSort || null
  const fallbackDir = DIRECTIONS.has(defaultDir) ? defaultDir : steps[0]
  const activeDir = DIRECTIONS.has(dir) ? dir : fallbackDir

  const isActive = useCallback(key => Boolean(key) && key === activeSort, [activeSort])

  const toggle = useCallback(key => {
    if (!key || typeof setSort !== 'function') return
    if (key !== activeSort) { setSort({ sort: key, dir: steps[0] }); return }
    const index = steps.indexOf(activeDir)
    setSort({ sort: key, dir: steps[(index + 1) % steps.length] })
  }, [activeSort, activeDir, setSort, steps])

  // 'none' is the correct aria-sort for a column that is not the current sort;
  // omitting the attribute would leave assistive technology guessing.
  const ariaSort = useCallback(key => {
    if (!key || key !== activeSort) return 'none'
    return activeDir === 'asc' ? 'ascending' : 'descending'
  }, [activeSort, activeDir])

  return { sort: activeSort, dir: activeDir, toggle, ariaSort, isActive }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/

// Returns a number, a non-empty string, or null for "missing". null is not a
// low value: missing cells are parked at one end of the table regardless of
// direction (see sortRows), so flipping a column never floats blanks to the top.
function normalizeValue(input) {
  if (input == null) return null
  if (input instanceof Date) { const time = input.getTime(); return Number.isNaN(time) ? null : time }
  if (typeof input === 'number') return Number.isNaN(input) ? null : input
  if (typeof input === 'bigint') return Number(input)
  if (typeof input === 'boolean') return input ? 1 : 0
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) return null
    if (ISO_DATE.test(text)) { const time = Date.parse(text); if (!Number.isNaN(time)) return time }
    return text
  }
  return null
}

function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  // numeric collation keeps "Token 2" before "Token 10"; sensitivity 'base'
  // keeps casing and accents from splitting otherwise identical tickers.
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Pure, stable comparator for in-page sorting.
 *
 * sortRows(rows, { key, dir, accessor, nullsLast, tieBreak }) -> new array
 *  - key       column key; read as row[key] unless `accessor` is given
 *  - dir       'asc' | 'desc' (default 'desc')
 *  - accessor  (row, key) => value, for computed or nested columns
 *  - nullsLast null/undefined/NaN/'' sit last in BOTH directions (default true)
 *  - tieBreak  (row) => value, compared ascending; ties then fall back to the
 *              original index so the sort is stable in every engine.
 */
export function sortRows(rows, { key, dir = 'desc', accessor, nullsLast = true, tieBreak } = {}) {
  const list = Array.isArray(rows) ? rows : []
  if (!key && typeof accessor !== 'function') return list.slice()
  const read = typeof accessor === 'function' ? accessor : row => (row == null ? null : row[key])
  const sign = dir === 'asc' ? 1 : -1
  const missingSign = nullsLast ? 1 : -1
  const secondary = typeof tieBreak === 'function' ? tieBreak : null
  const decorated = list.map((row, index) => ({ row, index, value: normalizeValue(read(row, key)) }))
  // The tie-break is direction independent on purpose: "stable" has to mean the
  // same residual order whichever way the column is pointing.
  const breakTie = (a, b) => {
    if (secondary) {
      const left = normalizeValue(secondary(a.row)), right = normalizeValue(secondary(b.row))
      if (left != null && right != null) { const cmp = compareValues(left, right); if (cmp) return cmp }
      else if (left != null || right != null) return left == null ? 1 : -1
    }
    return a.index - b.index
  }
  decorated.sort((a, b) => {
    const aMissing = a.value === null, bMissing = b.value === null
    if (aMissing || bMissing) {
      if (aMissing && bMissing) return breakTie(a, b)
      return (aMissing ? 1 : -1) * missingSign
    }
    const cmp = compareValues(a.value, b.value)
    return cmp ? sign * cmp : breakTie(a, b)
  })
  return decorated.map(entry => entry.row)
}

export default useColumnSort
