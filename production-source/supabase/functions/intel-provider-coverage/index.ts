// Investor Intel — provider coverage report.
// Probes provider support per launch chain and writes chain_capabilities so the
// UI can flip capabilities from 'unverified' to live/limited/unavailable.
// Invokable by pg_cron (x-cron-secret) or a super-admin (JWT).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { CHAINS, CHAIN_PROVIDERS, alchemyNetworkFor, isEvmFamily, type CapabilityStatus } from '../_shared/chains.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

const COVERAGE_CAPS = [
  'market', 'metadata', 'balances', 'tx', 'portfolio',
  'holders', 'liquidity', 'microstructure', 'macro', 'categories', 'defi', 'execution', 'alerts', 'narrative', 'risk', 'social',
] as const
const SOLANA_DEFI = new Set(['solana'])     // Kamino
const SOLANA_EXEC = new Set(['solana'])     // DFlow
const DEFILLAMA_DEFI = new Set(['ethereum', 'base', 'arbitrum', 'bnb', 'polygon', 'avalanche', 'sui', 'sei', 'injective', 'near', 'tron', 'ton'])

function envPresent(name: string): boolean {
  return !!String(Deno.env.get(name) || '').trim()
}

export type C1CoverageState = {
  metadataChains: Set<string>
  priceChains: Set<string>
  walletChains: Set<string>
  transferChains: Set<string>
  defiChains: Set<string>
  dexMarketChains: Set<string>
  dexOhlcvChains: Set<string>
  cexDepthRows: boolean
  macroRows: boolean
  categoryRows: boolean
  kaminoRows: boolean
}

async function distinctChains(admin: any, table: string): Promise<Set<string>> {
  try {
    const { data } = await admin.from(table).select('chain').limit(5000)
    return new Set((data || []).map((r: any) => String(r.chain || '')).filter(Boolean))
  } catch {
    return new Set()
  }
}

export async function loadC1CoverageState(admin: any): Promise<C1CoverageState> {
  const [metadataChains, priceChains, walletChains, transferChains, protocolChains, chainTvlChains, poolChains, dexMarketChains, dexOhlcvChains, cexDepthRows, macroRows, categoryRows, kaminoRows] = await Promise.all([
    distinctChains(admin, 'token_metadata_snapshots'),
    distinctChains(admin, 'token_price_snapshots'),
    distinctChains(admin, 'wallet_portfolio_snapshots'),
    distinctChains(admin, 'asset_transfer_activity'),
    distinctChains(admin, 'protocol_tvl_snapshots'),
    distinctChains(admin, 'chain_tvl_snapshots'),
    distinctChains(admin, 'defi_pool_snapshots'),
    distinctChains(admin, 'dex_pair_snapshots'),
    distinctChains(admin, 'pool_ohlcv_snapshots'),
    (async () => {
      try {
        const { data } = await admin.from('exchange_latest_orderbook').select('provider').limit(1)
        return (data || []).length > 0
      } catch {
        return false
      }
    })(),
    (async () => {
      try {
        const { data } = await admin.from('market_macro_snapshots').select('provider').limit(1)
        return (data || []).length > 0
      } catch {
        return false
      }
    })(),
    (async () => {
      try {
        const { data } = await admin.from('narrative_category_snapshots').select('provider').limit(1)
        return (data || []).length > 0
      } catch {
        return false
      }
    })(),
    (async () => {
      try {
        const { data } = await admin.from('kamino_vault_snapshots').select('id').limit(1)
        return (data || []).length > 0
      } catch {
        return false
      }
    })(),
  ])
  const defiChains = new Set<string>([...protocolChains, ...chainTvlChains, ...poolChains])
  if (kaminoRows) defiChains.add('solana')
  return { metadataChains, priceChains, walletChains, transferChains, defiChains, dexMarketChains, dexOhlcvChains, cexDepthRows, macroRows, categoryRows, kaminoRows }
}

function alchemyReady(chain: string): boolean {
  return isEvmFamily(chain) && !!alchemyNetworkFor(chain) && envPresent('ALCHEMY_API_KEY')
}

