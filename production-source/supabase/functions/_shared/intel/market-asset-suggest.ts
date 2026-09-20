// Investor Intel — catalogue suggestions for the Markets search box and for the
// bare `/intel/markets/<input>` address.
//
// One question: "what shared-catalogue assets does this typed text name?". The
// answer is read from `market_assets` and nothing else, so it costs no provider
// call and no credit and a free member may ask it (the caller gates the op on
// the `market_boards` surface, exactly like the list read).
//
// Identity detection is NOT re-invented here: a pasted contract is classified by
// the same pure `detectIdentifier()` the universal resolver uses, and the
// catalogue is searched with the same `marketPlatformSlugs()` platform keys that
// the resolver's catalogue step uses. What this module does NOT do is walk the
// resolver's provider ladder — that ladder spends per-member credit, which a
// keystroke must never do. An address the catalogue does not carry is returned
// as a plain contract route, so the asset page's existing contract path (and its
// existing gates) decides what to spend when the reader actually opens it.

import { detectIdentifier } from './asset-identifier.ts'
import { marketPlatformSlugs } from './market-read-quality.ts'
import { getChain } from '../chains.ts'

export const SUGGEST_MIN_LENGTH = 2
export const SUGGEST_MAX_LENGTH = 100
export const SUGGEST_DEFAULT_LIMIT = 8
export const SUGGEST_MAX_LIMIT = 20
/** Rows read per catalogue probe before ranking. Bounded so a keystroke reads a
 *  page, never the catalogue. */
const PROBE_LIMIT = 25

/** How the typed text matched. Reported verbatim to the reader; the ORDER rows
 *  are offered in is the tier below, which is not the same thing. */
export const SUGGEST_MATCH_ORDER = [
  'contract', 'symbol_exact', 'name_exact', 'symbol_prefix', 'name_prefix', 'name_contains',
] as const
export type SuggestMatch = typeof SUGGEST_MATCH_ORDER[number]
/** The matches that name ONE asset rather than merely starting like it. A single
 *  surviving asset in the strongest of these opens directly. */
export const SUGGEST_EXACT_MATCHES: SuggestMatch[] = ['contract', 'symbol_exact', 'name_exact']

/**
 * The tier a match is offered in. Matching the typed text EXACTLY is one tier
 * whether the text was the ticker or the project name: ranking every ticker
 * match above every name match put two meme tokens called BITCOIN above Bitcoin
 * for the query "bitcoin", which is the opposite of what the reader asked for.
 * Inside the tier, market cap decides — and Bitcoin is $1.5T.
 *
 * A pasted contract stays above both: it is an address, not a word, so there is
 * nothing to weigh it against. Prefix and contains stay below, each in their own
 * tier, because starting like the text is weaker evidence than being it.
 */
export function suggestTier(match: SuggestMatch): number {
  if (match === 'contract') return 0
  if (match === 'symbol_exact' || match === 'name_exact') return 1
  if (match === 'symbol_prefix') return 2
  return match === 'name_prefix' ? 3 : 4
}

export interface SuggestRow {
  sourceProvider: string
  providerId: string
  symbol: string | null
  displayName: string | null
  normalizedSymbol: string | null
  chain: string | null
  marketCap: number | null
  rank: number | null
  imageUrl: string | null
  match: SuggestMatch
  /** Other catalogues carrying the same asset, collapsed into this row. */
  alsoIn: string[]
  href: string
}

export interface SuggestResult {
  q: string
  limit: number
  matches: SuggestRow[]
  error: 'invalid_query' | 'catalogue_unavailable' | null
}

const COLUMNS = 'source_provider,provider_id,symbol,normalized_symbol,name,primary_chain,market_cap,market_cap_rank,image_url,cached_image_url,platforms,in_current_catalog'

/** PostgREST filter values carry their own punctuation. Anything that would end
 *  a value or open a quoted one is dropped before the query is built, so the
 *  typed text can never change the shape of the filter. */
function sanitize(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : ''
  let out = ''
  for (const ch of value.trim().slice(0, SUGGEST_MAX_LENGTH)) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 32 || code === 127) continue
    if ('",()\\`'.includes(ch)) continue
    out += ch
  }
  return out.trim()
}

/** LIKE wildcards in the typed text are literal characters, not operators. */
const likePattern = (value: string): string => value.replace(/[%_]/g, (m) => `\\${m}`)

const num = (v: unknown): number | null => {
  const n = Number(v)
  return v == null || v === '' || !Number.isFinite(n) ? null : n
}

