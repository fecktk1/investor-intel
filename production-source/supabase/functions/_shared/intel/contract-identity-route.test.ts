// The two production defects of 2026-09-21, held down by tests.
//
// DEFECT A. `/intel/markets/<solana mint>` in a Pro workspace showed "The asset
// read could not be completed. Retry" for both of the owner's own tokens. The
// edge logs show the shape exactly: one `suggest` 200, then a `detail` that
// answered 503 in 0.9 ms having issued no database read at all
// (trace 6144432d-22f1-4d8a-91c7-d2ec5ebf76eb, 2026-09-21T16:55:44Z). 0.9 ms is
// `resolveMarketAsset` refusing before it reads anything, and it refused because
// the catalogue row for that mint is a row `intel_upsert_on_demand_asset` wrote
// under `source_provider = 'on_demand'`. The suggest read linked it under that
// name; the market read accepts 'contract', 'coingecko' and 'coinmarketcap' and
// nothing else, so it answered `invalid_provider` → `identity_unavailable` 503.
//
// DEFECT B. FORGE's logo fell back to a "FOR" monogram while every other row
// showed its image. Its stored URL was
// ".../public-assets/market-logos/memecoin/solana/2wqw81f24mx" — our own mirror
// URL cut at exactly 120 characters by the resolver's generic `text()` helper.
// The object in the bucket is the full 157-character name, so the cut URL 404s.

import { assert, assertEquals as eq } from 'jsr:@std/assert@1'
import { resolveMarketAsset } from './market-asset-resolver.ts'
import { suggestHref, suggestMarketAssets, evmChainChoice, CONTRACT_SUGGESTION_MAX } from './market-asset-suggest.ts'
import { contractIdentityOf, contractRouteHref, isContractIdentityProvider } from './contract-identity-route.ts'
import { normalizeLogoUrl, MAX_LOGO_URL_LENGTH } from './asset-resolver.ts'

const FORGE = '2wqw81F24mxBsQTAvKFAufzmzPZVnq29CJqftekforgE'
const DASH = '8RWFpyz9VW7Wyv626v49f8ybzREcYhYDC19vaWedpump'
const LINK = '0x514910771af9ca656af840dff83e8264ecf986ca'
const MIRROR = `https://andrimdaxlxcqgqdqrbz.supabase.co/storage/v1/object/public/public-assets/market-logos/memecoin/solana/${FORGE.toLowerCase()}.jpg`

// ── The naming rule ──────────────────────────────────────────────────────────

Deno.test('a contract identity is a contract under either of its two provider names', () => {
  for (const provider of ['contract', 'on_demand']) {
    assert(isContractIdentityProvider(provider), provider)
    eq(contractIdentityOf(provider, `solana:${FORGE}`), { chain: 'solana', address: FORGE })
  }
  for (const provider of ['coinmarketcap', 'coingecko', '', null, undefined]) {
    eq(isContractIdentityProvider(provider), false)
    eq(contractIdentityOf(provider, `solana:${FORGE}`), null)
  }
  // The mint's trailing capital E is part of the address and survives.
  eq(contractIdentityOf('on_demand', `solana:${FORGE}`)?.address.endsWith('forgE'), true)
  for (const bad of ['', 'solana:', `SOLANA:${FORGE}`, FORGE, `notachain:${FORGE}`]) {
    eq(contractIdentityOf('on_demand', bad), null, bad)
  }
})

Deno.test('the contract route labels the path and identifies in the query', () => {
  eq(contractRouteHref('solana', FORGE, 'FORGE'), `/intel/markets/FORGE?provider=contract&id=solana%3A${FORGE}`)
  eq(contractRouteHref('solana', FORGE, null), `/intel/markets/${FORGE}?provider=contract&id=solana%3A${FORGE}`)
  eq(contractRouteHref('solana', FORGE, '  '), `/intel/markets/${FORGE}?provider=contract&id=solana%3A${FORGE}`)
})

// ── Defect A: the market read ────────────────────────────────────────────────

function catalogueThatMustNotBeRead() {
  return { from: () => { throw new Error('the catalogue was read for a contract identity') } }
}

