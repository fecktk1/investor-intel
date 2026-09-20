/** Explicit CMC platform IDs are not EVM chain IDs. Verified against platform
 * listing plus exact-contract token/holder/swap responses on 2026-09-12. */
export const CMC_DEX_NETWORKS=[
 {chain:'eip155:1',platform:'ethereum',platformId:1,label:'Ethereum'},
 {chain:'eip155:8453',platform:'base',platformId:199,label:'Base'},
 {chain:'eip155:42161',platform:'arbitrum',platformId:51,label:'Arbitrum'},
 {chain:'solana',platform:'solana',platformId:16,label:'Solana'},
] as const
export const CMC_DEX_DISCOVERY=['dexTrending','dexNew','dexMeme','dexGainers'] as const
/** The three stage arrays /v1/dex/meme/list answers with, verbatim. They are the
 * response envelope, not a request parameter: the endpoint has no stage selector. */
export const CMC_DEX_MEME_STAGES=['newCreations','aboutGraduates','graduates'] as const
/** Rows kept per stage array. The documented request field is `limit`, not
 * `pageSize`; 25 is what this platform asks for and what the lane budgets. */
export const CMC_DEX_MEME_LIMIT=25
/** The verified CMC DEX network id a meme request names by default. Solana is
 * where the launchpads this lane is about live. It is a REQUEST field only: the
 * answer is still attributed from each row's own `pid`, never from this default. */
export const CMC_DEX_MEME_PLATFORM_ID=16
/** Launchpad protocol codes /v1/dex/meme/list accepts, exactly as the published
 * response field `pt` names them: 1001 Pump.fun, 1002 Moonshot, 2001 Four.meme.
 * A code outside this list is refused rather than asked about — the registry is
 * where a reviewed provider fact lives, and a guessed code is a wrong question.
 * Which of these the meme lane actually asks is its own decision (Four.meme
 * launches on BNB Chain, which is not a verified network here). */
export const CMC_DEX_MEME_PROTOCOLS=[1001,1002,2001]
/** Holder classifications returned by /v1/dex/holders/tag_count. Probed on
 * 2026-09-14 (docs/investor-intel/evidence/cmc-cost-probe-2026-09-14.json):
 * data.holders came back with exactly these eight rows. They are CMC's labels
 * for addresses, never people, and the list bounds a tag_count response. */
export const CMC_HOLDER_TAGS=['tag_dev','tag_sniper','tag_kol','tag_whale','tag_bot','tag_insider','tag_initial_bundler','tag_smart_money']
export const isDexDiscovery=(name:string)=>CMC_DEX_DISCOVERY.includes(name as any)
export const cmcDexNetwork=(platform:string)=>CMC_DEX_NETWORKS.find(n=>n.platform===platform)
export const cmcDexSameAddress=(a:unknown,b:unknown,platform:string)=>typeof a==='string'&&typeof b==='string'&&(platform==='solana'?a===b:a.toLowerCase()===b.toLowerCase())
export const cmcDexAddress=(address:unknown,platform:string)=>typeof address==='string'&&(platform==='solana'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address):/^0x[0-9a-fA-F]{40}$/.test(address))
/** One public on-chain account, in the canonical form every DEX surface in this
 * repository uses: lower-case for EVM, exact base58 for Solana. An address that
 * is not valid for the requested chain is null: an unusable identity is not an
 * account, and it is never repaired into one.
 *
 * An address is an ACCOUNT, never a person. Nothing in this repository resolves
 * one to a name, an ENS record, an exchange, a social handle or an entity, and
 * no caller may link two addresses together on the strength of having seen them
 * in the same response. */
