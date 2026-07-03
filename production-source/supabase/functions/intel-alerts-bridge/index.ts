// Investor Intel — alert unification bridge (pg_cron, service-role).
//
// Fires the canonical intel_alert_events from data we already store but never
// alerted on, activating the declared-but-dead wallet_activity / holder_shift
// triggers and adding unlock / supply_shock / metadata_migration. Idempotent via
// alert_event_unification_map. Flag-gated (ALERT_UNIFICATION_ENABLED, default
// OFF) so global enablement is a one-flag flip; the legacy
// onchain_alert_notifications path is untouched during transition.
//
// CP-3: our CoinGecko plan has no webhooks, so metadata_migration is fed by the
// poll-sourced metadata_drift_events table, not a push webhook.

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  BRIDGE_TRIGGERS, DAY_MS, emitBridgedAlert, entityChain,
  exceedsThreshold, supplyShockPct, unlockQualifies, walletActivityQualifies,
  type EmitResult,
} from '../_shared/intel/alert-bridge.ts'
import { isFeatureEnabled } from '../_shared/intel/runtime-flags.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

// deno-lint-ignore no-explicit-any
type DB = any
// deno-lint-ignore no-explicit-any
type Rule = any

const tally = () => ({ fired: 0, duplicate: 0, cooldown: 0, error: 0, checked: 0 })
// deno-lint-ignore no-explicit-any
function record(t: any, r: EmitResult) { t[r]++ }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const cronOk = !!req.headers.get('x-cron-secret') && req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
    if (!cronOk) return json({ error: 'unauthorized' }, 401)

    const admin: DB = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // Rollout gate (DB-backed flag; env override wins). Shadow/dry-run until on.
    const enabled = await isFeatureEnabled(admin, 'ALERT_UNIFICATION_ENABLED', false)
    const body = await req.json().catch(() => ({}))
    const dryRun = !enabled || body?.dryRun === true

    const { data: rules } = await admin.from('intel_alert_rules')
      .select('id, org_id, trigger_type, config, cooldown_minutes, is_active, entity:entities(*), org:orgs(product_mode)')
      .in('trigger_type', BRIDGE_TRIGGERS as unknown as string[])
      .eq('is_active', true)
      .limit(1000)

    const active = (rules || []).filter((r: Rule) => r.org?.product_mode === 'intel' && r.entity)
    const t = tally()
    const perTrigger: Record<string, number> = {}

    for (const r of active.slice(0, 500)) {
      t.checked++
      const cands = await gatherCandidates(admin, r)
      for (const c of cands) {
        if (dryRun) { perTrigger[r.trigger_type] = (perTrigger[r.trigger_type] || 0) + 1; continue }
        const res = await emitBridgedAlert(admin, {
          ruleId: r.id, orgId: r.org_id, triggerType: r.trigger_type,
          sourceSystem: c.sourceSystem, sourceTable: c.sourceTable, sourceRef: c.sourceRef,
          metric: c.metric, value: c.value, cooldownMinutes: r.cooldown_minutes, payload: c.payload,
        })
        record(t, res)
      }
    }

    return json({ ok: true, enabled, dry_run: dryRun, ...t, candidates_by_trigger: perTrigger })
  } catch (err) {
    return json({ error: (err as Error)?.message || 'alert_bridge_failed' }, 500)
  }
})

interface Candidate {
  sourceSystem: string
  sourceTable: string
  sourceRef: string
  metric: string
  value: number | null
  payload: Record<string, unknown>
}

// Dispatch a rule to its data source and return the source rows that should fire.
async function gatherCandidates(db: DB, r: Rule): Promise<Candidate[]> {
  const ent = r.entity
  const cfg = r.config || {}
  try {
    switch (r.trigger_type) {
      case 'unlock': return await unlockCandidates(db, ent, cfg)
      case 'supply_shock': return await supplyShockCandidates(db, ent, cfg)
      case 'wallet_activity': return await walletActivityCandidates(db, ent, cfg)
      case 'holder_shift': return await holderShiftCandidates(db, ent, cfg)
      case 'metadata_migration': return await metadataMigrationCandidates(db, ent)
      default: return []
    }
  } catch { return [] }
}

// deno-lint-ignore no-explicit-any
async function unlockCandidates(db: DB, ent: any, cfg: any): Promise<Candidate[]> {
  const sym = (ent.display_symbol || '').toString()
  const addr = (ent.contract_address || '').toString()
  if (!sym && !addr) return []
  const windowDays = Number(cfg.window_days) > 0 ? Number(cfg.window_days) : 7
  const now = Date.now()
  let q = db.from('token_unlocks').select('id, token, token_symbol, unlock_date, amount, pct_supply')
    .gte('unlock_date', new Date(now).toISOString())
    .lte('unlock_date', new Date(now + (windowDays + 1) * DAY_MS).toISOString())
    .order('unlock_date', { ascending: true }).limit(10)
  const ors: string[] = []
  if (sym) ors.push(`token_symbol.ilike.${sym}`)
  if (addr) ors.push(`token.ilike.${addr}`)
  if (ors.length) q = q.or(ors.join(','))
  const { data } = await q
  const out: Candidate[] = []
  for (const u of data || []) {
    const ms = new Date(u.unlock_date).getTime()
    if (!unlockQualifies(ms, now, windowDays)) continue
    out.push({
      sourceSystem: 'unlock', sourceTable: 'token_unlocks', sourceRef: `unlock:${u.id}`,
      metric: 'unlock_pct_supply', value: u.pct_supply != null ? Number(u.pct_supply) : null,
      payload: { symbol: u.token_symbol || sym, unlock_date: u.unlock_date, amount: u.amount, pct_supply: u.pct_supply },
    })
  }
  return out
}

