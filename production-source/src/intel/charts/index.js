// Shared Investor Intel chart kit. Every chart is a bordered-free <figure
// class="intel-chart"> with a table twin, takes all colour from workspace tokens
// and honours prefers-reduced-motion. See src/intel/pages/ChartLabPage.jsx
// (route /intel/lab/charts, super admin only) for live examples of every state.
export { default as RadialGauge } from './RadialGauge'
export { default as RadialBars } from './RadialBars'
export { default as Sunburst } from './Sunburst'
export { default as PolarClock } from './PolarClock'
export { default as Ribbon } from './Ribbon'
export { default as Bump } from './Bump'
export { default as HeatStrip } from './HeatStrip'
export { default as StackedShare } from './StackedShare'
export { default as Histogram, binLabel, binTone } from './Histogram'
export { default as Sparkline } from './Sparkline'
export { default as Scatter } from './Scatter'
export { default as LineArea } from './LineArea'
export { TONES, PALETTE, toneColor, seriesColor, gridStroke, axisText, tooltipStyle, useReducedMotion, markMotion } from './theme'