export function suggestHref(sourceProvider: string, providerId: string, symbol: string | null): string {
  const label = symbol && symbol.trim() ? symbol.trim() : providerId
  return `/intel/markets/${encodeURIComponent(label)}?${new URLSearchParams({ provider: sourceProvider, id: providerId })}`
}

/** `<chain>:<address>` when the prefix names a chain we carry, else null. */
export function splitChainPrefix(value: string): { chain: string; address: string } | null {
  const at = value.indexOf(':')
  if (at <= 0 || at === value.length - 1) return null
  const chain = value.slice(0, at).toLowerCase()
  if (!getChain(chain)) return null
  return { chain, address: value.slice(at + 1) }
}

/** The chain-bound readings of a pasted identifier, using the resolver's own
 *  pure detection. A bare EVM address reads as every EVM chain, so the caller
 *  only offers an uncatalogued contract route when exactly one reading stands. */
export function contractReadings(query: string): { chain: string; address: string }[] {
  const prefixed = splitChainPrefix(query)
  const detection = prefixed
    ? detectIdentifier(prefixed.address, { chainHint: prefixed.chain })
    : detectIdentifier(query)
  if (detection.invalid) return []
  return detection.candidates
    .filter((c) => !!c.chain && !!c.address)
    .map((c) => ({ chain: c.chain as string, address: c.address }))
    .slice(0, 24)
}

// deno-lint-ignore no-explicit-any
async function probe(admin: any, build: (query: any) => any): Promise<Record<string, unknown>[] | null> {
  try {
    const { data, error } = await build(admin.from('market_assets').select(COLUMNS))
    if (error) return null
    return Array.isArray(data) ? data as Record<string, unknown>[] : []
  } catch {
    return null
  }
}

function classify(row: Record<string, unknown>, lowered: string, upper: string): SuggestMatch | null {
  const symbol = String(row.symbol || '').toLowerCase()
  const normalized = String(row.normalized_symbol || '').toUpperCase()
  const name = String(row.name || '').toLowerCase()
  if (normalized === upper || symbol === lowered) return 'symbol_exact'
  if (name === lowered) return 'name_exact'
  if (symbol.startsWith(lowered)) return 'symbol_prefix'
  if (name.startsWith(lowered)) return 'name_prefix'
  if (name.includes(lowered)) return 'name_contains'
  return null
}

/** CoinMarketCap's current catalogue is the one the screen prefers, so it is the
 *  row kept when two catalogues carry the same asset. */
function catalogueRank(row: Record<string, unknown>): number {
  if (row.source_provider !== 'coinmarketcap') return 2
  return row.in_current_catalog === false ? 1 : 0
}

function toRow(row: Record<string, unknown>, match: SuggestMatch): SuggestRow {
  const sourceProvider = String(row.source_provider || '')
  const providerId = String(row.provider_id ?? '')
  const symbol = row.symbol ? String(row.symbol) : null
  return {
    sourceProvider,
    providerId,
    symbol,
    displayName: row.name ? String(row.name) : null,
    normalizedSymbol: row.normalized_symbol ? String(row.normalized_symbol) : null,
    chain: row.primary_chain ? String(row.primary_chain) : null,
    marketCap: num(row.market_cap),
    rank: num(row.market_cap_rank),
    imageUrl: (row.cached_image_url ? String(row.cached_image_url) : null) || (row.image_url ? String(row.image_url) : null),
    match,
    alsoIn: [],
    href: suggestHref(sourceProvider, providerId, symbol),
  }
}

/**
 * Ranked catalogue suggestions for typed text.
 *
 * Reads at most four bounded pages of `market_assets` and ranks them in memory:
 * contract, then symbol-exact, name-exact, symbol-prefix, name-prefix and
 * name-contains, each by market cap. The same asset carried by two catalogues
 * collapses to one row (CoinMarketCap kept, the other named in `alsoIn`), so a
 * ticker that names one asset really does return one suggestion.
 */
