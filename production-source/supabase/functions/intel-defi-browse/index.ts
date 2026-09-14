// Investor Intel - cache-backed DeFi browse rows.
// Reads C2 snapshots only; no provider fan-out from page render.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { loadDefiBrowsePage } from '../_shared/defi-c2-cache.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No authorization header' }, 401)
    const { orgId, chain = 'solana', view = 'vaults', ...options } = await req.json().catch(() => ({}))
    if (!orgId) return json({ error: 'orgId required' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ error: 'unauthorized' }, 401)

    const result = await loadDefiBrowsePage(userClient, orgId, { ...options, chain, view })
    return json({ ...result, chain: String(chain).toLowerCase(), view: view === 'lending' ? 'lending' : 'vaults' })
  } catch (err) {
    const code = (err as { code?: string })?.code
    return json({ rows: [], status: 'provider_error', source: 'cache', error: code === '42501' ? 'Workspace unavailable' : 'defi_browse_failed' }, code === '42501' ? 403 : code === '22023' ? 400 : 503)
  }
})
