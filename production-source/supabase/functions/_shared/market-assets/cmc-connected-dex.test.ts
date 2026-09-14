import {assertEquals as eq,assertThrows,assert} from 'jsr:@std/assert'
import {cmcDexIdentity,validateCmcDexResponse} from './cmc-dex.ts'
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
Deno.test('pool creation time cannot become liquidity observation time; exact token legs are required',async()=>{
 const params={platform:'ethereum',address,size:'12'},row={addr:'0x'+'c'.repeat(40),t0:{addr:address},t1:{addr:'0x'+'b'.repeat(40)},pubAt:at-1000,liqUsd:0}
 assert(validateCmcDexResponse('dexPools',{data:[row]},params))
 eq(validateCmcDexResponse('dexPools',{data:[{...row,t0:{addr:'0x'+'d'.repeat(40)}}]},params),false)
 eq((await normalizeCmcInvestigation('dexPools',{data:[row]},params,stamp,expiry,expiry)).observations,[])
})
