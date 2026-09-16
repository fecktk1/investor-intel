// Investor Intel: cadence calibrated from the account's own observed burn.
//
// WHAT THIS IS NOT. It is not a cap. `cmc_request_reserve` in SQL remains the
// one enforcement point: it holds the reservation ledger, compares against
// LEAST(p_cap, credit_limit * 0.8) and refuses a call that would cross it. This
// module never raises that ceiling, never bypasses it, and never decides
// whether a call may happen. It decides only how OFTEN the scheduled captures
// ask, which is the difference between arriving at the reset with budget spare
// and arriving at it in the first week.
//
// WHAT CHANGES. Cadence used to come entirely from a constant table
// (planTargets in schedule-policy.ts, mirrored in SQL). That table stays, and
// stays the reviewed maximum rate. What is new is a measurement: successive
// observations of the provider's own credits_used, appended by
// `cmc_account_observe` beside the account sync that already happens, give a
// real burn rate. Compare it with what the remaining budget can afford between
// now and the reset and the scheduler can stretch a cadence it cannot sustain.
//
// THE PLAN IS NEVER INFERRED. cmcPlan() in cmc-transport.ts uses an explicitly
// verified profile and says why: "never infer a tier from a key or credit
// balance". Nothing here reads a plan name, returns one, or lets a balance
// imply one. The only output is a multiplier on a cadence.
//
// IT ONLY EVER SLOWS DOWN. The multiplier floor is 1. The plan target table is
// the fastest rate anybody reviewed, and spending faster than a reviewed rate
// because this month happens to look cheap would be this module deciding to
// spend money on its own. Every degradation path returns a multiplier of
// exactly 1, which is today's behaviour unchanged.
//
// THE 30 SEPTEMBER BOUNDARY. CMC_SOURCE_POLICY_EXPIRES_AT (2026-09-30T23:59
// UTC) flips several source permissions to false, and the verified hackathon
// profile expires at the same instant, which moves the enforced ceiling from
// 360,000 credits to 12,000. Burn measured on one side of a boundary does not
// describe the other: mixed observations would demand an enormous stretch at
// midnight and relax an hour later. Observations at or before the newest
// boundary already passed are discarded, and until two survive the calibrator
// reports `awaiting_post_boundary_observations` and changes nothing.

export interface AccountObservation { at: string; used: number; limit: number; resetAt: string }

export interface CadenceCalibration {
  /** Multiplier on a cadence in seconds. Always >= 1. */
  scale: number
  /** Why this multiplier, always named. Never empty. */
  reason: string
  /** Observations that survived the boundary, reset and shape filters. */
  usable: number
  observedCreditsPerSecond: number | null
  affordableCreditsPerSecond: number | null
  remainingCredits: number | null
  secondsToReset: number | null
  windowSeconds: number | null
  observedAt: string | null
}

export const MAX_SCALE = 8
/** A cadence is stretched, never parked: a feature must keep running. */
export const MAX_CADENCE_SECONDS = 7 * 86_400
/** Two syncs closer together than this measure scheduler jitter, not burn. */
export const MIN_WINDOW_SECONDS = 600
/** Past this the newest observation no longer describes the account now. */
export const MAX_OBSERVATION_AGE_SECONDS = 21_600
/** Burn has to exceed what is affordable by this much before anything moves,
 * so a rate hovering at the line does not flip the cadence back and forth. */
export const HYSTERESIS = 0.15
/** Ceiling on how far one read may move the multiplier, so a single unusual
 * window cannot slam every cadence to the maximum in one step. */
export const MAX_STEP = 2

const BASE: CadenceCalibration = {
  scale: 1, reason: 'no_observations', usable: 0,
  observedCreditsPerSecond: null, affordableCreditsPerSecond: null,
  remainingCredits: null, secondsToReset: null, windowSeconds: null, observedAt: null,
}

/** Today's behaviour, with a named reason. Every failure lands here. */
export const conservativeCalibration = (reason: string, over: Partial<CadenceCalibration> = {}): CadenceCalibration =>
  ({ ...BASE, reason, ...over, scale: 1 })

