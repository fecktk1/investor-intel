/** Explicit CMC platform IDs are not EVM chain IDs. Verified against platform
 * listing plus exact-contract token/holder/swap responses on 2026-09-12. */
export const CMC_DEX_NETWORKS=[
 {chain:'eip155:1',platform:'ethereum',platformId:1,label:'Ethereum'},
 {chain:'eip155:8453',platform:'base',platformId:199,label:'Base'},
 {chain:'eip155:42161',platform:'arbitrum',platformId:51,label:'Arbitrum'},
 {chain:'solana',platform:'solana',platformId:16,label:'Solana'},
] as const
export const CMC_DEX_DISCOVERY=['dexTrending','dexNew','dexMeme','dexGainers'] as const
/** Holder classifications returned by /v1/dex/holders/tag_count. Probed on
 * 2026-09-14 (docs/investor-intel/evidence/cmc-cost-probe-2026-09-14.json):
 * data.holders came back with exactly these eight rows. They are CMC's labels
 * for addresses, never people, and the list bounds a tag_count response. */
export const CMC_HOLDER_TAGS=['tag_dev','tag_sniper','tag_kol','tag_whale','tag_bot','tag_insider','tag_initial_bundler','tag_smart_money']
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
/** Provider decimals arrive as numbers or decimal strings. Anything else (null,
 * empty string, NaN, Infinity, an object) is absence, never a value. */
export function cmcDexNumber(value:unknown):number|null {
 if(typeof value==='number')return Number.isFinite(value)?value:null
 if(typeof value!=='string'||!/^-?\d+(\.\d+)?([eE][-+]?\d{1,3})?$/.test(value.trim()))return null
 const n=Number(value.trim());return Number.isFinite(n)?n:null
}
/** A response page may never be longer than the page the request asked for.
 * A missing or unreadable bound is itself a rejection: an unbounded answer to a
 * bounded question is not the answer to that question. */
