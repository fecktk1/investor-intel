import { normalizeBars, type Bar } from './chart-analysis.ts'
import { validateDrawing } from './chart-workspace-contract.ts'

import {CHART_OUTCOME_VERSION,validateOutcomeSpec,type OutcomeSpec} from './chart-outcome-contract.ts'
export {CHART_OUTCOME_VERSION,validateOutcomeSpec,type OutcomeSpec} from './chart-outcome-contract.ts'
type Options={at:number;intervalMs?:number;knownOnly?:boolean}

/** Hypothetical OHLC evaluation, never a fill or an accounting writer. Unknown
 * intrabar order and missing periods terminate evaluation instead of choosing a
 * profitable path. Close triggers enter only after their full source bar. */
export function chartOutcome(input: Bar[], raw: OutcomeSpec, options: Options) {
  const spec = validateOutcomeSpec(raw), sign = spec.direction === 'long' ? 1 : -1, step = options.intervalMs
  if (!Number.isSafeInteger(options.at) || options.at>4102444800000 || options.at < spec.start || !Number.isSafeInteger(step) || step! < 1000) throw Error('A valid evaluation time and verified candle interval are required.')
  const normalized = normalizeBars(input), bars = normalized.bars.filter(b => b.t >= spec.start && b.closedAt != null && b.closedAt <= options.at && b.o != null && b.h != null && b.l != null && (!options.knownOnly || b.recordedAt != null && b.recordedAt <= options.at))
  const base = { version: CHART_OUTCOME_VERSION, spec, at: options.at, intervalMs: step!, knownOnly: !!options.knownOnly, bars: bars.length,
    knownAt: bars.length && bars.every(b => b.recordedAt != null) ? Math.max(...bars.map(b => b.recordedAt!)) : null,
    entry: null as null | { t: number; closedAt: number; price: number; exactTime: boolean }, exit: null as null | { t: number; closedAt: number; price: number; exactTime: boolean },
    pnl: null as null | { gross: number; fees: number; net: number; entryPrice: number; exitPrice: number }, possibilities: [] as { label: string; net: number }[] }
  const result = (status: string, reason: string) => ({ ...base, status, reason })
  if (!bars.length) return result('unavailable', 'No eligible completed OHLC bars exist in this evaluation window.')
  if (bars[0].t - spec.start >= step!) return result('incomplete', 'The beginning of the requested window is missing. An earlier trigger cannot be excluded.')
  const economics = (entry: number, exit: number) => {
    const entryPrice = entry * (1 + sign * spec.slippageBps / 10000), exitPrice = exit * (1 - sign * spec.slippageBps / 10000)
    const gross = sign * (exitPrice - entryPrice) * spec.quantity, fees = (entryPrice + exitPrice) * spec.quantity * spec.feeBps / 10000, net = gross - fees
    if (![entryPrice, exitPrice, gross, fees, net].every(Number.isFinite)) throw Error('The modeled result exceeds the supported calculation range.')
    return { gross, fees, net, entryPrice, exitPrice }
  }
  for (let index = 0; index < bars.length; index++) {
    const b = bars[index]
    if (index > 0 && b.t - bars[index - 1].t !== step) return result('incomplete', 'A source period is missing. Trigger and exit order across the gap are unknown.')
    const stopHit = sign === 1 ? b.l! <= spec.stop : b.h! >= spec.stop, targetHit = spec.target != null && (sign === 1 ? b.h! >= spec.target : b.l! <= spec.target)
    let enteredThisBar = false
    if (!base.entry) {
      const hit = spec.trigger === 'touch' ? b.l! <= spec.entry && b.h! >= spec.entry : spec.trigger === 'close_above' ? b.c > spec.entry : b.c < spec.entry
      if (!hit) continue
      const price = spec.trigger === 'touch' ? spec.entry : b.c
      if ((price - spec.stop) * sign <= 0 || spec.target != null && (spec.target - price) * sign <= 0) return result('missed', 'The trigger close is already outside the specified stop/target bracket. No hypothetical entry is assumed.')
      base.entry = { t: b.t, closedAt: b.closedAt!, price, exactTime: spec.trigger !== 'touch' }
      enteredThisBar = true
      if (spec.trigger !== 'touch') continue // The close signal cannot exit earlier in its own bar.
      if (b.o !== spec.entry && (stopHit || targetHit)) return result('ambiguous', 'The entry and an exit level occurred in the same candle. OHLC cannot establish their order; no result is assigned.')
    }
    const stopAtOpen = !enteredThisBar && (b.o! - spec.stop) * sign <= 0
    const targetAtOpen = !enteredThisBar && spec.target != null && (b.o! - spec.target) * sign >= 0
    if (stopHit && targetHit && !stopAtOpen && !targetAtOpen) {
      base.possibilities = [{ label: 'Stop first', net: economics(base.entry.price, spec.stop).net }, { label: 'Target first', net: economics(base.entry.price, spec.target!).net }]
      return result('ambiguous', 'Both exit levels were reached in the same candle. Their order is unknown; the two modeled outcomes remain separate.')
    }
    if (stopHit || targetHit) {
      const stopped = stopAtOpen || stopHit && !targetAtOpen, price = stopped ? stopAtOpen ? b.o! : spec.stop : spec.target!
      base.exit = { t: b.t, closedAt: b.closedAt!, price, exactTime: stopAtOpen || targetAtOpen }
      base.pnl = economics(base.entry.price, price)
      return result(stopped ? 'stopped' : 'target', stopped ? stopAtOpen ? 'The candle opened beyond the stop; the model uses that opening price before costs.' : 'The stop was reached in a later completed candle.' : 'The target was reached; the model uses the target price before costs, without favorable gap improvement.')
    }
  }
  if (options.at - bars.at(-1)!.closedAt! >= step!) return result('incomplete', 'The latest completed source period is missing. The outcome remains unresolved.')
  return base.entry ? result('open', 'The trigger occurred; neither exit has been established by the evaluation cutoff. No realized result is assigned.') : result('pending', 'No qualifying trigger occurred in these completed candles.')
}

