// Investor Intel - cache-backed DeFi browse rows.
// Reads C2 snapshots only; no provider fan-out from page render.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { loadDefiBrowseFromSnapshots } from '../_shared/defi-c2-cache.ts'

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
    const { orgId, chain = 'solana', view = 'vaults' } = await req.json().catch(() => ({}))
    if (!orgId) return json({ error: 'orgId required' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ error: 'unauthorized' }, 401)

    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY')
    const service = serviceKey ? createClient(supabaseUrl, serviceKey) : userClient
    const result = await loadDefiBrowseFromSnapshots(service, String(chain).toLowerCase(), view === 'lending' ? 'lending' : 'vaults')
    return json({ ...result, chain: String(chain).toLowerCase(), view: view === 'lending' ? 'lending' : 'vaults' })
  } catch (err) {
    return json({ rows: [], status: 'provider_error', source: 'cache', error: (err as Error)?.message || 'defi_browse_failed' }, 200)
  }
})
