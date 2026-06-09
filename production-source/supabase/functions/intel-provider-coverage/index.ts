// Investor Intel — provider coverage report.
// Probes provider support per launch chain and writes chain_capabilities so the
// UI can flip capabilities from 'unverified' to live/limited/unavailable.
// Invokable by pg_cron (x-cron-secret) or a super-admin (JWT).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { birdeyeGet } from '../_shared/birdeye-client.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

// Our 17 launch chains → Birdeye chain id (null = Birdeye unsupported).
const BIRDEYE_NAME: Record<string, string | null> = {
  solana: 'solana', ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', bnb: 'bsc', polygon: 'polygon',
  avalanche: 'avalanche', sui: 'sui', sei: 'sei', bitcoin: null, hyperliquid: null, injective: null, near: null,
  tron: 'tron', ton: null, xrpl: null, zcash: null,
}
const CAPS = ['market', 'metadata', 'balances', 'tx', 'holders', 'liquidity', 'defi', 'execution', 'alerts', 'narrative', 'risk', 'portfolio', 'social']
const SOLANA_DEFI = new Set(['solana'])     // Kamino
const SOLANA_EXEC = new Set(['solana'])     // DFlow
const SPECIALIZED = new Set(['bitcoin', 'hyperliquid', 'injective', 'near', 'tron', 'ton', 'xrpl', 'zcash'])

function statusFor(chain: string, cap: string, birdeyeOk: boolean): string {
  // chain-agnostic
  if (cap === 'narrative' || cap === 'social') return 'live'
  if (cap === 'defi') return SOLANA_DEFI.has(chain) ? 'live' : (chain === 'injective' ? 'limited' : 'unavailable')
  if (cap === 'execution') return SOLANA_EXEC.has(chain) ? 'live' : 'unavailable'
  if (cap === 'alerts') return birdeyeOk ? 'live' : 'limited'
  // market-derived caps depend on Birdeye
  if (['market', 'metadata', 'liquidity', 'holders', 'risk'].includes(cap)) {
    if (!birdeyeOk) return SPECIALIZED.has(chain) ? 'limited' : 'unavailable'
    return SPECIALIZED.has(chain) ? 'limited' : 'live'
  }
  if (['balances', 'tx', 'portfolio'].includes(cap)) {
    // QuickNode multichain + Birdeye portfolio; privacy chains limited.
    if (chain === 'zcash') return 'limited'
    return birdeyeOk ? 'live' : 'limited'
  }
  return 'unverified'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const cronOk = req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    if (!cronOk) {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return json({ error: 'unauthorized' }, 401)
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: { user } } = await userClient.auth.getUser()
      const { data: prof } = user ? await userClient.from('profiles').select('is_super_admin').eq('id', user.id).maybeSingle() : { data: null }
      if (!prof?.is_super_admin) return json({ error: 'forbidden' }, 403)
    }

    // Verify Birdeye support per chain via a cheap probe of the networks list.
    let supported = new Set<string>()
    try {
      const r = await birdeyeGet('/defi/networks', { chain: 'solana', ctx: { supabase: admin, jobName: 'intel-provider-coverage', caller: 'coverage', kind: 'request' } })
      if (r?.ok) {
        const arr = (r.data?.data || r.data || []) as any[]
        supported = new Set((Array.isArray(arr) ? arr : []).map((x) => String(x).toLowerCase()))
      }
    } catch { /* fall back to static map */ }

    const rows: any[] = []
    const now = new Date().toISOString()
    for (const [chain, beName] of Object.entries(BIRDEYE_NAME)) {
      const birdeyeOk = !!beName && (supported.size === 0 ? true : supported.has(beName))
      for (const cap of CAPS) rows.push({ chain, capability: cap, status: statusFor(chain, cap, birdeyeOk), verified_at: now, updated_at: now })
    }
    const { error } = await admin.from('chain_capabilities').upsert(rows, { onConflict: 'chain,capability' })
    if (error) throw error
    return json({ ok: true, chains: Object.keys(BIRDEYE_NAME).length, capabilities_written: rows.length, birdeye_supported: [...supported].slice(0, 30) })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'coverage_failed' }, 500)
  }
})
