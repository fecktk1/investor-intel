// Investor adapter — canonical asset identity (SINGLE source of truth).
//
// Symbols are display labels, not durable keys. This module centralizes symbol →
// canonical key resolution + the display-symbol fallback, so the signal producer,
// signal_feed_v2 callers, portfolio exposure, alerts, thesis drift, markets derived
// views, and Explain This routing never duplicate symbol→canonical logic.
//
// Canonical key forms (always lowercased):
//   cg:{coingecko_id}    — preferred for global assets (unique per asset, cross-chain safe)
//   sym:{NORMALIZED}     — fallback when no coingecko id is known
//   native:{chain}       — a chain's native asset / a chain subject
//
// Resolution is loaded once from market_assets (global top-N). Adapters may import
// crypto/Supabase; core utilities may not.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = any

export interface AssetResolver {
  toCanonicalKey: (symbolOrKey: string | null | undefined, chain?: string | null) => string | null
  displaySymbolFor: (key: string | null | undefined) => string | null
  keyForChain: (chainId: string | null | undefined) => string | null
}

const normSym = (s: unknown): string => String(s || '').trim().replace(/^\$/, '').toUpperCase()

/** Already-canonical keys pass through unchanged. */
function isCanonical(s: string): boolean {
  return /^(cg|sym|native):/.test(s)
}

export async function buildAssetResolver(admin: DB, opts: { limit?: number } = {}): Promise<AssetResolver> {
  const limit = Math.min(Math.max(opts.limit ?? 5000, 100), 8000)
  const bySym = new Map<string, { key: string; symbol: string; mc: number }>()
  const keyToSym = new Map<string, string>()

  try {
    const { data } = await admin
      .from('market_assets')
      .select('source_provider, provider_id, symbol, normalized_symbol, market_cap')
      .order('market_cap', { ascending: false, nullsFirst: false })
      .limit(limit)
    for (const r of (data || [])) {
      const sym = normSym(r.normalized_symbol || r.symbol)
      if (!sym) continue
      const isCg = String(r.source_provider || '').toLowerCase().includes('coingecko') && r.provider_id
      const key = (isCg ? `cg:${r.provider_id}` : `sym:${sym}`).toLowerCase()
      const mc = Number(r.market_cap) || 0
      const cur = bySym.get(sym)
      if (!cur || mc > cur.mc) bySym.set(sym, { key, symbol: r.symbol || sym, mc })
      if (!keyToSym.has(key)) keyToSym.set(key, r.symbol || sym)
    }
  } catch { /* market_assets absent → pure sym: fallback */ }

  const keyForChain = (chainId: string | null | undefined): string | null => {
    const c = String(chainId || '').trim().toLowerCase()
    return c ? `native:${c}` : null
  }

  const toCanonicalKey = (symbolOrKey: string | null | undefined, _chain?: string | null): string | null => {
    const raw = String(symbolOrKey || '').trim()
    if (!raw) return null
    if (isCanonical(raw.toLowerCase())) return raw.toLowerCase()
    const sym = normSym(raw)
    if (!sym) return null
    const hit = bySym.get(sym)
    return hit ? hit.key : `sym:${sym}`.toLowerCase()
  }

  const displaySymbolFor = (key: string | null | undefined): string | null => {
    const k = String(key || '').trim().toLowerCase()
    if (!k) return null
    if (keyToSym.has(k)) return keyToSym.get(k)!
    if (k.startsWith('sym:')) return k.slice(4).toUpperCase()
    if (k.startsWith('native:')) return k.slice(7).toUpperCase()
    return null
  }

  return { toCanonicalKey, displaySymbolFor, keyForChain }
}
