import { normalizeBars, calculateStudy, STUDY_CATALOG, type Bar } from './chart-analysis.ts'
import { chartStructureReview } from './chart-levels.ts'
import { type PatternOptions } from './chart-patterns.ts'
import { validateDrawing } from './chart-workspace-contract.ts'

export const CHART_READ_VERSION = 'read-1'
const definitions = ['dema', 'ema', 'rsi', 'macd', 'bollinger', 'vwap', 'atr']
const clock = (bars: Bar[]) => bars.length && bars.every(b => b.recordedAt != null) ? Math.max(...bars.map(b => b.recordedAt!)) : null

/** A reproducible reading of the loaded evidence, independent of AI generation. */
export function chartResearchRead(input: Bar[], options: PatternOptions) {
  if (!Number.isFinite(options.at)) throw Error('invalid_chart_read_time')
  const step = options.intervalMs
  if (!Number.isSafeInteger(step) || step! < 1000) return { version: CHART_READ_VERSION, last: null, studies: [], levels: [], scenarios: [], knownAt: null, reason: 'A verified bar interval is required.' }
  const eligible = normalizeBars(input).bars.filter(b => b.closedAt != null && b.closedAt <= options.at && (!options.knownOnly || b.recordedAt != null && b.recordedAt <= options.at))
  let first = 0
  for (let i = 1; i < eligible.length; i++) if (eligible[i].t - eligible[i - 1].t !== step) first = i
  const bars = eligible.slice(first), last = bars.at(-1) ?? null
  const studies = definitions.map(type => {
    const result = calculateStudy(bars, { id: type, type }, { intervalMs: step })
    const readings = result.series.map(series => ({ label: series.name, value: last && series.points.at(-1)?.t === last.t ? series.points.at(-1)!.value : null, points: series.points.slice(-20) }))
    return { id: type, label: STUDY_CATALOG[type].label, pane: result.pane, readings, reason: result.reason, definition: result.definition, warmup: result.warmup, bars: bars.length }
  })
  const structure = chartStructureReview(bars, options)
  const support = last ? structure.levels.filter(l => l.upper! < last.c).sort((a, b) => b.upper! - a.upper!)[0] : null
  const resistance = last ? structure.levels.filter(l => l.lower! > last.c).sort((a, b) => a.lower! - b.lower!)[0] : null
  // Outer boundaries represent a complete move beyond the zone. Nothing is
  // rounded before condition evaluation or serialized into a proposed order.
  const low = support?.lower ?? null, high = resistance?.upper ?? null
  const scenarios = [
    { id: 'bull', label: 'Bull case', trigger: high, invalidation: resistance?.lower ?? null, operator: 'above',
      criterion: high == null ? 'A confirmed resistance zone is unavailable.' : `A future completed close strictly above ${high} would clear the nearest confirmed resistance zone.`,
      invalidationText: resistance == null ? 'Unavailable without a confirmed zone.' : `A subsequent completed close at or below ${resistance.lower} would fail to hold above that zone.`,
      caveat: 'An intrabar wick is not a completed-close trigger. Liquidity, execution costs and future outcomes are not established by this condition.' },
    { id: 'base', label: 'Range case', trigger: null, invalidation: null, operator: 'inside',
      criterion: low == null || high == null ? 'Both a confirmed support and resistance zone are required.' : `Future completed closes remaining between ${low} and ${high}, inclusive, stay within the observed surrounding zones.`,
      invalidationText: low == null || high == null ? 'Unavailable without both boundaries.' : `A completed close below ${low} or above ${high} ends this range condition.`,
      caveat: 'Remaining inside a range is descriptive; it does not establish accumulation, equilibrium or a profitable trade.' },
    { id: 'bear', label: 'Bear case', trigger: low, invalidation: support?.upper ?? null, operator: 'below',
      criterion: low == null ? 'A confirmed support zone is unavailable.' : `A future completed close strictly below ${low} would clear the nearest confirmed support zone.`,
      invalidationText: support == null ? 'Unavailable without a confirmed zone.' : `A subsequent completed close at or above ${support.upper} would fail to hold below that zone.`,
      caveat: 'This conditional scenario is not a short recommendation or a forecast. A wick and a closing break remain different observations.' },
  ].map(scenario => ({ ...scenario, available: scenario.id === 'base' ? low != null && high != null : scenario.trigger != null,
    evidenceIds: scenario.id === 'bull' ? resistance ? [resistance.id] : [] : scenario.id === 'bear' ? support ? [support.id] : [] : [support?.id, resistance?.id].filter(Boolean) as string[] }))
  return { version: CHART_READ_VERSION, last, studies, levels: [support, resistance].filter(Boolean), scenarios, knownAt: clock(bars),
    reason: 'Deterministic reading of completed, contiguous source bars. Scenarios describe future conditions around observed levels; no probability, target, position size, trade instruction or automatic thesis change is generated.' }
}

/** Explain the exact selected evidence, without asking a language model to invent a number. */
export function explainChartLevel(level: NonNullable<ReturnType<typeof chartResearchRead>['levels'][number]>, last: Bar, source: string) {
  const side = level.upper! < last.c ? 'below' : level.lower! > last.c ? 'above' : 'around'
  return `${level.label} spans ${level.lower}–${level.upper}, ${side} the completed close of ${last.c}. It groups ${level.distinctPivots} distinct confirmed source pivots, using ${level.windows.join(' and ')} bars on each side. ${level.tier} describes repeated observations, not reliability odds. The zone was fully confirmed at ${new Date(level.confirmedAt).toISOString()}. Source: ${source.slice(0, 120)}. ${level.definition}`
}

export function chartReadDrawing(read: ReturnType<typeof chartResearchRead>, id: string, mode: string, source: string) {
  if (!read.last) throw Error('No completed price observation is available.')
  const scenario = mode === 'neutral' ? null : read.scenarios.find(s => s.id === mode)
  if (mode !== 'neutral' && (!scenario || !scenario.available)) throw Error('The selected scenario has insufficient confirmed evidence.')
  const evidence = read.studies.map(study => `${study.label}: ${study.readings.map(r => `${r.label} ${r.value ?? 'unavailable'}`).join(', ') || study.reason}`).join('; ')
  const text = `${CHART_READ_VERSION} · ${scenario?.label || 'Neutral chart read'}. Source: ${source.slice(0, 120)}. Completed ${new Date(read.last.closedAt!).toISOString()}; close ${read.last.c}. ${scenario ? `${scenario.criterion} ${scenario.invalidationText} ${scenario.caveat}` : evidence}. ${read.reason}`
  return validateDrawing({ id, tool: 'text', anchors: [{ t: read.last.t, price: read.last.c }], text, color: '#DFA647', width: 1 })
}
