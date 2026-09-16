import assert from 'node:assert/strict'
import {
  calibrateCadence, calibratedCadenceSeconds, calibratePolicyRows, conservativeCalibration,
  loadAccountObservations, MAX_CADENCE_SECONDS, MAX_SCALE, type AccountObservation,
} from './budget-calibration.ts'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const RESET = '2026-11-01T00:00:00.000Z'
const CEILING = 12_000                       // the Basic month cmc_request_reserve enforces
const POLICY_EXPIRY = '2026-09-30T23:59:00Z'

const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()
const observation = (minutesAgo: number, used: number, over: Partial<AccountObservation> = {}): AccountObservation =>
  ({ at: at(minutesAgo), used, limit: 15_000, resetAt: RESET, ...over })

/** A supabase-js stand-in for the one row this module reads. */
// deno-lint-ignore no-explicit-any
const fakeDb = (config: unknown, error: unknown = null): any => ({
  from: () => {
    const q: Record<string, unknown> = {}
    q.select = () => q; q.eq = () => q
    q.maybeSingle = () => Promise.resolve({ data: error ? null : { config }, error })
    return q
  },
})

Deno.test('with no account observations at all the reviewed cadence is left exactly as it is', () => {
  const calibration = calibrateCadence({ observations: [], ceiling: CEILING, now: NOW })
  assert.equal(calibration.scale, 1)
  assert.equal(calibration.reason, 'no_observations')
  assert.equal(calibratedCadenceSeconds(300, calibration), 300)
  assert.equal(calibratedCadenceSeconds(86_400, calibration), 86_400)
})

Deno.test('an unreadable observation row degrades to the conservative cadence under its own name', async () => {
  const failed = await loadAccountObservations(fakeDb(null, { message: 'permission denied' }))
  assert.deepEqual(failed, { observations: [], previousScale: null, scaleAt: null, error: 'observations_unavailable' })
  const calibration = calibrateCadence({ observations: failed.observations, ceiling: CEILING, now: NOW, error: failed.error })
  assert.equal(calibration.scale, 1)
  assert.equal(calibration.reason, 'observations_unavailable')
  assert.deepEqual(await loadAccountObservations(null), { observations: [], previousScale: null, scaleAt: null, error: 'db_unavailable' })
  // A row that exists with no observations yet is a successful read of nothing,
  // which is a different fact from a read that failed.
  assert.deepEqual(await loadAccountObservations(fakeDb({ observations: [] })), { observations: [], previousScale: null, scaleAt: null, error: null })
})

