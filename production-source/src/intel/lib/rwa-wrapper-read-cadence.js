// Investor Intel: why the wrapper board's prices are the age they are.
//
// The board is OUR read of CoinMarketCap, taken on a schedule, so its prices
// are as old as our newest read. Two facts say so, both derived from what the
// read already carries and never from a guess about the provider:
//
//   1. How far CoinMarketCap's own update time on these prices sat behind our
//      read (the capture's newest `fetchedAt` against the quotes' newest
//      `pricesObservedAt`). Every live read measured from 2026-09-20 to
//      2026-09-24 was one to two minutes behind: the provider updates
//      tokenised-asset quotes continuously, and the board is old only because
//      our read is.
//   2. When we read, and when the next read is due, from the lane's own cron
//      expression on the payload (`schedule.rwa_wrappers.cron`).
//
// A fact that cannot be derived is null and the surface says nothing about it.

const MINUTE = 60_000, HOUR = 3_600_000

const msOf = (value) => {
  const ms = Date.parse(String(value ?? ''))
  return Number.isFinite(ms) ? ms : null
}

const pad = (n) => String(n).padStart(2, '0')

/** The daily run times of a cron expression of the form "M H[,H...] * * *"
 * (the only form the capture lanes use), as sorted [hour, minute] pairs. Any
 * other form is null: a schedule that cannot be read is not described. */
export function dailyRunTimes(cron) {
  const parts = String(cron ?? '').trim().split(/\s+/)
  if (parts.length !== 5 || parts.slice(2).some((p) => p !== '*')) return null
  if (!/^\d{1,2}$/.test(parts[0])) return null
  const minute = Number(parts[0])
  if (minute > 59) return null
  const hours = parts[1].split(',')
  if (!hours.length || hours.some((h) => !/^\d{1,2}$/.test(h) || Number(h) > 23)) return null
  return [...new Set(hours.map(Number))].sort((a, b) => a - b).map((hour) => [hour, minute])
}

/** "02:47", "08:47", ... for a daily cron, or null. */
export function dailyRunLabels(cron) {
  const times = dailyRunTimes(cron)
  return times ? times.map(([h, m]) => `${pad(h)}:${pad(m)}`) : null
}

/** The first scheduled run strictly after `now`, as an ISO string, or null. */
export function nextRunAfter(cron, now = Date.now()) {
  const times = dailyRunTimes(cron)
  const at = now instanceof Date ? now.getTime() : Number(now)
  if (!times || !Number.isFinite(at)) return null
  const day = new Date(at)
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())
  for (let offset = 0; offset < 2; offset++) {
    for (const [hour, minute] of times) {
      const candidate = midnight + offset * 86_400_000 + hour * HOUR + minute * MINUTE
      if (candidate > at) return new Date(candidate).toISOString()
    }
  }
  return null
}

/** The facts the board states beside its price age.
 *
 * `readAt` is the newest `fetchedAt` on the rows (when our read happened, not
 * the capture hour it is filed under). `lagMs` is how far the provider's own
 * update time sat behind that read; a negative or missing difference is null. */
export function wrapperReadCadence(payload, now = Date.now()) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : []
  const reads = rows.map((row) => msOf(row?.fetchedAt)).filter((ms) => ms != null)
  const readMs = reads.length ? Math.max(...reads) : null
  const observedMs = msOf(payload?.pricesObservedAt)
  const lag = readMs != null && observedMs != null ? readMs - observedMs : null
  const cron = payload?.schedule?.rwa_wrappers?.cron
  return {
    readAt: readMs != null ? new Date(readMs).toISOString() : null,
    lagMs: lag != null && lag >= 0 ? lag : null,
    runTimes: dailyRunLabels(cron),
    nextRunAt: nextRunAfter(cron, now),
  }
}

/** "2 minutes" or "6 hours" in the reader's language. Under a minute reads as
 * one minute: the provider's clock has one-second resolution and a read one
 * second after an update is not "0 minutes" behind in any useful sense. */
export function durationText(ms, language) {
  if (!Number.isFinite(ms) || ms < 0) return null
  const [amount, unit] = ms < 90 * MINUTE ? [Math.max(1, Math.round(ms / MINUTE)), 'minute'] : [Math.round(ms / HOUR), 'hour']
  try {
    return new Intl.NumberFormat(language || 'en', { style: 'unit', unit, unitDisplay: 'long' }).format(amount)
  } catch {
    return `${amount} ${unit}${amount === 1 ? '' : 's'}`
  }
}

/** "02:47, 08:47, 14:47 and 20:47" in the reader's language. */
export function timesText(labels, language) {
  if (!Array.isArray(labels) || !labels.length) return null
  try {
    return new Intl.ListFormat(language || 'en', { style: 'long', type: 'conjunction' }).format(labels)
  } catch {
    return labels.join(', ')
  }
}