// Number(null) and Number('') are 0, and a cadence of 0 is a real recorded
// value, so an absent figure must be rejected before the numeric coercion.
const finite = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const instant = (v: unknown): number | null => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : null }
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
// Nine places, because a credit a day is 1.16e-5 per second and a coarser
// rounding would report a real slow burn as no burn at all.
const round = (value: number, places = 9): number => Number(value.toFixed(places))

export interface CalibrationInput {
  observations: AccountObservation[]
  /** The governed ceiling `cmc_request_reserve` enforces, from cmcCreditCeiling. */
  ceiling: number | null | undefined
  now?: number
  /** Instants after which earlier burn no longer describes this account: the
   * source-policy expiry and the verified-profile expiry. */
  boundaries?: Array<string | null | undefined>
  /** A previous multiplier, so one read cannot move it more than MAX_STEP. */
  previousScale?: number | null
  /** A read failure, carried rather than mistaken for "no burn". */
  error?: string | null
}

export function calibrateCadence(input: CalibrationInput): CadenceCalibration {
  const now = input.now ?? Date.now()
  if (input.error) return conservativeCalibration(input.error)
  const ceiling = finite(input.ceiling)
  if (ceiling == null || ceiling <= 0) return conservativeCalibration('ceiling_unknown')

  const boundary = (input.boundaries ?? []).map(instant).filter((t): t is number => t != null && t <= now)
    .reduce((newest, t) => Math.max(newest, t), 0)

  const clean = (Array.isArray(input.observations) ? input.observations : [])
    .filter((o) => o && finite(o.used) != null && finite(o.limit) != null && instant(o.at) != null && instant(o.resetAt) != null)
    .filter((o) => instant(o.at)! > boundary)
    // A window that has already reset describes a period that is over.
    .filter((o) => instant(o.resetAt)! > now)
    .sort((a, b) => instant(a.at)! - instant(b.at)!)

  if (!clean.length) return conservativeCalibration(boundary > 0 ? 'awaiting_post_boundary_observations' : 'no_observations')
  const newest = clean[clean.length - 1]
  const observedAt = new Date(instant(newest.at)!).toISOString()
  const age = (now - instant(newest.at)!) / 1000
  if (age > MAX_OBSERVATION_AGE_SECONDS) return conservativeCalibration('observations_stale', { usable: clean.length, observedAt })
  if (clean.length < 2) {
    return conservativeCalibration(boundary > 0 ? 'awaiting_post_boundary_observations' : 'single_observation', { usable: clean.length, observedAt })
  }

  // Only pairs inside ONE reset window, at ONE credit limit, with a counter that
  // did not go backwards, describe one burn.
  const rates: number[] = []
  let windowSeconds = 0
  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1], b = clean[i]
    if (a.resetAt !== b.resetAt || finite(a.limit) !== finite(b.limit)) continue
    if (finite(b.used)! < finite(a.used)!) continue
    const seconds = (instant(b.at)! - instant(a.at)!) / 1000
    if (seconds < MIN_WINDOW_SECONDS) continue
    rates.push((finite(b.used)! - finite(a.used)!) / seconds)
    windowSeconds += seconds
  }
  if (!rates.length) return conservativeCalibration('window_too_short', { usable: clean.length, observedAt })

  // The median resists one refresh storm. A mean would let a single spike hold
  // every cadence stretched for the rest of the month.
  const observed = round(median(rates))
  const secondsToReset = (instant(newest.resetAt)! - now) / 1000
  const remaining = Math.max(0, ceiling - finite(newest.used)!)
  const measured: CadenceCalibration = {
    ...BASE, usable: clean.length, observedAt, observedCreditsPerSecond: observed,
    remainingCredits: round(remaining, 3), secondsToReset: round(secondsToReset, 3), windowSeconds: round(windowSeconds, 3),
    affordableCreditsPerSecond: secondsToReset > 0 ? round(remaining / secondsToReset) : null,
  }
  if (secondsToReset <= 0) return { ...measured, scale: 1, reason: 'reset_window_closed' }
  // A burn of exactly zero is a real reading: nothing was spent in the window.
  // It can never be short of budget, so the reviewed cadence stands.
  if (observed <= 0) return { ...measured, scale: 1, reason: 'burn_within_budget' }
  const affordable = measured.affordableCreditsPerSecond!
  if (affordable <= 0) return { ...measured, scale: MAX_SCALE, reason: 'budget_exhausted' }

  const ratio = observed / affordable
  if (ratio <= 1 + HYSTERESIS) return { ...measured, scale: 1, reason: 'burn_within_budget' }
  // The step ceiling damps SUCCESSIVE moves. With no previous multiplier there
  // is nothing to damp, and braking immediately is the safer reading.
  const previous = finite(input.previousScale)
  const step = previous != null && previous >= 1 ? previous * MAX_STEP : Number.POSITIVE_INFINITY
  const scale = Math.min(MAX_SCALE, step, Number(ratio.toFixed(2)))
  return { ...measured, scale, reason: scale >= MAX_SCALE ? 'burn_over_budget_capped' : 'burn_over_budget' }
}

