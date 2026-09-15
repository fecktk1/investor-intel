import React, { useMemo, useState } from 'react'
import { ChartFrame, ChartTable, markProps, useChartText, defaultValueFormat } from './frame'
import { toneColor, seriesColor, gridStroke, useReducedMotion } from './theme'
import { arcPath } from './geometry'

const CX = 170, CY = 170, R0 = 42, RING = 36

const nodeValue = node => {
  const own = Number(node?.value)
  if (Array.isArray(node?.children) && node.children.length) return node.children.reduce((sum, child) => sum + nodeValue(child), 0)
  return Number.isFinite(own) ? own : 0
}

// Flatten the tree into drawable arcs. Arc size is proportional to value; an
// all-zero tree still lists every node in the table twin as a zero.
function layout(root, depth) {
  const arcs = []
  const total = nodeValue(root)
  const walk = (nodes, level, a0, span, path, parentTone, index0) => {
    if (level > depth) return
    const sum = nodes.reduce((acc, n) => acc + nodeValue(n), 0)
    let cursor = a0
    nodes.forEach((node, i) => {
      const value = nodeValue(node)
      const share = sum > 0 ? value / sum : 1 / Math.max(1, nodes.length)
      const width = span * share
      const tone = node.tone || parentTone
      const nodePath = [...path, node.name]
      arcs.push({
        key: `${level}-${nodePath.join('/')}-${i}`,
        name: node.name, level, value, path: nodePath,
        a0: cursor, a1: cursor + width,
        color: tone ? toneColor(tone) : seriesColor(level === 1 ? index0 + i : index0),
        share: total > 0 ? value / total : 0,
      })
      if (Array.isArray(node.children) && node.children.length) walk(node.children, level + 1, cursor, width, nodePath, tone, level === 1 ? index0 + i : index0)
      cursor += width
    })
  }
  walk(Array.isArray(root?.children) ? root.children : [], 1, 0, 360, [root?.name].filter(Boolean), null, 0)
  return { arcs, total }
}

export default function Sunburst({ title, description, root, depth = 3, formatValue, state = 'ready', reason, onSelect }) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const fmt = formatValue || defaultValueFormat
  const { arcs, total } = useMemo(() => layout(root || {}, depth), [root, depth])
  const [focus, setFocus] = useState(null)
  const active = arcs.find(a => a.key === focus) || null
  const readoutPath = active ? active.path.join(' › ') : (root?.name ? `${root.name} · ${fmt(total)}` : '')

  return (
    <ChartFrame
      t={t} title={title} description={description} state={state} reason={reason}
      plot={{ width: 340, height: 340, radial: true }}
      readout={<p className="intel-chart-kit-readout" aria-live="polite">{active ? `${readoutPath} · ${fmt(active.value)}` : readoutPath}</p>}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[t('charts.legend', { defaultValue: 'Legend' }), t('charts.value', { defaultValue: 'Value' }), t('charts.share', { defaultValue: 'Share' })]}
          rows={arcs.map(a => [a.path.join(' › '), fmt(a.value), `${(a.share * 100).toFixed(1)}%`])}
        />
      }
    >
      <svg viewBox="0 0 340 340" role="img" className="intel-chart-radial"
        aria-label={`${title}. ${fmt(total)}. ${t('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
        <circle cx={CX} cy={CY} r={R0} fill="none" stroke={gridStroke} />
        {arcs.map(arc => {
          const rIn = R0 + (arc.level - 1) * RING
          return (
            <path
              key={arc.key}
              {...markProps({ label: `${arc.path.join(' › ')} ${fmt(arc.value)}`, onActivate: () => onSelect?.(arc), reduced })}
              d={arcPath(CX, CY, rIn, rIn + RING - 2, arc.a0, arc.a1)}
              fill={arc.color}
              fillOpacity={active && active.key !== arc.key ? 0.35 : 0.85}
              stroke="var(--bg-1)" strokeWidth="1"
              onMouseEnter={() => setFocus(arc.key)}
              onMouseLeave={() => setFocus(null)}
              onFocus={() => setFocus(arc.key)}
              onBlur={() => setFocus(null)}
            >
              <title>{`${arc.path.join(' › ')} · ${fmt(arc.value)}`}</title>
            </path>
          )
        })}
        <text className="intel-chart-value" x={CX} y={CY + 2} textAnchor="middle" style={{ fontSize: 15 }}>{fmt(active ? active.value : total)}</text>
        <text x={CX} y={CY + 20} textAnchor="middle">{active ? active.name : (root?.name || '')}</text>
      </svg>
    </ChartFrame>
  )
}
