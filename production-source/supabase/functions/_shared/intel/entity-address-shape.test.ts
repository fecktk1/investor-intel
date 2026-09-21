import { assert, assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { looksLikeFamily, refuseAddressShape } from './entity-address-shape.ts'
import { EntityResolveRefusal, normalizeEntity } from '../entity-resolver.ts'

// The production defect: LINK's Ethereum contract pasted while the chain picker
// still said Solana became `solana:mainnet/token:0x5149…`, a row nothing could
// ever match, and the add looked accepted.
const LINK = '0x514910771AF9Ca656af840dff83E8264EcF986CA'
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'

Deno.test('an EVM contract is refused on Solana and the refusal names both sides', () => {
  const refusal = refuseAddressShape('solana', LINK)
  assert(refusal)
  assertEquals(refusal.code, 'entity_address_shape')
  assertEquals(refusal.chain, 'solana')
  assertEquals(refusal.chainLabel, 'Solana')
  assertEquals(refusal.expected, 'base58')
  assertEquals(refusal.looksLike, 'evm')
})

Deno.test('a Solana mint is refused on every EVM chain the picker offers', () => {
  for (const chain of ['ethereum', 'base', 'arbitrum', 'optimism', 'bnb', 'polygon', 'avalanche', 'linea', 'blast']) {
    const refusal = refuseAddressShape(chain, JUP)
    assert(refusal, `${chain} accepted a Solana mint`)
    assertEquals(refusal.expected, 'evm_hex')
    assertEquals(refusal.looksLike, 'solana')
  }
})

Deno.test('the matching chain is accepted, in either case for EVM', () => {
  assertEquals(refuseAddressShape('ethereum', LINK), null)
  assertEquals(refuseAddressShape('ethereum', LINK.toLowerCase()), null)
  assertEquals(refuseAddressShape('solana', JUP), null)
  assertEquals(refuseAddressShape('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), null)
})

Deno.test('an unregistered chain or an empty value is nobody’s refusal to make', () => {
  assertEquals(refuseAddressShape('not-a-chain', LINK), null)
  assertEquals(refuseAddressShape('solana', ''), null)
})

Deno.test('looksLikeFamily names only what it can tell', () => {
  assertEquals(looksLikeFamily(LINK), 'evm')
  assertEquals(looksLikeFamily(JUP), 'solana')
  assertEquals(looksLikeFamily('hello'), null)
})

Deno.test('the resolver refuses the mismatch instead of minting a canonical key', () => {
  const error = assertThrows(() => normalizeEntity({ kind: 'asset', chain: 'solana', value: LINK }), EntityResolveRefusal)
  assertEquals((error as EntityResolveRefusal).details.chain, 'solana')
  assertEquals((error as EntityResolveRefusal).details.looksLike, 'evm')
})

Deno.test('every EVM chain still resolves its own contract, lowercased once', () => {
  const entity = normalizeEntity({ kind: 'asset', chain: 'ethereum', value: LINK })
  assertEquals(entity.canonical_ref_key, 'eip155:1/erc20:0x514910771af9ca656af840dff83e8264ecf986ca')
  assertEquals(entity.contract_address, '0x514910771af9ca656af840dff83e8264ecf986ca')
  const base = normalizeEntity({ kind: 'asset', chain: 'base', value: LINK })
  assertEquals(base.canonical_ref_key, 'eip155:8453/erc20:0x514910771af9ca656af840dff83e8264ecf986ca')
})

Deno.test('a Solana mint keeps its case and a native reference is never shape-checked', () => {
  assertEquals(normalizeEntity({ kind: 'asset', chain: 'solana', value: JUP }).canonical_ref_key, `solana:mainnet/token:${JUP}`)
  assertEquals(normalizeEntity({ kind: 'asset', chain: 'bitcoin', value: 'native:bitcoin' }).canonical_ref_key, 'bip122:mainnet/native:btc')
  assertEquals(normalizeEntity({ kind: 'asset', chain: 'ethereum', value: 'ETH' }).canonical_ref_key, 'eip155:1/native:eth')
})
