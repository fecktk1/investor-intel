// Shared formatting helpers for the exchange Markets surfaces.
// Single source of truth for money, counts and percentage rendering across Intel:
// every surface must read these instead of hand-rolling another abbreviator, so a
// trillion-dollar market cap never renders as "$1580.0B" and a 1e-7 memecoin price
// never renders in exponent notation.
const DASH = '—'

// Ascending so the largest matching unit wins. Decimal counts are deliberate:
// T/B/Q keep two so wide columns line up ("$1.58T" next to "$12.30T"), M keeps
// one, K and below keep none.
const USD_UNITS = [
  { min: 1e3, divisor: 1e3, suffix: 'K', digits: 0 },
  { min: 1e6, divisor: 1e6, suffix: 'M', digits: 1 },
  { min: 1e9, divisor: 1e9, suffix: 'B', digits: 2 },
  { min: 1e12, divisor: 1e12, suffix: 'T', digits: 2 },
  { min: 1e15, divisor: 1e15, suffix: 'Q', digits: 2 },
]

// null / '' / booleans / NaN / ±Infinity all collapse to null so every caller
// renders the same em dash instead of "$NaN".
const finiteOrNull = (v) => {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const usdScale = (magnitude) => {
  let picked = magnitude > 0 && magnitude < 1
    ? { min: 0, divisor: 1, suffix: '', digits: 2 }
    : { min: 0, divisor: 1, suffix: '', digits: 0 }
  for (let i = 0; i < USD_UNITS.length; i += 1) if (magnitude >= USD_UNITS[i].min) picked = USD_UNITS[i]
  const idx = USD_UNITS.indexOf(picked)
  // Rounding can push a value into the next unit (999_999_999 → "1000.0M").
  if (idx >= 0 && idx < USD_UNITS.length - 1 && Number((magnitude / picked.divisor).toFixed(picked.digits)) >= 1000) return USD_UNITS[idx + 1]
  return picked
}

// { divisor, suffix, digits } for a value's magnitude — exported so axis
// formatters can share the unit ladder without re-deriving the thresholds.
export const usdUnit = (v) => {
  const n = finiteOrNull(v)
  const { divisor, suffix, digits } = usdScale(n == null ? 0 : Math.abs(n))
  return { divisor, suffix, digits }
}

const abbreviate = (v, { digits } = {}) => {
  const n = finiteOrNull(v)
  if (n == null) return null
  const magnitude = Math.abs(n)
  const scale = usdScale(magnitude)
  const places = Number.isFinite(digits) ? digits : scale.digits
  return `${n < 0 ? '-' : ''}${(magnitude / scale.divisor).toFixed(places)}${scale.suffix}`
}

// Sign-safe compact currency: "-$5.00B", never "$-5000000000".
export const formatUsd = (v, opts) => {
  const out = abbreviate(v, opts)
  if (out == null) return DASH
  return out.charAt(0) === '-' ? `-$${out.slice(1)}` : `$${out}`
}

// Display currency. Everything Investor Intel stores is denominated in USD;
// `formatMoney` renders a stored USD amount in the reader's chosen currency at
// display time, on the SAME K/M/B/T/Q ladder as formatUsd so a converted column
// lines up with an unconverted one.
//
//   sign            the currency's display sign ('€', 'CA$'). Pass null when the
//                   sign is ambiguous (three different "kr", a right-to-left
//                   dirham) and the ISO code is what a reader can identify.
//   suffix          true where the sign conventionally follows the amount (zł).
//   rate            units of `currency` per 1 USD.
//
// A missing, zero or non-finite rate is NOT an excuse to render a number that is
// wrong by an unknown factor: the amount falls back to dollars, and the caller
// (useDisplayCurrency) reports `fallback: true` so the surface can say so.
// `rate` has no default on purpose: an omitted rate is an ABSENT rate, and an
// absent rate renders dollars. Defaulting it to 1 would print a euro sign in
// front of a dollar figure the first time a caller forgot to pass one.
export const formatMoney = (v, { currency = 'USD', rate, sign = '$', suffix = false, digits } = {}) => {
  const n = finiteOrNull(v)
  if (n == null) return DASH
  const factor = finiteOrNull(rate)
  if (factor == null || factor <= 0) return formatUsd(v, { digits })
  const out = abbreviate(n * factor, { digits })
  if (out == null) return DASH
  const negative = out.charAt(0) === '-'
  const magnitude = negative ? out.slice(1) : out
  const code = String(currency || 'USD').toUpperCase()
  const label = sign ? (suffix ? `${magnitude} ${sign}` : `${sign}${magnitude}`) : `${magnitude} ${code}`
  return negative ? `-${label}` : label
}

// Same unit ladder without the currency sign, for counts (holders, txns).
export const formatCompact = (v, opts) => {
  const out = abbreviate(v, opts)
  return out == null ? DASH : out
}

const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉'
const toSubscript = (n) => String(n).split('').map((d) => SUBSCRIPT_DIGITS[Number(d)]).join('')

// Structured price so React callers can render a real <sub> element. Returns
// { text } for everything that formats inline, or { prefix, zeros, digits } for
// sub-cent prices in subscript-zero notation.
export const formatPriceParts = (p) => {
  const n = finiteOrNull(p)
  if (n == null) return { text: DASH }
  const sign = n < 0 ? '-' : ''
  const magnitude = Math.abs(n)
  if (magnitude === 0) return { text: '$0.00' }
  if (magnitude >= 1) return { text: `${sign}$${magnitude.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
  if (magnitude >= 0.01) return { text: `${sign}$${magnitude.toFixed(4)}` }
  let exponent = Math.floor(Math.log10(magnitude))
  let mantissa = Number((magnitude / 10 ** exponent).toFixed(3))
  if (mantissa >= 10) { mantissa /= 10; exponent += 1 }
  const digits = mantissa.toFixed(3).replace('.', '').replace(/0+$/, '') || '0'
  return { prefix: `${sign}$0.0`, zeros: -exponent - 1, digits }
}

// Never exponent notation: 1.23e-7 → "$0.0₆123".
export const formatPrice = (p) => {
  const parts = formatPriceParts(p)
  return parts.text != null ? parts.text : `${parts.prefix}${toSubscript(parts.zeros)}${parts.digits}`
}

// Sign is always explicit except at a true zero, and sub-1% moves keep two
// decimals so ±0.04% never flattens to "+0.0%".
export const formatPct = (v, { digits } = {}) => {
  const n = finiteOrNull(v)
  if (n == null) return DASH
  const magnitude = Math.abs(n)
  const places = Number.isFinite(digits) ? digits : magnitude >= 1000 ? 0 : magnitude < 1 ? 2 : 1
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${magnitude.toFixed(places)}%`
}

// Legacy names kept so existing call sites keep working.
export const fmtPrice = formatPrice
export const fmtPct = formatPct
export const fmtVol = formatUsd
export const fmtNum = (v) => v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
export const timeAgo = (iso) => {
  if (!iso) return ''
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  const s = Math.max(0, (Date.now() - date.getTime()) / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h ago`
  const options = date.getFullYear() === new Date().getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' }
  return new Intl.DateTimeFormat(undefined, options).format(date)
}
export const bucketConfidence = (n) => n == null ? 'low' : n >= 67 ? 'high' : n >= 34 ? 'medium' : 'low'
export const pctClass = (v) => (v ?? 0) >= 0 ? 'text-[var(--ok)]' : 'text-red-400'
