import {CHAINS,birdeyeChainForApp,normalizeTokenAddress} from '../chains.ts'

export function hydrationTarget(input:any,entity=false){
  if(!input||typeof input!=='object'||Array.isArray(input))return null
  const chain=entity
    ? CHAINS.find(c=>c.namespace===input.chain_namespace&&c.caip2Ref===String(input.chain_id))
    : CHAINS.find(c=>c.id===input.chain)||CHAINS.find(c=>birdeyeChainForApp(c.id)===input.chain)
  if(!chain)return null
  const providerChain=birdeyeChainForApp(chain.id)
  const address=normalizeTokenAddress(chain.id,String((entity?input.contract_address:input.address)||''))
  if(!providerChain||!(chain.namespace==='eip155'?/^0x[a-f0-9]{40}$/.test(address):chain.id==='solana'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)))return null
  const canonical=chain.namespace==='eip155'?`${chain.namespace}:${chain.caip2Ref}/erc20:${address}`:`solana:mainnet/token:${address}`
  const supplied=String((entity?input.canonical_ref_key:input.ref)||'')
  const ref=chain.namespace==='eip155'?supplied.toLowerCase():supplied
  const aliases=[canonical,`${chain.namespace}:${chain.caip2Ref}:${address}`,`${chain.id}:token:${address}`,`${chain.id}:${address}`]
  if(chain.id==='solana')aliases.push(`solana:mainnet/spl:${address}`)
  if(ref&&!aliases.includes(ref))return null
  return {chain:chain.id,providerChain,address,ref:canonical,entityId:(entity?input.id:input.entityId)||null}
}
