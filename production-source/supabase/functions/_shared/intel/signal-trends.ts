// Investor Intel — deterministic snapshot-history trend layer.
//
// Pure / no-I/O. Turns a per-signal history (from intel_signal_snapshots, retained
// 15 months) into the momentum the single 45-min prev-delta can't express: 1h/24h/7d
// change, exp-decay of recency, a consecutive same-direction streak, and a short
// least-squares slope. The basis is `severity` — the 0..1 strength field the snapshot
// table actually stores (it has no global_score column); callers pass the current
// severity as the anchor so windows compare like-for-like.

export interface TrendRow { snapshot_at: string; value: number; direction?: string | null }
export interface TrendPatch {
  d_1h: number | null
  d_24h: number | null
  d_7d: number | null
  decay: number | null
  streak: number
  slope: number | null
}

const round = (n: number, p = 4) => Number(n.toFixed(p))

export function computeTrends(
  history: TrendRow[],
  current: { value: number; direction?: string | null },
  now: number,
): TrendPatch {
  const curV = Number(current.value)
  const rows = (history || [])
    .map((r) => ({ t: new Date(r.snapshot_at).getTime(), v: Number(r.value), d: r.direction ?? null }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.v))
    .sort((a, b) => a.t - b.t)

  // window delta: current minus the snapshot nearest at-or-before now-Δ (null if the
  // window has no prior snapshot — sparse history must read as "unknown", not 0).
  const windowDelta = (ms: number): number | null => {
    const cutoff = now - ms
    let anchor: number | null = null
    for (const r of rows) { if (r.t <= cutoff) anchor = r.v; else break }
    return anchor === null || !Number.isFinite(curV) ? null : round(curV - anchor)
  }

  const last = rows.length ? rows[rows.length - 1] : null
  const decay = last ? round(Math.exp(-((now - last.t) / 3_600_000) / 24)) : null

  // streak: consecutive most-recent steps sharing the same sign of change, stopping at
  // a direction flip. Series = history + current; "cycle" = one snapshot-to-snapshot step.
  const series = [...rows.map((r) => ({ v: r.v, d: r.d })), { v: curV, d: current.direction ?? null }]
  const steps: number[] = []
  const flips: boolean[] = []
  for (let i = 1; i < series.length; i++) {
    const diff = series[i].v - series[i - 1].v
    steps.push(diff > 0.001 ? 1 : diff < -0.001 ? -1 : 0)
    flips.push(!!(series[i].d && series[i - 1].d && series[i].d !== series[i - 1].d))
  }
  let streak = 0
  const refSign = steps.length ? steps[steps.length - 1] : 0
  if (refSign !== 0) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i] !== refSign || flips[i]) break
      streak++
    }
  }

  // slope: least-squares fit of value over the last ≤8 points (per step)
  const tail = series.slice(-8)
  let slope: number | null = null
  if (tail.length >= 2) {
    const n = tail.length
    const mx = (n - 1) / 2
    const my = tail.reduce((a, p) => a + p.v, 0) / n
    let num = 0, den = 0
    for (let i = 0; i < n; i++) { num += (i - mx) * (tail[i].v - my); den += (i - mx) ** 2 }
    slope = den ? round(num / den, 5) : 0
  }

  return {
    d_1h: windowDelta(3_600_000),
    d_24h: windowDelta(86_400_000),
    d_7d: windowDelta(7 * 86_400_000),
    decay,
    streak,
    slope,
  }
}
