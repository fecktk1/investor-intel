// Investor Intel — alert evaluation (pg_cron, service-role).
// Walks active intel_alert_rules, checks live Birdeye data for the rule's token
// against its threshold, and fires intel_alert_events (with a cooldown). The AI
// "why it matters" is generated on demand from the Alerts page.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { getTokenOverview } from '../_shared/birdeye-client.ts'

const BIRDEYE_CHAIN: Record<string, string> = { '1': 'ethereum', '8453': 'base', '42161': 'arbitrum', '56': 'bsc', '137': 'polygon', '43114': 'avalanche' }
function birdeyeChainFor(ns: string, ref: string): string | null {
  if (ns === 'solana') return 'solana'
  if (ns === 'eip155') return BIRDEYE_CHAIN[ref] || null
  return null
}
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }) }

Deno.serve(async (req) => {
  try {
    if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return json({ error: 'forbidden' }, 401)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // narrative_heat alerts read narrative_state (no provider calls) → run first so
    // they fire even when Birdeye is unconfigured/disabled.
    const narrativeFired = await evalNarrativeHeat(admin)

    const beKey = Deno.env.get('BIRDEYE_API_KEY')
    if (!beKey) return json({ ok: true, checked: 0, fired: 0, narrative_fired: narrativeFired })

    const { data: rules } = await admin
      .from('intel_alert_rules')
      .select('*, entity:entities(*), org:orgs!inner(product_mode)')
      .eq('is_active', true)
      .limit(1000)

    const active = (rules || []).filter((r: any) => r.org?.product_mode === 'intel' && r.entity?.contract_address)
    let fired = 0, checked = 0

    for (const r of active.slice(0, 400)) {
      const ent = r.entity
      const beChain = birdeyeChainFor(ent.chain_namespace, ent.chain_id)
      if (!beChain) continue
      checked++

      // Overview via the centralized client: cached/deduped/capped/logged and
      // kill-switch aware. Also warms the shared overview cache.
      const ov = await getTokenOverview(beChain, ent.contract_address, { supabase: admin, jobName: 'intel-alerts-eval', caller: 'alerts-cron', orgId: r.org_id })
      if (!ov) continue

      const cfg = r.config || {}
      const thr = Number(cfg.threshold_pct)
      const pc = Number(ov.price_change_24h_pct)
      const vc = Number(ov.volume_change_24h_pct)
      let triggered = false; let metric = null; let value = null
      if (!Number.isNaN(thr)) {
        if (r.trigger_type === 'price_move' && !Number.isNaN(pc) && Math.abs(pc) >= thr) { triggered = true; metric = 'price_change_24h_pct'; value = pc }
        else if (r.trigger_type === 'volume_spike' && !Number.isNaN(vc) && vc >= thr) { triggered = true; metric = 'volume_change_24h_pct'; value = vc }
        else if (r.trigger_type === 'liquidity_drop' && Number(ov.liquidity) > 0 && cfg.min_liquidity_usd && Number(ov.liquidity) < Number(cfg.min_liquidity_usd)) { triggered = true; metric = 'liquidity_usd'; value = Number(ov.liquidity) }
      }
      if (!triggered) continue

      // Cooldown: skip if an event for this rule fired in the last 12h.
      const { data: recent } = await admin.from('intel_alert_events').select('id').eq('rule_id', r.id).gte('fired_at', new Date(Date.now() - 12 * 3600_000).toISOString()).limit(1)
      if (recent && recent.length) continue

      await admin.from('intel_alert_events').insert({
        org_id: r.org_id, rule_id: r.id,
        payload: { trigger_type: r.trigger_type, metric, value, threshold_pct: thr, symbol: ov.symbol || ent.display_symbol, price: ov.price, ref: ent.canonical_ref_key },
      })
      fired++
    }
    return json({ ok: true, checked, fired, narrative_fired: narrativeFired })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'eval_failed' }, 500)
  }
})

// Fire narrative_heat events for followed narratives whose state materially changed
// (stage transition / momentum spike / elevated risk). Reads narrative_state only —
// no provider calls. Best-effort: returns the count, never throws.
// deno-lint-ignore no-explicit-any
async function evalNarrativeHeat(admin: any): Promise<number> {
  try {
    const { data: rules } = await admin.from('intel_alert_rules')
      .select('id, org_id, config, org:orgs!inner(product_mode)')
      .eq('is_active', true).eq('trigger_type', 'narrative_heat').limit(1000)
    // deno-lint-ignore no-explicit-any
    const active = (rules || []).filter((r: any) => r.org?.product_mode === 'intel' && r.config?.slug)
    if (!active.length) return 0

    // deno-lint-ignore no-explicit-any
    const slugs = [...new Set(active.map((r: any) => r.config.slug))]
    const { data: tax } = await admin.from('narrative_taxonomy').select('id, slug, name').in('slug', slugs)
    // deno-lint-ignore no-explicit-any
    const byId = new Map<string, any>((tax || []).map((t: any) => [t.id, t]))
    const ids = (tax || []).map((t: { id: string }) => t.id)
    const { data: states } = ids.length ? await admin.from('narrative_state').select('*').in('narrative_id', ids) : { data: [] }
    // deno-lint-ignore no-explicit-any
    const bySlug = new Map<string, any>()
    for (const s of (states || [])) { const ti = byId.get(s.narrative_id); if (ti) bySlug.set(ti.slug, { ...s, name: ti.name }) }

    let fired = 0
    for (const r of active) {
      const st = bySlug.get(r.config.slug); if (!st) continue
      const prefs = r.config || {}
      const delta = st.score_delta || {}
      const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0)
      const stageChange = prefs.stage_change !== false && st.prev_stage && st.prev_stage !== st.lifecycle_stage
        && st.stage_changed_at && (Date.now() - new Date(st.stage_changed_at).getTime()) < 6 * 3600_000
      const momoSpike = num(delta.momentum) >= Number(prefs.momentum_delta || 10)
      const riskSpike = prefs.risk_spike !== false && num(st.risk_score) >= Number(prefs.risk_score || 65)
      let reason: string | null = null
      if (stageChange) reason = `stage ${st.prev_stage} → ${st.lifecycle_stage}`
      else if (momoSpike) reason = `momentum +${Math.round(num(delta.momentum))}`
      else if (riskSpike) reason = `risk elevated (${Math.round(num(st.risk_score))})`
      if (!reason) continue

      const { data: recent } = await admin.from('intel_alert_events').select('id')
        .eq('rule_id', r.id).gte('fired_at', new Date(Date.now() - 12 * 3600_000).toISOString()).limit(1)
      if (recent && recent.length) continue

      await admin.from('intel_alert_events').insert({
        org_id: r.org_id, rule_id: r.id,
        payload: { trigger_type: 'narrative_heat', slug: r.config.slug, name: st.name, reason,
          lifecycle_stage: st.lifecycle_stage, prev_stage: st.prev_stage, signal_class: st.signal_class,
          momentum: st.momentum_score, risk: st.risk_score },
      })
      fired++
    }
    return fired
  } catch (_e) { return 0 }
}
