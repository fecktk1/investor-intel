import {assertEquals,assertThrows} from 'jsr:@std/assert'
import {aggregateExchangeDisclosure,exchangeDisclosureReference,exchangeDisclosureParams} from './exchange-disclosure.ts'
const row=(currency=1,wallet='wallet',balance:any=2,price:any=10,platform=1027)=>({wallet_address:wallet,balance,platform:{crypto_id:platform,name:'Ethereum'},currency:{crypto_id:currency,symbol:'SAME',name:'Asset',price_usd:price}})
Deno.test('selected asset is joined by exact identity across the full response, independent of table pagination',()=>{
 const data=Array.from({length:50},(_,i)=>row(i+1,`wallet-${i}`))
 data.push(row(50,'other-network',0,0,1))
 const r=aggregateExchangeDisclosure({data},'270',1,12,'50')
 assertEquals(r.rows.some(r=>r.id==='50'),false)
 assertEquals(r.selectedAsset!.subject,'market:coinmarketcap:50');assertEquals(r.selectedAsset!.state,'reported')
 assertEquals(r.selectedAsset!.asset.quantity,2);assertEquals(r.selectedAsset!.asset.records,2)
 assertEquals(r.selectedAsset!.networks.length,2);assertEquals(r.selectedAsset!.networks.find(n=>n.id==='1').quantity,0)
 assertEquals(r.selectedAsset!.asset.shareOfPricedPercent,2)
 assertEquals(aggregateExchangeDisclosure({data},'270',25,12,'50').selectedAsset,r.selectedAsset)
})
Deno.test('selected disclosure distinguishes absent, excluded, partly priced and legitimate zero records',()=>{
 const data=[row(1,'zero',0,0),row(2,'unpriced',2,null),row(2,'priced'),row(3,'conflict'),row(3,'conflict',3),row(4,'invalid',-1),row(5,'good'),row(5,'bad',-1)]
 const get=(id:string)=>aggregateExchangeDisclosure({data},'270',1,12,id).selectedAsset!
 assertEquals(get('1').state,'reported');assertEquals(get('1').asset.quantity,0);assertEquals(get('1').asset.pricedUsd,0)
 assertEquals(get('2').state,'partial');assertEquals(get('2').asset.unpricedRecords,1)
 assertEquals(get('3').state,'excluded');assertEquals(get('3').asset,null);assertEquals(get('3').conflictingRecords,1)
 assertEquals(get('4').state,'excluded');assertEquals(get('4').invalidRecords,1)
 assertEquals(get('5').state,'partial');assertEquals(get('5').asset.quantity,2)
 assertEquals(get('99').state,'not_reported');assertEquals(get('99').asset,null)
})
Deno.test('disclosure input rejects ambiguous identities and unknown options before any provider read',()=>{
 assertEquals(exchangeDisclosureParams({id:270,assetId:1}),{id:'270',start:1,limit:25,assetId:'1'})
 for(const assetId of [true,0,-1,'BTC','01','1e2',' 1 ',[],{},'1,2','1000000000000'])assertThrows(()=>exchangeDisclosureParams({id:'270',assetId}))
 for(const input of [null,[],{id:true},{id:'270',start:0},{id:'270',limit:101},{id:'270',wallet:'x'}])assertThrows(()=>exchangeDisclosureParams(input))
 assertThrows(()=>aggregateExchangeDisclosure({data:[]},'270',1,25,'BTC'))
})
Deno.test('saved disclosure selection retains exact subject without exporting values or changing the shared response hash',async()=>{
 const body={data:[row(1,'secret-wallet',12,34)]},provenance={fetchedAt:'2026-09-12T03:18:02Z'}
 const all=await exchangeDisclosureReference(body,'270',provenance),selected=await exchangeDisclosureReference(body,'270',provenance,'1')
 assertEquals(selected.payloadHash,all.payloadHash);assertEquals(selected.selectedSubject,'market:coinmarketcap:1')
 assertEquals(JSON.stringify(selected).includes('secret-wallet'),false);assertEquals(selected.observedAt,null)
})
Deno.test('disclosure aggregates the entire response before pagination and keeps same-ticker identities separate',()=>{
 const data=Array.from({length:300},(_,i)=>row(i+1,'wallet'+i)),r=aggregateExchangeDisclosure({data},'270',1,25)
 assertEquals(r.rows.length,25);assertEquals(r.total,300);assertEquals(r.summary.pricedUsd,6000);assertEquals(r.summary.reportedWallets,300);assertEquals(r.hasMore,true);assertEquals(r.observedAt,null)
 assertEquals(aggregateExchangeDisclosure({data},'270',276,25).hasMore,false)
})
Deno.test('zero values are valid, unpriced records are visible, and duplicate conflicts are excluded',()=>{
 const r=aggregateExchangeDisclosure({data:[row(1,'a',0,0),row(2,'b',2,null),row(3,'c'),row(3,'c'),row(4,'d'),row(4,'d',3),row(5,'bad',-1)]},'270')
 assertEquals(r.summary,{reportedRecords:7,uniqueRecords:3,reportedWallets:3,duplicateRecords:1,conflictingRecords:1,invalidRecords:1,unpricedRecords:1,pricedUsd:20})
 assertEquals(r.rows.find(r=>r.id==='1').quantity,0);assertEquals(r.rows.find(r=>r.id==='2').unpricedRecords,1);assertEquals(r.coverage,'partial')
 assertEquals(aggregateExchangeDisclosure({data:[row(1,'z',0,0)]},'270').rows[0].shareOfPricedPercent,null)
})
Deno.test('malformed, oversized and invalid pagination do not become empty coverage',()=>{
 assertThrows(()=>aggregateExchangeDisclosure({data:{}},'270'));assertThrows(()=>aggregateExchangeDisclosure({data:Array(10001).fill(row())},'270'))
 assertThrows(()=>aggregateExchangeDisclosure({data:[]},'270',0));assertEquals(aggregateExchangeDisclosure({data:[]},'270').coverage,'empty')
})
Deno.test('reference identifies the full response, preserves source clock, and omits values and wallet addresses',async()=>{
 const body={data:[row(1,'secret-wallet',12,34)]},provenance={fetchedAt:'2026-09-12T03:18:02Z'}
 const first=await exchangeDisclosureReference(body,'270',provenance)
 const repeat=await exchangeDisclosureReference(body,'270',{fetchedAt:'2026-09-12T04:18:02Z'})
 assertEquals(first.payloadHash,repeat.payloadHash);assertEquals(first.observedAt,null);assertEquals(first.retrievedAt,provenance.fetchedAt)
 assertEquals(first.replay,'references_only');assertEquals(JSON.stringify(first).includes('secret-wallet'),false)
 assertEquals(first.payloadHash===(await exchangeDisclosureReference({data:[row(1,'secret-wallet',13,34)]},'270',provenance)).payloadHash,false)
 const many=aggregateExchangeDisclosure({data:Array.from({length:110},(_,i)=>row(1,`wallet-${i}`,1,1,i+1))},'270')
 assertEquals(many.chainTotal,110);assertEquals(many.chainsTruncated,true);assertEquals(many.summary.pricedUsd,110)
})