export function chartOutcomeDrawing(outcome: ReturnType<typeof chartOutcome>, id: string, source: string) {
  const s = outcome.spec
  const text = `${CHART_OUTCOME_VERSION} · Hypothetical ${s.direction}; ${outcome.status}. Source: ${source.slice(0, 120)}. Start ${new Date(s.start).toISOString()}; evaluated through ${new Date(outcome.at).toISOString()}; interval ${outcome.intervalMs}ms; recorded-only ${outcome.knownOnly}; inputs captured by ${outcome.knownAt==null?'unknown':new Date(outcome.knownAt).toISOString()}. Trigger ${s.trigger} ${s.entry}; stop ${s.stop}; target ${s.target ?? 'none'}; quantity ${s.quantity}; fee ${s.feeBps}bps each side; slippage ${s.slippageBps}bps each side. Entry ${outcome.entry ? JSON.stringify(outcome.entry) : 'not established'}; exit ${outcome.exit ? JSON.stringify(outcome.exit) : 'not established'}. Modeled result ${outcome.pnl ? JSON.stringify(outcome.pnl) : 'unresolved'}${outcome.possibilities.length ? '; possible outcomes ' + JSON.stringify(outcome.possibilities) : ''}. ${outcome.reason} Retrospective rehearsal, not an executed trade or evidence that the idea existed at the start time.`
  return validateDrawing({ id, tool: 'text', anchors: [{ t: outcome.entry ? outcome.entry.exactTime ? outcome.entry.closedAt : outcome.entry.t : s.start, price: outcome.entry?.price ?? s.entry }], text, color: '#DFA647', width: 1, outcome: {version:CHART_OUTCOME_VERSION,spec:outcome.spec,at:outcome.at,intervalMs:outcome.intervalMs,knownOnly:outcome.knownOnly,source:source.slice(0,120)} })
}
