import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
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
    const cronOk = req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
    const authHeader = req.headers.get('Authorization')
    if (!cronOk) {
      if (!authHeader) return json({ error: 'unauthorized' }, 401)
      const userClient = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } },
      )
      const { data: auth } = await userClient.auth.getUser()
      const { data: profile } = auth?.user
        ? await userClient.from('profiles').select('is_super_admin').eq('id', auth.user.id).maybeSingle()
        : { data: null }
      if (!profile?.is_super_admin) return json({ error: 'forbidden' }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const confirm = body?.confirm !== false
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data, error } = await admin.rpc('intel_provider_snapshot_retention_run', { p_confirm: confirm })
    if (error) return json({ error: error.message }, 500)
    return json({ ok: true, confirm, result: data })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'provider_retention_rollup_failed' }, 500)
  }
})
