import React from 'react'

// Header row for the plain board tables under src/intel.
//
// The workspace right-aligns a numeric cell with one rule, .intel-number in
// workspace.css, and that rule applies to any element — a <th> included. A
// header therefore aligns with its column by carrying the same class the cells
// under it carry. Before this existed every board wrote the header row out by
// hand with `text-left` hardcoded, so a column of right-aligned figures sat
// under a label pinned to the far left of it.
//
// `numeric` lists the columns whose body cells use .intel-number. A trace or
// sparkline column is not one of them: its cell holds a drawing that starts at
// the left edge, so its header stays left too.

export const BOARD_CELL_CLASS = 'border-b border-[var(--border-default)] py-2 pr-3'

export const boardHeaderClass = align =>
  `${align === 'right' ? 'intel-number' : 'text-left'} font-normal text-[var(--fg-4)] ${BOARD_CELL_CLASS}`

export default function BoardTableHeader({ columns = [], numeric = [] }) {
  const right = new Set(numeric)
  return (
    <tr>
      {columns.map((column, index) => {
        const align = right.has(index) ? 'right' : 'left'
        return (
          <th key={`${column}-${index}`} scope="col" data-align={align} className={boardHeaderClass(align)}>
            {column}
          </th>
        )
      })}
    </tr>
  )
}