export function cmcDexCanonicalAddress(value:unknown,platform:string):string|null {
 if(!cmcDexAddress(value,platform))return null
 const address=String(value)
 return platform==='solana'?address:address.toLowerCase()
}
/** Verified chain aliases only; new chains require matching platform evidence. */
export function cmcDexIdentity(value:unknown) {
  if(typeof value!=='string')return null
  const match=/^(eip155:[1-9][0-9]*)(?::|\/erc20:)(0x[a-fA-F0-9]{40})$/.exec(value),sol=/^solana:(?:mainnet\/spl:)?([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(value)
  const network=CMC_DEX_NETWORKS.find(n=>n.chain===(match?.[1]??(sol?'solana':null)))
  const address=match?.[2]?.toLowerCase()??sol?.[1]
  return network&&address?{...network,subject:`${network.chain}:${address}`,address}:null
}
/**
 * The verified network a DISCOVERY ROW names, honouring an optional client-side
 * platform pin. Shared by every caller that has to split a platform-unfiltered
 * answer (/v1/dex/meme/list takes no platform filter) by the platform each row
 * claims for itself, so the pid -> registry mapping exists in exactly one place.
 *
 * Null means "not ours", for one of two reasons the CALLER must tell apart: a
 * chain this platform has no verified CMC DEX evidence for, or a verified chain
 * other than the pinned one. Neither is ever repaired into an identity.
 */
export function cmcDexRowIdentity(canonicalKey:unknown,pinnedPlatformId:number|null=null) {
  const identity=cmcDexIdentity(canonicalKey)
  if(!identity)return null
  return pinnedPlatformId!=null&&identity.platformId!==pinnedPlatformId?null:identity
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
/** The most pool rows one /v1/dex/token/pools answer may carry. The provider
 * ignores `size`; this is a ceiling against a runaway body, not a page size. */
export const CMC_DEX_POOL_PAGE_CEILING=1000
const withinLimit=(list:unknown[],bound:unknown)=>{const n=cmcDexInteger(bound);return n!=null&&n>0&&list.length<=n}
/** /v1/dex/holders/list is NOT paginated. The 2026-09-15 05:00 UTC capture proved
 * the provider ignores `limit` and returns the whole tag cohort: tag_smart_money
 * answered 29 rows and tag_kol answered 253 rows, both for a requested limit of
 * 50. The request's `limit` therefore cannot bound the response — it bounds only
 * what we keep (see cmcRows). What is left here is an absolute sanity ceiling:
 * past it the answer is not a holder page at all. 2500 is already the practical
 * maximum, because cmc-transport reads at most 2 MB of body and a row of this
 * endpoint's ~25 fields runs several hundred bytes. */
export const CMC_DEX_HOLDER_RESPONSE_MAX=2500
/** One page of /v1/dex/holders/list. The published reference puts the rows under
 * data.holders; the live tape has also answered with data.list and with a bare
 * data array, and the cursor is optional (lastId, or nextId, or absent).
 * Returns null when nothing in the response looks like a page at all. */
export function cmcDexHolderPage(data:any):{rows:any[];cursor:string|null}|null {
  const rows=Array.isArray(data)?data:Array.isArray(data?.holders)?data.holders:Array.isArray(data?.list)?data.list:null
  if(!rows)return null
  const cursor=Array.isArray(data)?null:data?.lastId??data?.nextId??null
  return {rows,cursor:cursor==null||cursor===''?null:String(cursor)}
}
/** One page of /v1/dex/token/pools, and the place where ZERO POOLS stops being a
 * malformed answer.
 *
 * A permissioned tokenised fund can have no public DEX pool at all, and that is
 * the finding, not a failure. On 2026-09-20 15:45 UTC the RWA depth lane read
 * three such contracts on Ethereum: every one answered HTTP 200 with error_code
 * 0 and nothing usable under `data`, and every one was refused
 * `malformed_response` for one credit, which made "this fund has no pool"
 * indistinguishable from "the provider broke".
 *
 * The published reference puts the rows in a bare `data` array. An ABSENT or null
 * `data`, an empty object, and an empty list under a documented container name
 * are all read here as zero pools. A container that HOLDS rows is returned so
 * those rows are validated exactly as a bare array's are. Anything else - a
 * scalar, a string, an object with unknown content - is still not a page at all
 * and returns null, so the transport keeps refusing it.
 */
// deno-lint-ignore no-explicit-any
export function cmcDexPoolPage(data:unknown):{rows:any[]}|null {
 if(data==null)return {rows:[]}
 if(Array.isArray(data))return {rows:data}
 if(typeof data!=='object')return null
 const d=data as Record<string,unknown>
 for(const key of ['pools','list','pairs'])if(Array.isArray(d[key]))return {rows:d[key] as any[]}
 return Object.keys(d).length?null:{rows:[]}
}
/** A bounded description of a response's SHAPE for a diagnostic log: top-level
 * keys, the type of each and the length of every array. NEVER a value, never an
 * address, never a body. It exists because the empty-pool shape cannot be
 * reproduced from a test - only a real run can tell us which of the several legal
 * empty shapes CoinMarketCap answers with, and a shape is safe to record. */
export function cmcShapeSummary(value:unknown,depth=2,max=120):string {
 const describe=(v:unknown,left:number):string=>{
  if(v===undefined)return 'absent'
  if(v===null)return 'null'
  if(Array.isArray(v))return `array[${v.length}]`
  if(typeof v!=='object')return typeof v
  const keys=Object.keys(v as Record<string,unknown>).sort().slice(0,8)
  if(left<=0)return `object(${keys.length})`
  return `{${keys.map(k=>`${k}:${describe((v as Record<string,unknown>)[k],left-1)}`).join(',')}}`
 }
 return describe(value,depth).slice(0,max)
}
/** The reference names the wallet key walletAddress; address and holderAddress
 * are the observed aliases. It identifies a classified account, never a person. */
export function cmcDexHolderAddress(row:any):string|null {
  for(const key of ['walletAddress','address','holderAddress'])if(typeof row?.[key]==='string'&&row[key])return row[key]
  return null
}
/** Tags arrive as an array of labels, or as one comma-separated string. */
export function cmcDexHolderTagList(value:unknown):string[]|null {
  const list=Array.isArray(value)?value:typeof value==='string'?value.split(','):null
  return list?list.map(v=>typeof v==='string'?v.trim():'').filter(Boolean):null
}
export function validateCmcDexResponse(name:string,body:any,params:Record<string,string>) {
  const d=body?.data
  if(name==='dexPlatforms')return Array.isArray(d)&&d.length<=500&&d.every(r=>r&&Number.isSafeInteger(r.id)&&typeof r.n==='string')
  // /v1/dex/meme/list is NOT shaped like the other three discovery lists. Read
  // against the published DEX token reference on 2026-09-15: its request body is
  // {protocol, exclusive, limit, newCreationFilter, aboutGraduateFilter,
  // graduateFilter} and it accepts NO platformIds, interval, pageSize or
  // nextPageIndex. It therefore has no platform filter at all: the answer spans
  // every chain the provider indexes and each row names its own `pid`. Requiring
  // one pinned platform of every row (what this validator did until 2026-09-15)
  // was checking the response against a parameter we were never entitled to send.
  //
  // What IS still required, fail-closed: three stage arrays, each no longer than
  // the `limit` we asked for, of bounded objects with a readable platform id; and
  // a row that claims one of OUR verified platforms must carry a valid address
  // for that platform. A row on an unverified chain is a legal answer here — it
  // is dropped later by cmcDexIdentity, never repaired into an identity.
  if(name==='dexMeme'){
   if(!d||typeof d!=='object'||Array.isArray(d))return false
   // An unbounded question has no bounded answer: without a limit we cannot tell
   // a full page from a truncated one, so the response is not accepted at all.
   const bound=cmcDexInteger(params.limit)
   if(bound==null||bound<1)return false
   return CMC_DEX_MEME_STAGES.every(stage=>{
    const list=(d as any)[stage]
    return Array.isArray(list)&&list.length<=bound&&list.every((r:any)=>{
     if(!r||typeof r!=='object'||Array.isArray(r))return false
     const id=cmcDexInteger(r.pid)
     if(id==null||id<1)return false
     const net=CMC_DEX_NETWORKS.find(n=>n.platformId===id)
     return net?cmcDexAddress(r.addr,net.platform):typeof r.addr==='string'&&/^[!-~]{1,200}$/.test(r.addr)
    })
   })
  }
  if(isDexDiscovery(name)){
   const lists=[d?.leaderboardList]
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
  // A ZERO-POOL answer is accepted and a non-empty page is validated exactly as
  // before: every row must be a pool on the requested chain and one of its two
  // legs must be the contract that was asked about. See cmcDexPoolPage for what
  // counts as empty and why. The empty case carries no row to identify and no
  // page to bound, so neither test applies to it.
  if(name==='dexPools'){
   const page=cmcDexPoolPage(d)
   if(!page)return false
   if(!page.rows.length)return true
   // `size` is NOT a bound on this page. The 2026-09-20 16:31 UTC depth run proved
   // it: 50 of 55 reads for tokens with many pools were refused here while the 5
   // tokens holding one or two pools passed, which is what an ignored page size
   // looks like (the holders list ignores `limit` the same way, see above). The
   // page is bounded by a sanity ceiling instead, every row is still identified
   // exactly as before, and callers take the rows they asked for.
   return page.rows.length<=CMC_DEX_POOL_PAGE_CEILING&&page.rows.every((r:any)=>cmcDexAddress(r?.addr,network.platform)&&(same(r.t0?.addr,address)||same(r.t1?.addr,address)))
  }
  // `ma` is the MAKER ADDRESS of the swap. Probed against the documented
  // /v1/dex/tokens/transactions body recorded in docs/investor-intel/live-on-chain-tape.md
  // (the 2026-09-15 BRETT-on-Base session), whose row is
  // {pid,f,bh,tp,pa,t0a,t1a,vu,q,t0pu,t1pu,tx,ts,qi,ma,ba,a0,a1,tii,t0s,t1s,...}.
  // It is OPTIONAL here on purpose: the provider does not promise it on every
  // row, and a swap that names no maker is still a real swap of this contract.
  // Such a row is kept WITHOUT a maker rather than dropped, because dropping it would
  // silently shrink the tape and make a volume total disagree with itself.
  // What is NOT tolerated is a maker that is not a valid account on the chain
  // that was asked about: that is a malformed answer, and this validator stays
  // fail-closed about identity exactly as it is for t0a/t1a and the holder page.
  if(name==='dexSwaps')return !!d&&Array.isArray(d.swaps)&&d.swaps.length<=Number(params.limit)&&d.swaps.every((r:any)=>(same(r.t0a,address)||same(r.t1a,address))&&typeof r.tx==='string'&&r.tx.length<=200&&cmcDexInteger(r.lgid)!=null&&(r.ma==null||cmcDexAddress(r.ma,network.platform)))&&(!d.lastId||isCmcDexCursor(d.lastId))
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
    // The container and the wallet key are read through cmcDexHolderPage /
    // cmcDexHolderAddress so a documented alias is not a malformed response.
    // Numbers arrive as strings here exactly as they do from tag_count, so no
    // numeric field is type-checked: the row mapping parses them instead.
    // The endpoint is unpaginated and ignores `limit`, so the bound is the
    // absolute ceiling, not the requested page (see CMC_DEX_HOLDER_RESPONSE_MAX).
    // What stays strict is identity: an address must be valid for the requested
    // platform, and a row that names another contract is refused.
    const page=cmcDexHolderPage(d)
    if(!page||!withinLimit(page.rows,CMC_DEX_HOLDER_RESPONSE_MAX))return false
    if(page.cursor!=null&&!isCmcDexCursor(page.cursor))return false
    return page.rows.every((r:any)=>{
      if(!r||typeof r!=='object'||Array.isArray(r)||!cmcDexAddress(cmcDexHolderAddress(r),network.platform))return false
      if(r.tokenAddress!=null&&!same(r.tokenAddress,address))return false
      const tags=r.tags==null?null:cmcDexHolderTagList(r.tags)
      return r.tags==null||(tags!=null&&tags.length<=CMC_HOLDER_TAGS.length&&tags.every(t=>t.length<=64))
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
