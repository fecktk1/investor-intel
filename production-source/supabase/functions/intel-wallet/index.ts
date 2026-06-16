// Investor Intel — wallet holdings (read-only, watch-by-address).
// Provider-layer portfolio for a wallet entity: total value + top holdings.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { chainIdFor } from '../_shared/chains.ts'
import { loadWalletPortfolioViaProviders } from '../_shared/alchemy-c1-hydration.ts'
import { persistApiIntelligence } from '../_shared/intelligence-core.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

function compactText(value: unknown, max = 600): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function stableHash(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function appChainForEntity(ent: any): string | null {
  const caip = chainIdFor(ent?.chain_namespace ?? null, ent?.chain_id ?? null)
  if (caip) return caip
  const raw = String(ent?.chain_id || ent?.chain_namespace || '').trim().toLowerCase()
  if (raw === 'evm') return 'evm'
  return raw || null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No authorization header' }, 401)
    const { orgId, entityId = null, ref = null } = await req.json() || {}
    if (!orgId || (!entityId && !ref)) return json({ error: 'orgId and entityId|ref required' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return json({ error: 'unauthorized' }, 401)
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY')
    const intelligenceClient = serviceKey ? createClient(supabaseUrl, serviceKey) : supabase
    let q = supabase.from('entities').select('*').eq('org_id', orgId)
    q = entityId ? q.eq('id', entityId) : q.eq('canonical_ref_key', ref)
    const { data: ent } = await q.maybeSingle()
    if (!ent) return json({ error: 'entity_not_found' }, 404)

    const chain = appChainForEntity(ent)
    const addr = ent.wallet_address || ent.asset_id
    if (!chain || !addr) return json({ entity: { address: addr, chain: ent.chain_namespace }, portfolio: null, unsupported: true })

    const providerResult = await loadWalletPortfolioViaProviders(addr, chain, {
      supabase: intelligenceClient,
      kind: 'request',
      caller: 'intel-wallet',
      jobName: 'intel-wallet',
      orgId,
      userId: user.id,
      entityId: ent.id,
      walletAddress: addr,
      chain,
    })
    const portfolio = providerResult.portfolio
    if (!portfolio) {
      return json({
        entity: { address: addr, chain: ent.chain_namespace, app_chain: chain, privacy_limited: ent.privacy_limited },
        portfolio: null,
        unsupported: providerResult.unsupported,
        provider: providerResult.provider,
      })
    }
    const topItems = portfolio.top_holdings || []
    const totalUsd = portfolio.total_usd ?? null
    const hourBucket = new Date().toISOString().slice(0, 13)
    await persistApiIntelligence(intelligenceClient, {
      visibility: 'org_private',
      orgId,
      rawTable: 'wallet_portfolio_snapshots',
      rawRecordId: `${ent.id || addr}:${hourBucket}`,
      rawHash: stableHash({ chain, address: addr, provider: providerResult.provider, totalUsd, topItems }),
      promotionStatus: 'linked',
      promotionScore: portfolio.token_count ? 0.65 : 0.45,
      validationStatus: 'api_wallet_portfolio_fetched',
      entityRefs: [
        compactText(ent.id, 120),
        compactText(ent.canonical_ref_key, 160),
        compactText(addr, 160),
        compactText(ent.asset_id, 160),
      ].filter(Boolean),
      sourceRefs: [{
        source: providerResult.provider || 'portfolio_provider',
        source_table: 'wallet_portfolio_snapshots',
        entity_id: ent.id,
        chain,
        address: addr,
        fetched_at: new Date().toISOString(),
      }],
      promotedMemoryType: 'wallet_portfolio_snapshot',
      promotedMemoryRef: ent.id || addr,
      derivedPayload: {
        entity_id: ent.id,
        chain: ent.chain_namespace,
        app_chain: chain,
        provider: providerResult.provider,
        address: addr,
        privacy_limited: ent.privacy_limited,
        total_usd: totalUsd,
        holding_count: portfolio.token_count,
        top_items: topItems,
      },
    }).catch((err: any) => console.warn('[intel-wallet] intelligence persistence skipped:', err?.message || err))

    return json({
      entity: { address: addr, chain: ent.chain_namespace, app_chain: chain, privacy_limited: ent.privacy_limited },
      portfolio,
      provider: providerResult.provider,
      unsupported: false,
    })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'wallet_failed' }, 400)
  }
})
