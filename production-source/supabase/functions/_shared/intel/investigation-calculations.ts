import {STRESS_BASES} from './stress-scenario-contract.ts'
import {conditionPeriod,matchesConditionSource} from './condition-source.ts'
import {venueConditionObservations} from './venue-condition-sources.ts'
import { evidenceAt, finite, instant, observationState, type Observation } from './investigation-evidence.ts'

export interface VenueObservation {
  id: string; subject: string; venueId: string; venue: string; observedAt: string | null; expiresAt: string | null;
  openInterestUsd: number | null; fundingRatePercent?: number | null; fundingPeriodSeconds?: number | null; fundingUnit?: 'percent' | 'ratio' | 'unknown';
  quoteCurrency: string; compatibleQuote: boolean; excluded?: boolean; sourceRef: string
}
export function marketFragility(rows: VenueObservation[], subject: string, asOf: number, alignmentMs = 300000) {
  const seen = new Set<string>(), excluded: { id: string; reason: string }[] = []
  const accepted = rows.filter(row => {
    const t = instant(row.observedAt), value = finite(row.openInterestUsd), identity = `${row.venueId}:${row.id}`
    const reason = row.subject !== subject ? 'Different asset identity' : !row.venueId||!row.id ? 'Missing venue or contract identity' : seen.has(identity) ? 'Duplicate contract' : row.excluded ? 'Provider excluded this observation' :
      !row.compatibleQuote || row.quoteCurrency !== 'USD' ? 'Quote currency is not verified as USD' :
      t == null || t > asOf || asOf - t > alignmentMs || (instant(row.expiresAt) ?? -Infinity) <= asOf ? 'Missing, stale or unaligned observation time' :
        value == null || value < 0 ? 'Open interest must be a nonnegative reported USD value' : null
    if (reason) { excluded.push({ id: row.id, reason }); return false }
    seen.add(identity); return true
  })
  const totalOpenInterestUsd = accepted.reduce((sum, row) => sum + row.openInterestUsd!, 0)
  const venues = new Map<string, { id: string; name: string; openInterestUsd: number; contracts: VenueObservation[] }>()
  for (const row of accepted) {
    const venue = venues.get(row.venueId) ?? { id: row.venueId, name: row.venue, openInterestUsd: 0, contracts: [] }
    venue.openInterestUsd += row.openInterestUsd!; venue.contracts.push(row); venues.set(row.venueId, venue)
  }
    const data = [...venues.values()].map(v => ({ ...v, sharePercent: totalOpenInterestUsd>0?v.openInterestUsd / totalOpenInterestUsd * 100:null,
    // Do not average different contracts or annualize an unknown funding period.
    funding: v.contracts.map(c => ({ contractId: c.id, rateRaw: finite(c.fundingRatePercent), ratePercent: c.fundingUnit==='unknown'?null:c.fundingUnit==='ratio'&&c.fundingRatePercent!=null?c.fundingRatePercent*100:finite(c.fundingRatePercent), unit: c.fundingUnit||'percent', periodSeconds: finite(c.fundingPeriodSeconds),
      comparable: c.fundingUnit!=='unknown' && finite(c.fundingRatePercent) != null && finite(c.fundingPeriodSeconds) != null && c.fundingPeriodSeconds! > 0 })) }))
    .sort((a, b) => b.openInterestUsd - a.openInterestUsd || a.id.localeCompare(b.id))
  return { venues: data, excluded, totalOpenInterestUsd: accepted.length ? totalOpenInterestUsd : null,
    largestVenueShare: data[0]?.sharePercent ?? null, coveredContracts: accepted.length, suppliedContracts: rows.length,
    coverage: 'Shares use only the covered, time-aligned derivative contracts. They are not exchange-wide or spot-market coverage.' }
}

