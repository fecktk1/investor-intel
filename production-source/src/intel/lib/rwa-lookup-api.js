// The public tokenised asset lookup (Edge Function intel-rwa-lookup).
//
// Members and demo visitors call it the same way: the anon key as the only
// credential and cookies omitted, so the answer is the one shared, public
// answer and no member token ever travels with it. In /intel/demo the demo
// network layer lets exactly this call through, rebuilt from the query alone
// (src/intel/demo/demo-fetch.js, DEMO_LIVE_FUNCTION).

export const RWA_LOOKUP_FUNCTION = 'intel-rwa-lookup'
/** Examples that are in the captured CoinMarketCap RWA catalogue: a stock, a
 * Treasury bill fund, and a commodity. */
export const RWA_LOOKUP_EXAMPLES = [
  { q: 'NVDA', key: 'example_nvda', label: 'Nvidia' },
  { q: 'SGOV', key: 'example_sgov', label: 'a Treasury bill fund' },
  { q: 'GOLD', key: 'example_gold', label: 'gold' },
]
/** Mirrors parseLookupQuery in supabase/functions/_shared/intel/rwa-lookup.ts. */
export const RWA_LOOKUP_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .&'()-]{0,59}$/u

export class RwaLookupError extends Error {
  constructor(code, { status = null, retryAfter = null } = {}) {
    super(code)
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

export function normaliseLookupQuery(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()
}

export async function lookupRwaAsset(query, {
  supabaseUrl = import.meta.env?.VITE_SUPABASE_URL,
  anonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY,
  fetchImpl = (...args) => globalThis.fetch(...args),
  signal,
} = {}) {
  const q = normaliseLookupQuery(query)
  if (!RWA_LOOKUP_PATTERN.test(q)) throw new RwaLookupError('invalid_query')
  const base = String(supabaseUrl || '').replace(/\/+$/, '')
  if (!base) throw new RwaLookupError('lookup_unreachable')
  const headers = { 'Content-Type': 'application/json' }
  if (anonKey) { headers.apikey = anonKey; headers.Authorization = `Bearer ${anonKey}` }
  let res
  try {
    res = await fetchImpl(`${base}/functions/v1/${RWA_LOOKUP_FUNCTION}`, { method: 'POST', headers, body: JSON.stringify({ q }), credentials: 'omit', signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new RwaLookupError('lookup_unreachable')
  }
  let body = null
  try { body = await res.json() } catch { body = null }
  if (!res.ok || !body || typeof body !== 'object') {
    const retry = Number(res.headers?.get?.('Retry-After') ?? body?.retryAfter)
    throw new RwaLookupError(body?.reason || body?.error || 'lookup_unavailable', { status: res.status, retryAfter: Number.isFinite(retry) ? retry : null })
  }
  return body
}