Deno.test('the key fingerprint stored beside the observations is never returned to a caller', async () => {
  const read = await loadAccountObservations(fakeDb({ fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6', observations: [observation(60, 10), observation(0, 20)] }))
  assert.equal(read.error, null)
  assert.equal(read.observations.length, 2)
  assert.ok(!JSON.stringify(read).includes('a1b2c3d4e5f6a1b2c3d4e5f6'))
  assert.deepEqual(Object.keys(read.observations[0]).sort(), ['at', 'limit', 'resetAt', 'used'])
})

Deno.test('the multiplier last applied is read back, and a stale or accelerating one is not', async () => {
  const fresh = await loadAccountObservations(fakeDb({ scale: 4, scale_at: at(30), observations: [] }), NOW)
  assert.equal(fresh.previousScale, 4)
  assert.equal(fresh.scaleAt, at(30))
  // Older than the observation freshness window: the next move starts from 1.
  const stale = await loadAccountObservations(fakeDb({ scale: 4, scale_at: at(600), observations: [] }), NOW)
  assert.equal(stale.previousScale, null)
  assert.equal(stale.scaleAt, at(600))
  // A recorded multiplier below 1 would be an acceleration, and is refused.
  assert.equal((await loadAccountObservations(fakeDb({ scale: 0.5, scale_at: at(1), observations: [] }), NOW)).previousScale, null)
  assert.equal((await loadAccountObservations(fakeDb({ observations: [] }), NOW)).previousScale, null)
})

Deno.test('one observation cannot be a burn rate and refuses to pretend otherwise', () => {
  const calibration = calibrateCadence({ observations: [observation(30, 400)], ceiling: CEILING, now: NOW })
  assert.equal(calibration.scale, 1)
  assert.equal(calibration.reason, 'single_observation')
  assert.equal(calibration.usable, 1)
  assert.equal(calibration.observedCreditsPerSecond, null)
})

Deno.test('observations too close together measure scheduler jitter and are not used', () => {
  const calibration = calibrateCadence({ observations: [observation(5, 100), observation(0, 900)], ceiling: CEILING, now: NOW })
  assert.equal(calibration.scale, 1)
  assert.equal(calibration.reason, 'window_too_short')
})

Deno.test('observations older than the freshness window no longer describe the account', () => {
  const calibration = calibrateCadence({ observations: [observation(600, 100), observation(480, 4000)], ceiling: CEILING, now: NOW })
  assert.equal(calibration.scale, 1)
  assert.equal(calibration.reason, 'observations_stale')
})

Deno.test('an account burning faster than its reset window affords stretches the cadence', () => {
  // 4,000 credits in an hour, with 8,000 left and 26 days to the reset: the
  // affordable rate is a small fraction of that, so every cadence stretches.
  const observations = [observation(60, 0), observation(0, 4000)]
  // With no multiplier on record the move is measured from 1, so the first read
  // brakes by one step rather than slamming to the ceiling.
  const first = calibrateCadence({ observations, ceiling: CEILING, now: NOW })
  assert.ok(first.scale > 1, `scale was ${first.scale}`)
  assert.equal(first.scale, 2)
  assert.equal(first.reason, 'burn_over_budget')
  assert.equal(first.observedCreditsPerSecond, Number((4000 / 3600).toFixed(9)))
  assert.equal(first.remainingCredits, 8000)
  assert.ok(first.affordableCreditsPerSecond! < first.observedCreditsPerSecond!)
  assert.equal(calibratedCadenceSeconds(300, first), 600)
  // Once the ramp has reached the ceiling the burn is still over budget, and the
  // multiplier says so under its own name.
  const ramped = calibrateCadence({ observations, ceiling: CEILING, now: NOW, previousScale: 8 })
  assert.equal(ramped.scale, MAX_SCALE)
  assert.equal(ramped.reason, 'burn_over_budget_capped')
  assert.equal(calibratedCadenceSeconds(300, ramped), 2400)
  // Stretched, never parked: a feature keeps running at some cadence.
  assert.ok(calibratedCadenceSeconds(86_400, ramped)! <= MAX_CADENCE_SECONDS)
})

Deno.test('an account inside its budget keeps the reviewed cadence and is never made faster', () => {
  // 3 credits an hour against a budget that affords far more.
  const calibration = calibrateCadence({ observations: [observation(120, 500), observation(0, 506)], ceiling: CEILING, now: NOW })
  assert.equal(calibration.scale, 1)
  assert.equal(calibration.reason, 'burn_within_budget')
  assert.ok(calibration.observedCreditsPerSecond! > 0)
  assert.ok(calibration.affordableCreditsPerSecond! > calibration.observedCreditsPerSecond!)
  assert.equal(calibratedCadenceSeconds(300, calibration), 300)
})

Deno.test('a burn of exactly zero is a real reading and not a missing one', () => {
  const calibration = calibrateCadence({ observations: [observation(120, 742), observation(0, 742)], ceiling: CEILING, now: NOW })
  assert.equal(calibration.observedCreditsPerSecond, 0)
  assert.equal(calibration.reason, 'burn_within_budget')
  assert.equal(calibration.scale, 1)
  assert.equal(calibration.usable, 2)
})

Deno.test('a credit reset between two observations discards the pair rather than reading a negative burn', () => {
  const beforeReset = observation(120, 11_800, { resetAt: RESET })
  const afterReset = observation(0, 12, { resetAt: RESET })
  const calibration = calibrateCadence({ observations: [beforeReset, afterReset], ceiling: CEILING, now: NOW })
  assert.equal(calibration.reason, 'window_too_short')
  assert.equal(calibration.scale, 1)
  // A pair spanning two different reset windows is not one burn either.
  const across = calibrateCadence({
    observations: [observation(120, 100, { resetAt: '2026-10-01T00:00:00.000Z' }), observation(0, 900)],
    ceiling: CEILING, now: NOW,
  })
  assert.equal(across.scale, 1)
})

Deno.test('burn measured before the source-policy expiry never crosses that boundary', () => {
  // Startup-rate burn recorded in September, read in October. Mixing them would
  // demand the maximum stretch the moment the ceiling falls.
  const septemberNow = Date.parse('2026-10-01T02:00:00Z')
  const september = [
    { at: '2026-09-30T22:00:00.000Z', used: 100_000, limit: 450_000, resetAt: RESET },
    { at: '2026-09-30T23:00:00.000Z', used: 140_000, limit: 450_000, resetAt: RESET },
  ]
  const calibration = calibrateCadence({ observations: september, ceiling: CEILING, now: septemberNow, boundaries: [POLICY_EXPIRY] })
  assert.equal(calibration.scale, 1)
  assert.equal(calibration.reason, 'awaiting_post_boundary_observations')
  assert.equal(calibration.usable, 0)
  // One post-boundary observation is still not a rate, and still changes nothing.
  const partial = calibrateCadence({
    observations: [...september, { at: '2026-10-01T01:00:00.000Z', used: 30, limit: 15_000, resetAt: RESET }],
    ceiling: CEILING, now: septemberNow, boundaries: [POLICY_EXPIRY],
  })
  assert.equal(partial.scale, 1)
  assert.equal(partial.reason, 'awaiting_post_boundary_observations')
})

Deno.test('one read cannot slam the multiplier to its ceiling in a single step', () => {
  const observations = [observation(60, 0), observation(0, 4000)]
  const first = calibrateCadence({ observations, ceiling: CEILING, now: NOW, previousScale: 1 })
  assert.equal(first.scale, 2)
  const second = calibrateCadence({ observations, ceiling: CEILING, now: NOW, previousScale: 2 })
  assert.equal(second.scale, 4)
  assert.equal(calibrateCadence({ observations, ceiling: CEILING, now: NOW, previousScale: 8 }).scale, MAX_SCALE)
})

Deno.test('an unknown ceiling is a reason to change nothing, never a reason to spend freely', () => {
  for (const ceiling of [null, undefined, 0, -5, Number.NaN, 'many' as unknown as number]) {
    const calibration = calibrateCadence({ observations: [observation(60, 0), observation(0, 9000)], ceiling, now: NOW })
    assert.equal(calibration.scale, 1, `ceiling ${String(ceiling)} must not move the cadence`)
    assert.equal(calibration.reason, 'ceiling_unknown')
  }
})

Deno.test('no output of the calibrator names or implies a plan', () => {
  const rich = calibrateCadence({ observations: [observation(60, 0), observation(0, 10)], ceiling: 360_000, now: NOW })
  const poor = calibrateCadence({ observations: [observation(60, 0), observation(0, 4000)], ceiling: CEILING, now: NOW })
  for (const calibration of [rich, poor, conservativeCalibration('no_observations')]) {
    const text = JSON.stringify(calibration)
    for (const plan of ['basic', 'builder', 'startup', 'growth', 'professional', 'enterprise', 'hackathon', 'plan']) {
      assert.ok(!text.toLowerCase().includes(plan), `calibration leaked ${plan}: ${text}`)
    }
  }
})

Deno.test('policy rows are stretched in one place so every capture lane reads the calibrated cadence', () => {
  const rows = [
    { provider: 'coinmarketcap', feature: 'catalogue', cadence_seconds: 3600, enabled: true },
    { provider: 'coinmarketcap', feature: 'quotes', cadence_seconds: 900, enabled: true },
    { provider: 'coinmarketcap', feature: 'broken', cadence_seconds: null, enabled: true },
  ]
  const stretched = calibratePolicyRows(rows, { ...conservativeCalibration('burn_over_budget'), scale: 2, reason: 'burn_over_budget' })
  assert.deepEqual(stretched.map((r) => r.cadence_seconds), [7200, 1800, null])
  // Enablement, ownership and every other column are untouched: this makes a
  // capture less frequent, it never turns one off.
  assert.deepEqual(stretched.map((r) => r.enabled), [true, true, true])
  assert.deepEqual(stretched.map((r) => r.feature), ['catalogue', 'quotes', 'broken'])
  // A conservative calibration returns the very same array.
  assert.equal(calibratePolicyRows(rows, conservativeCalibration('no_observations')), rows)
  assert.equal(calibratePolicyRows(rows, null), rows)
  assert.deepEqual(calibratePolicyRows(null, null), [])
})