export interface AttentionObservation { subject: string; name: string; rank: number | null; rankTime: number | null; volumeUsd: number | null; marketCapUsd: number | null; quoteTime: number | null }
export function attentionCapital(current: AttentionObservation[], previous: AttentionObservation[] | null, maxAlignmentMs = 3600000) {
  const before = new Map((previous ?? []).map(o => [o.subject, o])), seen = new Set<string>()
  return current.filter(o => { if (seen.has(o.subject)) return false; seen.add(o.subject); return true }).map(o => {
    const old = before.get(o.subject), aligned = o.rankTime != null && o.quoteTime != null && Math.abs(o.rankTime - o.quoteTime) <= maxAlignmentMs
    const baselineAligned = old?.rankTime != null && old.quoteTime != null && Math.abs(old.rankTime - old.quoteTime) <= maxAlignmentMs &&
      o.rankTime != null && o.quoteTime != null && o.rankTime > old.rankTime && o.quoteTime > old.quoteTime &&
      Math.abs((o.rankTime - old.rankTime) - (o.quoteTime - old.quoteTime)) <= maxAlignmentMs
    const validRank = finite(o.rank) != null && o.rank! > 0
    const rankChange = aligned && baselineAligned && validRank && finite(old?.rank) != null && old!.rank! > 0 ? old!.rank! - o.rank! : null
    const volumeChangePercent = aligned && baselineAligned && finite(o.volumeUsd) != null && o.volumeUsd! >= 0 && finite(old?.volumeUsd) != null && old!.volumeUsd! > 0 ? (o.volumeUsd! / old!.volumeUsd! - 1) * 100 : null
    const turnover = aligned && finite(o.marketCapUsd) != null && o.marketCapUsd! > 0 && finite(o.volumeUsd) != null && o.volumeUsd! >= 0 ? o.volumeUsd! / o.marketCapUsd! : null
    return { ...o, aligned, rankChange, volumeChangePercent, turnover,
      state: !aligned ? 'unaligned' : !old || !baselineAligned ? 'baseline_needed' : rankChange == null || volumeChangePercent == null ? 'partial' : 'comparable',
      pattern: rankChange != null && volumeChangePercent != null ? rankChange > 0 && volumeChangePercent <= 0 ? 'Attention rose while reported volume did not' :
        rankChange <= 0 && volumeChangePercent > 0 ? 'Reported volume rose without improving attention rank' : 'Attention and volume moved together or were unchanged' : 'A comparable prior observation is needed' }
  })
}

export interface CohortMember { subject: string; name: string; joinedAt: string; initialPrice: number | null; initialMarketCapUsd: number | null; initialObservedAt: string | null }
export function cohortPerformance(members: CohortMember[], quotes: { subject: string; price: number | null; observedAt: string | null; recordedAt?: string | null; available: boolean }[], asOf: number) {
  const membership = new Map<string, CohortMember>()
  for (const member of [...members].sort((a, b) => (instant(a.joinedAt) ?? Infinity) - (instant(b.joinedAt) ?? Infinity))) if (!membership.has(member.subject)) membership.set(member.subject, member)
  const unique = [...membership.values()].filter(m => (instant(m.joinedAt) ?? Infinity) <= asOf)
  const current = new Map(quotes.map(q => [q.subject, q]))
  const completeWeights = unique.length > 0 && unique.every(m => finite(m.initialMarketCapUsd) != null && m.initialMarketCapUsd! >= 0)
  const initialCap = completeWeights ? unique.reduce((sum, m) => sum + m.initialMarketCapUsd!, 0) : null
  const rows = unique.map(m => {
    const q = current.get(m.subject), time = instant(q?.observedAt), initialTime = instant(m.initialObservedAt)
    const known = time != null && time <= asOf && (q?.recordedAt == null || (instant(q.recordedAt) ?? Infinity) <= asOf)
    const comparable = q?.available === true && finite(q.price) != null && q.price! >= 0 && finite(m.initialPrice) != null && m.initialPrice! > 0 &&
      initialTime != null && initialTime <= instant(m.joinedAt)! && time != null && time >= initialTime && known
    const returnPercent = comparable ? (q!.price! / m.initialPrice! - 1) * 100 : null
    const weight = initialCap != null && initialCap > 0 ? m.initialMarketCapUsd! / initialCap : null
    return { ...m, currentPrice: known ? q?.price ?? null : null, returnPercent, available: q?.available === true && known,
      initialWeight: weight, equalWeightContribution: returnPercent == null ? null : returnPercent / unique.length,
      capWeightContribution: returnPercent == null || weight == null ? null : returnPercent * weight,
      status: !q || !q.available ? 'Unavailable; retained in original cohort' : !comparable ? 'Missing comparable price or observation time' : 'Comparable' }
  })
  const comparable = rows.filter(r => r.returnPercent != null), positive = comparable.filter(r => r.returnPercent! > 0).length
  return { rows, originalMembers: unique.length, availableMembers: rows.filter(r => r.available).length, comparableMembers: comparable.length,
    initialTopFiveWeightPercent:initialCap!=null&&initialCap>0?rows.map(r=>r.initialWeight??0).sort((a,b)=>b-a).slice(0,5).reduce((a,b)=>a+b,0)*100:null,
    initialConcentrationHhi:initialCap!=null&&initialCap>0?rows.reduce((sum,r)=>sum+(r.initialWeight??0)**2,0):null,
    positiveMembers: positive, breadthPercent: comparable.length ? positive / comparable.length * 100 : null,
    knownEqualContribution: comparable.length ? comparable.reduce((sum, r) => sum + r.equalWeightContribution!, 0) : null,
    knownCapContribution: comparable.length && initialCap != null && initialCap > 0 ? comparable.reduce((sum, r) => sum + (r.capWeightContribution ?? 0), 0) : null,
    completeReturn: comparable.length === unique.length && unique.length > 0,
    coverage: 'Missing constituents remain in the denominator. Partial contributions are not a complete cohort return.' }
}

