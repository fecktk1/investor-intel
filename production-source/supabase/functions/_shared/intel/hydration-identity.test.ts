import {birdeyeHolderListSupported} from './holder-coverage.ts'
import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {hydrationTarget} from './hydration-identity.ts'
const address='0xAb11111111111111111111111111111111111111'
Deno.test('automatic EVM enrichment keeps Base and Arbitrum on their actual network',()=>{
 for(const [chain,id] of [['base','8453'],['arbitrum','42161'],['ethereum','1']]){
  const target=hydrationTarget({id:'entity',chain_namespace:'eip155',chain_id:id,contract_address:address,canonical_ref_key:`eip155:${id}/erc20:${address}`},true)
  eq(target?.chain,chain);eq(target?.ref,`eip155:${id}/erc20:${address.toLowerCase()}`);eq(target?.entityId,'entity')
 }
})
Deno.test('unknown EVM networks, mismatched identity and missing chains cannot default to Ethereum or Solana',()=>{
 eq(hydrationTarget({chain_namespace:'eip155',chain_id:'9999999',contract_address:address},true),null)
 eq(hydrationTarget({address}),null)
 eq(hydrationTarget({chain:'base',address,ref:`eip155:1/erc20:${address}`}),null)
 eq(hydrationTarget({chain:'ethereum',address:address+'?api-key=bad'}),null)
})
Deno.test('provider chain aliases use a stable application chain in saved records',()=>{
 const target=hydrationTarget({chain:'bsc',address})
 eq(target?.chain,'bnb');eq(target?.providerChain,'bsc');eq(target?.ref,`eip155:56/erc20:${address.toLowerCase()}`)
})
Deno.test('Solana contract casing is retained and a differently cased reference is rejected',()=>{
 const mint='So11111111111111111111111111111111111111112'
 const target=hydrationTarget({chain:'solana',address:mint,ref:`solana:mainnet/token:${mint}`})
 eq(target?.address,mint);eq(target?.ref,`solana:mainnet/token:${mint}`)
 eq(hydrationTarget({chain:'solana',address:mint,ref:`solana:mainnet/token:${mint.toLowerCase()}`}),null)
})

Deno.test('holder-list coverage is endpoint specific and cannot borrow EVM price support',()=>{
 eq(birdeyeHolderListSupported('solana'),true)
 for(const chain of ['base','ethereum','arbitrum','bnb','unknown'])eq(birdeyeHolderListSupported(chain),false)
 for(const input of [null,undefined,[],true])eq(hydrationTarget(input),null)
})
