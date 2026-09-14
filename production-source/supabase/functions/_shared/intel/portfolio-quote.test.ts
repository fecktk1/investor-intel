import assert from 'node:assert/strict'
import {portfolioQuoteStatus} from './portfolio-quote.ts'
const now=Date.parse('2026-09-11T03:00:00Z')
const row=(source:string,age:number,extra={})=>({current_value:100,current_price:1,price_source:source,last_priced_at:new Date(now-age).toISOString(),price_status:'priced',...extra})
Deno.test('CMC and exchange quotes use short cadence rather than wallet daily cadence',()=>{
 assert.equal(portfolioQuoteStatus(row('coinmarketcap',299999),now),'priced');assert.equal(portfolioQuoteStatus(row('coinmarketcap',300001),now),'stale')
 assert.equal(portfolioQuoteStatus(row('exchange_profile',599999),now),'priced');assert.equal(portfolioQuoteStatus(row('exchange_profile',600001),now),'stale')
 assert.equal(portfolioQuoteStatus(row('provider_inline',29*3600000),now),'priced');assert.equal(portfolioQuoteStatus(row('provider_inline',31*3600000),now),'stale')
})
Deno.test('expired provider caches and declared stale data cannot be promoted by a recent observation',()=>{
 assert.equal(portfolioQuoteStatus(row('coinmarketcap',1000,{market_context:{priceExpiresAt:new Date(now).toISOString()}}),now),'stale')
 assert.equal(portfolioQuoteStatus(row('coinmarketcap',1000,{price_status:'stale'}),now),'stale')
})
Deno.test('missing or future provenance is unavailable or stale while valid zero remains a real value',()=>{
 for(const extra of [{current_value:null},{current_price:null},{current_value:Infinity}])assert.equal(portfolioQuoteStatus(row('coinmarketcap',1000,extra),now),'unpriced')
 assert.equal(portfolioQuoteStatus(row('coinmarketcap',-60000),now),'stale');assert.equal(portfolioQuoteStatus(row('coinmarketcap',1000,{last_priced_at:null}),now),'stale')
 assert.equal(portfolioQuoteStatus(row('coinmarketcap',1000,{current_value:0,current_price:0}),now),'priced')
})
