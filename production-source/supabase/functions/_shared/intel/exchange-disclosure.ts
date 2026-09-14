import {digest,stableJson} from './investigation-evidence.ts'
const positiveId=(v:any)=>(typeof v==='number'||typeof v==='string')&&/^[1-9][0-9]{0,11}$/.test(String(v))?String(v):null
const number=(v:any)=>v==null||v===''||typeof v==='boolean'?null:Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null

/** Product selection is not a provider parameter: all assets reuse one exchange
 * response and the same budget reservation/cache key. */
export function exchangeDisclosureParams(input:any):{id:string;start:number;limit:number;assetId?:string} {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['id','start','limit','assetId'].includes(k)))throw Error('invalid_disclosure_request')
 const id=positiveId(input.id),assetId=input.assetId==null?undefined:positiveId(input.assetId),start=input.start??1,limit=input.limit??25
 if(!id||assetId===null||!Number.isInteger(start)||start<1||start>10000||!Number.isInteger(limit)||limit<1||limit>100)throw Error('invalid_disclosure_request')
 return {id,start,limit,...(assetId?{assetId}:{})}
}

/** Aggregate the whole bounded response before pagination. Missing valuations,
 * conflicting duplicates and incomplete source coverage are never a denominator. */
export function aggregateExchangeDisclosure(body:any,exchangeId:string,start=1,limit=25,assetId?:string) {
 if(!positiveId(exchangeId)||!Number.isInteger(start)||start<1||start>10000||!Number.isInteger(limit)||limit<1||limit>100)throw Error('invalid_disclosure_request')
 if(assetId!=null&&!positiveId(assetId))throw Error('invalid_disclosure_request')
 const raw=body?.data
 if(!Array.isArray(raw)||raw.length>10000)throw Error('malformed_exchange_disclosure')
 const groups=new Map<string,any>(),conflicts=new Set<string>();let invalid=0,duplicates=0,selectedInvalid=0
 for(const r of raw){
  const currencyId=positiveId(r?.currency?.crypto_id),platformId=positiveId(r?.platform?.crypto_id),wallet=typeof r?.wallet_address==='string'&&r.wallet_address.length<=200?r.wallet_address:null,balance=number(r?.balance),price=number(r?.currency?.price_usd)
  if(!currencyId||!platformId||!wallet||balance==null){invalid++;if(assetId&&currencyId===assetId)selectedInvalid++;continue}
  const walletKey=/^0x[a-fA-F0-9]{40}$/.test(wallet)?wallet.toLowerCase():wallet
  const key=JSON.stringify([platformId,walletKey,currencyId]),old=groups.get(key)
  if(old){if(old.balance===balance&&old.price===price)duplicates++;else conflicts.add(key);continue}
  groups.set(key,{currencyId,platformId,wallet:walletKey,balance,price,symbol:String(r.currency.symbol||'').slice(0,40),name:String(r.currency.name||'').slice(0,160),platformName:String(r.platform.name||'').slice(0,160)})
 }
 const assets=new Map<string,any>(),chains=new Map<string,any>(),wallets=new Set<string>(),selectedNetworks=new Map<string,any>();let pricedUsd=0,unpriced=0,selectedConflicts=0
 for(const [key,r]of groups){
  if(conflicts.has(key)){if(r.currencyId===assetId)selectedConflicts++;continue}
  const usd=r.price==null?null:r.balance*r.price
  if(usd!=null&&!Number.isFinite(usd))throw Error('malformed_exchange_valuation')
  if(usd==null)unpriced++;else pricedUsd+=usd
  wallets.add(JSON.stringify([r.platformId,r.wallet]))
  const a=assets.get(r.currencyId)||{id:r.currencyId,symbol:r.symbol,name:r.name,quantity:0,pricedUsd:0,unpricedRecords:0,records:0,platforms:new Set<string>()}
  a.quantity+=r.balance;a.pricedUsd+=usd??0;a.records++;a.unpricedRecords+=usd==null?1:0;a.platforms.add(r.platformId);assets.set(r.currencyId,a)
  const c=chains.get(r.platformId)||{id:r.platformId,name:r.platformName,pricedUsd:0,unpricedRecords:0,records:0};c.pricedUsd+=usd??0;c.records++;c.unpricedRecords+=usd==null?1:0;chains.set(r.platformId,c)
  if(r.currencyId===assetId){const n=selectedNetworks.get(r.platformId)||{id:r.platformId,name:r.platformName,quantity:0,pricedUsd:0,unpricedRecords:0,records:0};n.quantity+=r.balance;n.pricedUsd+=usd??0;n.records++;n.unpricedRecords+=usd==null?1:0;selectedNetworks.set(r.platformId,n)}
 }
 if(!Number.isFinite(pricedUsd)||[...assets.values()].some(a=>!Number.isFinite(a.quantity)))throw Error('malformed_exchange_valuation')
 const ordered=[...assets.values()].map(a=>({...a,platforms:[...a.platforms],shareOfPricedPercent:pricedUsd>0?a.pricedUsd/pricedUsd*100:null})).sort((a,b)=>b.pricedUsd-a.pricedUsd||Number(a.id)-Number(b.id))
 const rows=ordered.slice(start-1,start-1+limit)
 const selected=assetId?ordered.find(a=>a.id===assetId)||null:null
 const selectedAsset=assetId?{subject:`market:coinmarketcap:${assetId}`,assetId,state:selected?(selected.unpricedRecords||selectedInvalid||selectedConflicts?'partial':'reported'):selectedInvalid||selectedConflicts?'excluded':'not_reported',asset:selected,invalidRecords:selectedInvalid,conflictingRecords:selectedConflicts,networks:[...selectedNetworks.values()].sort((a,b)=>b.pricedUsd-a.pricedUsd||Number(a.id)-Number(b.id)).slice(0,100),networkTotal:selectedNetworks.size,networksTruncated:selectedNetworks.size>100}:null
 return {rows,total:ordered.length,hasMore:start-1+limit<ordered.length,exchangeId,selectedAsset,chains:[...chains.values()].sort((a,b)=>b.pricedUsd-a.pricedUsd).slice(0,100),chainTotal:chains.size,chainsTruncated:chains.size>100,
  summary:{reportedRecords:raw.length,uniqueRecords:groups.size-conflicts.size,reportedWallets:wallets.size,duplicateRecords:duplicates,conflictingRecords:conflicts.size,invalidRecords:invalid,unpricedRecords:unpriced,pricedUsd},
  coverage:invalid||conflicts.size||unpriced?'partial':raw.length?'reported':'empty',observedAt:null,
  caveat:'Third-party wallet disclosures cover wallets reported with at least $100,000. Balances may be delayed. This is not a complete asset inventory, audited reserves, liabilities or proof of solvency. Shares use only the priced, non-conflicting records in this response. Balance and price observation times are unreported.'}
}

