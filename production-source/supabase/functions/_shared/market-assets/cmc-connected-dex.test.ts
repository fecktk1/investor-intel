import {assertEquals as eq,assertThrows,assert} from 'jsr:@std/assert'
import {cmcDexIdentity,cmcDexPoolPage,cmcShapeSummary,validateCmcDexResponse,CMC_HOLDER_TAGS,CMC_DEX_HOLDER_RESPONSE_MAX} from './cmc-dex.ts'
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
Deno.test('holder pages carry only addresses valid for the requested chain',()=>{
 const params={platform:'ethereum',tokenAddress:address,tag:'tag_whale',limit:'2'}
 const holder={walletAddress:'0x'+'b'.repeat(40),tokenAddress:address,balance:'12',percent:'0.4',tags:['tag_whale'],fundingSource:'cex'}
 assert(validateCmcDexResponse('dexHolders',{data:{holders:[holder],lastId:'abc=='}},params))
 assert(validateCmcDexResponse('dexHolders',{data:{holders:[]}},params))
 // The endpoint ignores `limit` and returns the whole tag, so a longer answer is
 // still this answer; the requested limit is applied by cmcRows instead, and a
 // request with no limit at all is not thereby unbounded.
 assert(validateCmcDexResponse('dexHolders',{data:{holders:[holder,holder,holder]}},params))
 assert(validateCmcDexResponse('dexHolders',{data:{holders:[holder]}},{platform:'ethereum',tokenAddress:address,tag:'tag_whale'}))
 // A Solana mint is not an address on Ethereum.
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[{...holder,walletAddress:sol}]}},params),false)
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[{...holder,tokenAddress:'0x'+'c'.repeat(40)}]}},params),false)
 // Tags may legitimately be one comma string; a number is still not a tag list.
 assert(validateCmcDexResponse('dexHolders',{data:{holders:[{...holder,tags:'tag_whale'}]}},params))
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[{...holder,tags:7}]}},params),false)
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[holder],lastId:'x&url=evil'}},params),false)
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[[holder]]}},params),false)
})
Deno.test('every documented holder container, wallet key and string number is one page',()=>{
 const params={platform:'ethereum',tokenAddress:address,tag:'tag_kol',limit:'2'}
 const wallet='0x'+'b'.repeat(40)
 // Numbers arrive as strings from this family: the first live tag_count answered
 // hc:"253", hr:"0.000020" and hr:"0E-18" for zero, so no numeric field may be type-gated.
 const base={balance:'19994.083826086',percent:'0.000020',buyUsd:'12.5',sellUsd:'0E-18',realizedPnl:'-3.25',firstActiveTime:'1700000000',lastActiveTime:'1700003600'}
 const containers=[
  {data:{holders:[{walletAddress:wallet,...base}]}},               // published reference
  {data:{list:[{address:wallet,...base}]}},                        // alias container and key
  {data:[{holderAddress:wallet,...base}]},                         // bare data array
  {data:{holders:[{walletAddress:wallet,...base}],lastId:'abc=='}},// cursor present
  {data:{holders:[{walletAddress:wallet,...base}],nextId:12345}},  // numeric cursor alias
 ]
 for(const body of containers)assert(validateCmcDexResponse('dexHolders',body,params),JSON.stringify(body).slice(0,120))
 // Identity stays strict across every container; the absolute ceiling still bites.
 eq(validateCmcDexResponse('dexHolders',{data:{list:[{address:sol,...base}]}},params),false)
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[{walletAddress:wallet,tokenAddress:'0x'+'c'.repeat(40),...base}]}},params),false)
 eq(validateCmcDexResponse('dexHolders',{data:Array.from({length:CMC_DEX_HOLDER_RESPONSE_MAX+1},()=>({holderAddress:wallet}))},params),false)
 eq(validateCmcDexResponse('dexHolders',{data:{holders:[{...base}]}},params),false)
 eq(validateCmcDexResponse('dexHolders',{data:{rows:[{walletAddress:wallet}]}},params),false)
 // The row mapping reads the same aliases the validator accepted, and parses the
 // string numerics rather than dropping them.
 const projected=cmcRows('dexHolders',{data:{list:[{address:wallet,tags:'tag_kol,tag_whale',...base}],nextId:12345}})
 eq(projected.rows[0].walletAddress,wallet)
 eq(projected.rows[0].tags,['tag_kol','tag_whale'])
 eq(projected.rows[0].balance,'19994.083826086')
 eq(projected.rows[0].buyVolumeUsd,12.5)
 eq(projected.rows[0].sellVolumeUsd,0)
 eq(projected.rows[0].realizedPnlUsd,-3.25)
 eq(projected.rows[0].firstSeenAt,'1700000000')
 eq(projected.nextCursor,'12345')
 eq(cmcRows('dexHolders',{data:[{holderAddress:wallet,...base}]}).rows[0].walletAddress,wallet)
 eq(cmcRows('dexHolders',{data:[{holderAddress:wallet}]}).nextCursor,null)
 eq(cmcRows('dexHolders',{data:{rows:[]}}).rows,[])
})
Deno.test('an unpaginated whole-tag answer validates and is truncated to the requested limit',()=>{
 // 2026-09-15 05:00 UTC: the provider ignores `limit` — tag_smart_money returned 29
 // rows and tag_kol returned 253, both for a requested limit of 50. The 253-row
 // answer must cache, and only the 50 rows that were asked for may be kept.
 const params={platform:'base',tokenAddress:address,tag:'tag_kol',limit:'50'}
 const live=(i:number)=>({name:'Wallet '+i,tags:['tag_kol'],price:'0.0034',symbol:'TKN',balance:'19994.0838',logoUrl:'x',percent:'0.000020',
  tokenLogo:'x',platformId:199,publicName:'','spotOpenTs':'1700000000',blockHeight:'1',fundingTime:'1700000000',tokenSymbol:'TKN',
  totalSupply:'1E+9',tokenAddress:address,fundingSource:'binance',nativeBalance:'0E-18',walletAddress:'0x'+String(i).padStart(40,'a'),
  stableCoinFlag:0,firstActiveTime:'1700000000',spotClearanceTs:'0',platformCryptoId:1,dexerPlatformName:'Base',memePumpInnerFlag:0,addressExplorerUrl:'x'})
 const body={data:{holders:Array.from({length:253},(_,i)=>live(i))}}
 assert(validateCmcDexResponse('dexHolders',body,params))
 eq(cmcRows('dexHolders',body,params).rows.length,50)
 // Without params the registry ceiling of 250 still bounds what is kept.
 eq(cmcRows('dexHolders',body).rows.length,250)
 eq(cmcRows('dexHolders',body,{...params,limit:'400'}).rows.length,250)
 const row=cmcRows('dexHolders',body,params).rows[0]
 eq(row.walletAddress,'0x'+'0'.padStart(40,'a'))
 eq(row.fundingSource,'binance')
 eq(row.tags,['tag_kol'])
 // PROVIDER FACT: this endpoint returns no volume, PnL or transaction-count field,
 // so those stay null rather than being synthesised from anything else.
 for(const absent of ['buyVolumeUsd','sellVolumeUsd','realizedPnlUsd','unrealizedPnlUsd','txCount','lastSeenAt'])eq(row[absent],null,absent)
 eq(row.firstSeenAt,'1700000000')
 // Nothing that names or describes a person survives the whitelist.
 for(const dropped of ['name','publicName','symbol','price','totalSupply','addressExplorerUrl','stableCoinFlag','quote'])eq(dropped in row,false,dropped)
})
Deno.test('tag counts read the string numerics the live capture actually returned',()=>{
 // Verbatim from the first real capture (base 0x8d01…): every number a string,
 // "0E-18" for a zero ratio, and the container carrying platformId and tokenAddress.
 const contract='0x8d01ebde5e01b0917daad6f84372484084226207'
 const params={platform:'base',tokenAddress:contract}
 const body={data:{holders:[{hc:'253',hr:'0.000020',tb:'19994.083826086',tag:'tag_kol'},{hc:'0',hr:'0E-18',tb:'0E-18',tag:'tag_dev'}],platformId:199,tokenAddress:contract}}
 assert(validateCmcDexResponse('dexHolderTags',body,params))
 eq(cmcRows('dexHolderTags',body).rows,[{tag:'tag_kol',hc:253,tb:19994.083826086,hr:0.00002},{tag:'tag_dev',hc:0,tb:0,hr:0}])
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
Deno.test('a token with NO pool is a zero-row answer, not a malformed one; a broken body still is',async()=>{
 // PRODUCTION, 2026-09-20 15:45 UTC: three permissioned tokenised funds on
 // Ethereum were each answered HTTP 200 with error_code 0 and nothing usable
 // under `data`, and each was refused `malformed_response` for one credit. That
 // made "this fund has no public pool" - the finding the RWA depth lane exists to
 // report - indistinguishable from "the provider broke".
 const params={platform:'ethereum',address,size:'20'}
 for(const empty of [null,undefined,[],{},{pools:[]},{list:[]},{pairs:[]}]){
  assert(validateCmcDexResponse('dexPools',{data:empty},params),`empty shape rejected: ${JSON.stringify(empty)??'undefined'}`)
  eq(cmcDexPoolPage(empty)?.rows,[])
 }
 // A body with no `data` key at all is the same zero-row answer here.
 assert(validateCmcDexResponse('dexPools',{status:{error_code:0}},params))
 // NOTHING ELSE IS RELAXED. A non-empty body is validated exactly as before.
 const row={addr:'0x'+'c'.repeat(40),t0:{addr:address},t1:{addr:'0x'+'b'.repeat(40)},pubAt:at-1000,liqUsd:0}
 assert(validateCmcDexResponse('dexPools',{data:[row]},params))
 assert(validateCmcDexResponse('dexPools',{data:{pools:[row]}},params),'a documented container carrying rows is read, and its rows are checked')
 eq(validateCmcDexResponse('dexPools',{data:{pools:[{...row,t0:{addr:'0x'+'d'.repeat(40)},t1:{addr:'0x'+'e'.repeat(40)}}]}},params),false)
 // An object that is neither empty nor a documented container is not a page.
 eq(cmcDexPoolPage({unexpected:1}),null)
 eq(validateCmcDexResponse('dexPools',{data:{unexpected:1}},params),false)
 eq(cmcDexPoolPage('no pools'),null)
 eq(validateCmcDexResponse('dexPools',{data:'no pools'},params),false)
 // `size` is not a bound: production (2026-09-20) showed the provider ignores it,
 // and refusing a longer page threw away every token that has many pools. A longer
 // page of valid rows is accepted; only a runaway body is refused.
 eq(validateCmcDexResponse('dexPools',{data:Array.from({length:21},()=>row)},params),true)
 eq(validateCmcDexResponse('dexPools',{data:Array.from({length:1001},()=>row)},params),false)
 // The pool `addr` is a pool id, not an account: the shapes below are the three
 // seen in production on 2026-09-20 (v2/v3 contract, Uniswap v4 bytes32, Solana hex).
 eq(validateCmcDexResponse('dexPools',{data:[{...row,addr:'0x0001e0226b92d6b13ea8718f7e40413172f54adc837abd7a8322b0ec047cc277'}]},params),true)
 {const mint='XsQLZycSZ7QnBBdBXQaTbQdiUcbRqjNJgyBGAMzhHav',sol={platform:'solana',address:mint,size:'20'}
  eq(validateCmcDexResponse('dexPools',{data:[{addr:'fe4717079183c0ee97a6a844a885332447d9833e3333',t0:{addr:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',sym:'USDC'},t1:{addr:mint,sym:'MUx'}}]},sol),true)
  // Solana legs stay case-exact.
  eq(validateCmcDexResponse('dexPools',{data:[{addr:'fe4717079183c0ee97a6a844a885332447d9833e3333',t0:{addr:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'},t1:{addr:mint.toLowerCase()}}]},sol),false)}
 // A pool id that is not a bounded opaque token is refused.
 eq(validateCmcDexResponse('dexPools',{data:[{...row,addr:'0xabc<script>'}]},params),false)
 eq(validateCmcDexResponse('dexPools',{data:[{...row,addr:'a'.repeat(101)}]},params),false)
 // One row that is not a pool of this contract still refuses the whole page.
 eq(validateCmcDexResponse('dexPools',{data:[row,{...row,t0:{addr:'0x0000000000000000000000000000000000000001'},t1:{addr:'0x0000000000000000000000000000000000000002'}}]},params),false)
 // A zero-pool answer normalises to no observation, exactly as a read page does.
 eq((await normalizeCmcInvestigation('dexPools',{data:null},params,stamp,expiry,expiry)).observations,[])
})
Deno.test('a shape summary names keys and lengths and never a value',()=>{
 const summary=cmcShapeSummary({pools:[],lastId:'abc',nested:{a:1}})
 eq(summary.includes('abc'),false)
 eq(summary.includes('pools:array[0]'),true)
 eq(cmcShapeSummary(null),'null')
 eq(cmcShapeSummary(undefined),'absent')
 eq(cmcShapeSummary([1,2,3]),'array[3]')
 // Bounded: a wide or deep body cannot become a long log line.
 const wide=Object.fromEntries(Array.from({length:40},(_,i)=>[`k${i}`,i]))
 assert(cmcShapeSummary(wide).length<=120)
})
