// Investor Intel - DeFi vault metrics + TVL/APY history.
// Stage C2 reads reusable snapshots first. Live provider fallback is reserved
// for explicit request-time misses; browse/render paths use intel-defi-browse.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { chainIdFor } from '../_shared/chains.ts'
import { loadDefiMetricSnapshot } from '../_shared/defi-c2-cache.ts'
import { kaminoForAddress } from '../_shared/kamino-client.ts'
import { findDefiLlamaPool, fetchDefiLlamaPoolHistory } from '../_shared/defillama-client.ts'
import { requireIntelAccess } from '../_shared/intel/research-service.ts'
import { orgAuthzErrorResponse } from '../_shared/org-authz.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No authorization header' }, 401)
    const { orgId, entityId = null, ref = null } = await req.json() || {}
    if (!orgId || (!entityId && !ref)) return json({ error: 'orgId and entityId|ref required' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY')
    const service = serviceKey ? createClient(supabaseUrl, serviceKey) : supabase
    await requireIntelAccess(req, createClient, service, orgId)

    let q = supabase.from('entities').select('*').eq('org_id', orgId)
    q = entityId ? q.eq('id', entityId) : q.eq('canonical_ref_key', ref)
    const { data: ent } = await q.maybeSingle()
    if (!ent) return json({ error: 'entity_not_found' }, 404)

    const addr = ent.contract_address || ent.asset_id
    const chain = chainIdFor(ent.chain_namespace, ent.chain_id)
    if (!chain) return json({ error: 'chain_identity_unavailable', state: 'unsupported', coverage: 'The asset has no recognized chain reference. No other network was queried.' }, 422)
    const isSolana = chain === 'solana'

    let current: any = null
    let provider: 'kamino' | 'defillama' | null = null
    let llamaPoolId: string | null = null

    const cached = await loadDefiMetricSnapshot(service, addr, chain).catch(() => null)
    if (cached?.current) {
      current = cached.current
      provider = cached.provider
      llamaPoolId = cached.llamaPoolId
    }

    if (!current && isSolana) {
      const k = await kaminoForAddress(addr, { supabase: service, kind: 'request', caller: 'intel-defi-metrics', jobName: 'intel-defi-metrics', orgId })
      if (k) { current = k; provider = 'kamino' }
    }

    if (!current) {
      const ll = await findDefiLlamaPool(addr, chain, { supabase: service, kind: 'request', caller: 'intel-defi-metrics', jobName: 'intel-defi-metrics', orgId })
      if (ll) {
        current = {
          type: ll.productType === 'lending' ? 'lending_market' as const : 'defi_pool' as const,
          apy: ll.apy,
          tvl_usd: ll.tvl_usd,
          tokenA: ll.tokenA,
          tokenB: ll.tokenB,
          protocol: ll.protocol,
          il_7d: ll.il_7d,
          reward_tokens: [],
          fees_24h: null,
        }
        provider = 'defillama'
        llamaPoolId = ll.poolId
      }
    }

    let history: any[] = []
    if (isSolana && provider === 'kamino') {
      const histRes = await supabase.rpc('intel_defi_vault_history', { p_vault_address: addr, p_days: 120 })
      history = histRes.data || []
    } else {
      const snapshotRes = await supabase.rpc('intel_defi_pool_history', { p_pool_address: addr, p_chain: chain, p_days: 120 })
      if (snapshotRes.data?.length) {
        history = snapshotRes.data
      } else if (llamaPoolId && current) {
        history = await fetchDefiLlamaPoolHistory(llamaPoolId, { supabase: service, kind: 'request', caller: 'intel-defi-metrics', jobName: 'intel-defi-metrics', orgId })
      }
    }

    return json({
      entity: { symbol: ent.display_symbol, ref: ent.canonical_ref_key, address: addr, chain },
      current: current || null,
      provider,
      data_unavailable: current === null,
      history,
    })
  } catch (e) {
    const accessError = orgAuthzErrorResponse(e, corsHeaders)
    if (accessError) return accessError
    return json({ error: (e as Error)?.message || 'defi_metrics_failed' }, 400)
  }
})
