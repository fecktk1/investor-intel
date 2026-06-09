// Investor Intel — DeFi vault metrics + TVL/APY history.
// Solana: tries Kamino (LP → Earn → lending market), then DeFiLlama as fallback.
// All other chains: DeFiLlama directly.
// History comes from accumulated snapshots (cron) first; live DeFiLlama chart as fallback.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { kaminoForAddress, defiLlamaForPool, defiLlamaPoolHistory } from '../_shared/intel-providers.ts'
import { chainIdFor } from '../_shared/chains.ts'

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

    const addr = ent.contract_address || ent.asset_id
    // entities stores chain_namespace (e.g. 'eip155') + chain_id (CAIP-2 ref,
    // e.g. '1'); reverse-map to our chain slug ('ethereum') for routing.
    const chain = chainIdFor(ent.chain_namespace, ent.chain_id) || 'solana'
    const isSolana = chain === 'solana'

    // ── Live metrics ──────────────────────────────────────────────────────────
    let current: any = null
    let provider: 'kamino' | 'defillama' | null = null
    let llamaPoolId: string | null = null

    if (isSolana) {
      const k = await kaminoForAddress(addr)
      if (k) { current = k; provider = 'kamino' }
    }

    if (!current) {
      const ll = await defiLlamaForPool(addr, chain)
      if (ll) {
        current = {
          type: 'defi_pool' as const,
          apy: ll.apy,
          tvl_usd: ll.tvl_usd,
          tokenA: ll.symbol?.split('-')[0] ?? null,
          tokenB: ll.symbol?.split('-')[1] ?? null,
          protocol: ll.protocol,
          il_7d: ll.il_7d,
          reward_tokens: ll.reward_tokens,
          fees_24h: null,
        }
        provider = 'defillama'
        llamaPoolId = ll.pool_id
      }
    }

    // ── History ───────────────────────────────────────────────────────────────
    // Prefer accumulated snapshots (cheaper); fall back to live DeFiLlama chart.
    let history: any[] = []
    if (isSolana && provider === 'kamino') {
      // Cross-org Kamino snapshot mirror (SECURITY DEFINER, fast)
      const histRes = await supabase.rpc('intel_defi_vault_history', { p_vault_address: addr, p_days: 120 })
      history = histRes.data || []
    } else {
      // Check accumulated defi_pool_snapshots first
      const snapshotRes = await supabase.rpc('intel_defi_pool_history', { p_pool_address: addr, p_chain: chain, p_days: 120 })
      if (snapshotRes.data?.length) {
        history = snapshotRes.data
      } else if (llamaPoolId) {
        // Live DeFiLlama chart as fallback (no snapshots yet)
        history = await defiLlamaPoolHistory(llamaPoolId)
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
    return json({ error: (e as Error)?.message || 'defi_metrics_failed' }, 400)
  }
})
