// Investor Intel — Degen (memecoin) read API. Reads memecoin_latest_tokens ONLY
// (cache-only; never a live provider call). Quality-gated buckets (G4): Hot/
// Trending/Established/High-Liquidity/High-Volume require verified market data;
// pre-liquidity launches surface ONLY in New Launches / Pump.fun (G3). Every row
// carries discovery_reasons + source; rows without them are never returned.
//
// Before any of that, every row goes through the exclusion gate
// (_shared/memecoin/degen-gate.ts): stablecoins, majors, wrapped/staked
// receipts, homoglyph impersonations and impossible market caps are not
// memecoins and never appear in the screener. They are counted by reason and
// can be listed on request (`showExcluded`), so the reader can see what was
// removed instead of wondering where USDT went.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { DegenQueryError, emptyDegenExclusions, emptyDegenSnapshot, isDegenSortKey } from '../_shared/memecoin/degen-query.ts'
import { degenScreenBody, degenScreenRows, readCatalogueContracts, readDegenTokens, type DegenReader } from '../_shared/memecoin/degen-read.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

// The catalogue is the only thing that can excuse a multi-billion market cap,
// and it changes on the hour at most. One read per cold function instance per
// five minutes, shared by every request that instance serves.
const CATALOGUE_TTL_MS = 5 * 60_000
let cataloguePromise: Promise<Set<string>> | null = null
let catalogueAt = 0

function catalogueContracts(admin: DegenReader): Promise<Set<string>> {
  const now = Date.now()
  if (!cataloguePromise || now - catalogueAt > CATALOGUE_TTL_MS) {
    catalogueAt = now
    // A failed read must not poison the cache for five minutes: drop it so the
    // next request retries, and fall back to an empty set for this one.
    cataloguePromise = readCatalogueContracts(admin).catch(() => { cataloguePromise = null; return new Set<string>() })
  }
  return cataloguePromise
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'unauthorized' }, 401)
    const u = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await u.auth.getUser()
    if (!user) return json({ error: 'unauthorized' }, 401)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const orgId = typeof body.orgId === 'string' ? body.orgId : null
    const page = Math.max(0, Number(body.page) || 0)
    const limit = Math.min(100, Math.max(1, Number(body.limit) || 50))
    const bucket = body.bucket ? String(body.bucket) : null
    // Rejected before any table read: a bad sort key is a caller bug, and it
    // must not cost a full token scan to find that out.
    if (body.sort != null && body.sort !== '' && !isDegenSortKey(body.sort)) return json({ error: 'invalid_sort' }, 400)

    let tokensR
    try { tokensR = await readDegenTokens(admin) }
    catch { return json({ snapshot: emptyDegenSnapshot(), rows: [], total: 0, page, limit, sort: 'trending', dir: 'desc', showExcluded: false, excluded: emptyDegenExclusions() }) }
    const all = degenScreenRows(tokensR?.data)

    // watchlist set (degen tokens by chain:contract)
    let watchSet: Set<string> | null = null
    if (bucket === 'watchlist' && orgId) {
      const { data: wl } = await admin.from('watchlist_items').select('entity:entities(chain, contract_address)').eq('org_id', orgId)
      watchSet = new Set((wl || []).map((w) => { const e = (w.entity as { chain?: string; contract_address?: string }); return e?.chain && e?.contract_address ? `${String(e.chain).toLowerCase()}:${String(e.contract_address).toLowerCase()}` : null }).filter(Boolean) as string[])
    }

    const catalogue = await catalogueContracts(admin)

    const result = degenScreenBody(all, body, { catalogueContracts: catalogue, watchSet, now: Date.now() })

    return json(result)
  } catch (e) {
    if (e instanceof DegenQueryError) return json({ error: e.code }, e.status)
    return json({ error: (e as Error)?.message || 'intel_degen_failed' }, 500)
  }
})
