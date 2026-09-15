import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { canonicalAddress, detectIdentifier, EVM_CHAIN_IDS } from './asset-identifier.ts'

const kinds = (value: string, chainHint?: string) => detectIdentifier(value, { chainHint })

// Two real-looking samples per namespace. Nothing here contacts a provider.
const SAMPLES: Record<string, string[]> = {
  evm: ['0xdAC17F958D2ee523a2206206994597C13D831ec7', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
  solana: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'So11111111111111111111111111111111111111112'],
  move_coin_type: ['0x2::sui::SUI', '0x1::aptos_coin::AptosCoin'],
  ton: ['EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', '0:0000000000000000000000000000000000000000000000000000000000000000'],
  tron: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'TF17BgPaZYbz8oxbjhriubPDsA7ArKoLX3'],
  xrpl: ['USD.rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq'],
  stellar: ['USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'],
  near: ['wrap.near', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'],
  cardano: ['29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83415e5c0d6', '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83415e5c0d6.7370616365627564'],
  cosmos_denom: ['ibc/C4CFF46FD6DE35CA4CF4CE031E643C8FDC9BA4B99AE598E9B0ED98FE3A2319F9', 'peggy0x6B175474E89094C44Da98b954EedeAC495271d0F'],
  hyperliquid: ['@107', 'HYPE/USDC'],
  cmc_id: ['cmc:1027', '1027'],
}

Deno.test('every namespace detects both of its real-looking samples', () => {
  for (const [kind, samples] of Object.entries(SAMPLES)) {
    for (const sample of samples) {
      const result = kinds(sample)
      eq(result.invalid, undefined, `${kind}: ${sample} → ${result.invalid}`)
      eq(result.kind, kind, `${kind}: ${sample} detected as ${result.kind}`)
      eq(result.candidates.length > 0, true, `${kind}: ${sample} produced no candidate`)
    }
  }
})

Deno.test('an EVM address is a candidate on every eip155 chain until a hint narrows it', () => {
  const open = kinds('0xdAC17F958D2ee523a2206206994597C13D831ec7')
  eq(open.candidates.length, EVM_CHAIN_IDS.length)
  eq(open.candidates.every((c) => c.namespace === 'eip155'), true)
  eq(open.candidates[0].confidence < 1, true)

  const narrowed = kinds('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'base')
  eq(narrowed.candidates.length, 1)
  eq(narrowed.candidates[0].chain, 'base')
  eq(narrowed.candidates[0].confidence, 1)
})

Deno.test('a Move coin type belongs to Sui and Aptos until the hint picks one', () => {
  eq(kinds('0x2::sui::SUI').candidates.map((c) => c.chain), ['sui', 'aptos'])
  eq(kinds('0x2::sui::SUI', 'aptos').candidates.map((c) => c.chain), ['aptos'])
})

Deno.test('base58 families that overlap keep the specific namespace first', () => {
  const tron = kinds('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
  eq(tron.candidates[0].chain, 'tron')
  eq(tron.candidates.some((c) => c.chain === 'solana'), true)
  eq(tron.candidates[0].confidence > tron.candidates[1].confidence, true)

  const xrpl = kinds('rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq')
  eq(xrpl.candidates[0].chain, 'xrpl')
})

Deno.test('a Solana mint is unambiguous and stays case-preserving', () => {
  const solana = kinds('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  eq(solana.candidates.length, 1)
  eq(solana.candidates[0].chain, 'solana')
  eq(canonicalAddress('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
})

Deno.test('canonicalAddress lowercases EVM only', () => {
  eq(canonicalAddress('eip155', '0xdAC17F958D2ee523a2206206994597C13D831ec7'), '0xdac17f958d2ee523a2206206994597c13d831ec7')
  eq(canonicalAddress('ton', 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'), 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs')
  eq(canonicalAddress('tron', '  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t  '), 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
})

Deno.test('five strings that are not identities are rejected with a reason', () => {
  eq(kinds('').invalid, 'empty_query')
  eq(kinds("' OR 1=1; DROP TABLE market_assets --").invalid, 'unsupported_characters')
  eq(kinds('https://dexscreener.com/base/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913').invalid, 'url_not_an_identity')
  eq(kinds('0x833589fcd6edb6e08f4c7c32d4f71b54bda029').invalid, 'malformed_evm_address')
  eq(kinds('BTC').invalid, 'symbol_not_an_identity')
})

Deno.test('a symbol is never an identity, with or without the dollar sign', () => {
  eq(kinds('ETH').invalid, 'symbol_not_an_identity')
  eq(kinds('$PEPE').invalid, 'symbol_not_an_identity')
  eq(kinds('ETH').candidates.length, 0)
})

Deno.test('a bare URL without a scheme is still rejected', () => {
  eq(kinds('www.coinmarketcap.com').invalid, 'url_not_an_identity')
  eq(kinds('coinmarketcap.com/currencies/bitcoin').invalid, 'unrecognized_identifier')
})

Deno.test('a hint that cannot hold the format is a mismatch, never a silent substitution', () => {
  eq(kinds('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'base').invalid, 'chain_hint_mismatch')
  eq(kinds('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'solana').invalid, 'chain_hint_mismatch')
  eq(kinds('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'not-a-chain').invalid, 'unknown_chain_hint')
})

Deno.test('a Cardano policy id is bound to the Cardano chain, not left chainless', () => {
  for (const sample of SAMPLES.cardano) {
    const result = kinds(sample)
    eq(result.candidates.length, 1)
    eq(result.candidates[0].namespace, 'cardano')
    eq(result.candidates[0].chain, 'cardano')
    eq(result.candidates[0].confidence, 1)
  }
  eq(kinds(SAMPLES.cardano[0], 'cardano').candidates[0].chain, 'cardano')
  eq(kinds(SAMPLES.cardano[0], 'ethereum').invalid, 'chain_hint_mismatch')
})

Deno.test('CoinMarketCap ids carry no chain', () => {
  const prefixed = kinds('cmc:1027')
  eq(prefixed.candidates[0].namespace, 'cmc')
  eq(prefixed.candidates[0].chain, null)
  eq(prefixed.candidates[0].address, '1027')
  eq(kinds('1027').candidates[0].address, '1027')
})

Deno.test('an over-long paste is rejected before any format work', () => {
  eq(detectIdentifier('0x' + 'a'.repeat(400)).invalid, 'too_long')
})
