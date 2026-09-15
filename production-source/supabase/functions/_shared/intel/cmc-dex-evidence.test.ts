import {assertEquals as eq,assert} from 'jsr:@std/assert'
import {dexEvidenceRows} from './cmc-dex-evidence.ts'
import {CMC_HOLDER_TAGS} from '../market-assets/cmc-dex.ts'
const address='0x'+'a'.repeat(40),subject=`eip155:1:${address}`
const tagParams={platform:'ethereum',tokenAddress:address}
const tagBody=(holders:any[])=>({data:{platformId:1,tokenAddress:address,holders}})

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

Deno.test('the reviewed dexToken price row is unchanged by the holder tag branch',()=>{
 const rows=dexEvidenceRows('dexToken',{data:{pid:1,addr:address,p:2600.5,pt:1700000000}},{platform:'ethereum',address})
 eq(rows.length,1)
 eq(rows[0].metric,'price')
 eq(rows[0].value,2600.5)
 eq(rows[0].observed,1700000000)
})
