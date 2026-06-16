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
    return json({ ok: true, metrics: data })
  } catch (err) {
    return json({ error: (err as Error)?.message || 'metrics_failed' }, 500)
  }
})
