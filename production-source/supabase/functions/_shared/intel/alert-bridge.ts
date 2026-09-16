// Alert unification bridge (v3.1, Batch 3).
//
// Fires the canonical `intel_alert_events` from data we ALREADY store but never
// alerted on: large_transfer_events (wallet_activity), token_unlocks (unlock),
// stablecoin_supply_snapshots (supply_shock), token_holder_snapshots /
// holder_concentration_scores (holder_shift), and metadata_drift_events
// (metadata_migration — poll-sourced; CP-3: our CoinGecko plan has no webhooks).
//
// Idempotency + provenance is gated by alert_event_unification_map (FULL unique
// (rule_id, source_table, source_ref)), so replaying a source row never
// double-fires. Dedup_key + cooldown mirror intel-alerts-eval so the two systems
// stay consistent. The legacy onchain_alert_notifications path is left intact
// during transition (backward compatible).

import { stableHash } from './provider-fact-rag.ts'
import { notAMarketMoveReceipt, type MetricAgreementReceipt } from './metric-agreement.ts'

// deno-lint-ignore no-explicit-any
type DB = any

export const DAY_MS = 86_400_000
export const DEFAULT_COOLDOWN_MIN = 720
export const NOISY_FIRES_48H = 4

// Trigger types this bridge owns (intel-alerts-eval owns price/volume/liquidity/narrative).
export const BRIDGE_TRIGGERS = [
  'wallet_activity', 'holder_shift', 'unlock', 'supply_shock', 'metadata_migration',
] as const
export type BridgeTrigger = typeof BRIDGE_TRIGGERS[number]

// ── Pure matchers (unit-testable) ────────────────────────────────────────────
export function bandFor(value: number | null): string {
  if (value == null || !isFinite(value)) return 'na'
  return String(Math.round(value / 5) * 5)
}

export function todayIso(nowMs?: number): string {
  return new Date(nowMs ?? Date.now()).toISOString().slice(0, 10)
}

// Same rule + metric + 5% band + day => one event (matches intel-alerts-eval).
export function dedupKeyFor(ruleId: string, metric: string | null, value: number | null, day?: string): string {
  return stableHash(`${ruleId}|${metric || 'na'}|${bandFor(value)}|${day ?? todayIso()}`)
}

export function unlockQualifies(unlockDateMs: number, nowMs: number, windowDays: number): boolean {
  if (!isFinite(unlockDateMs)) return false
  return unlockDateMs >= nowMs && unlockDateMs <= nowMs + Math.max(0, windowDays) * DAY_MS
}

export function supplyShockPct(prev: number, cur: number): number {
  if (!(prev > 0) || !isFinite(cur)) return 0
  return ((cur - prev) / prev) * 100
}

export function holderShiftDelta(prevTop10Pct: number, curTop10Pct: number): number {
  if (!isFinite(prevTop10Pct) || !isFinite(curTop10Pct)) return 0
  return curTop10Pct - prevTop10Pct
}

export function walletActivityQualifies(usdValue: number, minUsd: number): boolean {
  return isFinite(usdValue) && usdValue >= (minUsd > 0 ? minUsd : 0)
}

export function exceedsThreshold(value: number, thresholdPct: number): boolean {
  return isFinite(value) && isFinite(thresholdPct) && Math.abs(value) >= Math.abs(thresholdPct)
}

// ── Hysteresis on the bridge ─────────────────────────────────────────────────
//
// The chart and market paths have run the armed/re-arm state machine
// (app_private.intel_condition_step) since 20260911202815. The bridge never
// did: it had cooldown plus permanent source_ref dedupe and nothing else, so a
// LEVEL that oscillates across its threshold re-fired every time the cooldown
// lapsed. Only a level can oscillate, so only the level triggers join:
//
//   supply_shock  a signed percentage against a threshold, recomputed from the
//                 newest pair of retained snapshots. It genuinely oscillates.
//
// Deliberately NOT joined, because each one is a DISCRETE RECORD rather than a
// level, is already permanently deduped by (rule, source_table, source_ref), and
// would be silenced rather than debounced by a re-arm gate:
//   wallet_activity      every candidate is a distinct transfer. Two transfers
//                        over the floor are two real events, not one flapping.
//   unlock               qualification is a DATE WINDOW, not a level, and each
//                        calendar version fires at most once for a rule.
//   metadata_migration   each drift row is a distinct recorded change.
//   holder_shift         it WOULD be a level (top-10 concentration), but
//                        alert-candidates.ts refuses it outright for want of a
//                        comparable population id and an original source clock.
//                        A state machine over a source that never produces a
//                        candidate would be dead code pretending to be a rule.
export const HYSTERESIS_BRIDGE_TRIGGERS = ['supply_shock'] as const
export const bridgeTriggerUsesCondition = (trigger: string): boolean =>
  (HYSTERESIS_BRIDGE_TRIGGERS as readonly string[]).includes(trigger)

