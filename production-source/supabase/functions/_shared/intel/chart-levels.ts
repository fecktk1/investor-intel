import { normalizeBars, type Bar } from './chart-analysis.ts'
import { chartStructure, type StructureFinding } from './chart-structure.ts'

export const LEVELS_VERSION = 'levels-1'
export type TieredLevel = StructureFinding & { methodVersion: string; tier: string; confirmations: StructureFinding[]; distinctPivots: number; windows: number[] }

/** A tier describes observed confirmations, not a success probability. The
 * second window must not count the same source bar as a second price test. */
export function groupConfirmedLevels(pivots: StructureFinding[], lastClose: number, atr: number, window: number): TieredLevel[] {
  if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(lastClose) || lastClose <= 0) return []
  const sorted = [...new Map(pivots.map(p => [p.id, p])).values()].sort((a, b) => a.price - b.price || a.t - b.t || a.id.localeCompare(b.id))
  const groups: StructureFinding[][] = []
  for (const pivot of sorted) {
    const group = groups.at(-1)
    // A chain of nearby prices may not broaden a zone beyond the stated limit.
    if (group && pivot.price - group[0].price <= atr * .25) group.push(pivot)
    else groups.push([pivot])
  }
  return groups.map(members => {
    const lower = members[0].price, upper = members.at(-1)!.price
    const price = members[Math.floor(members.length / 2)].price
    const distinctPivots = new Set(members.map(p => p.t)).size, windows = [...new Set(members.map(p => p.window))].sort((a, b) => a - b)
    const tier = distinctPivots < 2 ? 'Single pivot' : windows.length > 1 ? 'Repeated across windows' : 'Repeated pivot'
    const label = upper < lastClose ? 'Support zone' : lower > lastClose ? 'Resistance zone' : 'Zone at current close'
    const boundary = upper < lastClose ? upper : lower > lastClose ? lower : lastClose
    const confirmations = members.slice().sort((a, b) => a.confirmedAt - b.confirmedAt || a.id.localeCompare(b.id))
    return { id: `level:${members.map(p => p.id).join('|')}`, kind: 'level', label, tier, methodVersion: LEVELS_VERSION,
      t: Math.min(...members.map(p => p.t)), confirmedAt: Math.max(...members.map(p => p.confirmedAt)),
      knownAt: members.every(p => p.knownAt != null) ? Math.max(...members.map(p => p.knownAt!)) : null,
      price, lower, upper, distanceAtr: (boundary - lastClose) / atr, window, windows, distinctPivots, confirmations,
      definition: `${LEVELS_VERSION}: confirmed pivots within a total width of 0.25 × current Wilder ATR form a zone. ${distinctPivots} distinct source bars; confirmation windows ${windows.join(' and ')} bars each side. The same pivot seen at two windows counts once. Support/resistance describes the zone relative to the last completed close, including previously crossed levels. Distance uses the nearest boundary. These tiers count observations, not predictive strength or trade probabilities.` }
  }).sort((a, b) => Math.abs(a.distanceAtr) - Math.abs(b.distanceAtr) || b.confirmedAt - a.confirmedAt).slice(0, 80)
}

export function chartStructureReview(input: Bar[], options: Parameters<typeof chartStructure>[1]) {
  const base = chartStructure(input, options), window = base.window, wider = Math.min(10, window * 2)
  const eligible = normalizeBars(input).bars.filter(b => b.o != null && b.closedAt != null && b.closedAt <= options.at && (!options.knownOnly || b.recordedAt != null && b.recordedAt <= options.at))
  let segmentStart = eligible[0]?.t ?? Infinity
  for (let i = 1; i < eligible.length; i++) if (eligible[i].t - eligible[i - 1].t !== options.intervalMs) segmentStart = eligible[i].t
  const wide = wider > window ? chartStructure(input, { ...options, window: wider }) : null
  const candidates = [...base.pivots, ...(wide?.pivots || [])].filter(p => p.t >= segmentStart)
  const levels = base.atr != null && eligible.length ? groupConfirmedLevels(candidates, eligible.at(-1)!.c, base.atr, window) : []
  return { ...base, levels, levelsVersion: LEVELS_VERSION, levelsReason: base.reason || (base.atr == null ? 'More completed, contiguous bars are needed for the ATR grouping width.' : !levels.length ? 'No confirmed zones in the latest continuous price segment.' : null) }
}
