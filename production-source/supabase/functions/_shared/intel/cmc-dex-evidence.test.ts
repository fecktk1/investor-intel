import {assertEquals as eq,assert} from 'jsr:@std/assert'
import {dexEvidenceRows} from './cmc-dex-evidence.ts'
import {normalizeCmcInvestigation} from './investigation-normalize.ts'
import {CMC_HOLDER_TAGS} from '../market-assets/cmc-dex.ts'
const address='0x'+'a'.repeat(40),subject=`eip155:1:${address}`
const tagParams={platform:'ethereum',tokenAddress:address}
const tagBody=(holders:any[])=>({data:{platformId:1,tokenAddress:address,holders}})
const MAKER='0x'+'19'.repeat(20),QUOTE='0x'+'cc'.repeat(20)
const swapParams={platform:'ethereum',address,limit:'5'}
const swapBody=(swaps:any[])=>({data:{swaps}})
const swapRow=(patch:any={})=>({tx:'0xfeed',lgid:3,v:250,tp:'buy',en:'Uniswap v3',t0a:address,t1a:QUOTE,
 a0:2,a1:1,t0pu:125,t1pu:250,ma:MAKER,ts:1700000000,...patch})

Deno.test('holder tag counts become per-tag account rows with no provider clock',()=>{
 const rows=dexEvidenceRows('dexHolderTags',tagBody([{tag:'tag_whale',hc:12,tb:'900.5',hr:'0.25'},{tag:'tag_dev',hc:1,tb:'5',hr:'0.01'}]),tagParams)
 eq(rows.length,2)
 eq(rows[0].subject,subject)
 eq(rows[0].metric,'holder_tag_count')
 eq(rows[0].value,12)
 eq(rows[0].unit,'accounts')
 // The provider dates nothing here: the capture time is the only clock, so the
 // caller must supply it rather than this file inventing one.
 eq(rows[0].observed,null)
 eq(rows[0].metadata.tag,'tag_whale')
 eq(rows[0].metadata.balance,'900.5')
 eq(rows[0].metadata.ratio,'0.25')
 eq(rows[0].metadata.chain,'ethereum')
 eq(rows[0].metadata.contract,address)
 eq(rows[0].periodSeconds,undefined)
 assert(String(rows[0].metadata.population).includes('not people'))
 // A ratio whose unit the provider never states is never relabelled as a percentage.
 eq(rows[0].metadata.ratioUnit,'unknown')
 eq(rows[1].metadata.tag,'tag_dev')
 eq(dexEvidenceRows('dexHolderTags',tagBody(CMC_HOLDER_TAGS.map(tag=>({tag,hc:1,tb:'1',hr:'0'}))),tagParams).length,8)
})

Deno.test('a tag response that does not answer this request produces no evidence',()=>{
 // Foreign contract, unverified platform, unknown label, unreadable count and a
 // page longer than the published tag set are each zero rows, never partial ones.
 eq(dexEvidenceRows('dexHolderTags',tagBody([{tag:'tag_whale',hc:1,tb:'1',hr:'0'}]),{platform:'ethereum',tokenAddress:'0x'+'b'.repeat(40)}),[])
 eq(dexEvidenceRows('dexHolderTags',tagBody([{tag:'tag_whale',hc:1,tb:'1',hr:'0'}]),{platform:'plasma',tokenAddress:address}),[])
 eq(dexEvidenceRows('dexHolderTags',tagBody([{tag:'tag_person',hc:1,tb:'1',hr:'0'}]),tagParams),[])
 eq(dexEvidenceRows('dexHolderTags',tagBody([{tag:'tag_whale',hc:'many',tb:'1',hr:'0'}]),tagParams),[])
 eq(dexEvidenceRows('dexHolderTags',tagBody([...CMC_HOLDER_TAGS,'tag_dev'].map(tag=>({tag,hc:1,tb:'1',hr:'0'}))),tagParams),[])
 eq(dexEvidenceRows('dexHolderTags',{data:{holders:[]}},tagParams),[])
})

Deno.test('candles and holder pages are not observations of this contract',()=>{
 // A k-line row is a provider aggregate over a named period, not a fact observed
 // at an instant, and it is not the same quantity as the `price` metric this file
 // records. Candles reach the app through cmcRows and the chart lane instead.
 eq(dexEvidenceRows('dexCandles',{data:[[1,2,0.5,1.5,100,1700000000,7]]},{platform:'ethereum',address,limit:'3'}),[])
 // Individual holder rows are classified addresses, never dated observations.
 eq(dexEvidenceRows('dexHolders',{data:{holders:[{walletAddress:'0x'+'b'.repeat(40),balance:'1'}]}},{...tagParams,tag:'tag_whale',limit:'2'}),[])
 // Lookup and batch families answer about other subjects and are not contract evidence.
 eq(dexEvidenceRows('dexSearch',{data:{tks:[{pltId:1,addr:address}]}},{q:'paxg',limit:'2'}),[])
 eq(dexEvidenceRows('dexBatch',{data:[{pid:1,addr:address}]},{platform:'ethereum',addresses:address}),[])
 eq(dexEvidenceRows('dexPriceBatch',{data:[{pid:1,a:address,p:1}]},{tokens:`ethereum:${address}`}),[])
})