const withinLimit=(list:unknown[],bound:unknown)=>{const n=cmcDexInteger(bound);return n!=null&&n>0&&list.length<=n}
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
  // Lookup and batch families answer about many subjects, so they are checked
  // before a single request identity is resolved.
  // Probed 2026-09-14: /v1/dex/search answered data {total, tks:[{pltId,plt,plti,
  // n,s,addr,pt,w,x,l,pu,pc24h,dec,tsup,fpt,fpct,v24h,mc,liq,ts,lf,cid,ut24h,ecs}]}.
  // Free text searches every chain the provider indexes, so membership of
  // CMC_DEX_NETWORKS cannot be required of every row. It IS required of every
  // row when the caller pinned a platform, and a row that claims a verified
  // platform must carry a valid address for it.
  if(name==='dexSearch'){
    const pinned=params.platform?cmcDexNetwork(params.platform):null
    if(params.platform&&!pinned)return false
    if(!d||Array.isArray(d)||!Array.isArray(d.tks)||!withinLimit(d.tks,params.limit))return false
    if(d.total!=null&&cmcDexInteger(d.total)==null)return false
    return d.tks.every((r:any)=>{
      if(!r||typeof r!=='object'||Array.isArray(r))return false
      const id=cmcDexInteger(r.pltId)
      if(id==null||id<1||(pinned&&id!==pinned.platformId))return false
      const net=CMC_DEX_NETWORKS.find(n=>n.platformId===id)
      // An unverified chain's address is an opaque bounded token; it never
      // becomes an identity, but it must still be one short printable line.
      return net?cmcDexAddress(r.addr,net.platform):typeof r.addr==='string'&&/^[!-~]{1,200}$/.test(r.addr)
    })
  }
  // Probed 2026-09-14: /v1/dex/tokens/batch-query answered a bare data array of
  // [{n,sym,addr,plt,pdex,pcid,pid,dec,crt,own,web,tw,tg,lg,pubAt,mcap,ts,liqUsd,
  //   hld,p,ph24h,pl24h,pt,fpt}]. One platform, the addresses that were asked for.
  if(name==='dexBatch'){
    const net=cmcDexNetwork(params.platform)
    const asked=String(params.addresses??'').split(',').filter(Boolean)
    if(!net||!asked.length||!asked.every(a=>cmcDexAddress(a,net.platform)))return false
    if(!Array.isArray(d)||!withinLimit(d,asked.length))return false
    const seen=new Set<string>()
    return d.every((r:any)=>{
      if(!r||typeof r!=='object'||Array.isArray(r)||r.pid!==net.platformId||!cmcDexAddress(r.addr,net.platform))return false
      // An answer about an address nobody asked for is not an answer to this request.
      if(!asked.some(a=>cmcDexSameAddress(a,r.addr,net.platform)))return false
      const key=net.platform==='solana'?String(r.addr):String(r.addr).toLowerCase()
      if(seen.has(key))return false
      seen.add(key);return true
    })
  }
  // Probed 2026-09-14: /v1/dex/token/price/batch answered a bare data array of
  // [{pid,pdex,pcid,a,n,sym,lg,p,pc1h,pc24h,v24h,l,ts,fpt,fpct,mc}] where `a` is
  // the token address and `p` the USD price. Every member states its own chain,
  // so every row must match a requested (platform,address) pair exactly.
  if(name==='dexPriceBatch'){
    const asked=String(params.tokens??'').split(',').filter(Boolean).map(v=>[v.slice(0,v.indexOf(':')),v.slice(v.indexOf(':')+1)] as [string,string])
    if(!asked.length||!asked.every(([p,a])=>!!cmcDexNetwork(p)&&cmcDexAddress(a,p)))return false
    if(!Array.isArray(d)||!withinLimit(d,asked.length))return false
    const seen=new Set<string>()
    return d.every((r:any)=>{
      if(!r||typeof r!=='object'||Array.isArray(r))return false
      const net=CMC_DEX_NETWORKS.find(n=>n.platformId===r.pid)
      if(!net||!cmcDexAddress(r.a,net.platform))return false
      if(!asked.some(([p,a])=>p===net.platform&&cmcDexSameAddress(a,r.a,net.platform)))return false
      // A price is a finite non-negative number or an explicit absence.
      const price=r.p==null?null:cmcDexNumber(r.p)
      if(r.p!=null&&(price==null||price<0))return false
      const key=`${net.platform}:${net.platform==='solana'?String(r.a):String(r.a).toLowerCase()}`
      if(seen.has(key))return false
      seen.add(key);return true
    })
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
  // Probed 2026-09-14: /v1/dex/holders/tag_count answered data {holders:[{tag,hc,
  // tb,hr}],platformId,tokenAddress} with exactly the eight CMC_HOLDER_TAGS rows.
  // hc is a holder-account count, tb the tagged balance, hr the holding ratio.
  // The provider states no unit for hr (fraction or percent is unconfirmed), so
  // the bound accommodates both and the value is never relabelled. No clock.
  if(name==='dexHolderTags'){
    if(!d||Array.isArray(d)||!Array.isArray(d.holders)||d.holders.length>CMC_HOLDER_TAGS.length)return false
    if(d.tokenAddress!=null&&!same(d.tokenAddress,address))return false
    if(d.platformId!=null&&d.platformId!==network.platformId)return false
    const seen=new Set<string>()
    return d.holders.every((r:any)=>{
      if(!r||typeof r!=='object'||Array.isArray(r)||typeof r.tag!=='string'||!CMC_HOLDER_TAGS.includes(r.tag)||seen.has(r.tag))return false
      seen.add(r.tag)
      const count=cmcDexInteger(r.hc),balance=cmcDexNumber(r.tb),ratio=cmcDexNumber(r.hr)
      return count!=null&&balance!=null&&balance>=0&&ratio!=null&&ratio>=0&&ratio<=100
    })
  }
  // Probed 2026-09-14/15: /v1/dex/holders/list answers data {holders:[{walletAddress,
  // balance,percent,tags,fundingSource,...}],lastId}. Each row is a classified
  // address on the requested chain, never a person; an address that is not valid
  // for the requested platform makes the whole page unusable.
  if(name==='dexHolders'){
    if(!d||Array.isArray(d)||!Array.isArray(d.holders)||!withinLimit(d.holders,params.limit))return false
    if(d.lastId!=null&&!isCmcDexCursor(d.lastId))return false
    return d.holders.every((r:any)=>{
      if(!r||typeof r!=='object'||Array.isArray(r)||!cmcDexAddress(r.walletAddress,network.platform))return false
      if(r.tokenAddress!=null&&!same(r.tokenAddress,address))return false
      return r.tags==null||(Array.isArray(r.tags)&&r.tags.length<=CMC_HOLDER_TAGS.length&&r.tags.every((t:any)=>typeof t==='string'&&t.length>0&&t.length<=64))
    })
  }
  // Probed 2026-09-14: /v1/k-line/candles answers a bare data array of positional
  // arrays of length 7, [open,high,low,close,volume,timestampSeconds,traders].
  // The rows carry no address, so the only identity is the one the request pinned;
  // the period clock is `t`, which the provider returns in ascending order.
  if(name==='dexCandles'){
    const raw=Array.isArray(d)?d:Array.isArray(d?.candles)?d.candles:null
    if(!raw||!withinLimit(raw,params.limit))return false
    let previous=-Infinity
    return raw.every((r:any)=>{
      if(!Array.isArray(r)||r.length<6||r.length>7)return false
      if(r.slice(0,6).some((v:unknown)=>cmcDexNumber(v)==null))return false
      if(r.length===7&&r[6]!=null&&cmcDexNumber(r[6])==null)return false
      const t=cmcDexNumber(r[5])!
      if(t<=0||t<previous)return false
      previous=t;return true
    })
  }
  return false
}
export type CmcDexIdentity=NonNullable<ReturnType<typeof cmcDexIdentity>>
/** Request inputs a capability needs beyond one contract identity. Everything
 * stays a plain scalar or list: cmcParams remains the only canonicaliser, so
 * nothing here is validated twice or bypassed. `from`/`to` are SECONDS. */
