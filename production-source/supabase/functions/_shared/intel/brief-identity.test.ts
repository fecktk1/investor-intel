import assert from 'node:assert/strict'
import { briefSubject, briefSignalMatches, briefNativeSymbol } from './brief-identity.ts'
import { assembleBrief } from './brief-assemble.ts'
Deno.test('brief identity preserves contract case and rejects ticker-only matches',()=>{
  const mint='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const row={canonical_ref_key:`solana:mainnet/spl:${mint}`,display_symbol:'SOL'}
  assert.equal(briefSubject(row)?.canonicalKey,`solana:${mint}`)
  assert.equal(briefSubject(row)?.tokenAddress,mint)
  assert.equal(briefSignalMatches(row,{display_symbol:'SOL'}),false)
  assert.equal(briefSignalMatches(row,{related_assets:[`solana:${mint}`]}),true)
  assert.equal(briefSignalMatches(row,{related_assets:[`solana:${mint.toLowerCase()}`]}),false)
  const testnet={canonical_ref_key:`solana:testnet/spl:${mint}`,display_symbol:'SOL'}
  assert.equal(briefSubject(testnet)?.canonicalKey,`solana:testnet/spl:${mint}`)
  assert.equal(briefSubject(testnet)?.tokenAddress,null)
  assert.equal(briefSignalMatches(testnet,{related_assets:[`solana:${mint}`]}),false)
  assert.equal(briefNativeSymbol({canonicalKey:'market:coingecko:usd-coin',symbol:'USDC'}),null)
  assert.equal(briefSignalMatches({canonicalKey:'eip155:42161:native',symbol:'ARB'},{display_symbol:'ETH'}),true)
})
Deno.test('brief fingerprints change when portfolio, identity or quantity changes without a price move',()=>{
  const input={portfolio:{id:'one'},holdings:[{canonicalKey:'eip155:1:native',symbol:'ETH',quantity:1,value:2500}]}
  const first=assembleBrief(input)
  for(const next of [{...input,portfolio:{id:'two'}},{...input,holdings:[{...input.holdings[0],quantity:2}]},{...input,holdings:[{...input.holdings[0],canonicalKey:'eip155:8453:native'}]}])assert.notEqual(assembleBrief(next).change_fingerprint,first.change_fingerprint)
})
