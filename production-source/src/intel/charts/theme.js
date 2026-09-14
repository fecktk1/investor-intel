import { useEffect, useState } from 'react'

// Every colour in the chart kit is a workspace token (src/intel/workspace.css)
// so the same component renders correctly in the dark and light themes. Never
// hardcode a hex value in a chart: the light theme redefines each token.
export const TONES = {
  accent: 'var(--accent)',
  blue: 'var(--signal-blue)',
  green: 'var(--signal-green)',
  red: 'var(--signal-red)',
  yellow: 'var(--signal-yellow)',
  muted: 'var(--fg-5)',
  fourth: 'var(--intel-comparison-fourth)',
}

// Cycle order for unnamed series. Keeps adjacent series distinguishable.
export const PALETTE = ['accent', 'blue', 'green', 'fourth', 'red', 'yellow', 'muted']

// Resolve a tone name to its token. An unknown tone falls back to the accent so
// a mis-typed tone never renders an invisible mark.
export const toneColor = tone => (tone && TONES[tone]) || TONES.accent

export const seriesColor = i => {
  const n = PALETTE.length
  const index = Number.isFinite(Number(i)) ? ((Math.trunc(Number(i)) % n) + n) % n : 0
  return TONES[PALETTE[index]]
}

export const gridStroke = 'var(--border-default)'
export const axisText = 'var(--fg-4)'
export const trackStroke = 'var(--border-default)'

export const tooltipStyle = {
  background: 'var(--bg-2)',
  border: '1px solid var(--border-default)',
  borderRadius: 0,
  color: 'var(--fg-1)',
  fontSize: '.75rem',
  padding: '.5rem .65rem',
}

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'
const readReducedMotion = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try { return !!window.matchMedia(REDUCE_QUERY).matches } catch { return false }
}

// SSR- and jsdom-safe. Returns true when the reader asked for reduced motion;
// callers then omit every transition rather than shortening it.
export function useReducedMotion() {
  const [reduced, setReduced] = useState(readReducedMotion)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    let media
    try { media = window.matchMedia(REDUCE_QUERY) } catch { return undefined }
    const sync = () => setReduced(!!media.matches)
    sync()
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', sync)
      return () => media.removeEventListener('change', sync)
    }
    if (typeof media.addListener === 'function') {
      media.addListener(sync)
      return () => media.removeListener(sync)
    }
    return undefined
  }, [])
  return reduced
}

// Inline motion for interactive marks. `null` when motion is reduced so no
// `transition` property is ever written to the element.
export const markMotion = reduced => (reduced ? null : { transition: 'opacity 140ms linear, stroke-width 140ms linear' })
