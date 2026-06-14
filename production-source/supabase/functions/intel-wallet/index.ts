// Investor Intel — wallet holdings (read-only, watch-by-address).
// Birdeye multichain portfolio for a wallet entity: total value + top holdings.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { birdeyeChainFor, birdeyeWalletPortfolio } from '../_shared/intel-providers.ts'
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

function portfolioItems(portfolio: any): any[] {
  if (Array.isArray(portfolio?.items)) return portfolio.items
  if (Array.isArray(portfolio?.tokens)) return portfolio.tokens
  if (Array.isArray(portfolio?.data?.items)) return portfolio.data.items
  if (Array.isArray(portfolio?.data?.tokens)) return portfolio.data.tokens
  return []
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
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY')
    const intelligenceClient = serviceKey ? createClient(supabaseUrl, serviceKey) : supabase
    let q = supabase.from('entities').select('*').eq('org_id', orgId)
    q = entityId ? q.eq('id', entityId) : q.eq('canonical_ref_key', ref)
    const { data: ent } = await q.maybeSingle()
    if (!ent) return json({ error: 'entity_not_found' }, 404)

    const beKey = Deno.env.get('BIRDEYE_API_KEY')
    const beChain = birdeyeChainFor(ent.chain_namespace, ent.chain_id)
    const addr = ent.wallet_address || ent.asset_id
    if (!beKey || !beChain || !addr) return json({ entity: { address: addr, chain: ent.chain_namespace }, portfolio: null, unsupported: true })

    const portfolio = await birdeyeWalletPortfolio(beChain, addr, beKey)
    const items = portfolioItems(portfolio)
    const topItems = items.slice(0, 15).map((item: any) => ({
      symbol: item.symbol || item.token_symbol || item.name || null,
      address: item.address || item.token_address || item.mint || null,
      value_usd: item.valueUsd ?? item.value_usd ?? item.usd_value ?? null,
      amount: item.amount ?? item.balance ?? null,
    }))
    const totalUsd = (portfolio as any)?.totalUsd ?? (portfolio as any)?.total_usd ?? (portfolio as any)?.total_value_usd ?? (portfolio as any)?.data?.totalUsd ?? null
    const hourBucket = new Date().toISOString().slice(0, 13)
    await persistApiIntelligence(intelligenceClient, {
      visibility: 'org_private',
      orgId,
      rawTable: 'birdeye_wallet_portfolio',
      rawRecordId: `${ent.id || addr}:${hourBucket}`,
      rawHash: stableHash({ chain: beChain, address: addr, totalUsd, topItems }),
      promotionStatus: 'linked',
      promotionScore: items.length ? 0.65 : 0.45,
      validationStatus: 'api_wallet_portfolio_fetched',
      entityRefs: [
        compactText(ent.id, 120),
        compactText(ent.canonical_ref_key, 160),
        compactText(addr, 160),
        compactText(ent.asset_id, 160),
      ].filter(Boolean),
      sourceRefs: [{
        source: 'birdeye',
        source_table: 'birdeye_wallet_portfolio',
        entity_id: ent.id,
        chain: beChain,
        address: addr,
        fetched_at: new Date().toISOString(),
      }],
      promotedMemoryType: 'wallet_portfolio_snapshot',
      promotedMemoryRef: ent.id || addr,
      derivedPayload: {
        entity_id: ent.id,
        chain: ent.chain_namespace,
        birdeye_chain: beChain,
        address: addr,
        privacy_limited: ent.privacy_limited,
        total_usd: totalUsd,
        holding_count: items.length,
        top_items: topItems,
      },
    }).catch((err: any) => console.warn('[intel-wallet] intelligence persistence skipped:', err?.message || err))

    return json({ entity: { address: addr, chain: ent.chain_namespace, privacy_limited: ent.privacy_limited }, portfolio })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'wallet_failed' }, 400)
  }
})
