import assert from 'node:assert/strict'
import {valuationReceipts,VALUATION_RECEIPT_LIMIT} from './valuation-receipts.ts'

const holding=(key:string,value:number,ref:string|null,extra:Record<string,unknown>={})=>({canonicalAssetKey:key,assetSymbol:key.toUpperCase(),currentValue:value,isClosed:false,
 lastPricedAt:'2026-09-16T11:59:00Z',marketContext:ref?{priceSourceRef:ref,priceExpiresAt:'2026-09-16T12:04:00Z'}:{},...extra})

Deno.test('a stored CoinMarketCap valuation reads as a cache receipt with nothing estimated',()=>{
 const [quotes,listings]=valuationReceipts([holding('a',10,'coinmarketcap:listings:1027'),holding('b',50,'coinmarketcap:quotes:1')])
 assert.equal(quotes.canonicalAssetKey,'b')
 assert.equal(quotes.receipt.capability,'quotes')
 assert.equal(quotes.receipt.endpoint,'/v3/cryptocurrency/quotes/latest')
 assert.deepEqual(quotes.receipt.parameters,{id:'1'})
 assert.equal(quotes.receipt.origin,'cache')
 for(const field of ['httpStatus','creditCount','elapsedMs','cacheAgeSeconds','fetchedAt','staleUntil','reservation'] as const)assert.equal(quotes.receipt[field],null)
 assert.equal(quotes.observedAt,'2026-09-16T11:59:00.000Z')
 assert.equal(listings.receipt.capability,'listings')
 assert.deepEqual(listings.receipt.parameters,{})
})

Deno.test('holdings without a stored provider reference, closed holdings and duplicates get no invented receipt',()=>{
 const rows=valuationReceipts([
  holding('wallet',5,null),holding('exchange',6,'exchange_profile:binance:BTC'),holding('closed',7,'coinmarketcap:quotes:2',{isClosed:true}),
  holding('dup',8,'coinmarketcap:quotes:3'),holding('dup',9,'coinmarketcap:quotes:3'),holding('bad',9,'coinmarketcap:quotes:0'),
 ])
 assert.deepEqual(rows.map(r=>r.canonicalAssetKey),['dup'])
})

Deno.test('the receipt list is bounded',()=>{
 const rows=valuationReceipts(Array.from({length:40},(_,i)=>holding(`k${i}`,i,`coinmarketcap:quotes:${i+1}`)))
 assert.equal(rows.length,VALUATION_RECEIPT_LIMIT)
 assert.equal(rows[0].canonicalAssetKey,'k39')
 assert.deepEqual(valuationReceipts(null as any),[])
})
