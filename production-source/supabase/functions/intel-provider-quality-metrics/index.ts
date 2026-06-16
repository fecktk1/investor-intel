// Internal-only Provider Intelligence quality metrics.
//
// Super-admin authenticated wrapper around the service-role RPC from migration
// 284. This is intentionally not wired into customer-facing product surfaces.

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// deno-lint-ignore no-explicit-any
async function countQuery(q: any): Promise<number | null> {
  try {
    const { count, error } = await q
    if (error) return null
    return typeof count === 'number' ? count : 0
  } catch {
    return null
  }
}

// deno-lint-ignore no-explicit-any
async function retentionHealth(admin: any) {
  const { data: policies, error } = await admin.from('intel_snapshot_retention_policies')
    .select('table_name,time_column,high_res_days,subject_type,privacy_scope,rollup_enabled,prune_enabled,updated_at')
    .order('table_name')
  if (error) return { status: 'unavailable', reason: error.message }

  const tableHealth = []
  let estimatedRows = 0
  for (const policy of policies || []) {
    const table = String(policy.table_name || '')
    const timeColumn = String(policy.time_column || '')
    if (!table || !timeColumn) continue
    const highResSince = new Date(Date.now() - Number(policy.high_res_days || 60) * 24 * 60 * 60 * 1000).toISOString()
    const totalRows = await countQuery(admin.from(table).select(timeColumn, { count: 'exact', head: true }))
    const highResRows = await countQuery(admin.from(table).select(timeColumn, { count: 'exact', head: true }).gte(timeColumn, highResSince))
    const oldRows = totalRows == null || highResRows == null ? null : Math.max(0, totalRows - highResRows)
    const { data: oldest } = await admin.from(table).select(timeColumn).order(timeColumn, { ascending: true }).limit(1).maybeSingle()
    const { data: newest } = await admin.from(table).select(timeColumn).order(timeColumn, { ascending: false }).limit(1).maybeSingle()
    const rollupRows = policy.rollup_enabled
      ? await countQuery(admin.from('intel_rollups').select('id', { count: 'exact', head: true }).eq('subject_type', policy.subject_type))
      : null
    estimatedRows += totalRows || 0
    tableHealth.push({
      table_name: table,
      subject_type: policy.subject_type,
      privacy_scope: policy.privacy_scope,
      high_res_days: policy.high_res_days,
      total_rows: totalRows,
      high_res_rows: highResRows,
      rows_past_high_res_window: oldRows,
      oldest_high_res_row: oldest?.[timeColumn] || null,
      newest_high_res_row: newest?.[timeColumn] || null,
      rollup_rows: rollupRows,
      prune_enabled: policy.prune_enabled,
      rollup_enabled: policy.rollup_enabled,
    })
  }

  const eventMemoryRows = await countQuery(admin.from('intel_event_memory').select('id', { count: 'exact', head: true }))
  const providerDecisionRows = await countQuery(admin.from('decision_memory').select('id', { count: 'exact', head: true }).eq('surface', 'provider_snapshot_memory'))
  const providerPromotionRows = await countQuery(admin.from('intelligence_promotions').select('id', { count: 'exact', head: true }).in('raw_table', (policies || []).map((p: Record<string, unknown>) => p.table_name).filter(Boolean)))
  const rollupRows = await countQuery(admin.from('intel_rollups').select('id', { count: 'exact', head: true }))
  return {
    status: 'available',
    generated_at: new Date().toISOString(),
    tables: tableHealth,
    summary: {
      policy_count: (policies || []).length,
      table_count: tableHealth.length,
      rollup_rows: rollupRows,
      event_memory_rows: eventMemoryRows,
      provider_snapshot_decision_rows: providerDecisionRows,
      provider_snapshot_promotion_rows: providerPromotionRows,
      estimated_snapshot_rows: estimatedRows,
      estimated_storage_bytes_rough: estimatedRows * 1200,
    },
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader) return json({ error: 'unauthorized' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const authed = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await authed.auth.getUser()
    if (!user) return json({ error: 'unauthorized' }, 401)

    const { data: profile } = await authed.from('profiles').select('is_super_admin').eq('id', user.id).maybeSingle()
    if (!profile?.is_super_admin) return json({ error: 'forbidden' }, 403)

    let body: Record<string, unknown> = {}
    try { body = await req.json() } catch { /* body optional */ }
    const days = Math.max(1, Math.min(90, Number(body.days || body.window_days || 7) || 7))

    const admin = createClient(supabaseUrl, serviceKey)
    const { data, error } = await admin.rpc('intel_provider_quality_metrics', { p_days: days })
    if (error) return json({ error: error.message || 'metrics_failed' }, 500)
    const retention_health = await retentionHealth(admin)
    return json({ ok: true, metrics: { ...(data || {}), retention_health } })
  } catch (err) {
    return json({ error: (err as Error)?.message || 'metrics_failed' }, 500)
  }
})
