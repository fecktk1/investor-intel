import {assertEquals as eq,assertThrows,assert} from 'jsr:@std/assert'
import {cmcDexIdentity,validateCmcDexResponse,CMC_HOLDER_TAGS} from './cmc-dex.ts'
import {cmcParams,cmcRows} from './cmc-capabilities.ts'
import {normalizeCmcInvestigation} from '../intel/investigation-normalize.ts'
const address='0x'+'a'.repeat(40),sol='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',at=Date.parse('2026-09-12T03:00:00Z'),stamp=new Date(at).toISOString(),expiry=new Date(at+900000).toISOString()
Deno.test('Base and Arbitrum use distinct CMC platform IDs and Solana addresses remain case-sensitive',()=>{
 eq(cmcDexIdentity(`eip155:8453/erc20:${address}`)?.platformId,199);eq(cmcDexIdentity(`eip155:42161:${address}`)?.platformId,51)
 eq(cmcDexIdentity(`solana:mainnet/spl:${sol}`)?.subject,`solana:${sol}`)
 assert(validateCmcDexResponse('dexToken',{data:{pid:199,addr:address}},{platform:'base',address}))
 eq(validateCmcDexResponse('dexToken',{data:{pid:8453,addr:address}},{platform:'base',address}),false)
 eq(validateCmcDexResponse('dexToken',{data:{pid:1,addr:address}},{platform:'arbitrum',address}),false)
 eq(validateCmcDexResponse('dexToken',{data:{pid:16,addr:sol.toLowerCase()}},{platform:'solana',address:sol}),false)
})
Deno.test('discovery POST params are bounded scalars and distinct stage/source states survive projection',()=>{
 const p=cmcParams('dexTrending',{platformIds:199,pageSize:12})
 eq(p,{interval:'24h',pageSize:'12',platformIds:'199'})
 for(const bad of [{platformIds:'1,199'},{pageSize:26},{url:'https://evil.test'},{filter:{maker:'private'}},{nextPageIndex:'x&url=evil'}])assertThrows(()=>cmcParams('dexTrending',bad))
 const row={pid:199,addr:address,n:'Same',sym:'DUP',p:0,pt:String(at-1000),ts:'1000000'}
 assert(validateCmcDexResponse('dexNew',{data:{leaderboardList:[row],nextPageIndex:'abc==' }},p))
 eq(validateCmcDexResponse('dexNew',{data:{leaderboardList:[{...row,pid:1}]}},p),false)
 const r=cmcRows('dexNew',{data:{leaderboardList:[row],total:'30',nextPageIndex:'abc=='}})
 eq(r.total,30);eq(r.nextCursor,'abc==');eq(r.rows[0].quote.price,0);eq(r.rows[0].quote.last_updated,new Date(at-1000).toISOString());eq(r.rows[0].canonicalKey,`eip155:8453:${address}`)
 eq(cmcRows('dexMeme',{data:{newCreations:[],aboutGraduates:[],graduates:[]}}).rows,[])
 eq(validateCmcDexResponse('dexMeme',{data:{}},p),false)
})
Deno.test('public swaps preserve zeros, execution provenance, excluded flags and separate logs across pages',async()=>{
 const params={platform:'base',address,limit:'25'},row={t0a:address,t1a:'0x'+'b'.repeat(40),ts:String(at-1000),tp:'sell',tx:'0x123',lgid:'2',a0:0,a1:5,v:0,t0pu:0,t1pu:1,ex:true,txtp:1}
 const a=await normalizeCmcInvestigation('dexSwaps',{data:{swaps:[row,{...row,lgid:'3'}]}},params,stamp,expiry,expiry)
 eq(a.observations.length,2);assert(a.observations[0].id!==a.observations[1].id);eq(a.observations[0].subject,`eip155:8453:${address}`)
 eq(a.observations[0].value,0);eq(a.observations[0].metadata?.baseQuantity,0);eq(a.observations[0].metadata?.excluded,true)
 const b=await normalizeCmcInvestigation('dexSwaps',{data:{swaps:[row]}},{...params,lastId:'previous',limit:'1'},stamp,expiry,expiry)
 eq(a.observations[0].id,b.observations[0].id);eq(a.observations[0].observedAt,new Date(at-1000).toISOString())
})
Deno.test('holder tag counts accept only the eight published tags, once each, for the requested contract',()=>{
 const params={platform:'ethereum',tokenAddress:address}
 const row={tag:'tag_whale',hc:5,tb:'900.5',hr:'0.25'}
 assert(validateCmcDexResponse('dexHolderTags',{data:{platformId:1,tokenAddress:address,holders:[row]}},params))
 assert(validateCmcDexResponse('dexHolderTags',{data:{holders:CMC_HOLDER_TAGS.map(tag=>({...row,tag}))}},params))
 // Over the published tag set, an unknown label, a repeated tag, another
 // contract, another platform, or an unreadable count are each a rejection.
 eq(validateCmcDexResponse('dexHolderTags',{data:{holders:[...CMC_HOLDER_TAGS.map(tag=>({...row,tag})),{...row,tag:'tag_dev'}]}},params),false)
 eq(validateCmcDexResponse('dexHolderTags',{data:{holders:[{...row,tag:'tag_person'}]}},params),false)
 eq(validateCmcDexResponse('dexHolderTags',{data:{holders:[row,{...row}]}},params),false)
 eq(validateCmcDexResponse('dexHolderTags',{data:{tokenAddress:'0x'+'b'.repeat(40),holders:[row]}},params),false)
 eq(validateCmcDexResponse('dexHolderTags',{data:{platformId:199,holders:[row]}},params),false)
 eq(validateCmcDexResponse('dexHolderTags',{data:{holders:[{...row,hc:'many'}]}},params),false)
 eq(validateCmcDexResponse('dexHolderTags',{data:{holders:[{...row,hr:'2500'}]}},params),false)
 eq(validateCmcDexResponse('dexHolderTags',{data:[row]},params),false)
 eq(validateCmcDexResponse('dexHolderTags',{data:{holders:[row]}},{platform:'plasma',tokenAddress:address}),false)
})
Deno.test('holder pages stay inside the requested page and only carry addresses valid for the requested chain',()=>{
 const params={platform:'ethereum',tokenAddress:address,tag:'tag_whale',limit:'2'}
 const holder={walletAddress:'0x'+'b'.repeat(40),tokenAddress:address,balance:'12',percent:'0.4',tags:['tag_whale'],fundingSource:'cex'}
 assert(validateCmcDexResponse('dexHolders',{data:{holders:[holder],lastId:'abc=='}},params))
 assert(validateCmcDexResponse('dexHolders',{data:{holders:[]}},params))
 // A page longer than the one that was asked for is not that page.
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[holder,holder,holder]}},params),false)
 // A Solana mint is not an address on Ethereum, and an unbounded page is refused.
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[{...holder,walletAddress:sol}]}},params),false)
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[holder]}},{platform:'ethereum',tokenAddress:address,tag:'tag_whale'}),false)
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[{...holder,tokenAddress:'0x'+'c'.repeat(40)}]}},params),false)
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[{...holder,tags:'tag_whale'}]}},params),false)
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[holder],lastId:'x&url=evil'}},params),false)
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[[holder]]}},params),false)
})
Deno.test('k-line pages stay bounded, numeric and forward in time',()=>{
 const params={platform:'ethereum',address,interval:'1h',limit:'3'}
 const bar=[1,2,0.5,1.5,100,1700000000,7]
 assert(validateCmcDexResponse('dexCandles',{data:[bar,[1,2,0.5,1.5,100,1700003600,7]]},params))
 assert(validateCmcDexResponse('dexCandles',{data:{candles:[bar]}},params))
 assert(validateCmcDexResponse('dexCandles',{data:[[1,2,0.5,1.5,100,1700000000]]},params))
 eq(validateCmcDexResponse('dexCandles',{data:[bar,bar,bar,bar]},params),false)
 // A clock that runs backwards inside one page is not one period series.
 eq(validateCmcDexResponse('dexCandles',{data:[[1,2,0.5,1.5,100,1700003600,7],bar]},params),false)
 eq(validateCmcDexResponse('dexCandles',{data:[[1,2,0.5,1.5,100,'later',7]]},params),false)
 eq(validateCmcDexResponse('dexCandles',{data:[[1,2,0.5,1.5,100]]},params),false)
 eq(validateCmcDexResponse('dexCandles',{data:[[1,2,0.5,1.5,100,1700000000,7,9]]},params),false)
 eq(validateCmcDexResponse('dexCandles',{data:[{o:1,h:2,l:0.5,c:1.5,v:100,t:1700000000}]},params),false)
 eq(validateCmcDexResponse('dexCandles',{data:[bar]},{platform:'ethereum',address}),false)
})
Deno.test('search results are bounded, and a recognised platform must carry a valid address for it',()=>{
 const params={q:'paxg',limit:'2'}
 const known={pltId:1,plt:'ethereum',n:'Paxos Gold',s:'PAXG',addr:address,pu:'2600'}
 // Free text searches every indexed chain, so an unverified platform row is kept
 // as an opaque bounded token rather than rejected or promoted to an identity.
 const foreign={pltId:9999,plt:'unverified',n:'Other',s:'OTH',addr:'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'}
 assert(validateCmcDexResponse('dexSearch',{data:{total:2,tks:[known,foreign]}},params))
 eq(validateCmcDexResponse('dexSearch',{data:{total:9,tks:[known,foreign,known]}},params),false)
 // A row that claims a verified platform must carry an address valid for it.
 eq(validateCmcDexResponse('dexSearch',{data:{tks:[{...known,addr:sol}]}},params),false)
 eq(validateCmcDexResponse('dexSearch',{data:{tks:[{...foreign,addr:'has space'}]}},params),false)
 eq(validateCmcDexResponse('dexSearch',{data:{tks:[{...known,pltId:'ethereum'}]}},params),false)
 eq(validateCmcDexResponse('dexSearch',{data:{tks:[known]}},{q:'paxg'}),false)
 eq(validateCmcDexResponse('dexSearch',{data:[known]},params),false)
 eq(validateCmcDexResponse('dexSearch',{data:{total:'many',tks:[known]}},params),false)
 // A pinned platform binds every row to it.
 assert(validateCmcDexResponse('dexSearch',{data:{tks:[known]}},{...params,platform:'ethereum'}))
 eq(validateCmcDexResponse('dexSearch',{data:{tks:[known,foreign]}},{...params,platform:'ethereum'}),false)
 eq(validateCmcDexResponse('dexSearch',{data:{tks:[known]}},{...params,platform:'plasma'}),false)
})
Deno.test('a batch answer never returns an address that was not asked for',()=>{
 const other='0x'+'b'.repeat(40),params={platform:'ethereum',addresses:`${address},${other}`}
 const row={n:'Paxos Gold',sym:'PAXG',addr:address,plt:'ethereum',pid:1,p:'2600',liqUsd:'1'}
 assert(validateCmcDexResponse('dexBatch',{data:[row]},params))
 // The provider echoes checksummed hex; identity comparison stays case-folded on EVM.
 assert(validateCmcDexResponse('dexBatch',{data:[{...row,addr:address.toUpperCase().replace('0X','0x')}]},params))
 eq(validateCmcDexResponse('dexBatch',{data:[{...row,addr:'0x'+'c'.repeat(40)}]},params),false)
 eq(validateCmcDexResponse('dexBatch',{data:[{...row,pid:199}]},params),false)
 eq(validateCmcDexResponse('dexBatch',{data:[row,{...row,addr:other},row]},params),false)
 eq(validateCmcDexResponse('dexBatch',{data:[row,row]},params),false)
 eq(validateCmcDexResponse('dexBatch',{data:[{...row,addr:sol}]},params),false)
 eq(validateCmcDexResponse('dexBatch',{data:{tokens:[row]}},params),false)
 eq(validateCmcDexResponse('dexBatch',{data:[row]},{platform:'plasma',addresses:address}),false)
 eq(validateCmcDexResponse('dexBatch',{data:[row]},{platform:'ethereum',addresses:''}),false)
})
Deno.test('price batch rows match a requested chain and address and carry a finite non-negative price or null',()=>{
 const params={tokens:`ethereum:${address},solana:${sol}`}
 const evm={pid:1,pdex:'uniswap',a:address,n:'Paxos Gold',sym:'PAXG',p:2600.5,pc24h:-1.2,l:10,mc:1}
 const spl={pid:16,a:sol,n:'USD Coin',sym:'USDC',p:null}
 assert(validateCmcDexResponse('dexPriceBatch',{data:[evm,spl]},params))
 assert(validateCmcDexResponse('dexPriceBatch',{data:[{...evm,p:'0'}]},params))
 eq(validateCmcDexResponse('dexPriceBatch',{data:[evm,spl,evm]},params),false)
 // Base was never asked about, so a Base row is not an answer to this request.
 eq(validateCmcDexResponse('dexPriceBatch',{data:[{...evm,pid:199}]},params),false)
 eq(validateCmcDexResponse('dexPriceBatch',{data:[{...evm,a:'0x'+'b'.repeat(40)}]},params),false)
 eq(validateCmcDexResponse('dexPriceBatch',{data:[{...evm,pid:16,a:address}]},params),false)
 eq(validateCmcDexResponse('dexPriceBatch',{data:[{...evm,p:-1}]},params),false)
 eq(validateCmcDexResponse('dexPriceBatch',{data:[{...evm,p:'about 2600'}]},params),false)
 eq(validateCmcDexResponse('dexPriceBatch',{data:[evm,evm]},params),false)
 eq(validateCmcDexResponse('dexPriceBatch',{data:{tokens:[evm]}},params),false)
 eq(validateCmcDexResponse('dexPriceBatch',{data:[evm]},{tokens:`plasma:${address}`}),false)
})
Deno.test('pool creation time cannot become liquidity observation time; exact token legs are required',async()=>{
 const params={platform:'ethereum',address,size:'12'},row={addr:'0x'+'c'.repeat(40),t0:{addr:address},t1:{addr:'0x'+'b'.repeat(40)},pubAt:at-1000,liqUsd:0}
 assert(validateCmcDexResponse('dexPools',{data:[row]},params))
 eq(validateCmcDexResponse('dexPools',{data:[{...row,t0:{addr:'0x'+'d'.repeat(40)}}]},params),false)
 eq((await normalizeCmcInvestigation('dexPools',{data:[row]},params,stamp,expiry,expiry)).observations,[])
})