export function coverageFor(chain: string, cap: string, c1: C1CoverageState): { status: CapabilityStatus; provider: string | null; caveat: string | null } {
  const providers = CHAIN_PROVIDERS[chain]
  if (cap === 'narrative' || cap === 'social') {
    return { status: 'live', provider: 'intel', caveat: null }
  }

  if (cap === 'metadata') {
    if (c1.metadataChains.has(chain)) return { status: 'live', provider: alchemyReady(chain) ? 'alchemy' : 'provider_snapshot', caveat: null }
    if (alchemyReady(chain)) return { status: 'limited', provider: 'alchemy', caveat: 'metadata snapshot cache pending' }
    if (chain === 'solana') return { status: 'limited', provider: 'helius', caveat: 'Solana metadata available through the portfolio layer' }
    return { status: 'unavailable', provider: null, caveat: 'no metadata provider mapped' }
  }

  if (cap === 'market') {
    if (c1.priceChains.has(chain)) return { status: 'live', provider: 'alchemy', caveat: null }
    if (c1.dexMarketChains.has(chain)) return { status: 'live', provider: 'dexscreener', caveat: null }
    if (alchemyReady(chain)) return { status: 'limited', provider: 'alchemy', caveat: 'price snapshot cache pending' }
    if (providers?.dexscreener || providers?.geckoterminal) return { status: 'limited', provider: providers.dexscreener ? 'dexscreener' : 'geckoterminal', caveat: 'DEX market coverage only' }
    return { status: 'unavailable', provider: null, caveat: 'no market provider mapped' }
  }

  if (cap === 'balances' || cap === 'portfolio') {
    if (c1.walletChains.has(chain)) return { status: 'live', provider: chain === 'solana' ? 'helius' : 'alchemy', caveat: null }
    if (alchemyReady(chain)) return { status: 'limited', provider: 'alchemy', caveat: 'wallet snapshot cache pending' }
    if (chain === 'solana' && envPresent('HELIUS_API_KEY')) return { status: 'limited', provider: 'helius', caveat: 'wallet snapshot cache pending' }
    return { status: 'unavailable', provider: null, caveat: 'no wallet portfolio provider mapped' }
  }

  if (cap === 'tx') {
    if (c1.transferChains.has(chain)) return { status: 'live', provider: chain === 'solana' ? 'helius' : 'alchemy', caveat: null }
    if (alchemyReady(chain)) return { status: 'limited', provider: 'alchemy', caveat: 'transfer activity snapshot cache pending' }
    if (chain === 'solana' && envPresent('HELIUS_API_KEY')) return { status: 'limited', provider: 'helius', caveat: 'transfer activity cache pending' }
    return { status: 'unavailable', provider: null, caveat: 'no transfer provider mapped' }
  }

  if (cap === 'defi') {
    if (c1.defiChains.has(chain)) return { status: 'live', provider: chain === 'solana' ? 'kamino' : 'defillama', caveat: null }
    if (SOLANA_DEFI.has(chain)) return { status: 'limited', provider: 'kamino', caveat: 'DeFi cache pending' }
    if (DEFILLAMA_DEFI.has(chain)) return { status: 'limited', provider: 'defillama', caveat: 'DeFi cache pending' }
    return { status: 'unavailable', provider: null, caveat: 'no defi provider mapped' }
  }

  if (cap === 'execution') {
    if (SOLANA_EXEC.has(chain) && envPresent('DFLOW_API_KEY')) return { status: 'live', provider: 'dflow', caveat: null }
    if (SOLANA_EXEC.has(chain)) return { status: 'unavailable', provider: 'dflow', caveat: 'DFLOW_API_KEY missing' }
    return { status: 'unavailable', provider: null, caveat: 'no execution provider mapped' }
  }

  if (cap === 'liquidity') {
    if (c1.dexMarketChains.has(chain)) return { status: 'live', provider: 'dexscreener', caveat: null }
    if (c1.dexOhlcvChains.has(chain)) return { status: 'limited', provider: 'geckoterminal', caveat: 'OHLCV snapshot cache live; pair liquidity cache pending' }
    if (providers?.dexscreener || providers?.geckoterminal) return { status: 'limited', provider: providers.dexscreener ? 'dexscreener' : 'geckoterminal', caveat: 'DEX snapshot cache pending' }
    return { status: 'unavailable', provider: null, caveat: 'no DEX provider mapped' }
  }

  if (cap === 'microstructure') {
    if (c1.cexDepthRows) return { status: 'live', provider: 'exchange-market', caveat: null }
    return { status: 'limited', provider: 'exchange-market', caveat: 'CEX depth cache pending' }
  }

  if (cap === 'macro') {
    if (c1.macroRows) return { status: 'live', provider: 'market-assets', caveat: null }
    return { status: 'limited', provider: 'market-assets', caveat: 'macro snapshot cache pending' }
  }

  if (cap === 'categories') {
    if (c1.categoryRows) return { status: 'live', provider: 'coingecko', caveat: null }
    return { status: 'limited', provider: 'coingecko', caveat: 'category snapshot cache pending' }
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

    const c1 = await loadC1CoverageState(admin)
    const rows: any[] = []
    const now = new Date().toISOString()
    for (const chainDef of CHAINS) {
      for (const capability of COVERAGE_CAPS) {
        const coverage = coverageFor(chainDef.id, capability, c1)
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