export interface StressRule { id: string; metric: string; comparator: string; threshold: number | null; unit?: string; periodSeconds?:number; threshold_unit?:string; time_window?:string; source_metric?:string; rule_kind?: string; label?: string; description?:string; interpretationRequired?:boolean }
export {STRESS_BASES} from './stress-scenario-contract.ts'
export function interpretStressRules(rules:StressRule[],bases:Record<string,string>={}){
 return rules.map(rule=>{
  const basis=Object.hasOwn(STRESS_BASES,bases[rule.id])?STRESS_BASES[bases[rule.id]]:null,label=rule.description||rule.label
  if(basis)return {...rule,...basis,label:label||basis.label,interpretationRequired:false}
  const unit=rule.unit||rule.threshold_unit,periodSeconds=rule.periodSeconds??conditionPeriod(rule.time_window)
  return {...rule,label,unit,periodSeconds,interpretationRequired:['price_move','volume_spike','tvl_change'].includes(rule.metric)&&(!unit||!periodSeconds)}
 })
}
export function compareThreshold(value: number, comparator: string, threshold: number): boolean | null {
  switch (comparator) {
    case '>': case 'gt': return value > threshold
    case '>=': case 'gte': return value >= threshold
    case '<': case 'lt': return value < threshold
    case '<=': case 'lte': return value <= threshold
    case '=': case 'eq': return value === threshold
    case '!=': case 'neq': return value !== threshold
    default: return null
  }
}
export function thesisStress(rules: StressRule[], observations: Observation[], subject: string, overrides: Record<string, number>, asOf: number) {
  const current = evidenceAt([...observations,...venueConditionObservations(observations,null,asOf)].filter(o => o.subject === subject), asOf)
  return rules.map(rule => {
    const candidates = rule.interpretationRequired?[]:current.filter(o => o.metric === rule.metric && matchesConditionSource(o,rule.source_metric,rule.metric) && (!rule.unit || rule.unit === o.unit) && (rule.periodSeconds==null||rule.periodSeconds===o.periodSeconds) && (rule.time_window!=='current'||o.periodSeconds==null) && observationState(o, asOf) === 'known')
    const observed = [...candidates].sort((a, b) => instant(b.observedAt)! - instant(a.observedAt)!)[0]
    const conflicting = observed && candidates.some(o => o.observedAt === observed.observedAt && o.value !== observed.value)
    const value = conflicting ? null : finite(observed?.value), threshold = finite(rule.threshold)
    const scenarioKey=rule.id||`${rule.metric}:${rule.unit||''}:${rule.periodSeconds||''}`
    const hypothetical = Object.hasOwn(overrides,scenarioKey)?finite(overrides[scenarioKey]):Object.hasOwn(overrides, rule.metric) ? finite(overrides[rule.metric]) : value
    const evaluate = (v: number | null) => rule.interpretationRequired||v == null || threshold == null ? null : compareThreshold(v, rule.comparator, threshold)
    return { rule, scenarioKey, observation: observed ?? null, current: value, hypothetical, currentlyMet: evaluate(value), scenarioMet: evaluate(hypothetical),
      reason: rule.interpretationRequired?'Choose the intended unit and period. This legacy condition did not record them.':conflicting ? 'Conflicting source observations' : !observed ? 'No fresh observation in the required unit and period' :
        threshold == null ? 'A numeric threshold is required' : compareThreshold(0, rule.comparator, 0) == null ? 'This condition requires a qualitative review' : null }
  })
}
export function stressSensitivity(row:ReturnType<typeof thesisStress>[number]){
 const threshold=finite(row.rule.threshold)
 if(row.rule.interpretationRequired||threshold==null||compareThreshold(0,row.rule.comparator,0)==null)return null
 const known=[threshold,row.current,row.hypothetical].filter((v):v is number=>v!=null),low=Math.min(...known),high=Math.max(...known),pad=Math.max(Math.abs(threshold)*.2,(high-low)*.3,1),from=low-pad,to=high+pad
 return {from,to,threshold,unit:row.rule.unit||row.observation?.unit||'',points:Array.from({length:21},(_,i)=>{const value=from+(to-from)*i/20;return {value,met:compareThreshold(value,row.rule.comparator,threshold)}})}
}
export function thesisCounterargument(rules: StressRule[], observations: Observation[], subject: string, asOf: number, authored: Record<string, string> = {}) {
  const rows = thesisStress(rules, observations, subject, {}, asOf)
  const disagreements = rows.filter(row => row.currentlyMet != null && (row.rule.rule_kind === 'invalidation' ? row.currentlyMet : row.rule.rule_kind === 'confirmation' ? !row.currentlyMet : false))
    .map(row => ({ condition: row.rule.label || `${row.rule.metric} ${row.rule.comparator} ${row.rule.threshold}`, metric: row.rule.metric,
      observation: row.observation!, reason: row.rule.rule_kind === 'invalidation' ? 'Your invalidation condition is met by the available observation.' : 'Your confirmation condition is not met by the available observation.',
      question: 'Does this evidence change the condition or the thesis? Record your assessment explicitly.' }))
  const missing = rows.filter(row => row.currentlyMet == null).map(row => ({ condition: row.rule.label || row.rule.metric, reason: row.reason, question: `What dated evidence would let you test ${row.rule.metric}?` }))
  const authoredQuestions = ['supports', 'weakens', 'proves_wrong', 'opposing'].filter(key => authored[key]?.trim()).map(key => ({ field: key, words: authored[key],
    question: 'Which dated observation supports or challenges this statement? Unmapped prose has not been automatically judged.' }))
  return { disagreements, missing, authoredQuestions, conclusion: disagreements.length ? 'The available evidence challenges these explicit conditions.' :
    'No supported disagreement was established from the testable conditions and available evidence.', changesThesis: false }
}