Deno.test('an on-demand indexed contract resolves on-chain instead of answering 503', async () => {
  // This is the exact request the recorder made. Before the fix it returned
  // { error: 'invalid_provider' } with no read at all, which marketDetail turns
  // into a 503 and the page shows as "The asset read could not be completed".
  const built = { source_provider: 'contract', provider_id: `solana:${FORGE}`, symbol: 'FORGE' }
  const seen: unknown[][] = []
  // deno-lint-ignore no-explicit-any
  const build = (...args: any[]) => { seen.push(args.slice(1, 3)); return Promise.resolve(built as any) }

  for (const provider of ['contract', 'on_demand']) {
    seen.length = 0
    const result = await resolveMarketAsset(catalogueThatMustNotBeRead(), 'FORGE', provider, `solana:${FORGE}`, undefined, build)
    eq(result, { data: built, error: null, ambiguous: false }, provider)
    eq(seen, [['solana', FORGE]], provider)
  }
  // A malformed id is still a refusal, and still never reaches a provider.
  eq((await resolveMarketAsset(catalogueThatMustNotBeRead(), 'FORGE', 'on_demand', 'nochain', undefined, build)).error, 'invalid_provider')
  // An unknown provider is still an unknown provider.
  eq((await resolveMarketAsset(catalogueThatMustNotBeRead(), 'FORGE', 'dexscreener', `solana:${FORGE}`, undefined, build)).error, 'invalid_provider')
})

// ── Defect A: every entry point converges on the one working route ───────────

Deno.test('a catalogue row keeps its provider identity; an on-demand row opens as a contract', () => {
  eq(suggestHref('coinmarketcap', '1', 'BTC'), '/intel/markets/BTC?provider=coinmarketcap&id=1')
  eq(suggestHref('coingecko', 'solana', 'SOL'), '/intel/markets/SOL?provider=coingecko&id=solana')
  eq(suggestHref('on_demand', `solana:${FORGE}`, 'FORGE'), `/intel/markets/FORGE?provider=contract&id=solana%3A${FORGE}`)
  eq(suggestHref('contract', `solana:${DASH}`, 'DASH'), `/intel/markets/DASH?provider=contract&id=solana%3A${DASH}`)
  // An on-demand row whose provider_id is not a contract keeps its own name
  // rather than being rewritten into a route that names no chain.
  eq(suggestHref('on_demand', '12345', 'ODD'), '/intel/markets/ODD?provider=on_demand&id=12345')
})

Deno.test('a bare EVM address is narrowed to what we have seen, and to Ethereum otherwise', () => {
  const readings = [
    { chain: 'ethereum', address: LINK }, { chain: 'base', address: LINK },
    { chain: 'arbitrum', address: LINK }, { chain: 'polygon', address: LINK },
  ]
  eq(evmChainChoice(readings, []), [{ chain: 'ethereum', address: LINK }])
  eq(evmChainChoice(readings, ['base', 'polygon']), [{ chain: 'base', address: LINK }, { chain: 'polygon', address: LINK }])
  eq(evmChainChoice(readings, ['BASE']), [{ chain: 'base', address: LINK }])
  eq(evmChainChoice(readings, ['ethereum', 'base', 'arbitrum', 'polygon']).length, CONTRACT_SUGGESTION_MAX)
  // A chain we have never heard of does not add a guess.
  eq(evmChainChoice(readings, ['solana']), [{ chain: 'ethereum', address: LINK }])
  // One reading is the answer, whatever we have observed.
  eq(evmChainChoice([{ chain: 'solana', address: FORGE }], []), [{ chain: 'solana', address: FORGE }])
  eq(evmChainChoice([], []), [])
})

