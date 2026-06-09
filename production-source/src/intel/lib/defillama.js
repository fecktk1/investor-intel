// Investor Intel — DeFiLlama browser fetchers (free, no key, CORS-open:
// yields.llama.fi sends `access-control-allow-origin: *`). Powers the multichain
// Vault Explorer + Lending Markets for every NON-Solana chain. Solana stays on
// Kamino (richer + native). All APY/LTV values are normalized to a FRACTION
// (0.12 = 12%) to match the Kamino + snapshot convention used across the DeFi UI.

const POOLS_URL = 'https://yields.llama.fi/pools'
const LENDBORROW_URL = 'https://yields.llama.fi/lendBorrow'

// our chain slug → DeFiLlama display name (DeFiLlama uses title case; BNB = "BSC").
export const DEFILLAMA_CHAINS = {
  solana: 'Solana', ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum',
  bnb: 'BSC', polygon: 'Polygon', avalanche: 'Avalanche', sui: 'Sui',
  sei: 'Sei', injective: 'Injective', near: 'Near', tron: 'Tron', ton: 'Ton',
}

const TTL = 120000 // 2 min — the pools list is large; cache aggressively
let _poolsCache = { data: null, ts: 0 }
let _lbCache = { data: null, ts: 0 }
const pct = (v) => (v == null ? null : Number(v) / 100) // percent → fraction

async function allPools() {
  if (_poolsCache.data && Date.now() - _poolsCache.ts < TTL) return _poolsCache.data
  const res = await fetch(POOLS_URL)
  if (!res.ok) throw new Error(`defillama pools ${res.status}`)
  const body = await res.json()
  const pools = Array.isArray(body) ? body : (body?.data || [])
  _poolsCache = { data: pools, ts: Date.now() }
  return pools
}

async function allLendBorrow() {
  if (_lbCache.data && Date.now() - _lbCache.ts < TTL) return _lbCache.data
  try {
    const res = await fetch(LENDBORROW_URL)
    if (!res.ok) return []
    const body = await res.json()
    const arr = Array.isArray(body) ? body : (body?.data || [])
    _lbCache = { data: arr, ts: Date.now() }
    return arr
  } catch { return [] }
}

// Classify a DeFiLlama pool into our product types: single-asset vs LP pair.
function classify(p) {
  return p.exposure === 'single' ? 'single' : 'lp'
}

// Vault/pool rows for one chain, normalized to the shared explorer row shape:
//   { key, address, name, productType, tvl_usd, apy, apyBase, apyReward,
//     protocol, chain, tokenA, tokenB, stable, url }
// `address` is the first underlying token (a real on-chain address that the
// entity resolver + defiLlamaForPool can deep-dive), falling back to the UUID.
export async function fetchLlamaPools(chainSlug) {
  const name = DEFILLAMA_CHAINS[chainSlug]
  if (!name) return []
  const pools = await allPools()
  return pools
    .filter((p) => p.chain === name && Number(p.tvlUsd || 0) > 0)
    .map((p) => {
      const sym = p.symbol || ''
      return {
        key: p.pool,
        poolId: p.pool,
        address: (p.underlyingTokens && p.underlyingTokens[0]) || p.pool,
        name: sym || p.pool,
        productType: classify(p),
        tvl_usd: Number(p.tvlUsd || 0),
        apy: pct(p.apy),
        apyBase: pct(p.apyBase),
        apyReward: pct(p.apyReward),
        apyMean30d: pct(p.apyMean30d),
        il_7d: pct(p.il7d),
        prediction: p.predictions ? { class: p.predictions.predictedClass, prob: p.predictions.predictedProbability } : null,
        protocol: p.project || null,
        chain: chainSlug,
        tokenA: sym.split('-')[0] || null,
        tokenB: sym.split('-')[1] || null,
        stable: !!p.stablecoin,
        url: `https://defillama.com/yields/pool/${p.pool}`,
      }
    })
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, 250)
}

// Full daily history for one pool (by DeFiLlama pool UUID) — powers the rich
// TVL/APY + base/reward charts in the pool detail panel. ~90d–4y of points.
export async function fetchLlamaPoolChart(poolId) {
  try {
    const res = await fetch(`https://yields.llama.fi/chart/${poolId}`)
    if (!res.ok) return []
    const body = await res.json()
    const data = Array.isArray(body) ? body : (body?.data || [])
    return data.map((p) => ({
      snapshot_at: p.timestamp,
      tvl_usd: p.tvlUsd ?? null,
      apy: pct(p.apy),
      apyBase: pct(p.apyBase),
      apyReward: pct(p.apyReward),
      il7d: pct(p.il7d),
    }))
  } catch { return [] }
}

// Lending-market rows for one chain — join /pools (supply APY, TVL, project)
// with /lendBorrow (borrow APY, LTV, borrowed) by the shared DeFiLlama pool id.
//   { key, address, symbol, market, protocol, chain, supplyApy, borrowApy,
//     tvl_usd, totalBorrowUsd, utilization, ltv }
export async function fetchLlamaLending(chainSlug) {
  const name = DEFILLAMA_CHAINS[chainSlug]
  if (!name) return []
  const [pools, lb] = await Promise.all([allPools(), allLendBorrow()])
  const lbByPool = new Map(lb.map((x) => [x.pool, x]))
  return pools
    .filter((p) => p.chain === name && lbByPool.has(p.pool) && Number(p.tvlUsd || 0) > 0)
    .map((p) => {
      const b = lbByPool.get(p.pool)
      // Gross supplied + borrowed come from /lendBorrow (pools.tvlUsd is NET
      // liquidity, which would push utilization above 100%).
      const supplied = Number(b.totalSupplyUsd || p.tvlUsd || 0)
      const borrowUsd = Number(b.totalBorrowUsd || 0)
      return {
        key: p.pool,
        address: (p.underlyingTokens && p.underlyingTokens[0]) || p.pool,
        symbol: p.symbol || '?',
        market: p.project || '—',
        protocol: p.project || null,
        chain: chainSlug,
        supplyApy: pct(p.apy),
        borrowApy: pct(b.apyBaseBorrow),
        tvl_usd: supplied,
        totalBorrowUsd: borrowUsd,
        utilization: supplied > 0 ? Math.min(borrowUsd / supplied, 1) : 0,
        ltv: b.ltv != null ? Number(b.ltv) : null, // already a fraction (0.67)
      }
    })
    // Keep the biggest markets by TVL (credible first); the UI re-sorts on click.
    // Sorting by APY here would surface micro-TVL degen outliers instead.
    .sort((a, b) => (b.tvl_usd || 0) - (a.tvl_usd || 0))
    .slice(0, 250)
}