export interface CmcDexParamOptions {
  tag?:string; limit?:string|number; lastId?:string
  interval?:string; unit?:string; pm?:string; from?:string|number; to?:string|number
  q?:string; platform?:string; addresses?:string[]; tokens?:{platform:string;address:string}[]
}
/** The holder family keys its subject as tokenAddress, not address. */
const CMC_DEX_HOLDER_FAMILY=['dexHolderCount','dexHolderHistory','dexHolderTags','dexHolders']
export function cmcDexParams(name:string,identity:CmcDexIdentity,options?:CmcDexParamOptions):Record<string,unknown>
export function cmcDexParams(name:string,identity:CmcDexIdentity|null,options:CmcDexParamOptions):Record<string,unknown>
export function cmcDexParams(name:string,identity:CmcDexIdentity|null,options:CmcDexParamOptions={}):Record<string,unknown> {
  const put=(key:string,value:unknown)=>value==null||value===''?{}:{[key]:String(value)}
  // Lookup and batch capabilities carry their own subjects. A single identity is
  // accepted as the one-member convenience case, never required.
  if(name==='dexSearch')return {...put('q',options.q),...put('platform',options.platform),...put('limit',options.limit)}
  if(name==='dexBatch')return {...put('platform',options.platform??identity?.platform),addresses:options.addresses??(identity?[identity.address]:[])}
  if(name==='dexPriceBatch')return {tokens:options.tokens??(identity?[{platform:identity.platform,address:identity.address}]:[])}
  if(!identity)throw new Error('missing_identifier')
  if(CMC_DEX_HOLDER_FAMILY.includes(name))return {platform:identity.platform,tokenAddress:identity.address,
    ...(name==='dexHolderHistory'?{interval:'1d',limit:'30'}:{}),
    // The provider rejects a holders list without a tag; one page of 50 is the
    // default so a single classification cannot spend an unbounded page.
    ...(name==='dexHolders'?{...put('tag',options.tag),limit:String(options.limit??'50'),...put('lastId',options.lastId)}:{})}
  // k-line takes a named candle width and a seconds window; cmcParams applies
  // the interval/unit defaults and the 1000-row ceiling.
  if(name==='dexCandles')return {platform:identity.platform,address:identity.address,
    ...put('interval',options.interval),...put('unit',options.unit),...put('limit',options.limit),
    ...put('from',options.from),...put('to',options.to),...put('pm',options.pm)}
  return {[name==='dexSecurity'?'platformName':'platform']:identity.platform,address:identity.address,
    ...(['dexLiquidityEvents','dexSwaps'].includes(name)?{limit:'25'}:name==='dexPools'?{size:'12'}:{}),
    ...put('lastId',options.lastId)}
}
