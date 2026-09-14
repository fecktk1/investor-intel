import {issuerCmcRepresentations,issuerProviderCmcId} from '../market-assets/issuer-identities.ts'
import { CHAIN_PROVIDERS, CHAIN_COINGECKO, getChain } from '../chains.ts'
export function marketChain(platform:string):string {
  const key=String(platform||'').trim().toLowerCase()
  if(CHAIN_PROVIDERS[key])return key
  return Object.entries(CHAIN_PROVIDERS).find(([,p])=>p.coingeckoPlatform===key)?.[0]||key
}
export function usableSpread(row:any,now=Date.now()):boolean {
  if(!row)return false
  const observed=Date.parse(row.as_of||''),age=now-observed
  return Number.isFinite(observed)&&age>=-30000&&age<=180000&&
    Number(row.confidence_score)>=70&&Number(row.lowest_ask_price)>0&&Number(row.highest_bid_price)>0&&
    !!row.buy_provider&&!!row.sell_provider&&row.buy_provider!==row.sell_provider&&
    Number.isFinite(Number(row.estimated_net_spread_pct))&&
    !(row.caution_flags||[]).some((f:unknown)=>/stale|depeg|normalization assumed|low liquidity/i.test(String(f)))
}

// Stable provider IDs, never symbol inference. These are the native asset on
// its originating chain; another network requires a selected contract identity.
const NATIVE_KEYS:Record<string,string>={
  'coingecko:bitcoin':'bip122:native:BTC','coinmarketcap:1':'bip122:native:BTC',
  'coingecko:ethereum':'eip155:1:native','coinmarketcap:1027':'eip155:1:native',
  'coingecko:solana':'solana:native:SOL','coinmarketcap:5426':'solana:native:SOL',
  'coingecko:binancecoin':'eip155:56:native','coinmarketcap:1839':'eip155:56:native',
  'coingecko:avalanche-2':'eip155:43114:native','coinmarketcap:5805':'eip155:43114:native',
}
export function verifiedNativeMarketSymbol(asset:any):string|null {
 const key=NATIVE_KEYS[asset?.source_provider+':'+asset?.provider_id]
 const symbols:Record<string,string>={'bip122:native:BTC':'BTC','eip155:1:native':'ETH','solana:native:SOL':'SOL','eip155:56:native':'BNB','eip155:43114:native':'AVAX'}
 return key&&symbols[key]===asset?.normalized_symbol?symbols[key]:null
}
export function marketCanonicalIdentity(asset:any):{canonicalAssetKey:string|null;identityState:string} {
  if(!asset)return {canonicalAssetKey:null,identityState:'unavailable'}
  const native=NATIVE_KEYS[`${asset.source_provider}:${asset.provider_id}`]
  if(native)return {canonicalAssetKey:native,identityState:'verified'}
  if(asset.source_provider==='coingecko') {
    const chains=Object.entries(CHAIN_COINGECKO).filter(([,id])=>id===asset.provider_id)
    const definition=chains.length===1?getChain(chains[0][0]):null
    if(definition)return {canonicalAssetKey:definition.namespace==='eip155'?`eip155:${definition.caip2Ref}:native`:`${definition.namespace}:native:${definition.nativeSymbol}`,identityState:'verified'}
  }
  const entries=Object.entries(asset.platforms||{}).filter(([,a])=>typeof a==='string'&&a)
  if(entries.length!==1)return {canonicalAssetKey:null,identityState:entries.length>1?'chain_selection_required':'unavailable'}
  const [platform,address]=entries[0],chain=marketChain(platform),def=getChain(chain)
  if(def?.namespace==='eip155'&&/^0x[0-9a-f]{40}$/i.test(String(address)))return {canonicalAssetKey:`eip155:${def.caip2Ref}:${String(address).toLowerCase()}`,identityState:'verified'}
  if(chain==='solana'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(address)))return {canonicalAssetKey:`solana:${address}`,identityState:'verified'}
  return {canonicalAssetKey:null,identityState:'unavailable'}
}
export function hasVerifiedCexIdentity(asset:any,mapping:any):boolean {
  if (!asset) return false
  const provider = String(asset.source_provider || ''), id = String(asset.provider_id || '')
  if (mapping?.is_active !== false && mapping) {
    const mappedId = String(mapping.canonical_asset_id || '')
    if (mappedId && (mappedId === `${provider}:${id}` || mappedId === `market:${provider}:${id}` || (provider === 'coingecko' && mappedId === id))) return true
    const mappedChain = mapping.chain ? marketChain(mapping.chain) : null
    if (mappedChain && mapping.contract_address) {
      const evm = getChain(mappedChain)?.namespace === 'eip155'
      const address = String(mapping.contract_address)
      if (Object.entries(asset.platforms || {}).some(([platform, contract]) => marketChain(platform) === mappedChain && typeof contract === 'string' && (evm ? contract.toLowerCase() === address.toLowerCase() : contract === address))) return true
    }
  }
  const known:Record<string,string> = { 'bip122:native:BTC':'BTC', 'eip155:1:native':'ETH', 'solana:native:SOL':'SOL', 'eip155:56:native':'BNB', 'eip155:43114:native':'AVAX' }
  const native = NATIVE_KEYS[`${provider}:${id}`]
  return !!native && known[native] === asset.normalized_symbol
}

/** All exact network representations the provider identifies. No balance aggregation. */
export function marketIdentityChoices(asset:any):{canonicalAssetKey:string;chain:string;label:string}[] {
  if (!asset) return []
  const choices = new Map<string,{canonicalAssetKey:string;chain:string;label:string}>()
  const origin = NATIVE_KEYS[`${asset.source_provider}:${asset.provider_id}`]
  const nativeCgId = asset.source_provider === 'coingecko' ? asset.provider_id : origin ? Object.entries(NATIVE_KEYS).find(([id,key]) => id.startsWith('coingecko:') && key === origin)?.[0].slice(10) : null
  for (const [chain,cgId] of Object.entries(CHAIN_COINGECKO)) {
    if (cgId !== nativeCgId) continue
    const def = getChain(chain); if (!def) continue
    const canonicalAssetKey = def.namespace === 'eip155' ? `eip155:${def.caip2Ref}:native` : `${def.namespace}:native:${def.nativeSymbol}`
    choices.set(canonicalAssetKey,{canonicalAssetKey,chain,label:`${def.label} · Native ${def.nativeSymbol}`})
  }
  for (const [platform,address] of Object.entries(asset.platforms || {}).slice(0,64)) {
    const chain = marketChain(platform), def = getChain(chain)
    const key = marketCanonicalIdentity({ platforms: { [platform]: address } }).canonicalAssetKey
    if (key && def) choices.set(key,{canonicalAssetKey:key,chain,label:`${def.label} · ${String(address).slice(0,8)}…${String(address).slice(-4)}`})
  }
  for(const representation of issuerCmcRepresentations(issuerProviderCmcId(asset.source_provider,String(asset.provider_id))||'')){
    const parts=representation.canonicalAssetKey.split(':'),def=parts[0]==='eip155'?Object.keys(CHAIN_PROVIDERS).map(getChain).find(d=>d?.namespace==='eip155'&&d.caip2Ref===parts[1]):getChain(parts[0])
    if(def)choices.set(representation.canonicalAssetKey,{canonicalAssetKey:representation.canonicalAssetKey,chain:def.id,label:def.label+' · Circle-issued USDC'})
  }
  return [...choices.values()].slice(0,64)
}
