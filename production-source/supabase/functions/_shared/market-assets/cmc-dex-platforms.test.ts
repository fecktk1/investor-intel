import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { CMC_DEX_NETWORKS } from './cmc-dex.ts'
import { candidateDexPlatforms, chainForPlatformName } from './cmc-dex-platforms.ts'

// A `/v1/dex/platform/list` page. The four verified rows carry their real ids
// (Ethereum 1, Base 199, Arbitrum 51, Solana 16 — verified 2026-09-12 against
// live token, holder and swap responses). The rest carry the row SHAPE only:
// their ids are placeholders, because the unverified half of the list is
// precisely what has not been read from a live response yet. Nothing in this
// module or its test treats an id as evidence.
const PLATFORMS = [
  { id: 1, n: 'Ethereum', dn: 'Ethereum' },
  { id: 199, n: 'Base', dn: 'Base' },
  { id: 51, n: 'Arbitrum', dn: 'Arbitrum' },
  { id: 16, n: 'Solana', dn: 'Solana' },
  { id: 9001, n: 'BNB Smart Chain (BEP20)', dn: 'BNB Chain' },
  { id: 9002, n: 'Avalanche C-Chain', dn: 'Avalanche' },
  { id: 9003, n: 'OP Mainnet', dn: 'Optimism' },
  { id: 9004, n: 'Polygon PoS', dn: 'Polygon' },
  { id: 9005, n: 'zkSync Era', dn: 'zkSync' },
  { id: 9006, n: 'Cronos', dn: 'Cronos' },
  { id: 9007, n: 'Hedera', dn: 'Hedera' },
  { id: 9008, n: 'Arbitrum Nova', dn: 'Arbitrum Nova' },
]

Deno.test('the verified four are returned unchanged and never appear as candidates', () => {
  const review = candidateDexPlatforms(PLATFORMS)
  eq(review.verified, [...CMC_DEX_NETWORKS])
  eq(review.verified.map((n) => n.platformId), [1, 199, 51, 16])
  eq(review.candidates.some((c) => [1, 199, 51, 16].includes(c.platformId)), false)
  eq(review.unmapped.some((u) => [1, 199, 51, 16].includes(u.platformId)), false)
  // The reviewed constant is copied, not aliased: nothing here can widen it.
  eq(CMC_DEX_NETWORKS.length, 4)
})

Deno.test('platforms whose chain we carry become candidates with their address format', () => {
  const review = candidateDexPlatforms(PLATFORMS)
  eq(review.candidates.map((c) => [c.platformId, c.chain]), [
    [9001, 'bnb'],
    [9002, 'avalanche'],
    [9003, 'optimism'],
    [9004, 'polygon'],
    [9005, 'zksync'],
  ])
  eq(review.candidates.every((c) => c.reason === 'chain_known_platform_unverified'), true)
  eq(review.candidates.every((c) => c.addressFormat === 'evm_hex'), true)
  // The chains proposal 25's unpriced holdings need are all on the worklist.
  for (const chain of ['bnb', 'avalanche', 'optimism']) {
    eq(review.candidates.some((c) => c.chain === chain), true, `${chain} missing from the worklist`)
  }
})

Deno.test('platforms with no chain in the registry are reported, not dropped', () => {
  const review = candidateDexPlatforms(PLATFORMS)
  eq(review.unmapped.map((u) => u.name), ['Cronos', 'Hedera', 'Arbitrum Nova'])
  eq(review.unmapped.every((u) => u.reason === 'no_chain_in_registry'), true)
  // Every row of the page is accounted for exactly once.
  eq(review.candidates.length + review.unmapped.length + 4, PLATFORMS.length)
})

Deno.test('a name is matched whole — a prefix never becomes another chain', () => {
  eq(chainForPlatformName('Arbitrum Nova'), null)
  eq(chainForPlatformName('Arbitrum One'), 'arbitrum')
  eq(chainForPlatformName('BNB Smart Chain (BEP20)'), 'bnb')
  eq(chainForPlatformName('  polygon  pos '), 'polygon')
  eq(chainForPlatformName('Ethereum Classic'), null)
  eq(chainForPlatformName('XRP Ledger'), 'xrpl')
  eq(chainForPlatformName('Cardano'), 'cardano')
  eq(chainForPlatformName(''), null)
  eq(chainForPlatformName(null), null)
})

Deno.test('unreadable and duplicate rows are handled without losing the page', () => {
  const review = candidateDexPlatforms([
    { id: 9001, n: 'BNB Smart Chain', dn: 'BNB Chain' },
    { id: 9001, n: 'BNB Smart Chain', dn: 'BNB Chain' },
    { id: 0, n: 'Broken' },
    { id: 'nope', n: 'Also broken' },
    { n: 'No id at all' },
    { id: 9009 },
    null,
    'not-a-row',
  ])
  eq(review.candidates.map((c) => c.platformId), [9001])
  // Six unreadable rows: two bad ids, one missing id, one missing name, and the
  // two entries that are not objects at all. The duplicate 9001 is collapsed.
  eq(review.unmapped.length, 6)
  eq(review.unmapped.every((u) => u.reason === 'unreadable_row'), true)
})

Deno.test('a payload that is not a list is an empty review, never an exception', () => {
  for (const payload of [null, undefined, {}, 'rows', 42]) {
    const review = candidateDexPlatforms(payload)
    eq(review.candidates, [])
    eq(review.unmapped, [])
    eq(review.verified.length, 4)
  }
})
