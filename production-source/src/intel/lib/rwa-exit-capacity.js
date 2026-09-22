// Exit capacity for a tokenised asset: how many days a position of a given size
// takes to sell if the seller keeps to a share of each day's traded volume.
//
// Pure, no I/O, no React. The depth board and the asset page's block both call
// it, so the method lives in one place and is tested once.
//
// ── THE METHOD, WHOLE ─────────────────────────────────────────────────────────
//   perDayUsd = participation × volume24hUsd × (1 − haircut)
//   days      = positionUsd ÷ perDayUsd
//
// It is a TURNOVER reading: it assumes the seller never exceeds a fixed share of
// a day's volume, and that the day's volume is the last reported 24 hours, cut
// by a stress haircut. Nothing here models price impact.
//
// The second reading is a SIZE RELATIVE TO RECOGNISED POOLS:
//   positionPctOfPool = positionUsd ÷ poolBaseUsd × 100
//   poolBaseUsd       = (exitLiquidityUsd ?? countedLiquidityUsd) × (1 − haircut)
// where exitLiquidityUsd is the quote side a seller receives, when CoinMarketCap
// reported it, and countedLiquidityUsd is both legs of the recognised pools. It
// is never called slippage and never presented as a price: no curve, fee tier or
// reserve split is in the data.
//
// ── NEVER ZERO DAYS FOR MISSING DATA ──────────────────────────────────────────
// Every input that could make the division meaningless returns `days: null` and
// an `unavailable` reason instead. A token with no reported volume is not a token
// that exits instantly, and one with zero volume is not one that exits never:
// both are named for what they are.

/** The participation presets offered in the input bar, in percent. */
export const PARTICIPATION_PRESETS = [5, 10, 20]
export const DEFAULT_POSITION_USD = 100_000
export const DEFAULT_PARTICIPATION_PCT = 10
export const DEFAULT_HAIRCUT_PCT = 0

/** Every reason an estimate can be unavailable. `state_<depth_state>` is built
 * from the row's own depth state, so it is listed here by prefix. */
export const EXIT_UNAVAILABLE = [
  'invalid_position', 'invalid_participation', 'invalid_haircut',
  'volume_not_reported', 'no_reported_trading',
  'counter_legs_unclassified', 'only_unrecognised_pools', 'state_',
]

/** The two scenarios the simulator shows, in the order it shows them. */
export const EXIT_SCENARIOS = ['recognised_pools', 'all_venues']

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Why a depth row cannot support an on-chain reading at all, or null. The same
 * gates the board uses before it will call any pool figure depth. */
export function depthGate({ state, classification, onlyUnrecognised } = {}) {
  if (state != null && state !== 'pools_read') return `state_${state}`
  if (state == null) return 'state_unknown'
  if (classification === 'unclassified') return 'counter_legs_unclassified'
  if (onlyUnrecognised) return 'only_unrecognised_pools'
  return null
}

function inputGate(positionUsd, participation, haircut) {
  if (positionUsd == null || positionUsd <= 0) return 'invalid_position'
  if (participation == null || participation <= 0 || participation > 1) return 'invalid_participation'
  if (haircut == null || haircut < 0 || haircut >= 1) return 'invalid_haircut'
  return null
}

/**
 * One estimate.
 *
 * `participation` and `haircut` are FRACTIONS (0.1 is ten percent).
 * `volumeUsd` is the 24-hour volume the scenario uses. `gate` is an optional
 * reason from `depthGate` that makes the pool comparison, and for the on-chain
 * scenario the whole estimate, unavailable.
 *
 * Returns `{ days, perDayUsd, positionPctOfPool, poolBaseUsd, poolBasis,
 * formula, unavailable, poolUnavailable }`. `days` is null whenever
 * `unavailable` is set, and is never 0.
 */
