// Investor Intel — provider coverage report.
// Probes provider support per launch chain and writes chain_capabilities so the
// UI can flip capabilities from 'unverified' to live/limited/unavailable.
// Invokable by pg_cron (x-cron-secret) or a super-admin (JWT).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { CHAINS, CHAIN_PROVIDERS, type CapabilityStatus } from '../_shared/chains.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

// Disjoint from portfolio-capability-probe, which owns:
// balances, metadata, market, tx, portfolio.
const COVERAGE_CAPS = ['holders', 'liquidity', 'defi', 'execution', 'alerts', 'narrative', 'risk', 'social'] as const
const SOLANA_DEFI = new Set(['solana'])     // Kamino
const SOLANA_EXEC = new Set(['solana'])     // DFlow
const DEFILLAMA_DEFI = new Set(['ethereum', 'base', 'arbitrum', 'bnb', 'polygon', 'avalanche', 'sui', 'sei', 'injective', 'near', 'tron', 'ton'])

function envPresent(name: string): boolean {
  return !!String(Deno.env.get(name) || '').trim()
}

function coverageFor(chain: string, cap: string): { status: CapabilityStatus; provider: string | null; caveat: string | null } {
  const providers = CHAIN_PROVIDERS[chain]
  if (cap === 'narrative' || cap === 'social') {
    return { status: 'live', provider: 'intel', caveat: null }
  }

  if (cap === 'defi') {
    if (SOLANA_DEFI.has(chain)) return { status: 'live', provider: 'kamino', caveat: null }
    if (DEFILLAMA_DEFI.has(chain)) return { status: 'live', provider: 'defillama', caveat: null }
    return { status: 'unavailable', provider: null, caveat: 'no defi provider mapped' }
  }

  if (cap === 'execution') {
    if (SOLANA_EXEC.has(chain) && envPresent('DFLOW_API_KEY')) return { status: 'live', provider: 'dflow', caveat: null }
    if (SOLANA_EXEC.has(chain)) return { status: 'unavailable', provider: 'dflow', caveat: 'DFLOW_API_KEY missing' }
    return { status: 'unavailable', provider: null, caveat: 'no execution provider mapped' }
  }

  if (cap === 'liquidity') {
    if (providers?.dexscreener || providers?.geckoterminal) return { status: 'live', provider: providers.dexscreener ? 'dexscreener' : 'geckoterminal', caveat: null }
    return { status: 'unavailable', provider: null, caveat: 'no DEX provider mapped' }
  }

  if (cap === 'holders' || cap === 'risk') {
    if (providers?.birdeye) return { status: 'live', provider: 'birdeye', caveat: null }
    if (providers?.dexscreener || providers?.geckoterminal) return { status: 'limited', provider: providers.dexscreener ? 'dexscreener' : 'geckoterminal', caveat: 'DEX provider only; holder/security depth unavailable' }
    return { status: 'unavailable', provider: null, caveat: 'no risk/holder provider mapped' }
  }

  if (cap === 'alerts') {
    if (providers?.birdeye || providers?.dexscreener || providers?.geckoterminal) {
      return { status: providers?.birdeye ? 'live' : 'limited', provider: providers?.birdeye ? 'birdeye' : 'dexscreener', caveat: providers?.birdeye ? null : 'DEX-only alerts coverage' }
    }
    return { status: 'unavailable', provider: null, caveat: 'no alert provider mapped' }
  }

  return { status: 'unverified', provider: null, caveat: 'capability not owned by coverage writer' }
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

    const rows: any[] = []
    const now = new Date().toISOString()
    for (const chainDef of CHAINS) {
      for (const capability of COVERAGE_CAPS) {
        const coverage = coverageFor(chainDef.id, capability)
        rows.push({
          chain: chainDef.id,
          capability,
          status: coverage.status,
          provider: coverage.provider,
          caveat: coverage.caveat,
          verified_at: now,
          updated_at: now,
        })
      }
    }
    const { error } = await admin.from('chain_capabilities').upsert(rows, { onConflict: 'chain,capability' })
    if (error) throw error
    return json({ ok: true, chains: CHAINS.length, capabilities_written: rows.length, capabilities: COVERAGE_CAPS })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'coverage_failed' }, 500)
  }
})
