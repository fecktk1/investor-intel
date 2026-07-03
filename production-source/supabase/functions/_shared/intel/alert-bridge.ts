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

export type EmitResult = 'fired' | 'duplicate' | 'cooldown' | 'error'

export async function emitBridgedAlert(db: DB, a: EmitArgs): Promise<EmitResult> {
  try {
    if (await cooledDown(db, a.ruleId, a.cooldownMinutes)) return 'cooldown'
    const dedupKey = dedupKeyFor(a.ruleId, a.metric, a.value)

    // Map gate: FULL unique (rule_id, source_table, source_ref). ignoreDuplicates
    // => empty result on conflict (already processed this source row for this rule).
    const { data: mapRows, error: mapErr } = await db.from('alert_event_unification_map')
      .upsert({
        rule_id: a.ruleId, org_id: a.orgId, source_system: a.sourceSystem,
        source_table: a.sourceTable, source_ref: a.sourceRef, dedup_key: dedupKey,
      }, { onConflict: 'rule_id,source_table,source_ref', ignoreDuplicates: true })
      .select('id')
    if (mapErr) return 'error'
    if (!mapRows || mapRows.length === 0) return 'duplicate'
    const mapId = mapRows[0].id

    const { data: ev, error: evErr } = await db.from('intel_alert_events').insert({
      org_id: a.orgId, rule_id: a.ruleId, dedup_key: dedupKey,
      payload: {
        trigger_type: a.triggerType, metric: a.metric, value: a.value,
        source_system: a.sourceSystem, source_table: a.sourceTable, source_ref: a.sourceRef,
        ...(a.payload || {}),
      },
    }).select('id').maybeSingle()

    if (evErr || !ev?.id) {
      // roll back the map claim so a later run can retry this source row
      await db.from('alert_event_unification_map').delete().eq('id', mapId)
      return 'error'
    }
    await db.from('alert_event_unification_map').update({ intel_alert_event_id: ev.id }).eq('id', mapId)
    return 'fired'
  } catch {
    return 'error'
  }
}

// Resolve a Birdeye-style chain slug from an entity's CAIP namespace/id.
const EVM_CHAINS: Record<string, string> = { '1': 'ethereum', '8453': 'base', '42161': 'arbitrum', '56': 'bsc', '137': 'polygon', '43114': 'avalanche', '10': 'optimism' }
export function entityChain(ns: string | null, ref: string | null): string | null {
  if (ns === 'solana') return 'solana'
  if (ns === 'eip155' && ref) return EVM_CHAINS[ref] || null
  return null
}