// One `market_assets` stand-in carrying the on-demand row production actually
// holds for FORGE, plus the two side tables `observedChains` reads.
function catalogue(rows: Record<string, unknown>[], observed: Record<string, string[]> = {}) {
  const table = (name: string) => {
    let out: Record<string, unknown>[] = name === 'market_assets'
      ? [...rows]
      : (observed[name] || []).map((chain) => ({ chain }))
    // deno-lint-ignore no-explicit-any
    const q: any = {}
    q.select = () => q
    q.eq = (column: string, value: unknown) => { out = out.filter((r) => String(r[column] ?? '') === String(value)); return q }
    q.ilike = (column: string, pattern: string) => {
      const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')
      out = out.filter((r) => new RegExp(`^${body}$`, 'i').test(String(r[column] ?? '')))
      return q
    }
    q.in = () => q
    q.or = (clause: string) => {
      const wanted = clause.split(',').map((part) => {
        const [lhs, value] = part.split('.eq.')
        return { slug: lhs.replace('platforms->>', ''), value }
      })
      out = out.filter((r) => wanted.some((w) => String((r.platforms as Record<string, unknown>)?.[w.slug] ?? '') === String(w.value)))
      return q
    }
    q.order = () => q
    q.limit = () => Promise.resolve({ data: out, error: null })
    return q
  }
  return { from: (name: string) => ({ select: () => table(name).select() }) }
}

const ON_DEMAND_FORGE = {
  source_provider: 'on_demand', provider_id: `solana:${FORGE}`, symbol: 'FORGE', normalized_symbol: 'FORGE',
  name: 'TheContentForge', primary_chain: 'solana', market_cap: null, market_cap_rank: null,
  image_url: null, cached_image_url: null, platforms: { solana: FORGE }, in_current_catalog: false,
}

Deno.test('pasting the mint of an on-demand indexed token offers the contract route', async () => {
  const result = await suggestMarketAssets(catalogue([ON_DEMAND_FORGE]), FORGE, 8)
  eq(result.error, null)
  eq(result.matches.length, 1)
  eq(result.matches[0].match, 'contract')
  eq(result.matches[0].displayName, 'TheContentForge')
  eq(result.matches[0].href, `/intel/markets/FORGE?provider=contract&id=solana%3A${FORGE}`)
})

Deno.test('a mint no catalogue carries is offered as the contract page itself', async () => {
  const result = await suggestMarketAssets(catalogue([]), DASH, 8)
  eq(result.error, null)
  eq(result.matches.length, 1)
  eq(result.matches[0], {
    sourceProvider: 'contract', providerId: `solana:${DASH}`, symbol: null, displayName: null,
    normalizedSymbol: null, chain: 'solana', marketCap: null, rank: null, imageUrl: null,
    match: 'contract', alsoIn: [], href: `/intel/markets/${DASH}?provider=contract&id=solana%3A${DASH}`,
  })
})

Deno.test('a bare EVM address the catalogue does not carry offers the chains we have seen it on', async () => {
  const seen = await suggestMarketAssets(catalogue([], { memecoin_latest_tokens: ['base'], dex_pair_snapshots: ['polygon'] }), LINK, 8)
  eq(seen.matches.map((row) => row.chain), ['base', 'polygon'])
  for (const row of seen.matches) eq(row.href, `/intel/markets/${LINK}?provider=contract&id=${row.chain}%3A${LINK}`)

  const unseen = await suggestMarketAssets(catalogue([]), LINK, 8)
  eq(unseen.matches.map((row) => row.chain), ['ethereum'])
})

Deno.test('text that names no asset and no address still offers nothing', async () => {
  const result = await suggestMarketAssets(catalogue([]), 'zzzz', 8)
  eq(result.error, null)
  eq(result.matches, [])
})

// ── Defect B: the logo ───────────────────────────────────────────────────────

Deno.test('a mirrored logo URL is kept whole, never cut to 120 characters', () => {
  // 157 characters. `text()` returned its first 120, which is a different URL.
  eq(MIRROR.length, 157)
  assert(MIRROR.length > 120)
  eq(normalizeLogoUrl(MIRROR), MIRROR)
  eq(normalizeLogoUrl(` ${MIRROR} `), MIRROR)
})

Deno.test('a logo that cannot be kept whole is dropped rather than truncated', () => {
  const tooLong = `https://example.org/${'a'.repeat(MAX_LOGO_URL_LENGTH)}.png`
  eq(normalizeLogoUrl(tooLong), null)
  for (const bad of ['', '   ', 'http://example.org/a.png', 'ipfs://QmHash', 'example.org/a.png', 42, null, undefined]) {
    eq(normalizeLogoUrl(bad), null, String(bad))
  }
})
