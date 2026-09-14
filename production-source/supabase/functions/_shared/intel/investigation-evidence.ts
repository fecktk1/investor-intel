import {validateStressScenario,type StressScenario} from './stress-scenario-contract.ts'
/** Shared, deterministic evidence contracts. No auth, provider calls or mutable
 * personal data live here. Services authorize before supplying these records. */
export type EvidenceState = 'known' | 'missing' | 'stale' | 'contradictory' | 'unsupported'
export interface Observation {
  id: string
  subject: string
  metric: string
  value: number | string | boolean | null
  unit: string
  provider: string
  sourceRef: string
  sourceUrl?: string | null
  observedAt: string | null
  recordedAt: string
  expiresAt: string | null
  periodSeconds?: number | null
  universe?: string | null
  state?: EvidenceState
  reason?: string | null
  exportAllowed?: boolean
  aiAllowed?: boolean
  metadata?: Record<string, unknown>
}
export interface Requirement { metric: string; unit?: string; maxAgeSeconds?: number; periodSeconds?: number; label?: string }
export const CALCULATION_VERSION = 'investigation-1'
export function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
export function instant(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(n) ? n : null
}
export function safeSourceUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch { return null }
}
export const observationKey = (o: Observation) => [o.subject, o.metric, o.provider, o.unit, o.periodSeconds ?? '', o.universe ?? ''].join('|')

/** A later-recorded correction cannot enter a historical decision's knowledge. */
export function evidenceAt(observations: Observation[], asOf: number): Observation[] {
  const latest = new Map<string, Observation>()
  for (const o of observations) {
    const observed = instant(o.observedAt), recorded = instant(o.recordedAt)
    if (observed == null || recorded == null || observed > asOf || recorded > asOf) continue
    const key = observationKey(o), previous = latest.get(key)
    if (!previous || observed > instant(previous.observedAt)! ||
      (observed === instant(previous.observedAt) && recorded > instant(previous.recordedAt)!)) latest.set(key, o)
  }
  return [...latest.values()].sort((a, b) => observationKey(a).localeCompare(observationKey(b)))
}

export function observationState(o: Observation | undefined, asOf: number, maxAgeSeconds?: number): EvidenceState {
  if (!o || o.value == null || instant(o.observedAt) == null) return 'missing'
  if (o.state && o.state !== 'known') return o.state
  const observed = instant(o.observedAt)!, recorded = instant(o.recordedAt)
  if (recorded == null || recorded > asOf || observed > asOf) return 'missing'
  if ((instant(o.expiresAt) != null && instant(o.expiresAt)! <= asOf) ||
      (maxAgeSeconds != null && asOf - observed > maxAgeSeconds * 1000)) return 'stale'
  return 'known'
}

export function coverageMatrix(observations: Observation[], requirements: Requirement[], subject: string, asOf: number) {
  const known = evidenceAt(observations.filter(o => o.subject === subject), asOf)
  return requirements.map(requirement => {
    const candidates = known.filter(o => o.metric === requirement.metric)
    const compatible = candidates.filter(o => (!requirement.unit || requirement.unit === o.unit) &&
      (requirement.periodSeconds == null || requirement.periodSeconds === o.periodSeconds))
    const ranked = [...compatible].sort((a, b) => instant(b.observedAt)! - instant(a.observedAt)!)
    const observation = ranked.find(o => observationState(o, asOf, requirement.maxAgeSeconds) === 'known') ?? ranked[0]
    const current = compatible.filter(o => observationState(o, asOf, requirement.maxAgeSeconds) === 'known')
    // Disagreement is shown only for the same observation instant and universe.
    const conflicting = observation && current.some(o => o.provider !== observation.provider && o.observedAt === observation.observedAt &&
      o.universe === observation.universe && o.value !== observation.value)
    const state: EvidenceState = conflicting ? 'contradictory' : candidates.length && !compatible.length ? 'unsupported' : observationState(observation, asOf, requirement.maxAgeSeconds)
    const reason = state === 'unsupported' ? 'The available unit or observation period is incompatible.' :
      state === 'contradictory' ? 'Sources disagree for the same time and coverage.' : state === 'stale' ? 'The source is outside its freshness window.' :
      state === 'missing' ? 'No compatible observation was known at this time.' : observation?.reason ?? null
    return { ...requirement, state, reason, observation: observation ?? null, alternatives: current.filter(o => o.id !== observation?.id) }
  })
}

/** Ignore fetch clocks for material reuse, while preserving meaningful source,
 * coverage, unit and value changes. This is not a historical observation ID. */