export interface ConditionStepArgs {
  ruleId: string
  orgId: string
  revision: number
  observationId: string
  observedAt: string
  value: number | null
  provider: string
  subject: string
}
export type ConditionStepState = 'baseline' | 'watching' | 'holding' | 'crossed' | 'changed' | 'access_unavailable'
export interface ConditionStepResult { candidate: boolean; state: ConditionStepState }

/** Runs the SAME state machine the chart and market paths use, against the
 * rule's own stored chart_state. A refusal to step is never treated as a
 * crossing: the caller emits nothing rather than firing on an unknown state. */
// deno-lint-ignore no-explicit-any
export async function stepBridgedCondition(db: any, a: ConditionStepArgs): Promise<ConditionStepResult> {
  const { data, error } = await db.rpc('intel_step_bridged_condition', {
    p_rule: a.ruleId, p_org: a.orgId, p_revision: a.revision,
    p_observation: { observationId: a.observationId, observedAt: a.observedAt, value: a.value, provider: a.provider, subject: a.subject },
  })
  if (error) throw Error('alert_condition_step_failed')
  if (!data || typeof data !== 'object' || typeof data.state !== 'string') throw Error('alert_condition_step_response_invalid')
  return { candidate: data.candidate === true, state: data.state as ConditionStepState }
}

// ── Cooldown (mirrors intel-alerts-eval: ×2 escalation when noisy) ────────────
export async function cooledDown(db: DB, ruleId: string, cooldownMinutes: number | null): Promise<boolean> {
  const base = Number(cooldownMinutes) > 0 ? Number(cooldownMinutes) : DEFAULT_COOLDOWN_MIN
  const { data } = await db.from('intel_alert_events').select('id, fired_at')
    .eq('rule_id', ruleId).gte('fired_at', new Date(Date.now() - 48 * 3600_000).toISOString())
    .order('fired_at', { ascending: false }).limit(NOISY_FIRES_48H + 1)
  const eff = (data?.length || 0) >= NOISY_FIRES_48H ? base * 2 : base
  const last = data?.[0]?.fired_at ? new Date(data[0].fired_at).getTime() : 0
  return last > Date.now() - eff * 60_000
}

// ── Idempotent emit ──────────────────────────────────────────────────────────
export interface EmitArgs {
  revision: number
  ruleId: string
  orgId: string
  triggerType: string
  sourceSystem: string    // unlock | supply | onchain | holder | metadata
  sourceTable: string
  sourceRef: string       // stable id of the source row (permanent dedup per rule)
  metric: string | null
  value: number | null
  cooldownMinutes: number | null
  payload?: Record<string, unknown>
}

export type EmitResult = 'fired' | 'duplicate' | 'cooldown' | 'changed' | 'access_unavailable'

// ── The evidentiary standard on bridged events ───────────────────────────────
//
// Every trigger this bridge owns reports a RECORDED EVENT (a transfer, an unlock
// date, a stablecoin supply step, a holder concentration reading, a metadata
// drift), and none of them measures the price, market capitalisation and volume
// triple for the event. So each one carries an explicit `unmeasured` verdict
// with research_lead true, stored the way the SQL market path stores its own:
// the verdict word at payload.metric_agreement and the full receipt beside it.
// Without it the event had no verdict at all and the receipt showed nothing,
// which a reader could mistake for a failed test.
export function bridgedAlertAgreement(trigger: string): MetricAgreementReceipt | null {
  return (BRIDGE_TRIGGERS as readonly string[]).includes(trigger) ? notAMarketMoveReceipt() : null
}
export function withBridgedAgreement(trigger: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  const agreement = bridgedAlertAgreement(trigger)
  if (!agreement) return payload
  // The bridge's own verdict wins over any candidate field of the same name: a
  // candidate never measures the triple, so it may never claim an agreement.
  return { ...payload, metric_agreement: agreement.metric_agreement, metric_agreement_receipt: agreement }
}

export async function emitBridgedAlert(db: DB, a: EmitArgs): Promise<EmitResult> {
  const {data,error}=await db.rpc('intel_emit_bridged_alert',{p_rule:a.ruleId,p_org:a.orgId,p_revision:a.revision,p_source_system:a.sourceSystem,p_source_table:a.sourceTable,p_source_ref:a.sourceRef,p_metric:a.metric,p_value:a.value,p_payload:withBridgedAgreement(a.triggerType,a.payload||{})})
  if(error)throw Error('alert_commit_failed')
  if(!['fired','duplicate','cooldown','changed','access_unavailable'].includes(data))throw Error('alert_commit_response_invalid')
  return data
}

// Resolve a Birdeye-style chain slug from an entity's CAIP namespace/id.
const EVM_CHAINS: Record<string, string> = { '1': 'ethereum', '8453': 'base', '42161': 'arbitrum', '56': 'bsc', '137': 'polygon', '43114': 'avalanche', '10': 'optimism' }
export function entityChain(ns: string | null, ref: string | null): string | null {
  if (ns === 'solana') return 'solana'
  if (ns === 'eip155' && ref) return EVM_CHAINS[ref] || null
  return null
}
