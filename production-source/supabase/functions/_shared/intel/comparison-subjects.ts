import {researchIdentity} from './research-identity.ts'
import type {AssetEvidenceSubject} from './asset-evidence-pack.ts'

// An explicit basket is authoritative. Never rebuild it from deduplicated tickers
// or inherit the first entity's identity for every member.
export function comparisonAssetSubjects(value:unknown):AssetEvidenceSubject[]|null {
 if(value==null)return null
 if(!Array.isArray(value)||value.length<2||value.length>4)throw new Error('invalid_comparison_assets')
 const seen=new Set<string>()
 return value.map(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid_comparison_assets')
  const item=raw as Record<string,unknown>
  const canonical=String(item.canonicalKey||item.ref||'')
  const provider=String(item.sourceProvider||''),providerId=String(item.providerId||'')
  const key=canonical||(['coinmarketcap','coingecko'].includes(provider)?`market:${provider}:${providerId}`:'')
  if(!key||key.length>240||/[\s\x00-\x1f]/.test(key))throw new Error('invalid_comparison_assets')
  const symbol=typeof item.symbol==='string'?item.symbol.slice(0,32):null
  const identity=researchIdentity({canonicalKey:key,symbol,orgId:null,userId:null})
  const market=/^market:(coinmarketcap:([1-9][0-9]{0,11})|coingecko:[a-z0-9][a-z0-9-]{0,120})$/.test(key)
  if(key.startsWith('market:')&&!market||!market&&!identity.tokenAddress&&!identity.providerId)throw new Error('invalid_comparison_assets')
  if(provider&&provider!==identity.sourceProvider||providerId&&providerId!==identity.providerId)throw new Error('conflicting_comparison_identity')
  const id=identity.tokenAddress?`${identity.chain}:${identity.tokenAddress}`:identity.providerId?`${identity.sourceProvider}:${identity.providerId}`:key
  if(seen.has(id))throw new Error('duplicate_comparison_asset')
  seen.add(id);return identity
 })
}
