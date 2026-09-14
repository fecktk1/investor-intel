import React from 'react'
import { useTranslation } from 'react-i18next'
import './sortable-header.css'

// Column headers for Investor Intel tables. The control is a real <button>, so
// Enter/Space activation, focus order and the focus ring come from the platform
// rather than from a keydown handler that would have to be re-proved per table.

const GLYPH = { desc: '↓', asc: '↑' }
const INACTIVE_GLYPH = '↕'

function headerClass(align, className) {
  return ['intel-sortable-header', align === 'right' ? 'intel-number' : '', className].filter(Boolean).join(' ')
}

// Non-sortable column, so a table can mix fixed and sortable headers without
// the two drifting apart in padding or alignment.
export function StaticHeader({ label, align = 'left', title, className = '' }) {
  return <th scope="col" data-align={align} title={title} className={headerClass(align, className)}>
    <span className="intel-sortable-header-static">{label}</span>
  </th>
}

export default function SortableHeader({ sortKey, label, sort, dir = 'desc', onToggle, align = 'left', title, className = '' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const active = Boolean(sortKey) && sortKey === sort
  const direction = dir === 'asc' ? 'asc' : 'desc'
  // 'none' rather than an omitted attribute: an unsorted column still has to
  // announce that it is sortable and currently unsorted.
  const ariaSort = active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
  const columnName = typeof label === 'string' ? label : (typeof title === 'string' ? title : String(sortKey || ''))
  const state = direction === 'asc'
    ? t('table.sorted_asc', { defaultValue: 'sorted ascending' })
    : t('table.sorted_desc', { defaultValue: 'sorted descending' })
  return <th scope="col" aria-sort={ariaSort} data-align={align} title={title} className={headerClass(align, className)}>
    <button
      type="button"
      className="intel-sortable-header-button"
      aria-label={t('table.sort_by', { column: columnName, defaultValue: 'Sort by {{column}}' })}
      onClick={() => { if (typeof onToggle === 'function') onToggle(sortKey) }}
    >
      <span className="intel-sortable-header-label">{label}</span>
      <span className="intel-sortable-header-glyph" data-active={active ? 'true' : undefined} aria-hidden="true">{active ? GLYPH[direction] : INACTIVE_GLYPH}</span>
    </button>
    {/* Announced as part of the column header; the button's aria-label replaces
        its own contents, so the current state cannot live inside the button. */}
    {active && <span className="sr-only">{state}</span>}
  </th>
}