/** A reviewed cadence stretched by a calibration. A missing, unusable or
 * conservative calibration returns the reviewed cadence unchanged. */
export function calibratedCadenceSeconds(seconds: unknown, calibration?: CadenceCalibration | null): number | null {
  const base = finite(seconds)
  if (base == null || base <= 0) return base
  const scale = finite(calibration?.scale)
  if (scale == null || scale <= 1) return base
  return Math.min(MAX_CADENCE_SECONDS, Math.round(base * scale))
}

/** Schedule rows with their cadences stretched. Applied once where the policy is
 * loaded, so every capture lane reads the calibrated cadence without any lane
 * needing to know this module exists. A row with no usable cadence is passed
 * through untouched rather than given one. */
export function calibratePolicyRows<T extends { cadence_seconds?: number | null }>(rows: T[] | null | undefined, calibration?: CadenceCalibration | null): T[] {
  const list = Array.isArray(rows) ? rows : []
  if (!calibration || !(Number(calibration.scale) > 1)) return list
  return list.map((row) => {
    const next = calibratedCadenceSeconds(row?.cadence_seconds, calibration)
    return next == null || next === row?.cadence_seconds ? row : { ...row, cadence_seconds: next }
  })
}

export const OBSERVATION_DATA_TYPE = 'cmc_account_observation'

/** The bounded ring of account observations. A read failure is reported as a
 * named reason and never as an empty history, because an empty history and an
 * unreadable one lead to the same conservative multiplier for different
 * reasons, and only one of them is worth an operator's attention.
 *
 * The row also holds the key fingerprint that scopes the series. It is read to
 * scope nothing here and is never returned: no caller of this function has any
 * use for it. */
// deno-lint-ignore no-explicit-any
export async function loadAccountObservations(db: any): Promise<{ observations: AccountObservation[]; error: string | null }> {
  if (!db?.from) return { observations: [], error: 'db_unavailable' }
  try {
    const { data, error } = await db.from('provider_quota_budgets').select('config')
      .eq('provider', 'coinmarketcap').eq('data_type', OBSERVATION_DATA_TYPE).maybeSingle()
    if (error) return { observations: [], error: 'observations_unavailable' }
    const raw = (data?.config as Record<string, unknown> | undefined)?.observations
    if (raw == null) return { observations: [], error: null }
    if (!Array.isArray(raw)) return { observations: [], error: 'observations_malformed' }
    const observations: AccountObservation[] = []
    for (const entry of raw as Array<Record<string, unknown>>) {
      if (!entry || typeof entry !== 'object') continue
      const used = finite(entry.used), limit = finite(entry.limit)
      if (used == null || limit == null || instant(entry.at) == null || instant(entry.resetAt) == null) continue
      observations.push({ at: new Date(instant(entry.at)!).toISOString(), used, limit, resetAt: new Date(instant(entry.resetAt)!).toISOString() })
    }
    return { observations, error: null }
  } catch { return { observations: [], error: 'observations_unavailable' } }
}
