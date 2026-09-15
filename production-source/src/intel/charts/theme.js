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

// Categorical palette for a figure that draws many series at once: fourteen hue
// steps at two lightness levels, twenty-eight colours, one set per theme. Seven
// tones were never enough for a rank map of the top twenty-five — the cycle
// repeated and several paths shared a colour.
//
// The hex values live in src/intel/workspace.css as --intel-series-NN, once for
// the dark workspace and once for the light one; SERIES_HEX below is the same
// table in JS so a test can measure the gaps rather than trusting the eye. The
// order is not the hue order: consecutive indices are a long way apart on the
// wheel so two series drawn next to each other never look related.
export const SERIES_HEX = [
  ['#e8a08d', '#9b3c22'], ['#44cf8c', '#12683f'], ['#e88de8', '#9b229b'],
  ['#cfc644', '#686212'], ['#8db7e8', '#225a9b'], ['#cf444e', '#681218'],
  ['#8de8b1', '#229b52'], ['#9e44cf', '#4a1268'], ['#e8dd8d', '#9b8d22'],
  ['#44aacf', '#125168'], ['#e88d9c', '#9b2236'], ['#44cf59', '#12681f'],
  ['#ae8de8', '#4e229b'], ['#cf9c44', '#684912'], ['#8dd2e8', '#227f9b'],
  ['#cf447e', '#681236'], ['#8de88d', '#229b22'], ['#4459cf', '#121f68'],
  ['#e8bf8d', '#9b6422'], ['#44cdcf', '#126768'], ['#e88dc5', '#9b226c'],
  ['#c2e88d', '#689b22'], ['#8d9ce8', '#22369b'], ['#cf7544', '#683012'],
  ['#8de8d2', '#229b7f'], ['#cf44b8', '#68125a'], ['#9ccf44', '#496812'],
  ['#447acf', '#123368'],
]

export const SERIES_TOKENS = SERIES_HEX.map((_, i) => `--intel-series-${String(i + 1).padStart(2, '0')}`)

// What a chart actually draws with. A token, never a hex: the light theme
// redefines every one of them.
export const SERIES_PALETTE = SERIES_TOKENS.map(token => `var(${token})`)

// Colour for series `i` of a multi-series figure. Twenty-eight distinct colours
// before anything repeats, so the rank map's twenty-five paths are all different.
export const paletteColor = i => {
  const n = SERIES_PALETTE.length
  const index = Number.isFinite(Number(i)) ? ((Math.trunc(Number(i)) % n) + n) % n : 0
  return SERIES_PALETTE[index]
}

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
