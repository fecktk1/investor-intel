/** Explicit CMC platform IDs are not EVM chain IDs. Verified against platform
 * listing plus exact-contract token/holder/swap responses on 2026-09-12. */
export const CMC_DEX_NETWORKS=[
 {chain:'eip155:1',platform:'ethereum',platformId:1,label:'Ethereum'},
 {chain:'eip155:8453',platform:'base',platformId:199,label:'Base'},
 {chain:'eip155:42161',platform:'arbitrum',platformId:51,label:'Arbitrum'},
 {chain:'solana',platform:'solana',platformId:16,label:'Solana'},
] as const
export const CMC_DEX_DISCOVERY=['dexTrending','dexNew','dexMeme','dexGainers'] as const
export const isDexDiscovery=(name:string)=>CMC_DEX_DISCOVERY.includes(name as any)
export const cmcDexNetwork=(platform:string)=>CMC_DEX_NETWORKS.find(n=>n.platform===platform)
export const cmcDexSameAddress=(a:unknown,b:unknown,platform:string)=>typeof a==='string'&&typeof b==='string'&&(platform==='solana'?a===b:a.toLowerCase()===b.toLowerCase())
export const cmcDexAddress=(address:unknown,platform:string)=>typeof address==='string'&&(platform==='solana'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address):/^0x[0-9a-fA-F]{40}$/.test(address))
/** Verified chain aliases only; new chains require matching platform evidence. */
export function cmcDexIdentity(value:unknown) {
  if(typeof value!=='string')return null
  const match=/^(eip155:[1-9][0-9]*)(?::|\/erc20:)(0x[a-fA-F0-9]{40})$/.exec(value),sol=/^solana:(?:mainnet\/spl:)?([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(value)
  const network=CMC_DEX_NETWORKS.find(n=>n.chain===(match?.[1]??(sol?'solana':null)))
  const address=match?.[2]?.toLowerCase()??sol?.[1]
  return network&&address?{...network,subject:`${network.chain}:${address}`,address}:null
}
/** Provider cursors are opaque, bounded base64-compatible values. Transport
 * uses URLSearchParams; separators cannot introduce another query argument. */
export const isCmcDexCursor=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_:./+=-]{1,200}$/.test(value)
export function cmcDexInteger(value:unknown):number|null {
 if(typeof value!=='number'&&!(typeof value==='string'&&/^\d+$/.test(value)))return null
 const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:null
}
export function validateCmcDexResponse(name:string,body:any,params:Record<string,string>) {
  const d=body?.data
  if(name==='dexPlatforms')return Array.isArray(d)&&d.length<=500&&d.every(r=>r&&Number.isSafeInteger(r.id)&&typeof r.n==='string')
  if(isDexDiscovery(name)){
   const lists=name==='dexMeme'?[d?.newCreations,d?.aboutGraduates,d?.graduates]:[d?.leaderboardList]
   return lists.every(list=>Array.isArray(list)&&list.length<=Number(params.pageSize)&&list.every(r=>{
    const network=CMC_DEX_NETWORKS.find(n=>n.platformId===r?.pid)
    return network&&String(r.pid)===params.platformIds&&cmcDexAddress(r.addr,network.platform)
   }))&&(!d.nextPageIndex||isCmcDexCursor(d.nextPageIndex))
  }
  const network=cmcDexNetwork(params.platform??params.platformName)
  if(!network)return false
  const same=(a:unknown,b:unknown)=>cmcDexSameAddress(a,b,network.platform)
  const address=params.address??params.tokenAddress
  if(name==='dexToken')return !!d&&!Array.isArray(d)&&same(d.addr,address)&&d.pid===network.platformId
  if(name==='dexHolderCount')return !!d&&!Array.isArray(d)&&same(d.tokenAddress,address)&&d.platformId===network.platformId&&cmcDexInteger(d.count)!=null
  if(name==='dexSecurity')return Array.isArray(d)&&d.length<=1&&d.every(r=>same(r.tokenContractAddress,address)&&r.platformId===network.platformId)
  if(name==='dexHolderHistory')return Array.isArray(d)&&d.length<=Number(params.limit)&&d.every(r=>same(r.tokenAddress,address)&&r.platform===network.platformId)
  if(name==='dexLiquidityEvents')return !!d&&Array.isArray(d.lcs)&&d.lcs.length<=Number(params.limit)&&d.lcs.every((r:any)=>same(r.t0a,address)||same(r.t1a,address))&&(!d.lastId||isCmcDexCursor(d.lastId))
  if(name==='dexPools')return Array.isArray(d)&&d.length<=Number(params.size)&&d.every(r=>cmcDexAddress(r?.addr,network.platform)&&(same(r.t0?.addr,address)||same(r.t1?.addr,address)))
  if(name==='dexSwaps')return !!d&&Array.isArray(d.swaps)&&d.swaps.length<=Number(params.limit)&&d.swaps.every((r:any)=>(same(r.t0a,address)||same(r.t1a,address))&&typeof r.tx==='string'&&r.tx.length<=200&&cmcDexInteger(r.lgid)!=null)&&(!d.lastId||isCmcDexCursor(d.lastId))
  return false
}
export function cmcDexParams(name:string,identity:NonNullable<ReturnType<typeof cmcDexIdentity>>) {
  return name==='dexHolderCount'||name==='dexHolderHistory'?{platform:identity.platform,tokenAddress:identity.address,...(name==='dexHolderHistory'?{interval:'1d',limit:'30'}:{})}:
    { [name==='dexSecurity'?'platformName':'platform']:identity.platform,address:identity.address,...(['dexLiquidityEvents','dexSwaps'].includes(name)?{limit:'25'}:name==='dexPools'?{size:'12'}:{})}
}