// deno-lint-ignore no-explicit-any
export async function suggestMarketAssets(admin: any, rawQuery: unknown, rawLimit?: unknown): Promise<SuggestResult> {
  const q = sanitize(rawQuery)
  const limitValue = Number(rawLimit)
  const limit = Number.isFinite(limitValue) && limitValue >= 1
    ? Math.min(SUGGEST_MAX_LIMIT, Math.trunc(limitValue))
    : SUGGEST_DEFAULT_LIMIT
  if (q.length < SUGGEST_MIN_LENGTH) return { q, limit, matches: [], error: 'invalid_query' }

  const lowered = q.toLowerCase()
  const upper = q.toUpperCase().replace(/^\$/, '')
  const pattern = likePattern(q)

  // Contract clauses use the SAME platform keys the resolver's catalogue step
  // uses, so a pasted address finds the catalogue row it would have found there.
  const readings = contractReadings(q)
  const clauses: string[] = []
  for (const reading of readings) {
    for (const slug of marketPlatformSlugs(reading.chain)) {
      for (const variant of [...new Set([reading.address, reading.address.toLowerCase()])]) {
        if (clauses.length >= 80) break
        clauses.push(`platforms->>${slug}.eq.${variant}`)
      }
    }
  }

  const [exactSymbol, symbolPrefix, nameMatch, contract] = await Promise.all([
    probe(admin, (query) => query.eq('normalized_symbol', upper).order('market_cap', { ascending: false, nullsFirst: false }).limit(PROBE_LIMIT)),
    probe(admin, (query) => query.ilike('symbol', `${pattern}%`).order('market_cap', { ascending: false, nullsFirst: false }).limit(PROBE_LIMIT)),
    probe(admin, (query) => query.ilike('name', `%${pattern}%`).order('market_cap', { ascending: false, nullsFirst: false }).limit(PROBE_LIMIT)),
    clauses.length ? probe(admin, (query) => query.or(clauses.join(',')).limit(8)) : Promise.resolve([]),
  ])
  // Every probe that was attempted failed: the catalogue could not be read at
  // all, which is reported rather than answered as "nothing matches".
  if ([exactSymbol, symbolPrefix, nameMatch].every((rows) => rows === null)) {
    return { q, limit, matches: [], error: 'catalogue_unavailable' }
  }

  const best = new Map<string, { row: Record<string, unknown>; match: SuggestMatch; providers: Set<string> }>()
  const consider = (row: Record<string, unknown>, forced?: SuggestMatch) => {
    const sourceProvider = String(row.source_provider || '')
    const providerId = String(row.provider_id ?? '')
    if (!sourceProvider || !providerId) return
    const match = forced || classify(row, lowered, upper)
    if (!match) return
    // Two catalogue rows for one asset are one asset. The key is the identity
    // the reader sees (ticker + project name), never the provider's own id.
    const key = `${String(row.normalized_symbol || row.symbol || '').toUpperCase()}|${String(row.name || '').toLowerCase()}`
    const existing = best.get(key)
    if (!existing) {
      best.set(key, { row, match, providers: new Set([sourceProvider]) })
      return
    }
    existing.providers.add(sourceProvider)
    const stronger = SUGGEST_MATCH_ORDER.indexOf(match) < SUGGEST_MATCH_ORDER.indexOf(existing.match)
    if (stronger) existing.match = match
    const better = catalogueRank(row) - catalogueRank(existing.row) ||
      (num(existing.row.market_cap) ?? -Infinity) - (num(row.market_cap) ?? -Infinity)
    if (better < 0) existing.row = row
  }

  for (const row of contract || []) consider(row, 'contract')
  for (const row of exactSymbol || []) consider(row)
  for (const row of symbolPrefix || []) consider(row)
  for (const row of nameMatch || []) consider(row)

  const matches = [...best.values()]
    .map(({ row, match, providers }) => {
      const suggestion = toRow(row, match)
      suggestion.alsoIn = [...providers].filter((p) => p !== suggestion.sourceProvider).sort()
      return suggestion
    })
    .sort((a, b) =>
      suggestTier(a.match) - suggestTier(b.match) ||
      (b.marketCap ?? -Infinity) - (a.marketCap ?? -Infinity) ||
      (a.sourceProvider === 'coinmarketcap' ? 0 : 1) - (b.sourceProvider === 'coinmarketcap' ? 0 : 1) ||
      a.providerId.localeCompare(b.providerId))

  // An address no catalogue carries still has a route. It is offered only when
  // exactly one chain can be read from it, so a bare EVM address never becomes
  // twenty guesses.
  if (!matches.length && readings.length === 1) {
    const { chain, address } = readings[0]
    const providerId = `${chain}:${address}`
    matches.push({
      sourceProvider: 'contract', providerId, symbol: null, displayName: null, normalizedSymbol: null,
      chain, marketCap: null, rank: null, imageUrl: null, match: 'contract', alsoIn: [],
      href: `/intel/markets/${encodeURIComponent(address)}?${new URLSearchParams({ provider: 'contract', id: providerId })}`,
    })
  }

  return { q, limit, matches: matches.slice(0, limit), error: null }
}
