// intel-asset-resolve — one endpoint for "the user pasted an identifier".
//
// POST { query, chain?, orgId? } → the resolver contract plus { ms }.
// Every namespace in the chain registry plus CoinMarketCap ids are accepted;
// the format is decided before anything is contacted, so an unrecognised string
// costs zero provider calls and zero database reads.
//
// Auth: a signed-in user is always required. When orgId is supplied, Investor
// Intel access for that org is verified too (requireIntelAccess), which is what
// lets the resolver read that org's entities.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { resolveAsset, MAX_QUERY_LENGTH } from '../_shared/intel/asset-resolver.ts'
import { requireIntelAccess } from '../_shared/intel/research-service.ts'
import { OrgAuthzError } from '../_shared/org-authz.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const started = Date.now()
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'unauthorized' }, 401)

    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid_body' }, 400)
    const { query, chain, orgId } = body
    if (typeof query !== 'string' || !query.trim()) return json({ error: 'invalid_query' }, 400)
    if (query.length > MAX_QUERY_LENGTH) return json({ error: 'query_too_long' }, 400)
    if (chain != null && (typeof chain !== 'string' || chain.length > 40)) return json({ error: 'invalid_chain' }, 400)
    if (orgId != null && (typeof orgId !== 'string' || orgId.length > 64)) return json({ error: 'invalid_org' }, 400)

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    let userId: string | null = null
    if (typeof orgId === 'string' && orgId) {
      const actor = await requireIntelAccess(req, createClient, admin, orgId)
      userId = actor?.userId ?? null
    } else {
      const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } },
      })
      const { data: { user } } = await anon.auth.getUser()
      if (!user) return json({ error: 'unauthorized' }, 401)
      userId = user.id
    }

    const result = await resolveAsset(admin, {
      query,
      chain: typeof chain === 'string' ? chain : null,
      orgId: typeof orgId === 'string' ? orgId : null,
      userId,
      ctx: { supabase: admin },
    })

    const status = result.status === 'invalid' ? 400 : result.status === 'rate_limited' ? 429 : 200
    return json({ ...result, ms: Date.now() - started }, status)
  } catch (e) {
    if (e instanceof OrgAuthzError) return json({ error: e.message }, e.status ?? 403)
    return json({ error: (e as Error)?.message || 'asset_resolve_failed' }, 500)
  }
})
