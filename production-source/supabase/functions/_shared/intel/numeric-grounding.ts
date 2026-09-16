// Numeric grounding: a generated figure must come from the evidence.
//
// The prompts already tell every model not to invent numbers, and the safety
// validator already refuses advice language. Neither checks that a percentage,
// dollar amount, multiple or count in the output was actually present in the
// evidence it was given. This module does, and the contract it enforces is:
//
//   1. EXTRACT every quoted figure from the generated prose: percentages,
//      currency amounts (with k/m/bn/tn magnitudes), multipliers ("3x") and
//      counts ("12,400 holders", "1.2 million").
//   2. GROUND each one against every number present in the supplied evidence,
//      within a STATED tolerance (below).
//   3. On failure the caller regenerates ONCE, naming the offending figures, and
//      if any figure is still ungrounded it returns a REFUSAL that says a figure
//      could not be grounded. The ungrounded text is never returned or stored.
//
// TOLERANCE. A figure matches an evidence number when their magnitudes differ by
// no more than the larger of:
//   * half a unit of the figure's last written digit, scaled by its magnitude
//     suffix ("12%" covers 11.5 to 12.5; "$1.2B" covers $1.15B to $1.25B), which
//     is what honest rounding of the evidence value can produce, and
//   * 1% of the figure (RELATIVE_TOLERANCE), for re-expressions such as a value
//     printed from a differently rounded copy of the same field.
// Sign is ignored ("fell 5%" grounds on -5), and a fraction and a percentage are
// the same number ("12.5%" grounds on 0.125, "45 bps" on 0.0045), because both are how evidence is
// honestly restated. Nothing else is derived: a figure the model COMPUTED from
// two evidence numbers is not in the evidence and does not ground.
//
// FALSE-POSITIVE GUARDS. Not figures, and never checked: calendar dates and
// times, bare years (1900 to 2100), ordinals ("3rd"), number words ("three",
// "first"), time windows ("24h", "7-day", "30 days"), citation markers ("[E3]"),
// identifiers ("Layer 2", "ERC-20", "L2", "v3", hex addresses), bare numbers
// below one thousand with no unit, and counted nouns below ten ("3 risks").
// A range ("10-15%", "$1 to 2B") is two figures sharing the unit written after
// it, and each end must ground.

export type FigureKind = 'percent' | 'currency' | 'multiplier' | 'count'

export interface Figure {
  /** The text as written, including its unit. */
  raw: string
  /** Absolute value in base units: percent points, currency units, a multiple, a count. */
  value: number
  kind: FigureKind
  /** Half a unit of the last written digit, in base units. */
  rounding: number
  index: number
}

export interface GroundingResult {
  ok: boolean
  checked: number
  ungrounded: Figure[]
  tolerance: string
}

export const RELATIVE_TOLERANCE = 0.01
/** A number followed by a count noun is checked from this value up. */
export const MIN_COUNT = 10
export const TOLERANCE_STATEMENT = 'A figure grounds when it is within half a unit of its last written digit, or within 1%, of a number in the supplied evidence. Sign is ignored and a fraction equals its percentage.'

const MAGNITUDE: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mm: 1e6, mn: 1e6, mil: 1e6, million: 1e6, millions: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9, billions: 1e9,
  t: 1e12, tn: 1e12, trillion: 1e12, trillions: 1e12,
}
const COUNT_NOUNS = 'holders?|wallets?|addresses|address|transactions?|txs?|trades?|tokens?|accounts?|users?|pairs?|markets?|exchanges?|validators?|members?|contracts?|listings?|assets?|coins?|swaps?|transfers?|buyers?|sellers?|traders?|stories|sources?|signals?|narratives?|protocols?|pools?|vaults?|chains?|projects?|posts?|mentions?|followers?|subscribers?|deposits?|withdrawals?|liquidations?|positions?|nodes?|miners?|blocks?'
const TIME_UNITS = 's|sec|secs|seconds?|mins?|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?|mo|mos|months?|y|yr|yrs|years?|q'

/** Blank out spans that contain digits but are not figures, keeping every index
 * so extracted positions still point into the original text. */
