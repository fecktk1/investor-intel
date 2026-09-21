// Investor Intel — entity resolver endpoint.
// Normalizes any asset/wallet/market/protocol/narrative into a canonical
// `entities` row (see _shared/entity-resolver.ts) under the caller's RLS.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { EntityResolveRefusal, resolveEntity } from '../_shared/entity-resolver.ts'

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

    const body = await req.json()
    const { orgId, kind = 'asset', chain, value, assetType, issuer, currency, symbol, displaySymbol } = body || {}
    if (!orgId || (!value && kind !== 'narrative')) return json({ error: 'orgId and value required' }, 400)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )

    const entity = await resolveEntity(supabase, orgId, { kind, chain, value, assetType, issuer, currency, symbol, displaySymbol })
    return json({ entity })
  } catch (e) {
    // A shape refusal is answered with its machine code and the chain it was
    // refused against, so the page can say why in the reader's own language
    // instead of printing an English sentence from the server.
    if (e instanceof EntityResolveRefusal) return json({ error: e.details.code, refusal: e.details }, 400)
    return json({ error: (e as Error)?.message || 'resolve_failed' }, 400)
  }
})
