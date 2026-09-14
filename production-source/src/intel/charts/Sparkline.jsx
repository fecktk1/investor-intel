import React from 'react'
import { toneColor } from './theme'
import './charts.css'

// Inline element: no figure, no caption, no table twin. It belongs inside a row
// of a table or a text line, where the surrounding cell already names the value.
export default function Sparkline({ values = [], width = 96, height = 24, tone = 'accent', emphasis = 'last', ariaLabel }) {
  const numbers = values.map(v => Number(v)).filter(Number.isFinite)
  const w = Number(width) > 0 ? Number(width) : 96
  const h = Number(height) > 0 ? Number(height) : 24
  const pad = 3
  const min = numbers.length ? Math.min(...numbers) : 0
  const max = numbers.length ? Math.max(...numbers) : 0
  const x = i => (numbers.length < 2 ? w / 2 : pad + (i / (numbers.length - 1)) * (w - pad * 2))
  const y = v => (max === min ? h / 2 : h - pad - ((v - min) / (max - min)) * (h - pad * 2))
  const d = numbers.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ')
  const markIndex = emphasis === 'max'
    ? numbers.indexOf(max)
    : emphasis === 'min' ? numbers.indexOf(min)
      : emphasis === 'none' ? -1
        : numbers.length - 1
  const color = toneColor(tone)

  return (
    <svg className="intel-sparkline" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img"
      aria-label={ariaLabel || `${numbers.length} observations`}>
      {numbers.length ? <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /> : null}
      {markIndex >= 0 && numbers.length ? <circle cx={x(markIndex)} cy={y(numbers[markIndex])} r="2.4" fill={color} /> : null}
    </svg>
  )
}
