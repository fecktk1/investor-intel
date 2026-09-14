import assert from 'node:assert/strict'
import { researchIdentity, researchCmcId } from './research-identity.ts'
Deno.test('research context bridges exact native aliases and provider-qualified references',()=>{
  for(const canonicalKey of ['bip122:mainnet/native:btc','bip122:native:BTC','native:bitcoin']) {
    assert.deepEqual(researchIdentity({canonicalKey,symbol:'native'}),{canonicalKey,chain:'bitcoin',symbol:'BTC',sourceProvider:'coingecko',providerId:'bitcoin',tokenAddress:null})
  }
  assert.equal(researchIdentity({canonicalKey:'eip155:42161/native:eth'}).providerId,'ethereum')
  assert.equal(researchIdentity({canonicalKey:'eip155:42161/native:arb'}).providerId,null)
  assert.equal(researchIdentity({canonicalKey:'bip122:wrong/native:btc'}).providerId,null)
  assert.equal(researchIdentity({symbol:'BTC'}).providerId,undefined)
  assert.equal(researchIdentity({canonicalKey:'market:coinmarketcap:1027'}).providerId,'1027')
})
Deno.test('research uses exact slash-form contracts on the recorded network',()=>{
 const address='0x'+'Ab'.repeat(20),mint='So11111111111111111111111111111111111111112'
 for(const canonicalKey of [`eip155:8453/erc20:${address}`,`eip155:8453:${address}`,`base:token:${address}`]) {
  const identity=researchIdentity({canonicalKey,symbol:'ETH'})
  assert.equal(identity.chain,'base');assert.equal(identity.tokenAddress,address.toLowerCase())
 }
 for(const canonicalKey of [`solana:mainnet/spl:${mint}`,`solana:mainnet/token:${mint}`,`solana:${mint}`]) {
  const identity=researchIdentity({canonicalKey,symbol:'SOL'})
  assert.equal(identity.chain,'solana');assert.equal(identity.tokenAddress,mint)
 }
 for(const canonicalKey of [`eip155:8453/spl:${address}`,`solana:testnet/spl:${mint}`,`eip155:999999/erc20:${address}`])assert.equal(researchIdentity({canonicalKey}).tokenAddress,undefined)
})
Deno.test('CMC research mapping bridges verified natives but never substitutes provider hints for contracts',()=>{
 assert.equal(researchCmcId({canonicalKey:'native:avalanche'}),'5805')
 assert.equal(researchCmcId({canonicalKey:'native:bnb'}),'1839')
 assert.equal(researchCmcId({canonicalKey:'eip155:42161/native:eth'}),'1027')
 assert.equal(researchCmcId({canonicalKey:'market:coinmarketcap:42019'}),'42019')
 assert.equal(researchCmcId({sourceProvider:'coingecko',providerId:'avalanche-2'}),'5805')
 for(const canonicalKey of ['eip155:8453/erc20:0x'+'a'.repeat(40),'eip155:999999/erc20:0x'+'a'.repeat(40),'solana:testnet/spl:So11111111111111111111111111111111111111112','eip155:42161/native:arb','ETH']) {
  assert.equal(researchCmcId({canonicalKey,sourceProvider:'coingecko',providerId:'ethereum'}),null)
 }
 assert.equal(researchCmcId({symbol:'BTC'}),null)
})