export interface ParticipationSnapshot { subject: string; provider: string; observedAt: string | null; population: string | null; holderCount: number | null;
  top1Percent: number | null; top10Percent: number | null; uniqueTraders: number | null; traderPeriodSeconds: number | null; sourceRef: string }
export function participationQuality(current: ParticipationSnapshot, previous: ParticipationSnapshot | null, asOf: number) {
  const valid = (n: unknown) => { const value = finite(n); return value != null && value >= 0 && value <= 100 ? value : null }
  const t = instant(current.observedAt), fresh = t != null && t <= asOf && asOf - t <= 86400000
  let top1 = valid(current.top1Percent), top10 = valid(current.top10Percent)
  const inconsistent = top1 != null && top10 != null && top1 > top10
  if (inconsistent) { top1 = null; top10 = null }
  const comparable = fresh && previous != null && current.subject === previous.subject && current.provider === previous.provider &&
    current.population != null && current.population === previous.population && (instant(previous.observedAt) ?? Infinity) < t! &&
    t! - (instant(previous.observedAt) ?? -Infinity) <= 2 * 86400000
  const oldTop10 = valid(previous?.top10Percent)
  return { ...current, top1Percent: top1, top10Percent: top10, fresh, comparable, inconsistent,
    uniqueTraders: finite(current.uniqueTraders) != null && current.uniqueTraders! >= 0 && finite(current.traderPeriodSeconds) != null && current.traderPeriodSeconds! > 0 ? current.uniqueTraders : null,
    holderCount: finite(current.holderCount) != null && current.holderCount! >= 0 ? current.holderCount : null,
    top10ChangePoints: comparable && top10 != null && oldTop10 != null ? top10 - oldTop10 : null,
    holderCountChange: comparable && finite(current.holderCount) != null && current.holderCount! >= 0 && finite(previous?.holderCount) != null && previous!.holderCount! >= 0 ? current.holderCount! - previous!.holderCount! : null,
    coverage: 'Wallets are not people. Custody, exchange and unknown address classifications can materially affect concentration.' }
}

