// intel-token-locate — resolve an EVM contract address to the chain(s) it trades on.
//
// EVM addresses are chain-ambiguous (the same 0x… can exist on many chains), so a
// paste can't be opened without knowing the chain. This wraps the free DexScreener
// multichain search and returns candidate { chain, symbol, liquidityUsd } rows —
// restricted to chains we can actually enrich (CHAIN_PROVIDERS) and de-duped to the
// best pair per chain — so the UI can auto-open the highest-liquidity match or show
// a small chooser. Solana mints are unambiguous and do NOT call this. Read-only;
// never blocks; returns { candidates: [] } on a miss.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { searchTokens } from '../_shared/memecoin/dexscreener.ts'
import { CHAIN_PROVIDERS } from '../_shared/chains.ts'
import { isValidEvmAddress } from '../_shared/investor-portfolio/addresses.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'unauthorized' }, 401)
    const u = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await u.auth.getUser()
    if (!user) return json({ error: 'unauthorized' }, 401)

    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const address = String(body.address || '').trim()
    if (!isValidEvmAddress(address)) return json({ error: 'invalid_address' }, 400)

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const ctx = { supabase: admin, jobName: 'intel-token-locate', kind: 'request' as const }
    const rows = await searchTokens(address, ctx)

    // Keep only exact-address matches on chains we can enrich; best liquidity per chain.
    const lc = address.toLowerCase()
    const byChain = new Map<string, { chain: string; symbol: string | null; liquidityUsd: number; fdv: number | null }>()
    for (const r of (rows || [])) {
      if (!r?.tokenAddress || String(r.tokenAddress).toLowerCase() !== lc) continue
      if (!CHAIN_PROVIDERS[r.chain]) continue
      const liq = Number(r.liquidityUsd) || 0
      const prev = byChain.get(r.chain)
      if (!prev || liq > prev.liquidityUsd) byChain.set(r.chain, { chain: r.chain, symbol: r.symbol ?? null, liquidityUsd: liq, fdv: r.fdv ?? null })
    }
    const candidates = [...byChain.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    return json({ candidates })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'token_locate_failed' }, 500)
  }
})