function mask(text: string): string {
  const blank = (m: string) => ' '.repeat(m.length)
  return text
    .replace(/\[E\d+\]/g, blank)                                   // citation markers
    .replace(/\b0x[0-9a-fA-F]{6,}\b/g, blank)                      // hex addresses and hashes
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}(?:[T ][\d:.]+Z?)?/g, blank)   // ISO dates and timestamps
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, blank)          // slash dates
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, blank)                // clock times
    .replace(/\b[A-Za-z]{1,12}-?\d+(?:\.\d+)*\b/g, (m) => /^(?:usd|us|eur|gbp)\d/i.test(m) ? m : blank(m)) // ERC-20, L2, v3, Web3, Q3
    .replace(/\b(?:layer|tier|stage|phase|season|round|top|rank|ranked|number|no\.|epoch|version|part|step)\s+#?\d+\b/gi, blank)
    .replace(/#\d+\b/g, blank)                                     // "#5"
    .replace(/\b\d+(?:st|nd|rd|th)\b/gi, blank)                     // ordinals
}

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`
const MAG = String.raw`(?:\s?(k|m|mm|mn|mil|b|bn|t|tn)\b|\s(thousand|millions?|billions?|trillions?)\b)`
const CURRENCY_PREFIX = String.raw`(US\$|\$|€|£|USD\s?|EUR\s?|GBP\s?)`

function parseToken(integer: string, fraction: string | undefined, magnitude: string | undefined): { value: number; decimals: number; scale: number } {
  const value = Number(`${integer.replace(/,/g, '')}${fraction ? `.${fraction}` : ''}`)
  const scale = magnitude ? MAGNITUDE[magnitude.toLowerCase()] ?? 1 : 1
  return { value: value * scale, decimals: fraction ? fraction.length : 0, scale }
}

const roundingOf = (decimals: number, scale: number) => 0.5 * 10 ** -decimals * scale

/** Every quoted figure in `text`, in reading order. */
export function extractFigures(input: unknown): Figure[] {
  const text = typeof input === 'string' ? input : ''
  if (!text) return []
  const masked = mask(text)
  const out: Figure[] = []
  const taken: [number, number][] = []
  const push = (start: number, end: number, value: number, kind: FigureKind, rounding: number) => {
    if (!Number.isFinite(value)) return
    out.push({ raw: text.slice(start, end).trim(), value: Math.abs(value), kind, rounding, index: start })
  }
  const claim = (start: number, end: number) => taken.push([start, end])
  /** Every match of `re` that does not overlap a figure already taken. A match
   * that starts inside or runs into a taken figure is retried from the end of
   * that figure, so "$450,000 and 3.5x" still finds the multiple. */
  const scan = (re: RegExp, handle: (m: RegExpExecArray, start: number, end: number) => void) => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(masked))) {
      const start = m.index, end = start + m[0].length
      const blocking = taken.filter(([a, b]) => start < b && end > a)
      if (blocking.length) { re.lastIndex = Math.max(start + 1, ...blocking.filter(([a]) => a <= start).map(([, b]) => b)); continue }
      handle(m, start, end)
      if (m[0].length === 0) re.lastIndex++
    }
  }

  // A range carries its unit once, after the second end. Both ends take it.
  const RANGE_SEP = String.raw`\s*(?:-|–|to|and)\s*`
  // A currency range never joins on "and": "$450,000 and 3.5x" is two figures.
  const CURRENCY_RANGE_SEP = String.raw`\s*(?:-|–|to)\s*`
  const unitPatterns: { kind: FigureKind; re: RegExp }[] = [
    // currency: prefix, optional range, optional magnitude
    { kind: 'currency', re: new RegExp(String.raw`(?<![\w.,])${CURRENCY_PREFIX}${NUMBER}${MAG}?(?:${CURRENCY_RANGE_SEP}\$?${NUMBER}${MAG}?(?![\d.,]*\s?(?:x|×|%)))?`, 'gi') },
    // currency: suffix
    { kind: 'currency', re: new RegExp(String.raw`(?<![\w.,$])${NUMBER}${MAG}?(?:${RANGE_SEP}${NUMBER}${MAG}?)?\s?(?:USD[CT]?|dollars?)\b`, 'gi') },
    // percent
    { kind: 'percent', re: new RegExp(String.raw`(?<![\w.,])[-+]?${NUMBER}(?:\s?%?${RANGE_SEP}[-+]?${NUMBER})?\s?(?:%|percent\b|per cent\b|pct\b|percentage points?\b|pp\b|bps\b|basis points?\b)`, 'gi') },
    // multiplier
    { kind: 'multiplier', re: new RegExp(String.raw`(?<![\w.,])${NUMBER}(?:${RANGE_SEP}${NUMBER})?\s?(?:x|×)(?![\w])`, 'gi') },
  ]

  for (const { kind, re } of unitPatterns) {
    scan(re, (_m, start, end) => {
      const slice = text.slice(start, end)
      const numbers = [...slice.matchAll(new RegExp(NUMBER + MAG + '?', 'gi'))]
      if (!numbers.length) return
      claim(start, end)
      // The magnitude written after the LAST number applies to every end that
      // wrote none ("$1-2B" is $1B to $2B).
      const lastMag = numbers.at(-1)![3] || numbers.at(-1)![4]
      for (const n of numbers) {
        const magnitude = n[3] || n[4] || (kind === 'currency' ? lastMag : undefined)
        const { value, decimals, scale } = parseToken(n[1], n[2], magnitude)
        // Basis points keep their own written value; `grounds` also accepts the
        // same quantity written as a fraction (0.0045 is 45 bps).
        push(start, end, value, kind, roundingOf(decimals, scale))
      }
    })
  }

  // Counts: a number with a count noun, or a large or magnitude-scaled bare number.
  const counted = new RegExp(String.raw`(?<![\w.,$€£])${NUMBER}${MAG}?(?:\s+(?:new|unique|active|distinct|more|fewer|total|daily|large|whale|top)){0,2}\s+(?:${COUNT_NOUNS})\b`, 'gi')
  scan(counted, (m, start, end) => {
    const { value, decimals, scale } = parseToken(m[1], m[2], m[3] || m[4])
    // Below ten a counted noun is almost always an enumeration of the answer's
    // own points ("3 risks", "2 exchanges") rather than a quoted measurement.
    if (value < MIN_COUNT) return
    claim(start, end)
    push(start, end, value, 'count', roundingOf(decimals, scale))
  })
  const bare = new RegExp(String.raw`(?<![\w.,$€£-])${NUMBER}${MAG}?(?![\w%×])(?!\s?(?:[-‐]\s?)?(?:${TIME_UNITS})\b)`, 'gi')
  scan(bare, (m, start, end) => {
    const magnitude = m[3] || m[4]
    const separated = m[1].includes(',')
    const { value, decimals, scale } = parseToken(m[1], m[2], magnitude)
    const year = !separated && !m[2] && !magnitude && /^\d{4}$/.test(m[1]) && value >= 1900 && value <= 2100
    if (year) return
    // A bare number is a claimed figure only when it could not be a label: it has
    // a magnitude word, thousands separators, or is at least one thousand.
    if (!magnitude && !separated && value < 1000) return
    claim(start, end)
    push(start, end, value, 'count', roundingOf(decimals, scale))
  })
  return out.sort((a, b) => a.index - b.index)
}

/** Every number present in the evidence: JSON numbers, and every numeric token
 * inside evidence strings (with magnitude suffixes applied). Bounded so an
 * unexpectedly large payload cannot stall a request. */
export function evidenceNumbers(evidence: unknown, limit = 200_000): number[] {
  const out: number[] = []
  const seen = new WeakSet<object>()
  const token = new RegExp(String.raw`(?<![\w.])-?${NUMBER}${MAG}?`, 'gi')
  const walk = (value: unknown, depth: number) => {
    if (out.length >= limit || depth > 40) return
    if (typeof value === 'number') { if (Number.isFinite(value)) out.push(Math.abs(value)); return }
    if (typeof value === 'string') {
      if (value.length > 400_000) value = value.slice(0, 400_000)
      for (const m of (value as string).matchAll(token)) {
        const plain = parseToken(m[1], m[2], undefined).value
        if (Number.isFinite(plain)) out.push(Math.abs(plain))
        if (m[3] || m[4]) { const scaled = parseToken(m[1], m[2], m[3] || m[4]).value; if (Number.isFinite(scaled)) out.push(Math.abs(scaled)) }
        if (out.length >= limit) return
      }
      return
    }
    if (value && typeof value === 'object') {
      if (seen.has(value as object)) return
      seen.add(value as object)
      for (const item of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) walk(item, depth + 1)
    }
  }
  walk(evidence, 0)
  return out
}

function grounds(figure: Figure, numbers: readonly number[]): boolean {
  const tolerance = Math.max(figure.rounding, figure.value * RELATIVE_TOLERANCE)
  for (const n of numbers) {
    if (Math.abs(n - figure.value) <= tolerance) return true
    if (figure.kind === 'percent' && (Math.abs(n * 100 - figure.value) <= tolerance || Math.abs(n * 10_000 - figure.value) <= tolerance)) return true
  }
  return false
}

/** Check every figure in `text` against `evidence`. */
export function checkNumericGrounding(text: unknown, evidence: unknown, numbers?: readonly number[]): GroundingResult {
  const figures = extractFigures(text)
  if (!figures.length) return { ok: true, checked: 0, ungrounded: [], tolerance: TOLERANCE_STATEMENT }
  const pool = numbers ?? evidenceNumbers(evidence)
  const ungrounded = figures.filter((figure) => !grounds(figure, pool))
  return { ok: ungrounded.length === 0, checked: figures.length, ungrounded, tolerance: TOLERANCE_STATEMENT }
}

/** Distinct figure texts, in order, bounded for prompts and receipts. */
export const ungroundedList = (figures: readonly Figure[], max = 12): string[] =>
  [...new Set(figures.map((f) => f.raw))].slice(0, max)

/** The one bounded regeneration instruction. It names the figures and forbids
 * replacing them with other unsupported ones. */
export function groundingRetryInstruction(result: GroundingResult): string {
  return `Your previous answer quoted figures that do not appear in the supplied evidence: ${ungroundedList(result.ungrounded).join('; ')}. Rewrite the answer so every percentage, currency amount, multiple and count is copied from the evidence provided. Do not estimate, recall, compute or round a new figure. Where the evidence has no figure for a point, say the figure is not available instead of giving one.`
}

/** The do-not-invent clause every generation prompt carries. */
export const NUMERIC_GROUNDING_RULE = 'NUMBERS: every percentage, currency amount, multiple and count you write must be copied from the supplied evidence. Never estimate, recall from memory, compute, extrapolate or invent a figure. If the evidence has no figure for a point, say the figure is not available.'

export interface GroundedGeneration<T> {
  status: 'grounded' | 'regenerated' | 'refused'
  output: T | null
  first: GroundingResult
  final: GroundingResult
  ungrounded: string[]
}

/**
 * Check, regenerate once, and refuse.
 *
 * `textOf` extracts the prose to check from an output. `regenerate` is called AT
 * MOST ONCE, with the retry instruction naming the offending figures, and may
 * return null when the regeneration itself failed. A refusal returns
 * `output: null`: the caller must not show or store the ungrounded output.
 */
export async function groundOrRefuse<T>(args: {
  output: T
  textOf: (output: T) => string
  evidence: unknown
  regenerate: (instruction: string, result: GroundingResult) => Promise<T | null>
}): Promise<GroundedGeneration<T>> {
  const numbers = evidenceNumbers(args.evidence)
  const first = checkNumericGrounding(args.textOf(args.output), null, numbers)
  if (first.ok) return { status: 'grounded', output: args.output, first, final: first, ungrounded: [] }
  let second: T | null = null
  try { second = await args.regenerate(groundingRetryInstruction(first), first) } catch { second = null }
  if (second != null) {
    const final = checkNumericGrounding(args.textOf(second), null, numbers)
    if (final.ok) return { status: 'regenerated', output: second, first, final, ungrounded: [] }
    return { status: 'refused', output: null, first, final, ungrounded: ungroundedList(final.ungrounded) }
  }
  return { status: 'refused', output: null, first, final: first, ungrounded: ungroundedList(first.ungrounded) }
}

/** The refusal an artifact carries in place of ungrounded prose. It states what
 * happened and which figures failed; it contains no claim of its own. */
export function groundingRefusal(ungrounded: readonly string[], extra: Record<string, unknown> = {}) {
  const listed = ungrounded.length ? ` Figures that could not be grounded: ${ungrounded.join('; ')}.` : ''
  return {
    summary: `This analysis was withheld because a figure in it could not be matched to the supplied evidence, even after one regeneration.${listed} Request an updated analysis; no ungrounded figure is shown.`,
    confidence: 'low',
    net_signal: 'data_limited',
    sources: [],
    ...extra,
    grounding: { status: 'refused', ungrounded: [...ungrounded], tolerance: TOLERANCE_STATEMENT },
  }
}
