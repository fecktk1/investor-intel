// Investor Intel — asset facts read API (CMC plan proposals 4, 11, 18, 19).
//
// Supply trust and listing notices, market-pair and supply deltas, listing-age
// cohorts and multi-chain deployments. Reads already-captured rows only:
// `market_assets.facts` (the daily CoinMarketCap metadata pass) and
// `intel_rank_history` (the daily capture job). This function NEVER calls a
// provider, never writes, and never fills a gap in the capture history.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { requireIntelAccess } from '../_shared/intel/research-service.ts'
import { orgAuthzErrorResponse } from '../_shared/org-authz.ts'
import { deltas, deployments, listingActivity, listingAge, listingCohorts, noticeState, supplyTrust } from '../_shared/intel/asset-facts.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } })

const PROVIDERS = ['coinmarketcap', 'coingecko'] as const

export async function handleAssetFacts(req: Request, clientFactory: typeof createClient = createClient): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { ...corsHeaders, 'Access-Control-Max-Age': '600' } })
  try {
    if (!req.headers.get('Authorization')) return json({ error: 'unauthorized' }, 401)
    const admin = clientFactory(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const orgId = typeof body.orgId === 'string' ? body.orgId : null
    // Verifies the user, then organization membership, then the Intel entitlement.
    await requireIntelAccess(req, clientFactory, admin, orgId)

    const op = typeof body.op === 'string' ? body.op : 'asset'
    const provider = typeof body.provider === 'string' ? body.provider : typeof body.sourceProvider === 'string' ? body.sourceProvider : 'coinmarketcap'
    if (!(PROVIDERS as readonly string[]).includes(provider)) return json({ error: 'invalid_provider' }, 400)
    const days = body.days == null ? 30 : Number(body.days)
    if (!Number.isFinite(days) || days < 1 || days > 400) return json({ error: 'invalid_days' }, 400)

    if (op === 'cohorts') return json(await listingCohorts(admin, provider))
    if (op === 'listing_activity') return json(await listingActivity(admin, provider, days))
    if (op !== 'asset') return json({ error: 'invalid_op' }, 400)

    const providerId = body.providerId != null ? String(body.providerId) : ''
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(providerId)) return json({ error: 'invalid_provider_id' }, 400)
    const { data: row, error } = await admin.from('market_assets')
      .select('source_provider,provider_id,symbol,name,primary_chain,platforms,circulating_supply,total_supply,max_supply,market_cap,num_market_pairs,facts,facts_at')
      .eq('source_provider', provider).eq('provider_id', providerId).maybeSingle()
    if (error) return json({ error: 'asset_facts_unavailable' }, 503)
    if (!row) return json({ error: 'asset_not_found' }, 404)

    return json({
      asset: { sourceProvider: row.source_provider, providerId: String(row.provider_id), symbol: row.symbol ?? null, name: row.name ?? null, numMarketPairs: row.num_market_pairs ?? null },
      supply: supplyTrust(row),
      age: listingAge(row),
      deployments: deployments(row),
      notice: noticeState(row),
      deltas: await deltas(admin, provider, providerId, days),
      factsAt: row.facts_at ?? null,
      attribution: provider === 'coinmarketcap' ? 'Data via CoinMarketCap' : 'Data via CoinGecko',
    })
  } catch (e) {
    const denied = orgAuthzErrorResponse(e, corsHeaders)
    if (denied) return denied
    return json({ error: (e as Error)?.message || 'asset_facts_failed' }, 500)
  }
}

if (import.meta.main) Deno.serve((req) => handleAssetFacts(req))