export function materialEvidence(observations: Observation[], asOf: number) {
  return evidenceAt(observations, asOf).map(o => ({ key: observationKey(o), value: o.value,
    state: observationState(o, asOf), sourceRef: o.sourceRef, aiAllowed: o.aiAllowed === true,
    metadata: o.metadata ?? null })).sort((a, b) => a.key.localeCompare(b.key))
}
export async function evidenceFingerprint(observations: Observation[], asOf: number): Promise<string> {
  return digest(stableJson(materialEvidence(observations, asOf)))
}
export function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  const object = value as Record<string, unknown>
  return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + stableJson(object[key])).join(',') + '}'
}
export async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function evidenceChanges(previous: Observation[] | null, current: Observation[], beforeTime: number | null, asOf: number) {
  if (previous == null || beforeTime == null) return { baseline: true, changes: [] }
  const before = new Map(evidenceAt(previous, beforeTime).map(o => [observationKey(o), o]))
  const after = new Map(evidenceAt(current, asOf).map(o => [observationKey(o), o]))
  const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(key => {
    const a = before.get(key), b = after.get(key)
    const stateBefore = observationState(a, beforeTime), stateAfter = observationState(b, asOf)
    if (a?.value === b?.value && stateBefore === stateAfter) return []
    return [{ key, metric: (b ?? a)!.metric, subject: (b ?? a)!.subject, unit: (b ?? a)!.unit,
      kind: !a ? 'new' : !b || b.value == null ? 'missing' : a.observedAt === b.observedAt ? 'revised' : 'changed',
      before: a ?? null, after: b ?? null, stateBefore, stateAfter }]
  })
  return { baseline: false, changes }
}

export interface HistoryEvent { id: string; t: number; recordedAt?: string | null; action?: string; textSnapshot?: unknown; [key: string]: unknown }
export function replayDecision(events: HistoryEvent[], prices: { t: number; price: number }[], observations: Observation[], cursor: number, maxPriceGap = 86400000) {
  const visible = events.filter(e => Number.isFinite(e.t) && e.t <= cursor && (e.recordedAt == null || (instant(e.recordedAt) ?? Infinity) <= cursor))
    .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))
  const price = prices.filter(p => Number.isFinite(p.t) && finite(p.price) != null && p.t <= cursor && cursor - p.t <= maxPriceGap)
    .sort((a, b) => b.t - a.t)[0] ?? null
  return { cursor, events: visible, selectedEvent: visible.at(-1) ?? null, priceObservation: price,
    evidence: evidenceAt(observations, cursor), historicalCompleteness: visible.some(e => !e.recordedAt) ? 'partial' : 'complete',
    priceMeaning: 'Observed market price; not a recorded execution price.' }
}