Deno.test('a public swap keeps the maker account the provider names',()=>{
 const rows=dexEvidenceRows('dexSwaps',swapBody([swapRow()]),swapParams)
 eq(rows.length,1)
 eq(rows[0].metric,'swap_event_usd')
 eq(rows[0].value,250)
 // The maker (`ma`) was discarded by this parser until 2026-09-16. It is the one
 // account a swap names and the only thing a per-wallet cohort can be built from.
 eq(rows[0].metadata.maker,MAKER)
 // EVM checksum casing folds to one account, so one address is one cohort key.
 eq(dexEvidenceRows('dexSwaps',swapBody([swapRow({ma:MAKER.toUpperCase().replace('0X','0x')})]),swapParams)[0].metadata.maker,MAKER)
 // The scope keeps its register and now says what a maker is.
 const scope=String(rows[0].metadata.scope)
 eq(scope.startsWith('Reported public swap; not a personal trade.'),true)
 assert(scope.includes('not a person'))
 // A Solana maker keeps its exact base58 form and is not lower-cased.
 const mint='So11111111111111111111111111111111111111112',other='11111111111111111111111111111111'
 const sol=dexEvidenceRows('dexSwaps',{data:{swaps:[{tx:'0x1',lgid:1,v:5,tp:'sell',t0a:mint,t1a:other,ma:other,ts:1700000000}]}},{platform:'solana',address:mint,limit:'5'})
 eq(sol[0].metadata.maker,other)
})

Deno.test('a swap keeps the per-leg direction the provider states for each leg',()=>{
 // LIVE PROBE 2026-09-16, /v1/dex/tokens/transactions: rows carry `t0pt`/`t1pt`,
 // observed as "reduce" and "add". They are what lets the cohort READ a direction
 // instead of inferring one from the buy/sell word.
 const rows=dexEvidenceRows('dexSwaps',swapBody([swapRow({tp:'sell',t0pt:'reduce',t1pt:'add'})]),swapParams)
 eq(rows[0].metadata.baseDirection,'reduce')
 eq(rows[0].metadata.quoteDirection,'add')
 // Stored VERBATIM. The vocabulary is undocumented, so a word we have not seen
 // reaches the consumer as what the provider actually said, neither normalised
 // into a known value nor dropped here.
 eq(dexEvidenceRows('dexSwaps',swapBody([swapRow({t0pt:'rebalance'})]),swapParams)[0].metadata.baseDirection,'rebalance')
 // A row that states no direction says so with null, never a guess. The swap is
 // still kept, and the consumer falls back to the buy/sell word.
 const bare=dexEvidenceRows('dexSwaps',swapBody([swapRow({t0pt:undefined,t1pt:undefined})]),swapParams)
 eq(bare.length,1)
 eq([bare[0].metadata.baseDirection,bare[0].metadata.quoteDirection],[null,null])
 eq(dexEvidenceRows('dexSwaps',swapBody([swapRow({t0pt:42})]),swapParams)[0].metadata.baseDirection,null)
})

Deno.test('a swap the provider attributed to nobody is kept without a maker, never dropped',()=>{
 // The provider does not promise `ma` on every row. A swap that names no maker
 // is still a real swap of this contract: dropping it would silently shrink the
 // tape and make a volume total disagree with itself.
 for(const absent of [{ma:undefined},{ma:null}]){
  const rows=dexEvidenceRows('dexSwaps',swapBody([swapRow(absent)]),swapParams)
  eq(rows.length,1,'the swap survives')
  eq(rows[0].value,250,'and keeps its value')
  eq(rows[0].metadata.maker,null,'with an explicit absence, never a repaired identity')
 }
 // A maker that is not a valid account on the chain that was asked about is a
 // MALFORMED answer, and the validator stays fail-closed about identity.
 for(const bad of ['0xnope','',42,{},'So11111111111111111111111111111111111111112'])
  eq(dexEvidenceRows('dexSwaps',swapBody([swapRow({ma:bad})]),swapParams),[],`refused: ${String(bad)}`)
})

Deno.test('a swap retains no longer than the source policy allows, maker included',async()=>{
 const fetchedAt=new Date().toISOString()
 const expiresAt=new Date(Date.now()+120000).toISOString()
 const staleUntil=new Date(Date.now()+900000).toISOString()
 const body=swapBody([swapRow()])
 // Retention OFF is the default. retainUntil collapses onto the stale window,
 // which for swaps is 900 seconds: nothing is kept beyond the life of the cache.
 const off=await normalizeCmcInvestigation('dexSwaps',body,swapParams,fetchedAt,expiresAt,staleUntil,()=>undefined)
 eq(off.rows.length,1)
 eq(off.rows[0].retainUntil,staleUntil)
 eq(off.policy.historical,false)
 // Retention ON extends it, and the maker travels the shared normalize path
 // unchanged: this lane opens no private door into the evidence table.
 const on=await normalizeCmcInvestigation('dexSwaps',body,swapParams,fetchedAt,expiresAt,staleUntil,
  k=>k==='CMC_ALLOW_HISTORICAL_RETENTION'?'true':undefined)
 assert(Date.parse(on.rows[0].retainUntil)>Date.parse(staleUntil),'retention on keeps the row past its stale window')
 eq(on.observations[0].metadata.maker,MAKER)
 eq(on.observations[0].metric,'swap_event_usd')
 // One swap is one event universe, keyed by transaction and log index. A maker
 // is not part of that identity: the same swap read twice stays one row.
 assert(String(on.observations[0].universe).endsWith(':event:0xfeed:3'))
})

Deno.test('the reviewed dexToken price row is unchanged by the holder tag branch',()=>{
 const rows=dexEvidenceRows('dexToken',{data:{pid:1,addr:address,p:2600.5,pt:1700000000}},{platform:'ethereum',address})
 eq(rows.length,1)
 eq(rows[0].metric,'price')
 eq(rows[0].value,2600.5)
 eq(rows[0].observed,1700000000)
})