// deno-lint-ignore no-explicit-any
async function supplyShockCandidates(db: DB, ent: any, cfg: any): Promise<Candidate[]> {
  const sym = (ent.display_symbol || '').toString()
  if (!sym) return []
  const thr = Number(cfg.threshold_pct) > 0 ? Number(cfg.threshold_pct) : 5
  const { data } = await db.from('stablecoin_supply_snapshots')
    .select('id, stablecoin, ts, circulating_usd').ilike('stablecoin', sym)
    .order('ts', { ascending: false }).limit(2)
  if (!data || data.length < 2) return []
  const pct = supplyShockPct(Number(data[1].circulating_usd), Number(data[0].circulating_usd))
  if (!exceedsThreshold(pct, thr)) return []
  return [{
    sourceSystem: 'supply', sourceTable: 'stablecoin_supply_snapshots', sourceRef: `supply:${data[0].id}`,
    metric: 'supply_change_pct', value: pct,
    payload: { stablecoin: data[0].stablecoin, from_usd: data[1].circulating_usd, to_usd: data[0].circulating_usd },
  }]
}

// deno-lint-ignore no-explicit-any
async function walletActivityCandidates(db: DB, ent: any, cfg: any): Promise<Candidate[]> {
  const addr = (ent.wallet_address || '').toString()
  if (!addr) return []
  const minUsd = Number(cfg.min_usd) > 0 ? Number(cfg.min_usd) : 100_000
  const { data } = await db.from('large_transfer_events')
    .select('id, event_key, usd_value, symbol, direction, tx_hash, observed_at')
    .eq('wallet_address', addr)
    .gte('observed_at', new Date(Date.now() - 24 * 3600_000).toISOString())
    .order('observed_at', { ascending: false }).limit(20)
  const out: Candidate[] = []
  for (const e of data || []) {
    const usd = Number(e.usd_value)
    if (!walletActivityQualifies(usd, minUsd)) continue
    out.push({
      sourceSystem: 'onchain', sourceTable: 'large_transfer_events', sourceRef: `ltx:${e.event_key || e.id}`,
      metric: 'transfer_usd', value: usd,
      payload: { symbol: e.symbol, direction: e.direction, tx_hash: e.tx_hash },
    })
  }
  return out
}

// Best-effort: token_holder_snapshots / holder_concentration_scores arrive in
// Batch 5. Wrapped so a missing table is a clean no-op.
// deno-lint-ignore no-explicit-any
async function holderShiftCandidates(db: DB, ent: any, cfg: any): Promise<Candidate[]> {
  const addr = (ent.contract_address || '').toString()
  const chain = entityChain(ent.chain_namespace, ent.chain_id)
  if (!addr || !chain) return []
  const thr = Number(cfg.threshold_pct) > 0 ? Number(cfg.threshold_pct) : 5
  try {
    const { data } = await db.from('holder_concentration_scores')
      .select('id, top10_pct, computed_at').eq('chain', chain).eq('token_address', addr)
      .order('computed_at', { ascending: false }).limit(2)
    if (!data || data.length < 2) return []
    const delta = Number(data[0].top10_pct) - Number(data[1].top10_pct)
    if (!exceedsThreshold(delta, thr)) return []
    return [{
      sourceSystem: 'holder', sourceTable: 'holder_concentration_scores', sourceRef: `holder:${data[0].id}`,
      metric: 'top10_holder_delta_pct', value: delta,
      payload: { from_pct: data[1].top10_pct, to_pct: data[0].top10_pct },
    }]
  } catch { return [] }
}

// deno-lint-ignore no-explicit-any
async function metadataMigrationCandidates(db: DB, ent: any): Promise<Candidate[]> {
  const ref = (ent.canonical_ref_key || '').toString()
  const addr = (ent.contract_address || '').toString()
  if (!ref && !addr) return []
  let q = db.from('metadata_drift_events')
    .select('id, drift_type, severity, occurred_at')
    .gte('occurred_at', new Date(Date.now() - 7 * DAY_MS).toISOString())
    .order('occurred_at', { ascending: false }).limit(10)
  const ors: string[] = []
  if (ref) ors.push(`canonical_ref_key.eq.${ref}`)
  if (addr) ors.push(`token_address.eq.${addr}`)
  if (ors.length) q = q.or(ors.join(','))
  const { data } = await q
  const out: Candidate[] = []
  for (const d of data || []) {
    out.push({
      sourceSystem: 'metadata', sourceTable: 'metadata_drift_events', sourceRef: `drift:${d.id}`,
      metric: 'drift_severity', value: d.severity != null ? Number(d.severity) : null,
      payload: { drift_type: d.drift_type },
    })
  }
  return out
}