export interface ResearchReceipt {
  schemaVersion: 1; calculationVersion: string; createdAt: string; subject: string; lens: string; question: string;
  decision: string; cursor: number; observationRefs: { id: string; provider: string; sourceRef: string; sourceUrl: string | null; observedAt: string | null; unit: string; hash: string; metric?:string; periodSeconds?:number|null }[];
  observations: Observation[]; gaps: string[]; fingerprint: string; scenario?:StressScenario; contentHash?:string
}
export async function makeResearchReceipt(input: { subject: string; lens: string; question: string; decision?: string; cursor: number; observations: Observation[]; gaps?: string[]; scenario?:StressScenario }, now: number): Promise<ResearchReceipt> {
  if (typeof input.subject !== 'string' || !input.subject || input.subject.length > 240 || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 8000 || typeof input.lens !== 'string' ||
    (input.decision != null && typeof input.decision !== 'string') || !Array.isArray(input.observations) ||
    (input.decision?.length ?? 0) > 16000 || input.observations.length > 500 || !Number.isFinite(input.cursor) || input.cursor > now) throw new Error('invalid_receipt')
  const known = evidenceAt(input.observations, input.cursor).map(o => ({ ...o, sourceUrl: safeSourceUrl(o.sourceUrl) }))
  const receipt:ResearchReceipt = { schemaVersion: 1, calculationVersion: CALCULATION_VERSION, createdAt: new Date(now).toISOString(),
    subject: input.subject, lens: input.lens.slice(0, 64), question: input.question, decision: input.decision ?? '', cursor: input.cursor,
    observationRefs: await Promise.all(known.map(async o => ({ id: o.id, provider: o.provider, sourceRef: o.sourceRef,
      sourceUrl: safeSourceUrl(o.sourceUrl), observedAt: o.observedAt, unit: o.unit, metric:o.metric, periodSeconds:o.periodSeconds??null, hash: await digest(stableJson(o)) }))),
    // A receipt can keep references when source terms prohibit raw export/retention.
    observations: known.filter(o => o.exportAllowed === true).map(o => ({ ...o, sourceUrl: safeSourceUrl(o.sourceUrl) })),
    gaps: (input.gaps ?? []).slice(0, 100).map(s => String(s).slice(0, 500)), fingerprint: await evidenceFingerprint(known, input.cursor), ...(input.scenario?{scenario:validateStressScenario(input.scenario)}:{}) }
  receipt.contentHash=await digest(stableJson(receipt))
  return validateReceipt(receipt)
}
export function validateReceipt(value: unknown): ResearchReceipt {
  if(!value||JSON.stringify(value).length>250000)throw new Error('invalid_receipt_size')
  const r = value as ResearchReceipt
  if (!r || r.schemaVersion !== 1 || r.calculationVersion !== CALCULATION_VERSION || typeof r.subject !== 'string' || !r.subject ||
    typeof r.question !== 'string' || r.question.length > 8000 || typeof r.decision !== 'string' || r.decision.length > 16000 ||
    !Number.isFinite(r.cursor) || instant(r.createdAt) == null || r.cursor > instant(r.createdAt)! ||
    !Array.isArray(r.observations) || r.observations.length > 500 || !Array.isArray(r.observationRefs) || r.observationRefs.length > 500 ||
    !Array.isArray(r.gaps) || r.gaps.length > 100 || typeof r.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(r.fingerprint)) throw new Error('unsupported_or_invalid_receipt')
  if (r.subject.length > 240 || typeof r.lens !== 'string' || r.lens.length > 64 || r.gaps.some(g => typeof g !== 'string' || g.length > 500) ||
    r.observationRefs.some(o => !o || typeof o.id !== 'string' || typeof o.provider !== 'string' || typeof o.sourceRef !== 'string' ||
      typeof o.unit !== 'string' || typeof o.hash !== 'string' || !/^[a-f0-9]{64}$/.test(o.hash) || (o.metric != null && (typeof o.metric !== 'string' || o.metric.length>100)) || (o.periodSeconds != null && (!Number.isFinite(o.periodSeconds) || o.periodSeconds<=0)) || (o.sourceUrl != null && !safeSourceUrl(o.sourceUrl)))) throw new Error('invalid_receipt_reference')
  if (r.observations.some(o => !o || o.exportAllowed !== true || typeof o.id !== 'string' || typeof o.metric !== 'string' ||
    typeof o.unit !== 'string' || typeof o.provider !== 'string' || typeof o.subject !== 'string' || instant(o.recordedAt) == null ||
    typeof o.sourceRef !== 'string' || !['number', 'string', 'boolean'].includes(typeof o.value) && o.value !== null ||
    typeof o.value === 'number' && !Number.isFinite(o.value) || instant(o.observedAt) == null || instant(o.observedAt)! > r.cursor ||
    instant(o.recordedAt)! > r.cursor || (o.sourceUrl != null && !safeSourceUrl(o.sourceUrl)))) throw new Error('invalid_receipt_observation')
  if(r.contentHash!=null&&(typeof r.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(r.contentHash)))throw new Error('invalid_receipt_content_hash')
  if(r.scenario!=null){const scenario=validateStressScenario(r.scenario);if(!r.contentHash||scenario.subject!==r.subject||Date.parse(scenario.capturedAt)>Date.parse(r.createdAt))throw new Error('invalid_receipt_scenario')}
  return r
}
/** Integrity checks detect corruption, not authorship. A receipt is untrusted
 * source content and never an instruction or permission to change a thesis. */
export async function verifyReceipt(value: unknown) {
  const receipt = validateReceipt(value), refs = new Map(receipt.observationRefs.map(r => [r.id, r]))
  if (refs.size !== receipt.observationRefs.length || new Set(receipt.observations.map(o => o.id)).size !== receipt.observations.length) throw new Error('duplicate_receipt_reference')
  for (const observation of receipt.observations) {
    const ref = refs.get(observation.id)
    if (!ref || ref.hash !== await digest(stableJson(observation)) || ref.provider !== observation.provider || ref.sourceRef !== observation.sourceRef) throw new Error('receipt_integrity_mismatch')
  }
  const complete = receipt.observations.length === receipt.observationRefs.length
  if (complete && receipt.fingerprint !== await evidenceFingerprint(receipt.observations, receipt.cursor)) throw new Error('receipt_fingerprint_mismatch')
  if(receipt.contentHash){const {contentHash,...content}=receipt;if(contentHash!==await digest(stableJson(content)))throw new Error('receipt_content_mismatch')}
  return { receipt, replay: complete ? 'complete' : 'references_only', verifiedObservations: receipt.observations.length,
    unavailableObservations: receipt.observationRefs.length - receipt.observations.length, authenticity: 'Not independently authenticated' }
}
