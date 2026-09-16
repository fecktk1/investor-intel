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
  bridgeTriggerUsesCondition, stepBridgedCondition,
  type EmitResult,
} from '../_shared/intel/alert-bridge.ts'
import { gatherCandidates,alertCandidateFailure } from '../_shared/intel/alert-candidates.ts'
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

const tally = () => ({ fired: 0, duplicate: 0, cooldown: 0, changed:0, access_unavailable:0, error: 0, checked: 0 })
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

    const { data: rules, error:ruleError } = await admin.from('intel_alert_rules')
      .select('id, org_id, user_id, trigger_type, config, chart_revision, cooldown_minutes, is_active, entity:entities(*), org:orgs(product_mode)')
      .in('trigger_type', BRIDGE_TRIGGERS as unknown as string[])
      .eq('is_active', true)
      .order('last_evaluation_attempt_at', { ascending: true, nullsFirst: true }).order('id').limit(500)

    if(ruleError)throw Error('alert_rules_read_failed')
    const active = (rules || []).filter((r: Rule) => r.org?.product_mode === 'intel' && r.entity)
    const t = tally()
    const perTrigger: Record<string, number> = {}

    for (const r of active) {
      t.checked++
      let state:Record<string,unknown>={status:'evaluated_no_match'}
      try {
      const cands = await gatherCandidates(admin, r)
      if(cands.length>100)throw Error('candidate_coverage_limit')
      const outcomes:string[]=[]
      for (const c of cands) {
        if (dryRun) { perTrigger[r.trigger_type] = (perTrigger[r.trigger_type] || 0) + 1; continue }
        // Hysteresis for the LEVEL triggers. The same armed/re-arm machine the
        // chart and market paths have used since 20260911202815 decides whether
        // this observation is a CROSSING at all. A rule that has not re-armed
        // records its step state and emits nothing, so a value oscillating
        // around its threshold no longer re-fires every time the cooldown
        // lapses. alert-bridge.ts lists which triggers join and why the others
        // deliberately do not.
        if (bridgeTriggerUsesCondition(r.trigger_type)) {
          const step = await stepBridgedCondition(admin, {
            ruleId: r.id, orgId: r.org_id, revision: r.chart_revision,
            observationId: c.sourceRef,
            observedAt: String(c.payload.known_at ?? c.payload.source_observed_at ?? ''),
            value: c.value, provider: String(c.payload.source ?? c.sourceSystem),
            subject: `${c.sourceTable}:${c.metric}`,
          })
          if (!step.candidate) { outcomes.push(step.state); continue }
        }
        const res = await emitBridgedAlert(admin, {
          ruleId: r.id, orgId: r.org_id, revision:r.chart_revision, triggerType: r.trigger_type,
          sourceSystem: c.sourceSystem, sourceTable: c.sourceTable, sourceRef: c.sourceRef,
          metric: c.metric, value: c.value, cooldownMinutes: r.cooldown_minutes, payload: {...c.payload,provider_source_ref:c.payload.source_ref},
        })
        record(t, res)
        outcomes.push(res)
      }
      state={status:dryRun?'preview_only':outcomes.includes('fired')?'fired':outcomes.includes('access_unavailable')?'access_unavailable':outcomes.includes('changed')?'rule_or_source_changed':outcomes.length?'suppressed':'evaluated_no_match',candidates:cands.length,outcomes:[...new Set(outcomes)]}
      } catch(error) {t.error++;state=alertCandidateFailure(error)}
      if(!dryRun){const saved=await admin.rpc('intel_record_alert_evaluation',{p_rule:r.id,p_org:r.org_id,p_revision:r.chart_revision,p_state:state});if(saved.error)t.error++}
    }

    return json({ ok: t.error===0, partial:t.error>0, enabled, dry_run: dryRun, ...t, candidates_by_trigger: perTrigger },t.error?503:200)
  } catch (err) {
    return json({ error: (err as Error)?.message || 'alert_bridge_failed' }, 500)
  }
})