export function exitEstimate({
  positionUsd, participation, haircut = 0, volumeUsd,
  exitLiquidityUsd = null, countedLiquidityUsd = null,
  gate = null, gateVolume = true,
} = {}) {
  const position = num(positionUsd)
  const share = num(participation)
  const cut = num(haircut ?? 0)
  const volume = num(volumeUsd)
  const formula = { positionUsd: position, participation: share, haircut: cut, volumeUsd: volume }
  const empty = { days: null, perDayUsd: null, positionPctOfPool: null, poolBaseUsd: null, poolBasis: null, formula }

  const bad = inputGate(position, share, cut)
  if (bad) return { ...empty, unavailable: bad, poolUnavailable: bad }

  // The pool comparison, gated on its own: the all-venue scenario can still
  // have a day count when the pools cannot be read as depth.
  const exitLiq = num(exitLiquidityUsd)
  const counted = num(countedLiquidityUsd)
  const basis = exitLiq != null && exitLiq > 0 ? 'exit_liquidity' : counted != null && counted > 0 ? 'counted_liquidity' : null
  const poolBaseUsd = basis ? (basis === 'exit_liquidity' ? exitLiq : counted) * (1 - cut) : null
  const poolUnavailable = gate || (basis ? null : 'no_recognised_pool_size')
  const pool = poolUnavailable
    ? { positionPctOfPool: null, poolBaseUsd: null, poolBasis: null }
    : { positionPctOfPool: (position / poolBaseUsd) * 100, poolBaseUsd, poolBasis: basis }

  const unavailable = (gateVolume && gate)
    || (volume == null ? 'volume_not_reported' : volume <= 0 ? 'no_reported_trading' : null)
  if (unavailable) return { ...empty, ...pool, unavailable, poolUnavailable }

  const perDayUsd = share * volume * (1 - cut)
  const days = position / perDayUsd
  return {
    days, perDayUsd, ...pool,
    formula: { ...formula, perDayUsd, days },
    unavailable: null, poolUnavailable,
  }
}

/**
 * Both scenarios for one depth row.
 *
 * `recognised_pools` uses the 24-hour volume of the pools the board counts
 * (`countedVolume24hUsd`) and is gated like every other on-chain figure.
 * `all_venues` uses CoinMarketCap's own 24-hour volume for the token
 * (`providerVolume24hUsd`, joined from the wrapper capture), which includes
 * centralised venues, so the depth state does not gate its day count; the pool
 * comparison beside it is still gated.
 *
 * `inputs` are in PERCENT as typed: `{ positionUsd, participationPct, haircutPct }`.
 */
export function rowExitScenarios(row, inputs = {}) {
  const participation = num(inputs.participationPct) == null ? null : num(inputs.participationPct) / 100
  const haircut = num(inputs.haircutPct ?? 0) == null ? null : num(inputs.haircutPct ?? 0) / 100
  const gate = depthGate({ state: row?.state, classification: row?.classification, onlyUnrecognised: row?.onlyUnrecognised })
  const common = {
    positionUsd: inputs.positionUsd, participation, haircut,
    exitLiquidityUsd: row?.exitLiquidityUsd, countedLiquidityUsd: row?.countedLiquidityUsd, gate,
  }
  const allVenues = exitEstimate({ ...common, volumeUsd: row?.providerVolume24hUsd, gateVolume: false })
  return {
    recognised_pools: exitEstimate({ ...common, volumeUsd: row?.countedVolume24hUsd }),
    all_venues: {
      ...allVenues,
      // When the join found nothing, say which of its reasons applies rather
      // than the generic "not reported".
      volumeReason: allVenues.unavailable === 'volume_not_reported' ? (row?.providerVolumeReason || null) : null,
      volumeCapturedAt: row?.providerVolumeCapturedAt || null,
    },
  }
}

/** Days as words-ready text. Never prints 0: below a tenth of a day is "<0.1". */
export function daysLabel(days) {
  const d = num(days)
  if (d == null || d <= 0) return '—'
  if (d < 0.1) return '<0.1'
  if (d < 10) return d.toFixed(1)
  if (d < 1_000) return String(Math.round(d))
  return Math.round(d).toLocaleString('en-US')
}

/** Parse a typed number; empty or junk is null, never 0. */
export function parseInput(value) {
  if (value == null) return null
  const cleaned = String(value).replace(/[,\s$%]/g, '')
  if (!cleaned) return null
  return num(cleaned)
}
