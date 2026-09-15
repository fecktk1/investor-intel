import React from 'react'
import { useTranslation } from 'react-i18next'
import { markMotion } from './theme'
import './charts.css'

export const useChartText = () => useTranslation('intel', { useSuspense: false }).t

export const defaultValueFormat = v => {
  const n = Number(v)
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'
}
export const defaultTimeFormat = t => {
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? String(t ?? '—') : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Interactive SVG marks. Real <button> elements inside foreignObject are not
// allowed here, so the mark carries the button role and its own key handling.
export function markProps({ label, onActivate, reduced, className = '', selected }) {
  const activate = event => { if (typeof onActivate === 'function') onActivate(event) }
  return {
    tabIndex: 0,
    role: 'button',
    'aria-label': label,
    'aria-pressed': selected == null ? undefined : !!selected,
    className: `intel-chart-mark${className ? ` ${className}` : ''}`,
    onClick: activate,
    onKeyDown: event => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault()
        activate(event)
      }
    },
    style: markMotion(reduced) || undefined,
  }
}

// The footprint the plot will take, as the chart itself knows it: the viewBox
// width and height it draws into, the 22rem cap a round figure carries, and any
// extra width or height cap the chart puts on its own svg. A chart that reports
// its plot keeps one height across loading, empty, error and ready, so the
// arriving svg never pushes the rest of the page down.
export function plotBoxStyle(plot) {
  if (!plot) return undefined
  const style = {}
  const width = Number(plot.width)
  const height = Number(plot.height)
  if (typeof plot.height === 'string') style.height = plot.height
  else if (width > 0 && height > 0) style.aspectRatio = `${width} / ${height}`
  else return undefined
  if (plot.radial) style.maxWidth = '22rem'
  if (plot.maxWidth) style.maxWidth = plot.maxWidth
  if (plot.maxHeight) style.maxHeight = plot.maxHeight
  return style
}

// A chart is a plain figure: no border, no background, no card. Legends are text
// rows with a small colour swatch; every chart carries a table twin.
export function ChartFrame({ t, title, description, state = 'ready', reason, legend, table, readout, plot, children }) {
  const failed = state === 'error'
  const empty = state !== 'error' && state !== 'ready'
  const box = plotBoxStyle(plot)
  return (
    <figure className="intel-chart intel-chart-kit">
      <figcaption>
        <span className="intel-chart-kit-title">{title}</span>
        {description ? <span className="intel-chart-kit-description">{description}</span> : null}
      </figcaption>
      {failed ? (
        <div className="intel-chart-kit-plot" style={box} data-reserved={box ? 'true' : undefined}>
          <p className="intel-chart-kit-state" role="alert">
            {t('charts.unavailable', { defaultValue: 'This chart could not be built.' })}{' '}
            {reason || t('charts.no_reason', { defaultValue: 'No reason was reported.' })}
          </p>
        </div>
      ) : empty ? (
        <div className="intel-chart-kit-plot" style={box} data-reserved={box ? 'true' : undefined}>
          <p className="intel-chart-kit-state" role="status">
            {t('charts.empty', { defaultValue: 'No observations are available for this chart.' })}
          </p>
        </div>
      ) : (
        <>
          {children}
          {readout}
          {legend}
          {table}
        </>
      )}
    </figure>
  )
}

export function ChartLegend({ t, items = [] }) {
  if (!items.length) return null
  return (
    <ul className="intel-chart-legend" aria-label={t('charts.legend', { defaultValue: 'Legend' })}>
      {items.map(item => (
        <li key={item.key}>
          <span className="intel-chart-swatch" style={{ background: item.color }} aria-hidden="true" />
          <span className="intel-chart-legend-label">{item.label}</span>
          {item.value == null ? null : <span className="intel-number intel-chart-legend-value">{item.value}</span>}
        </li>
      ))}
    </ul>
  )
}

// The table twin repeats the same values with the same formatting. First cell of
// every row is the row header, so a screen reader announces the series name.
export function ChartTable({ t, caption, columns = [], rows = [] }) {
  return (
    <details className="intel-chart-table">
      <summary>{t('charts.show_as_table', { defaultValue: 'Show as table' })}</summary>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>{columns.map((column, i) => <th key={`${column}-${i}`} scope="col">{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row[0] == null ? i : `${row[0]}-${i}`}>
              {row.map((cell, j) => (j === 0
                ? <th key={j} scope="row">{cell}</th>
                : <td key={j} className="intel-number">{cell}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}
