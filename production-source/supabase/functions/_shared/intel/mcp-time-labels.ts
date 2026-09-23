// Readable labels for the timestamps in an MCP tool result.
//
// WHY THIS EXISTS. Every time in a result is ISO 8601 UTC, which is right for a
// program and easy for a model to misread: on 2026-09-23 an agent reading
// "2026-09-22T16:58:36Z" from rwa_best_wrapper called it "Monday's 16:58 UTC
// reading" (22 Sep 2026 was a Tuesday). Nothing in the result carried a weekday, so
// the model computed one and got it wrong. The fix is to state it, not to hope.
//
// THE SHAPE. The timestamps keep their machine-readable values. The result gains
// one top-level `time_labels` object mapping each distinct timestamp (or date) in
// it to a label such as "Tue 22 Sep 2026, 16:58:36 UTC". A map of distinct values
// stays small because captures share times, and it never renames or reshapes a
// field a client already reads.
//
// THE BOUND. A long series would add a label per point, so collection is
// breadth-first (the as_of and row times come before the deep series points) and
// stops at TIME_LABEL_CAP distinct values; `time_labels_truncated` says when it
// stopped.

export const TIME_LABEL_CAP = 40

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A UTC instant (Z or +00:00, with or without seconds and fractions) or a plain
 * calendar date. Offsets other than UTC are left alone rather than relabelled. */
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]00(?::?00)?)$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const pad = (n: number) => String(n).padStart(2, '0')

/** "Tue 22 Sep 2026, 16:58:36 UTC" for an instant (seconds only when not zero),
 * "Tue 22 Sep 2026" for a date, null for anything else. */
export function timeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const isDate = DATE.test(value)
  if (!isDate && !INSTANT.test(value)) return null
  const ms = Date.parse(isDate ? `${value}T00:00:00Z` : value.replace(' ', 'T').replace(/([+-]00)$/, '$1:00'))
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  const day = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  if (isDate) return day
  const seconds = d.getUTCSeconds()
  return `${day}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(seconds)}` : ''} UTC`
}

/** The payload with `time_labels` added (and `time_labels_truncated` when the cap
 * bound). A payload that is not a plain object, or carries no timestamp, is
 * returned unchanged. */
export function withTimeLabels<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const labels: Record<string, string> = {}
  let count = 0
  let truncated = false
  const queue: unknown[] = [payload]
  const seen = new Set<unknown>()
  while (queue.length) {
    const node = queue.shift()
    if (!node || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    for (const value of Array.isArray(node) ? node : Object.values(node as Record<string, unknown>)) {
      if (typeof value === 'string') {
        if (value in labels) continue
        const label = timeLabel(value)
        if (!label) continue
        if (count >= TIME_LABEL_CAP) { truncated = true; continue }
        labels[value] = label
        count += 1
      } else if (value && typeof value === 'object') {
        queue.push(value)
      }
    }
  }
  if (!count) return payload
  return { ...(payload as Record<string, unknown>), time_labels: labels, ...(truncated ? { time_labels_truncated: true } : {}) } as T
}