export interface LiquidityEvent { id: string; subject: string; pool: string; transactionRef: string; logIndex: string; timestamp: number; kind: 'add' | 'remove' | 'migrate'; valueUsd: number | null; sourceRef: string }
export function liquidityEvents(events: LiquidityEvent[], subject: string, from: number, to: number) {
  const seen = new Set<string>()
  const rows = events.filter(event => {
    const key = `${event.pool}:${event.transactionRef}:${event.logIndex}`
    if (event.subject !== subject || !event.transactionRef || event.logIndex == null || !Number.isFinite(event.timestamp) || event.timestamp < from || event.timestamp > to || seen.has(key)) return false
    seen.add(key); return true
  }).sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  const known = rows.filter(e => ['add', 'remove'].includes(e.kind) && finite(e.valueUsd) != null && e.valueUsd! >= 0)
  return { events: rows, knownNetChangeUsd: known.length ? known.reduce((sum, e) => sum + (e.kind === 'remove' ? -e.valueUsd! : e.valueUsd!), 0) : null,
    unpricedEvents: rows.filter(e => finite(e.valueUsd) == null || e.valueUsd! < 0).length,
    coverage: 'Recorded liquidity changes are not executable order-book depth and do not establish that liquidity caused a price move.' }
}
export interface DepthSnapshot { subject: string; side: 'buy' | 'sell'; observedAt: string; expiresAt: string; currency: string; verifiedQuote: boolean;
  feeBps: number | null; levels: { price: number; quantity: number }[]; sourceRef: string }
export function positionLiquidity(quantity: number | null, priceUsd: number | null, tvlUsd: number | null, depth: DepthSnapshot | null, subject: string, asOf: number) {
  const valueUsd = finite(quantity) != null && quantity! >= 0 && finite(priceUsd) != null && priceUsd! > 0 ? quantity! * priceUsd! : null
  const ratio = valueUsd != null && finite(tvlUsd) != null && tvlUsd! > 0 ? valueUsd / tvlUsd! * 100 : null
  const validDepth = depth && depth.subject === subject && depth.currency === 'USD' && depth.verifiedQuote &&
    instant(depth.observedAt) != null && instant(depth.observedAt)! <= asOf && asOf - instant(depth.observedAt)! <= 60000 && (instant(depth.expiresAt) ?? -Infinity) > asOf
  if (!validDepth || finite(quantity) == null || quantity! <= 0) return { valueUsd, positionToTvlPercent: ratio, execution: null, reason: 'Fresh, identity-matched USD depth and a positive size are required. TVL alone cannot estimate execution.' }
  const levels = depth!.levels.filter(l => finite(l.price) != null && l.price > 0 && finite(l.quantity) != null && l.quantity > 0)
    .sort((a, b) => depth!.side === 'buy' ? a.price - b.price : b.price - a.price)
  let remaining = quantity!, gross = 0
  for (const level of levels) { const amount = Math.min(remaining, level.quantity); gross += amount * level.price; remaining -= amount; if (remaining <= 0) break }
  const filled = quantity! - remaining, fee = finite(depth!.feeBps)
  const feeUsd = fee != null && fee >= 0 && fee <= 10000 ? gross * fee / 10000 : null
  const average = filled > 0 ? gross / filled : null, reference = levels[0]?.price ?? null
  return { valueUsd, positionToTvlPercent: ratio, execution: { side: depth!.side, requestedQuantity: quantity, coveredQuantity: filled,
    uncoveredQuantity: remaining, grossUsd: gross, feeUsd, netUsd: feeUsd == null ? null : gross + (depth!.side === 'buy' ? feeUsd : -feeUsd),
    averagePrice: average, slippagePercent: average != null && reference != null ? (depth!.side === 'buy' ? average / reference - 1 : 1 - average / reference) * 100 : null,
    sourceRef: depth!.sourceRef, complete: remaining <= 0 }, reason: 'Indicative calculation from the recorded depth, not a guaranteed execution or order.' }
}