/** A durable source reference contains no balances, prices or wallet addresses.
 * It identifies the complete response reviewed, independent of the UI page.
 * Current source policy does not permit embedding CMC values in exports. */
export async function exchangeDisclosureReference(body:any,exchangeId:string,provenance:any,assetId?:string) {
 if(!positiveId(exchangeId)||!Array.isArray(body?.data)||body.data.length>10000||!Number.isFinite(Date.parse(provenance?.fetchedAt)))throw Error('invalid_disclosure_reference')
 if(assetId!=null&&!positiveId(assetId))throw Error('invalid_disclosure_reference')
 return {schemaVersion:1,provider:'coinmarketcap',subject:`exchange:coinmarketcap:${exchangeId}`,...(assetId?{selectedSubject:`market:coinmarketcap:${assetId}`} : {}),endpoint:'/v1/exchange/assets',
  sourceUrl:'https://coinmarketcap.com/api/documentation/pro-api-reference/exchange',
  payloadHash:await digest(stableJson({exchangeId,data:body.data})),retrievedAt:provenance.fetchedAt,observedAt:null,
  timeMeaning:'Retrieval time identifies the response reviewed; balance and price observation times are unreported.',
  replay:'references_only',method:'exchange-disclosure-1',coverage:'Third-party reported wallets; not audited reserves or evidence of solvency.'}
}
