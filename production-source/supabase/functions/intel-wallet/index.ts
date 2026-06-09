// Investor Intel — wallet holdings (read-only, watch-by-address).
// Birdeye multichain portfolio for a wallet entity: total value + top holdings.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { birdeyeChainFor, birdeyeWalletPortfolio } from '../_shared/intel-providers.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No authorization header' }, 401)
    const { orgId, entityId = null, ref = null } = await req.json() || {}
    if (!orgId || (!entityId && !ref)) return json({ error: 'orgId and entityId|ref required' }, 400)

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    let q = supabase.from('entities').select('*').eq('org_id', orgId)
    q = entityId ? q.eq('id', entityId) : q.eq('canonical_ref_key', ref)
    const { data: ent } = await q.maybeSingle()
    if (!ent) return json({ error: 'entity_not_found' }, 404)

    const beKey = Deno.env.get('BIRDEYE_API_KEY')
    const beChain = birdeyeChainFor(ent.chain_namespace, ent.chain_id)
    const addr = ent.wallet_address || ent.asset_id
    if (!beKey || !beChain || !addr) return json({ entity: { address: addr, chain: ent.chain_namespace }, portfolio: null, unsupported: true })

    const portfolio = await birdeyeWalletPortfolio(beChain, addr, beKey)
    return json({ entity: { address: addr, chain: ent.chain_namespace, privacy_limited: ent.privacy_limited }, portfolio })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'wallet_failed' }, 400)
  }
})
